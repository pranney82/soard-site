/**
 * Broadcast control room: loudness meter (AudioWorklet)
 * =====================================================
 * Sees every sample of the feed (an AnalyserNode only sees snapshots, so it
 * misses short peaks). Per channel, every 100 ms it posts:
 *   kms  mean square after BS.1770 K-weighting (for LUFS)
 *   ms   plain mean square (for the dBFS level bars)
 *   peak largest sample (dBFS sample peak)
 *   tp   largest 4x-oversampled value (BS.1770 true peak)
 * The main thread (control-room.js) turns blocks into momentary (400 ms),
 * short-term (3 s) and gated integrated loudness.
 *
 * K-weighting coefficients follow libebur128's derivation for any sample
 * rate. True peak uses a 48-tap windowed-sinc 4x interpolator.
 */

function kFilters(fs) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const hp = [1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  return [shelf, hp];
}

// 4x interpolator: 48 taps, Hann-windowed sinc, each phase normalized to unity gain
const PHASES = 4, TAPS = 12;
const FIR = (() => {
  const n = PHASES * TAPS, c = (n - 1) / 2;
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i - c) / PHASES;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    h[i] = sinc * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n));
  }
  const phases = [];
  for (let p = 0; p < PHASES; p++) {
    const taps = new Float64Array(TAPS);
    let sum = 0;
    for (let k = 0; k < TAPS; k++) { taps[k] = h[p + k * PHASES]; sum += taps[k]; }
    for (let k = 0; k < TAPS; k++) taps[k] /= sum;
    phases.push(taps);
  }
  return phases;
})();

class MeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blockLen = Math.round(sampleRate * 0.1);
    this.filters = kFilters(sampleRate);
    this.ch = [0, 1].map(() => ({ z: [[0, 0], [0, 0]], hist: new Float64Array(TAPS), pos: 0, kSum: 0, sum: 0, peak: 0, tp: 0 }));
    this.count = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const frames = input[0].length;
    for (let c = 0; c < 2; c++) {
      const x = input[c] || input[0];
      const s = this.ch[c];
      for (let i = 0; i < frames; i++) {
        const v = x[i];
        // K-weighting: two biquads, transposed direct form II
        let y = v;
        for (let f = 0; f < 2; f++) {
          const [b0, b1, b2, a1, a2] = this.filters[f];
          const z = s.z[f];
          const out = b0 * y + z[0];
          z[0] = b1 * y - a1 * out + z[1];
          z[1] = b2 * y - a2 * out;
          y = out;
        }
        s.kSum += y * y;
        s.sum += v * v;
        const a = v < 0 ? -v : v;
        if (a > s.peak) s.peak = a;
        // True peak: interpolate 4 points per sample from the last 12 samples
        s.hist[s.pos] = v;
        for (let p = 0; p < PHASES; p++) {
          const taps = FIR[p];
          let acc = 0;
          for (let k = 0, idx = s.pos; k < TAPS; k++) { acc += taps[k] * s.hist[idx]; idx = idx === 0 ? TAPS - 1 : idx - 1; }
          const m = acc < 0 ? -acc : acc;
          if (m > s.tp) s.tp = m;
        }
        s.pos = s.pos === TAPS - 1 ? 0 : s.pos + 1;
      }
    }
    this.count += frames;
    if (this.count >= this.blockLen) {
      const n = this.count;
      this.port.postMessage({
        n,
        kms: this.ch.map((s) => s.kSum / n),
        ms: this.ch.map((s) => s.sum / n),
        peak: this.ch.map((s) => s.peak),
        tp: this.ch.map((s) => s.tp),
      });
      for (const s of this.ch) { s.kSum = 0; s.sum = 0; s.peak = 0; s.tp = 0; }
      this.count = 0;
    }
    return true;
  }
}

registerProcessor('soard-meter', MeterProcessor);
