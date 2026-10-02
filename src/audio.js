/* ===========================================================
   audio.js
   Mic capture, the output chain, and reversed playback.

   Why it's loud now (the old version was too quiet on iPhone):
   - The mic is opened with echo cancellation, noise suppression and auto
     gain control all OFF, so iOS isn't pumping the level around.
   - Each take is auto-maximized after recording: boosted toward a loud RMS
     target without letting peaks clip (same approach as me-again).
   - Playback runs through a +9 dB drive into a limiter and a soft clipper,
     so it's loud on a phone speaker without digital overs.

   Why it's instant: the mic is captured as raw PCM by an AudioWorklet
   (capture-worklet.js) instead of MediaRecorder, so releasing the button
   doesn't wait on an encode + decode before playback can start.
   =========================================================== */

const TRIM_HEAD = 0.03;  // s cut from the take's start (press thud)
const TRIM_TAIL = 0.03;  // s cut from the take's end (release thud)

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.micStream = null;
    this.micSource = null;
    this.analyser = null;
    this.capture = null;       // AudioWorkletNode (or ScriptProcessor fallback)
    this.chunks = [];
    this.recording = false;
    this.pendingFlush = null;  // resolve() for an in-flight worklet flush
    this.master = null;        // playback volume
    this.voices = new Set();   // { src, gain } currently playing
    this.onChunk = null;       // (Float32Array) => void while recording
    this.onMicLost = null;     // () => void if the mic track ends (iOS)
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

  /* -------- setup (must run inside a user gesture on iOS) -------- */

  async init({ deviceId } = {}) {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio is not supported in this browser.');
      this.ctx = new AC();
      this._buildOutput();
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    await this.openMic(deviceId);
  }

  // Ask iOS to wake the context again (it suspends/interrupts it after
  // backgrounding or a phone call). Cheap to call on every press.
  wake() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  _buildOutput() {
    const ctx = this.ctx;
    //   voices -> master (volume) -> drive -> limiter -> soft clip -> out
    this.master = ctx.createGain();
    const drive = ctx.createGain();
    drive.gain.value = 2.8; // ≈ +9 dB; the limiter catches the peaks
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.18;
    const safety = softClipper(ctx);
    this.master.connect(drive).connect(limiter).connect(safety.input);
    safety.output.connect(ctx.destination);
  }

  setVolume(v) {
    if (!this.master) return;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  async setOutputDevice(id) {
    if (this.ctx && typeof this.ctx.setSinkId === 'function') {
      await this.ctx.setSinkId(id || '');
    }
  }

  async openMic(deviceId) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone access is not supported in this browser.');
    }
    this.closeMic();
    // No processing: echo cancellation / noise suppression / AGC all fight
    // an instrument or voice and made the old version quiet and pumpy.
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (deviceId) audio.deviceId = { exact: deviceId };
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    const track = this.micStream.getAudioTracks()[0];
    if (track) track.addEventListener('ended', () => { if (this.onMicLost) this.onMicLost(); });

    this.micSource = this.ctx.createMediaStreamSource(this.micStream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.micSource.connect(this.analyser);

    if (!this.capture) await this._buildCapture();
    this.micSource.connect(this.capture);
  }

  get micAlive() {
    const t = this.micStream && this.micStream.getAudioTracks()[0];
    return !!t && t.readyState === 'live';
  }

  closeMic() {
    if (this.micSource) { try { this.micSource.disconnect(); } catch (_) { /* ok */ } }
    if (this.micStream) this.micStream.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.micSource = null;
    this.analyser = null;
  }

  async _buildCapture() {
    const ctx = this.ctx;
    // The capture node outputs silence; it's routed to the speakers through a
    // muted gain only so every browser keeps pulling audio through it.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);

    if (ctx.audioWorklet) {
      try {
        await ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url).href);
        const node = new AudioWorkletNode(ctx, 'capture', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
          channelCount: 1, channelCountMode: 'explicit',
        });
        node.port.onmessage = (e) => this._onCaptureMessage(e.data);
        node.connect(mute);
        this.capture = node;
        return;
      } catch (err) {
        console.warn('AudioWorklet unavailable, using ScriptProcessor', err);
      }
    }
    // Fallback for browsers without AudioWorklet.
    const sp = ctx.createScriptProcessor(2048, 1, 1);
    sp.onaudioprocess = (e) => this._onCaptureMessage(e.inputBuffer.getChannelData(0).slice());
    sp.connect(mute);
    this.capture = sp;
  }

  _onCaptureMessage(data) {
    if (data && data.flushed) {
      if (this.recording) this._push(data.flushed);
      if (this.pendingFlush) { this.pendingFlush(); this.pendingFlush = null; }
      return;
    }
    if (this.recording) this._push(data);
  }

  _push(chunk) {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    if (this.onChunk) this.onChunk(chunk);
  }

  /* -------- metering -------- */

  level() {
    if (!this.analyser) return 0;
    const buf = this._meterBuf || (this._meterBuf = new Float32Array(this.analyser.fftSize));
    this.analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
    return peak;
  }

  /* -------- recording -------- */

  startRecording() {
    this.chunks = [];
    this.recording = true;
  }

  get recordedSeconds() {
    let n = 0;
    for (const c of this.chunks) n += c.length;
    return n / this.sampleRate;
  }

  // Stop and return the raw take (Float32Array), or null if (nearly) empty.
  async stopRecording() {
    if (!this.recording) return null;
    // Collect the worklet's partial batch (≤ 43 ms) so the tail isn't lost.
    if (this.capture && this.capture.port) {
      await new Promise((resolve) => {
        this.pendingFlush = resolve;
        this.capture.port.postMessage('flush');
        setTimeout(resolve, 120); // never hang the UI on it
      });
    }
    this.recording = false;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const head = Math.floor(TRIM_HEAD * this.sampleRate);
    const tail = Math.floor(TRIM_TAIL * this.sampleRate);
    const len = total - head - tail;
    if (len < this.sampleRate * 0.05) { this.chunks = []; return null; }
    const all = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) { all.set(c, o); o += c.length; }
    this.chunks = [];
    return all.subarray(head, head + len);
  }

  abortRecording() {
    this.recording = false;
    this.chunks = [];
  }

  /* -------- processing -------- */

  // Reverse a raw take into a playable AudioBuffer, optionally maximized.
  // Returns { buffer, gain } where gain is the linear boost applied.
  makeReversed(samples, { maximize = true } = {}) {
    const gain = maximize ? maximizeGain(samples) : 1;
    const buf = this.ctx.createBuffer(1, samples.length, this.sampleRate);
    const out = buf.getChannelData(0);
    const n = samples.length;
    for (let i = 0; i < n; i++) out[i] = samples[n - 1 - i] * gain;
    return { buffer: buf, gain };
  }

  /* -------- playback -------- */

  // Play buffers together. Returns { startTime, duration } of the longest.
  play(buffers, { rate = 1, fadeIn = 0, fadeOut = 0, onEnded } = {}) {
    this.stopAll(0.03);
    const ctx = this.ctx;
    const now = ctx.currentTime + 0.01;
    let longest = 0;
    let ended = 0;
    for (const b of buffers) {
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      const dur = b.duration / rate;
      longest = Math.max(longest, dur);
      const fi = Math.min(fadeIn, dur / 2);
      const fo = Math.min(fadeOut, dur / 2);
      if (fi > 0) { g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(1, now + fi); }
      else g.gain.setValueAtTime(1, now);
      if (fo > 0) { g.gain.setValueAtTime(1, now + dur - fo); g.gain.linearRampToValueAtTime(0, now + dur); }
      src.connect(g).connect(this.master);
      const voice = { src, gain: g };
      this.voices.add(voice);
      src.onended = () => {
        this.voices.delete(voice);
        ended += 1;
        if (ended === buffers.length && onEnded) onEnded();
      };
      src.start(now);
    }
    return { startTime: now, duration: longest };
  }

  get playing() { return this.voices.size > 0; }

  // Stop everything with a short fade (no click). `fade` in seconds.
  stopAll(fade = 0.08) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      v.src.onended = null;
      try {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setValueAtTime(v.gain.gain.value, now);
        v.gain.gain.linearRampToValueAtTime(0, now + fade);
        v.src.stop(now + fade + 0.01);
      } catch (_) { /* already stopped */ }
    }
    this.voices.clear();
  }
}

/* -------- helpers -------- */

// Boost toward a loud target WITHOUT clipping (from me-again): take the gentler
// of "peak up to the ceiling" and "RMS up to the target". Boost-only.
function maximizeGain(d, { ceiling = 0.97, targetRms = 0.33, maxGain = 40 } = {}) {
  let peak = 0, sumSq = 0;
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  if (peak < 1e-4 || !d.length) return 1;
  const rms = Math.sqrt(sumSq / d.length);
  const g = Math.min(ceiling / peak, rms > 0 ? targetRms / rms : maxGain, maxGain);
  return g > 1 ? g : 1;
}

// Unity below |x| = 0.75, then a tanh knee toward 0.99. Input is scaled by
// 1/1.5 (and the curve back up) so overs up to +3.5 dBFS land on the knee.
function softClipper(ctx) {
  const range = 1.5, knee = 0.75, room = 0.24;
  const input = ctx.createGain();
  input.gain.value = 1 / range;
  const shaper = ctx.createWaveShaper();
  const n = 2049;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = range * ((i / (n - 1)) * 2 - 1);
    const a = Math.abs(u);
    curve[i] = Math.sign(u) * (a <= knee ? a : knee + room * Math.tanh((a - knee) / room));
  }
  shaper.curve = curve;
  shaper.oversample = '2x';
  input.connect(shaper);
  return { input, output: shaper };
}
