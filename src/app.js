/* ===========================================================
   app.js
   UI and interaction for There and Back Again.

   Record button, "Hold" mode (default):
     press & hold  -> record
     let go        -> reverse and play straight away
     quick tap     -> replay (or stop, if playing)
   "Tap on / off" mode:
     tap           -> start recording (stops any playback)
     tap again     -> reverse and play
   The right-hand button always replays / stops. Space bar = the record
   button on a keyboard.
   =========================================================== */

import { AudioEngine } from './audio.js';

const TAP_SECONDS = 0.3;     // a hold shorter than this counts as a tap
const MAX_SECONDS = 120;     // recording auto-stops here
const TRACKS = 3;
const SETTINGS_KEY = 'thereAndBack.settings';

const audio = new AudioEngine();
const $ = (id) => document.getElementById(id);

const els = {
  gate: $('gate'), gateText: $('gateText'), btnEnable: $('btnEnable'),
  meterBar: $('meterBar'), canvas: $('waveform'), waveWrap: $('waveformWrap'),
  waveLabel: $('waveLabel'), playhead: $('playhead'),
  btnRecord: $('btnRecord'), btnIcon: $('btnIcon'), btnLabel: $('btnLabel'),
  btnLoop: $('btnLoop'), btnReplay: $('btnReplay'), replayIcon: $('replayIcon'),
  status: $('status'), infoRow: $('infoRow'),
  settingsToggle: $('settingsToggle'), settingsBody: $('settingsBody'),
  volume: $('volume'), volumeVal: $('volumeVal'), maximize: $('maximize'),
  rate: $('rate'), rateVal: $('rateVal'),
  fadeIn: $('fadeIn'), fadeInVal: $('fadeInVal'), fadeOut: $('fadeOut'), fadeOutVal: $('fadeOutVal'),
  inputSelect: $('inputSelect'), outputSelect: $('outputSelect'), outputField: $('outputField'),
  modeNote: $('modeNote'),
  pills: [...document.querySelectorAll('.track-pill')],
};

const ICON_REC = '<circle cx="50" cy="50" r="36" />';
const ICON_STOP = '<rect x="27" y="27" width="46" height="46" rx="8" />';
const PATH_PLAY = 'M8 5v14l11-7z';
const PATH_STOP = 'M7 7h10v10H7z';

/* ---------------- state ---------------- */

const state = {
  ready: false,          // mic + audio unlocked
  phase: 'idle',         // idle | recording | processing | playing
  mode: 'hold',          // hold | tap
  loop: false,
  tracks: new Array(TRACKS).fill(null), // reversed AudioBuffers
  active: 0,
  pressStart: 0,         // performance.now() at press (hold mode)
  wasPlayingAtPress: false,
  pointerId: null,
  playStart: 0, playDur: 0,
  recTimer: null,
  liveCols: [],          // live waveform peaks while recording
};

const hasTakes = () => state.tracks.some(Boolean);

/* ---------------- setup ---------------- */

els.btnEnable.addEventListener('click', enable);

async function enable() {
  els.btnEnable.disabled = true;
  try {
    await audio.init({ deviceId: els.inputSelect.value || undefined });
    els.btnEnable.textContent = 'Tap to start';
    audio.setVolume(Number(els.volume.value));
    audio.onMicLost = micLost;
    state.ready = true;
    els.gate.classList.add('hidden');
    await populateDevices();
    showInfo();
    meterLoop();
  } catch (err) {
    els.gateText.textContent = micErrorText(err);
  } finally {
    els.btnEnable.disabled = false;
  }
}

function micLost() {
  // iOS can end the mic track after backgrounding or a call.
  abortEverything();
  state.ready = false;
  els.gateText.textContent = 'The microphone was disconnected. Tap to reconnect.';
  els.btnEnable.textContent = 'Reconnect';
  els.gate.classList.remove('hidden');
}

function micErrorText(err) {
  if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
    return 'Microphone permission was denied. Allow it in your browser settings, then tap again.';
  }
  if (err && err.name === 'NotFoundError') return 'No microphone was found.';
  return `Couldn't start audio: ${err && err.message ? err.message : err}`;
}

/* ---------------- record button ---------------- */

const btn = els.btnRecord;
btn.addEventListener('contextmenu', (e) => e.preventDefault());

btn.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || state.pointerId !== null) return;
  e.preventDefault();
  state.pointerId = e.pointerId;
  try { btn.setPointerCapture(e.pointerId); } catch (_) { /* ok */ }
  press();
});
const endPointer = (e) => {
  if (e.pointerId !== state.pointerId) return;
  state.pointerId = null;
  release();
};
btn.addEventListener('pointerup', endPointer);
btn.addEventListener('pointercancel', endPointer);
// If the browser drops capture without a pointerup, still end the hold.
btn.addEventListener('lostpointercapture', endPointer);
// Keyboard "click" (Enter) for accessibility: behaves like a tap.
btn.addEventListener('click', (e) => {
  if (e.detail !== 0) return; // real pointer clicks are handled above
  press(); release(true);
});

// Space bar acts as the record button.
let spaceDown = false;
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || isTyping(e.target)) return;
  e.preventDefault();
  if (spaceDown) return;
  spaceDown = true;
  press();
});
document.addEventListener('keyup', (e) => {
  if (e.code !== 'Space' || !spaceDown) return;
  e.preventDefault();
  spaceDown = false;
  release();
});
const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');

function press() {
  if (!state.ready) return;
  audio.wake();
  if (!audio.micAlive) { micLost(); return; }
  if (state.phase === 'processing') return;

  if (state.mode === 'tap') {
    if (state.phase === 'recording') finishRecording();
    else startRecording();
    return;
  }
  // Hold mode: start recording right away so the first note isn't lost; if
  // it turns out to be a quick tap we throw the take away on release.
  state.wasPlayingAtPress = state.phase === 'playing';
  state.pressStart = performance.now();
  startRecording();
}

function release(forceTap = false) {
  if (state.mode === 'tap' || state.phase !== 'recording') return;
  const held = (performance.now() - state.pressStart) / 1000;
  if (forceTap || held < TAP_SECONDS) {
    // Quick tap: discard the blip and treat it as replay / stop.
    audio.abortRecording();
    stopRecTimer();
    state.phase = 'idle';
    if (!state.wasPlayingAtPress && hasTakes()) playAll();
    else {
      renderAll();
      if (!hasTakes()) setStatus('Hold the button down while you make a sound.');
    }
    return;
  }
  finishRecording();
}

function startRecording() {
  stopPlayback(true);
  audio.startRecording();
  state.phase = 'recording';
  state.liveCols = [];
  audio.onChunk = addLiveColumn;
  startRecTimer();
  renderAll();
}

async function finishRecording() {
  state.phase = 'processing';
  stopRecTimer();
  renderAll();
  const samples = await audio.stopRecording();
  audio.onChunk = null;
  if (!samples) {
    state.phase = 'idle';
    renderAll();
    setStatus('Too short — nothing recorded.');
    return;
  }
  const { buffer, gain } = audio.makeReversed(samples, { maximize: els.maximize.checked });
  state.tracks[state.active] = buffer;
  const dB = 20 * Math.log10(gain);
  setStatus(`Recorded ${buffer.duration.toFixed(1)}s${gain > 1.01 ? ` · boosted +${dB.toFixed(0)} dB` : ''}`);
  playAll();
}

/* ---------------- playback ---------------- */

function playAll() {
  const bufs = state.tracks.filter(Boolean);
  if (!bufs.length) { state.phase = 'idle'; renderAll(); return; }
  const { startTime, duration } = audio.play(bufs, {
    rate: Number(els.rate.value),
    fadeIn: Number(els.fadeIn.value),
    fadeOut: Number(els.fadeOut.value),
    onEnded: () => {
      if (state.phase !== 'playing') return;
      if (state.loop) playAll();
      else { state.phase = 'idle'; renderAll(); }
    },
  });
  state.playStart = startTime;
  state.playDur = duration;
  state.phase = 'playing';
  renderAll();
  playheadLoop();
}

function stopPlayback(quick = false) {
  if (state.phase === 'playing') state.phase = 'idle';
  audio.stopAll(quick ? 0.03 : 0.12);
}

function abortEverything() {
  audio.abortRecording();
  audio.onChunk = null;
  stopRecTimer();
  stopPlayback(true);
  state.phase = 'idle';
  state.pointerId = null;
  renderAll();
}

els.btnReplay.addEventListener('click', () => {
  if (!state.ready) return;
  audio.wake();
  if (state.phase === 'playing') { stopPlayback(); renderAll(); }
  else if (state.phase === 'idle' && hasTakes()) playAll();
});

els.btnLoop.addEventListener('click', () => {
  state.loop = !state.loop;
  renderAll();
});

/* ---------------- tracks ---------------- */

els.pills.forEach((pill, i) => {
  pill.addEventListener('click', (e) => {
    if (state.phase === 'recording' || state.phase === 'processing') return;
    if (e.target.classList.contains('clear-x')) {
      state.tracks[i] = null;
      if (state.phase === 'playing') stopPlayback();
    }
    state.active = i;
    renderAll();
  });
});

/* ---------------- timers ---------------- */

function startRecTimer() {
  stopRecTimer();
  state.recTimer = setInterval(() => {
    const s = audio.recordedSeconds;
    setStatus(`Recording ${s.toFixed(1)}s`);
    if (s >= MAX_SECONDS) finishRecording();
  }, 100);
}
function stopRecTimer() {
  if (state.recTimer) clearInterval(state.recTimer);
  state.recTimer = null;
}

// Stop cleanly if the page is hidden mid-take (iOS suspends audio).
document.addEventListener('visibilitychange', () => {
  if (document.hidden && (state.phase === 'recording' || state.phase === 'playing')) abortEverything();
});

/* ---------------- rendering ---------------- */

function renderAll() {
  const p = state.phase;
  btn.classList.toggle('recording', p === 'recording');
  btn.classList.toggle('processing', p === 'processing');
  btn.classList.toggle('playing', p === 'playing');
  els.btnIcon.innerHTML = p === 'recording' ? ICON_STOP : ICON_REC;

  let label;
  if (state.mode === 'hold') {
    label = p === 'recording' ? 'Let go to hear it backwards'
      : p === 'playing' ? 'Tap to stop · hold to record again'
      : hasTakes() ? 'Hold to record · tap to replay' : 'Hold to record';
  } else {
    label = p === 'recording' ? 'Tap to stop & reverse'
      : p === 'playing' ? 'Tap to record again' : 'Tap to record';
  }
  els.btnLabel.textContent = p === 'processing' ? 'Reversing…' : label;
  btn.setAttribute('aria-label', label);

  els.btnLoop.classList.toggle('on', state.loop);
  els.btnLoop.setAttribute('aria-pressed', String(state.loop));
  const canReplay = hasTakes() && (p === 'idle' || p === 'playing');
  els.btnReplay.disabled = !canReplay;
  els.replayIcon.querySelector('path').setAttribute('d', p === 'playing' ? PATH_STOP : PATH_PLAY);
  els.btnReplay.setAttribute('aria-label', p === 'playing' ? 'Stop' : 'Replay');

  els.pills.forEach((pill, i) => {
    pill.classList.toggle('selected', i === state.active);
    pill.classList.toggle('has-audio', !!state.tracks[i]);
  });

  if (p !== 'recording') drawTrack();
}

function setStatus(text) { els.status.textContent = text || ' '; }

/* ---------------- waveform ---------------- */

function canvasCtx() {
  const c = els.canvas;
  const dpr = window.devicePixelRatio || 1;
  const r = c.getBoundingClientRect();
  if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) {
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  return { g, w: r.width, h: r.height };
}
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function drawTrack() {
  const buf = state.tracks[state.active];
  const { g, w, h } = canvasCtx();
  if (!buf) {
    els.waveLabel.textContent = `Track ${state.active + 1} · empty`;
    return;
  }
  const d = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(d.length / w));
  g.fillStyle = cssVar(state.phase === 'playing' ? '--wave-play' : '--wave-idle');
  for (let x = 0; x < w; x++) {
    const i0 = Math.floor(x * d.length / w);
    let min = 0, max = 0;
    for (let j = 0; j < step; j++) { const s = d[i0 + j] || 0; if (s < min) min = s; if (s > max) max = s; }
    const y0 = (1 - max) * h / 2, y1 = (1 - min) * h / 2;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
  els.waveLabel.textContent = `Track ${state.active + 1} · reversed · ${buf.duration.toFixed(1)}s`;
}

function addLiveColumn(chunk) {
  let peak = 0;
  for (let i = 0; i < chunk.length; i++) { const a = Math.abs(chunk[i]); if (a > peak) peak = a; }
  state.liveCols.push(peak);
  const { g, w, h } = canvasCtx();
  // Quiet iPhone input: show it scaled up so there's something to see.
  const scale = Math.min(8, 0.9 / Math.max(0.02, ...state.liveCols.slice(-400)));
  const cols = state.liveCols.slice(-Math.floor(w / 2));
  g.fillStyle = cssVar('--wave-rec');
  cols.forEach((p, i) => {
    const amp = Math.max(1, p * scale * h / 2);
    g.fillRect(i * 2, h / 2 - amp, 1.5, amp * 2);
  });
  els.waveLabel.textContent = 'Recording…';
}

let playheadRAF = 0;
function playheadLoop() {
  const ph = els.playhead;
  cancelAnimationFrame(playheadRAF);
  const tick = () => {
    if (state.phase !== 'playing' || !state.playDur) { ph.style.display = 'none'; return; }
    const buf = state.tracks[state.active];
    // Follow the selected track's length within the layered playback.
    const dur = buf ? buf.duration / Number(els.rate.value) : state.playDur;
    const t = (audio.ctx.currentTime - state.playStart) / dur;
    if (t >= 0 && t <= 1) {
      ph.style.display = 'block';
      ph.style.transform = `translateX(${t * els.waveWrap.clientWidth}px)`;
    } else ph.style.display = 'none';
    playheadRAF = requestAnimationFrame(tick);
  };
  playheadRAF = requestAnimationFrame(tick);
}

let meterRunning = false;
function meterLoop() {
  if (meterRunning) return;
  meterRunning = true;
  const tick = () => {
    const lvl = state.ready ? audio.level() : 0;
    // dB-ish scale so the quiet iPhone mic still moves the meter.
    const db = 20 * Math.log10(lvl + 1e-6);
    const pct = Math.max(0, Math.min(100, (db + 60) / 60 * 100));
    els.meterBar.style.width = `${pct}%`;
    els.meterBar.classList.toggle('hot', lvl > 0.9);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

window.addEventListener('resize', () => { if (state.phase !== 'recording') drawTrack(); });

/* ---------------- settings ---------------- */

els.settingsToggle.addEventListener('click', () => {
  const open = els.settingsBody.hidden;
  els.settingsBody.hidden = !open;
  els.settingsToggle.setAttribute('aria-expanded', String(open));
});

document.querySelectorAll('#modeSeg .seg-btn').forEach((b) => {
  b.addEventListener('click', () => {
    if (state.phase === 'recording') return;
    state.mode = b.dataset.mode;
    saveSettings();
    renderAll();
    renderSettings();
  });
});

const sliders = [
  [els.volume, els.volumeVal, (v) => `${Math.round(v * 100)}%`],
  [els.rate, els.rateVal, (v) => `${v.toFixed(2)}×`],
  [els.fadeIn, els.fadeInVal, (v) => `${v.toFixed(2)}s`],
  [els.fadeOut, els.fadeOutVal, (v) => `${v.toFixed(2)}s`],
];
sliders.forEach(([input]) => input.addEventListener('input', () => {
  renderSettings();
  saveSettings();
  if (input === els.volume) audio.setVolume(Number(els.volume.value));
}));
els.maximize.addEventListener('change', saveSettings);

els.inputSelect.addEventListener('change', async () => {
  if (!state.ready) return;
  abortEverything();
  try {
    await audio.openMic(els.inputSelect.value || undefined);
    showInfo();
    saveSettings();
  } catch (err) { setStatus(micErrorText(err)); }
});
els.outputSelect.addEventListener('change', () => {
  audio.setOutputDevice(els.outputSelect.value).catch(() => setStatus('Could not switch output.'));
});

function renderSettings() {
  sliders.forEach(([input, out, fmt]) => { out.textContent = fmt(Number(input.value)); });
  document.querySelectorAll('#modeSeg .seg-btn').forEach((b) => {
    const on = b.dataset.mode === state.mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  els.modeNote.textContent = state.mode === 'hold'
    ? 'Hold to record, let go to hear it reversed. A quick tap replays or stops.'
    : 'Tap to start recording, tap again to hear it reversed. The ▶ button replays.';
}

async function populateDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, name) => {
      const keep = sel.value;
      sel.innerHTML = '<option value="">Default</option>';
      devices.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default')
        .forEach((d, i) => sel.add(new Option(d.label || `${name} ${i + 1}`, d.deviceId)));
      sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '';
    };
    fill(els.inputSelect, 'audioinput', 'Mic');
    // Output switching only works where AudioContext.setSinkId exists (Chrome).
    if (audio.ctx && typeof audio.ctx.setSinkId === 'function') {
      fill(els.outputSelect, 'audiooutput', 'Speaker');
      els.outputField.hidden = false;
    }
  } catch (_) { /* labels unavailable; defaults still work */ }
}

function showInfo() {
  const t = audio.micStream && audio.micStream.getAudioTracks()[0];
  const s = t && t.getSettings ? t.getSettings() : {};
  const pills = [`${audio.sampleRate / 1000} kHz`];
  if (s.autoGainControl === false) pills.push('AGC off');
  if (s.autoGainControl === true) pills.push('AGC on (browser ignored the request)');
  els.infoRow.innerHTML = '';
  pills.forEach((text) => {
    const span = document.createElement('span');
    span.className = 'info-pill';
    span.textContent = text;
    els.infoRow.append(span);
  });
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      mode: state.mode,
      volume: els.volume.value,
      maximize: els.maximize.checked,
      rate: els.rate.value,
      fadeIn: els.fadeIn.value,
      fadeOut: els.fadeOut.value,
    }));
  } catch (_) { /* storage unavailable; settings just won't persist */ }
}

function loadSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (_) { /* ignore */ }
  if (s) {
    if (s.mode === 'hold' || s.mode === 'tap') state.mode = s.mode;
    if (s.volume != null) els.volume.value = s.volume;
    if (s.maximize != null) els.maximize.checked = !!s.maximize;
    if (s.rate != null) els.rate.value = s.rate;
    if (s.fadeIn != null) els.fadeIn.value = s.fadeIn;
    if (s.fadeOut != null) els.fadeOut.value = s.fadeOut;
  }
  renderSettings();
}

/* ---------------- go ---------------- */

loadSettings();
renderAll();

// Console debugging.
window.thereAndBack = { audio, state };
