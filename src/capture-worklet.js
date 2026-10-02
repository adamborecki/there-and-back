// Streams raw mic samples to the main thread in ~43 ms batches (2048 frames
// at 48 kHz). Recording raw PCM instead of using MediaRecorder means there is
// nothing to encode or decode when the button is released: the take is
// already a Float32Array, ready to reverse and play.
//
// Messages out: Float32Array batches, plus { flushed: Float32Array } in reply
// to a 'flush' message (the partial batch, so a take's tail isn't lost).
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(2048);
    this.fill = 0;
    this.port.onmessage = (e) => {
      if (e.data !== 'flush') return;
      const rest = this.batch.slice(0, this.fill);
      this.fill = 0;
      this.port.postMessage({ flushed: rest }, [rest.buffer]);
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const n = Math.min(ch.length - i, this.batch.length - this.fill);
        this.batch.set(ch.subarray(i, i + n), this.fill);
        this.fill += n;
        i += n;
        if (this.fill === this.batch.length) {
          this.port.postMessage(this.batch, [this.batch.buffer]);
          this.batch = new Float32Array(2048);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
