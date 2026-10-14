/**
 * AAC loudness from the bitstream (no audio decoder)
 * ==================================================
 * Workers have no audio decoder, but the server still needs to know whether
 * the reveal has sound, so it can alert while nobody has the admin open.
 * Frame sizes say nothing: Stream re-encodes live audio at a constant
 * ~128 kbps, so silence and speech both average ~341 bytes per frame.
 *
 * So this decodes the spectrum of each AAC-LC frame: section data, scale
 * factors and Huffman-coded coefficients for both channels, inverse
 * quantization (|q|^(4/3) * 2^((sf-100)/4)), then undoes mid/side and
 * intensity stereo to get true left and right. The MDCT preserves energy,
 * so summing squared coefficients gives each channel's level without the
 * filterbank, and weighting each line by the BS.1770 K-filter's response
 * gives loudness in LUFS with the standard 400 ms gating.
 *
 * Checked against FFmpeg's decoder (astats, ebur128) on noise, tones,
 * speech, mono, one-sided and mid/side stereo: tests/stream-probe.test.mjs.
 *
 * Containers: fragmented MP4 (what Stream's HLS serves) and MPEG-TS with
 * ADTS (in case live packaging ever differs). AAC-LC only; anything else
 * reports { supported: false } rather than guessing.
 */

import { SF_CODE, SF_BITS, SPECTRAL } from './_aac-tables.js';

// Scale factor band edges per sampling frequency index (long: 1024 lines, short: 128)
const L96 = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80, 88, 96, 108, 120, 132, 144, 156, 172, 188, 212, 240, 276, 320, 384, 448, 512, 576, 640, 704, 768, 832, 896, 960, 1024];
const L64 = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80, 88, 100, 112, 124, 140, 156, 172, 192, 216, 240, 268, 304, 344, 384, 424, 464, 504, 544, 584, 624, 664, 704, 744, 784, 824, 864, 904, 944, 984, 1024];
const L48 = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 88, 96, 108, 120, 132, 144, 160, 176, 196, 216, 240, 264, 292, 320, 352, 384, 416, 448, 480, 512, 544, 576, 608, 640, 672, 704, 736, 768, 800, 832, 864, 896, 928, 1024];
const L32 = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 88, 96, 108, 120, 132, 144, 160, 176, 196, 216, 240, 264, 292, 320, 352, 384, 416, 448, 480, 512, 544, 576, 608, 640, 672, 704, 736, 768, 800, 832, 864, 896, 928, 960, 992, 1024];
const L24 = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 52, 60, 68, 76, 84, 92, 100, 108, 116, 124, 136, 148, 160, 172, 188, 204, 220, 240, 260, 284, 308, 336, 364, 396, 432, 468, 508, 552, 600, 652, 704, 768, 832, 896, 960, 1024];
const L16 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 100, 112, 124, 136, 148, 160, 172, 184, 196, 212, 228, 244, 260, 280, 300, 320, 344, 368, 396, 424, 456, 492, 532, 572, 616, 664, 716, 772, 832, 896, 960, 1024];
const L8 = [0, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 132, 144, 156, 172, 188, 204, 220, 236, 252, 268, 288, 308, 328, 348, 372, 396, 420, 448, 476, 508, 544, 580, 620, 664, 712, 764, 820, 880, 944, 1024];
const S96 = [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 92, 128];
const S48 = [0, 4, 8, 12, 16, 20, 28, 36, 44, 56, 68, 80, 96, 112, 128];
const S24 = [0, 4, 8, 12, 16, 20, 24, 28, 36, 44, 52, 64, 76, 92, 108, 128];
const S16 = [0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 60, 72, 88, 108, 128];
const S8 = [0, 4, 8, 12, 16, 20, 24, 28, 36, 44, 52, 60, 72, 88, 108, 128];
const SWB_LONG = [L96, L96, L64, L48, L48, L32, L24, L24, L16, L16, L16, L8, L8];
const SWB_SHORT = [S96, S96, S96, S48, S48, S48, S24, S24, S16, S16, S16, S8, S8];
const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

const ZERO_HCB = 0, ESC_HCB = 11, NOISE_HCB = 13, INTENSITY_HCB2 = 14, INTENSITY_HCB = 15;
const EIGHT_SHORT = 2;

/**
 * Spectral codebook shapes (ISO/IEC 14496-3 Table 4.A.1 header): values per
 * codeword, whether values carry their own sign, and the base used to split
 * a symbol into values (symbol = Σ v_i * mod^(dim-1-i), offset by lav when signed).
 */
const CB_SHAPE = [null,
  { dim: 4, signed: true, mod: 3, lav: 1 }, { dim: 4, signed: true, mod: 3, lav: 1 },
  { dim: 4, signed: false, mod: 3, lav: 2 }, { dim: 4, signed: false, mod: 3, lav: 2 },
  { dim: 2, signed: true, mod: 9, lav: 4 }, { dim: 2, signed: true, mod: 9, lav: 4 },
  { dim: 2, signed: false, mod: 8, lav: 7 }, { dim: 2, signed: false, mod: 8, lav: 7 },
  { dim: 2, signed: false, mod: 13, lav: 12 }, { dim: 2, signed: false, mod: 13, lav: 12 },
  { dim: 2, signed: false, mod: 17, lav: 16 },
];

/** Maps decoder spectral energy onto dBFS RMS (calibrated against FFmpeg's decoder output). */
const CAL_DB = -153.5;
/** Below this a frame counts as silent: a live mic in a quiet room still sits around -60. */
export const SILENT_DB = -70;

function lookup(codes, bits) {
  const byLen = new Map();
  codes.forEach((code, i) => {
    if (!byLen.has(bits[i])) byLen.set(bits[i], new Map());
    byLen.get(bits[i]).set(code, i);
  });
  return byLen;
}
const SF_LOOKUP = lookup(SF_CODE, SF_BITS);
const SPECTRAL_LOOKUP = SPECTRAL.map((t) => (t ? lookup(t[0], t[1]) : null));
// |q|^(4/3): inverse quantization before the step size (escapes reach 8191, pulses add up to 15)
const POW43 = new Float64Array(8192 + 17);
for (let i = 0; i < POW43.length; i++) POW43[i] = Math.pow(i, 4 / 3);

class Bits {
  constructor(bytes) { this.b = bytes; this.pos = 0; this.end = bytes.length * 8; }
  read(n) {
    if (this.pos + n > this.end) throw new Error('read past end of frame');
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v * 2) + ((this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  skip(n) { this.pos += n; if (this.pos > this.end) throw new Error('skip past end of frame'); }
  align() { this.pos = (this.pos + 7) & ~7; }
  huff(table, maxLen = 19) {
    let code = 0;
    for (let len = 1; len <= maxLen; len++) {
      code = (code * 2) + this.read(1);
      const hit = table.get(len)?.get(code);
      if (hit !== undefined) return hit;
    }
    throw new Error('bad Huffman code');
  }
}

// ─── Codec config ───────────────────────────────────────────────────

/** AudioSpecificConfig bytes → { aot, sfIndex, sampleRate, channels } */
export function parseAudioSpecificConfig(bytes) {
  const r = new Bits(bytes);
  let aot = r.read(5);
  if (aot === 31) aot = 32 + r.read(6);
  let sfIndex = r.read(4);
  let sampleRate = SAMPLE_RATES[sfIndex] || null;
  if (sfIndex === 15) { sampleRate = r.read(24); sfIndex = SAMPLE_RATES.indexOf(sampleRate); }
  const channels = r.read(4);
  return { aot, sfIndex, sampleRate, channels };
}

function toBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new Error('expected bytes');
}

function boxes(buf, start, end) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
    let header = 8;
    if (size === 1 && p + 16 <= end) { size = Number(dv.getBigUint64(p + 8)); header = 16; }
    else if (size === 0) size = end - p;
    if (size < header || p + size > end) break;
    out.push({ type, start: p, body: p + header, end: p + size });
    p += size;
  }
  return out;
}

/** Descriptor length in esds: up to four 7-bit groups. */
function descLen(buf, p) {
  let len = 0, i = 0;
  while (i < 4) { const v = buf[p + i++]; len = (len << 7) | (v & 0x7f); if (!(v & 0x80)) break; }
  return { len, size: i };
}

/**
 * The audio track of an fMP4 init segment: its AudioSpecificConfig, parsed,
 * plus the track id (so muxed audio+video segments can be filtered). Null if
 * there is no AAC track.
 */
export function configFromInit(init) {
  const buf = toBytes(init);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const moov = boxes(buf, 0, buf.length).find((b) => b.type === 'moov');
  for (const trak of moov ? boxes(buf, moov.body, moov.end).filter((b) => b.type === 'trak') : []) {
    const inner = boxes(buf, trak.body, trak.end);
    const tkhd = inner.find((b) => b.type === 'tkhd');
    const mdia = inner.find((b) => b.type === 'mdia');
    const hdlr = mdia && boxes(buf, mdia.body, mdia.end).find((b) => b.type === 'hdlr');
    if (!tkhd || !hdlr || String.fromCharCode(...buf.subarray(hdlr.body + 8, hdlr.body + 12)) !== 'soun') continue;
    const trackId = dv.getUint32(tkhd.body + (buf[tkhd.body] === 1 ? 20 : 12));
    const config = esdsConfig(buf, trak.start, trak.end);
    if (config) return { ...config, trackId };
  }
  const config = esdsConfig(buf, 0, buf.length);
  return config ? { ...config, trackId: null } : null;
}

function esdsConfig(buf, start, end) {
  // esds sits at different depths in QuickTime v1/v2 sound entries, so find it by its fourcc
  for (let p = start + 4; p + 12 < end; p++) {
    if (buf[p] !== 0x65 || buf[p + 1] !== 0x73 || buf[p + 2] !== 0x64 || buf[p + 3] !== 0x73) continue; // 'esds'
    let q = p + 8; // fourcc + version/flags
    if (buf[q] !== 0x03) continue;
    let d = descLen(buf, q + 1); q += 1 + d.size;
    q += 2; // ES_ID
    const flags = buf[q++];
    if (flags & 0x80) q += 2;
    if (flags & 0x40) q += 1 + buf[q];
    if (flags & 0x20) q += 2;
    if (buf[q] !== 0x04) continue;
    d = descLen(buf, q + 1); q += 1 + d.size + 13;
    if (buf[q] !== 0x05) continue;
    d = descLen(buf, q + 1); q += 1 + d.size;
    return parseAudioSpecificConfig(buf.subarray(q, q + d.len));
  }
  return null;
}

// ─── Containers → raw AAC frames ────────────────────────────────────

/**
 * Raw AAC frames from a fragmented MP4 media segment (every moof/mdat pair,
 * so LL-HLS parts work too). With trackId, other tracks are skipped.
 */
export function framesFromFmp4(segment, trackId = null) {
  const buf = toBytes(segment);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const top = boxes(buf, 0, buf.length);
  const frames = [];
  for (let i = 0; i < top.length; i++) {
    const moof = top[i];
    if (moof.type !== 'moof') continue;
    const mdat = top.slice(i + 1).find((b) => b.type === 'mdat');
    for (const traf of boxes(buf, moof.body, moof.end).filter((b) => b.type === 'traf')) {
      const inner = boxes(buf, traf.body, traf.end);
      const tfhd = inner.find((b) => b.type === 'tfhd');
      let base = moof.start, defaultSize = 0;
      if (tfhd) {
        if (trackId != null && dv.getUint32(tfhd.body + 4) !== trackId) continue;
        const flags = dv.getUint32(tfhd.body) & 0xffffff;
        let p = tfhd.body + 8; // version/flags + track_ID
        if (flags & 0x1) { base = Number(dv.getBigUint64(p)); p += 8; }
        if (flags & 0x2) p += 4;
        if (flags & 0x8) p += 4;
        if (flags & 0x10) defaultSize = dv.getUint32(p);
      }
      let next = null;
      for (const trun of inner.filter((b) => b.type === 'trun')) {
        const flags = dv.getUint32(trun.body) & 0xffffff;
        const count = dv.getUint32(trun.body + 4);
        let p = trun.body + 8;
        let offset = next;
        if (flags & 0x1) { offset = base + dv.getInt32(p); p += 4; }
        if (offset == null) offset = mdat ? mdat.body : null;
        if (offset == null) break;
        if (flags & 0x4) p += 4;
        for (let s = 0; s < count; s++) {
          if (flags & 0x100) p += 4;
          let size = defaultSize;
          if (flags & 0x200) { size = dv.getUint32(p); p += 4; }
          if (flags & 0x400) p += 4;
          if (flags & 0x800) p += 4;
          if (size > 0 && offset + size <= buf.length) frames.push(buf.subarray(offset, offset + size));
          offset += size;
        }
        next = offset;
      }
    }
  }
  return frames;
}

/** Raw AAC frames + config from an ADTS byte stream. */
export function framesFromAdts(stream) {
  const buf = toBytes(stream);
  const frames = [];
  let config = null;
  let p = 0;
  while (p + 7 <= buf.length) {
    if (buf[p] !== 0xff || (buf[p + 1] & 0xf6) !== 0xf0) { p++; continue; }
    const header = (buf[p + 1] & 1) ? 7 : 9; // protection_absent
    const len = ((buf[p + 3] & 3) << 11) | (buf[p + 4] << 3) | (buf[p + 5] >> 5);
    if (len < header || p + len > buf.length) break;
    if (!config) {
      const sfIndex = (buf[p + 2] >> 2) & 0xf;
      config = { aot: (buf[p + 2] >> 6) + 1, sfIndex, sampleRate: SAMPLE_RATES[sfIndex] || null, channels: ((buf[p + 2] & 1) << 2) | (buf[p + 3] >> 6) };
    }
    frames.push(buf.subarray(p + header, p + len));
    p += len;
  }
  return { frames, config };
}

/** ADTS bytes out of an MPEG-TS segment (PAT → PMT → first AAC elementary stream), or null. */
export function adtsFromTs(segment) {
  const buf = toBytes(segment);
  let pmtPid = null, audioPid = null, total = 0;
  const chunks = [];
  for (let p = 0; p + 188 <= buf.length; p += 188) {
    if (buf[p] !== 0x47) return null;
    const pusi = (buf[p + 1] >> 6) & 1;
    const pid = ((buf[p + 1] & 0x1f) << 8) | buf[p + 2];
    const afc = (buf[p + 3] >> 4) & 3;
    let q = p + 4;
    if (afc & 2) q += 1 + buf[q];
    if (!(afc & 1) || q >= p + 188) continue;
    if (pid === 0 && pusi) {
      q += 1 + buf[q]; // pointer field
      const end = q + 3 + (((buf[q + 1] & 0xf) << 8) | buf[q + 2]) - 4;
      for (let e = q + 8; e + 4 <= end; e += 4) {
        if (((buf[e] << 8) | buf[e + 1]) !== 0) { pmtPid = ((buf[e + 2] & 0x1f) << 8) | buf[e + 3]; break; }
      }
    } else if (pid === pmtPid && pusi && audioPid == null) {
      q += 1 + buf[q];
      const end = q + 3 + (((buf[q + 1] & 0xf) << 8) | buf[q + 2]) - 4;
      for (let e = q + 12 + (((buf[q + 10] & 0xf) << 8) | buf[q + 11]); e + 5 <= end;) {
        if (buf[e] === 0x0f) { audioPid = ((buf[e + 1] & 0x1f) << 8) | buf[e + 2]; break; }
        e += 5 + (((buf[e + 3] & 0xf) << 8) | buf[e + 4]);
      }
    } else if (pid === audioPid) {
      if (pusi) q += 9 + buf[q + 8]; // PES header
      const part = buf.subarray(q, p + 188);
      chunks.push(part); total += part.length;
    }
  }
  if (audioPid == null) return null;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ─── raw_data_block → per-channel energy ────────────────────────────

function icsInfo(r) {
  r.read(1); // reserved
  const windowSequence = r.read(2);
  r.read(1); // window shape
  if (windowSequence === EIGHT_SHORT) {
    const maxSfb = r.read(4);
    const grouping = r.read(7);
    const groupLen = [1];
    for (let i = 6; i >= 0; i--) {
      if ((grouping >> i) & 1) groupLen[groupLen.length - 1]++;
      else groupLen.push(1);
    }
    return { short: true, maxSfb, groupLen };
  }
  const maxSfb = r.read(6);
  if (r.read(1)) throw new Error('predictor data (not AAC-LC)');
  return { short: false, maxSfb, groupLen: [1] };
}

/**
 * One individual_channel_stream, decoded to signed, dequantized spectral
 * values in coded order (band by band; a short-window group's windows one
 * after another inside each band). Zero, noise and intensity bands keep
 * their slots, so the two channels of a common-window pair line up.
 */
function decodeIcs(r, commonInfo, config) {
  const globalGain = r.read(8);
  const info = commonInfo || icsInfo(r);
  const swb = info.short ? SWB_SHORT[config.sfIndex] : SWB_LONG[config.sfIndex];
  if (!swb || info.maxSfb > swb.length - 1) throw new Error('band count out of range');
  const groups = info.groupLen.length;
  const bands = groups * info.maxSfb;

  // section_data: Huffman codebook for every band of every window group
  const sectBits = info.short ? 3 : 5;
  const esc = (1 << sectBits) - 1;
  const cbs = new Uint8Array(bands);
  for (let g = 0; g < groups; g++) {
    let k = 0;
    while (k < info.maxSfb) {
      const cb = r.read(4);
      if (cb === 12) throw new Error('reserved codebook');
      let len = 0, inc;
      while ((inc = r.read(sectBits)) === esc) len += esc;
      len += inc;
      if (k + len > info.maxSfb) throw new Error('section overruns bands');
      cbs.fill(cb, g * info.maxSfb + k, g * info.maxSfb + k + len);
      k += len;
    }
  }

  // scale_factor_data: quantizer step per band; noise (PNS) bands carry their energy, intensity bands a position
  let sf = globalGain, noise = globalGain - 90, isPos = 0, firstNoise = true;
  const step = new Float64Array(bands);   // 2^((sf-100)/4)
  const extra = new Float64Array(bands);  // noise: band energy; intensity: position
  for (let i = 0; i < bands; i++) {
    const cb = cbs[i];
    if (cb === ZERO_HCB) continue;
    if (cb === INTENSITY_HCB || cb === INTENSITY_HCB2) { isPos += r.huff(SF_LOOKUP) - 60; extra[i] = isPos; continue; }
    if (cb === NOISE_HCB) {
      if (firstNoise) { noise += r.read(9) - 256; firstNoise = false; } else noise += r.huff(SF_LOOKUP) - 60;
      extra[i] = info.groupLen[Math.floor(i / info.maxSfb)] * Math.pow(2, noise / 2);
      continue;
    }
    sf += r.huff(SF_LOOKUP) - 60;
    step[i] = Math.pow(2, (sf - 100) / 4);
  }

  // pulse_data (long windows only), tns_data (skipped), gain_control (not in LC)
  let pulses = null;
  if (r.read(1)) {
    if (info.short) throw new Error('pulse data in a short window');
    const n = r.read(2) + 1;
    let k = swb[r.read(6)];
    pulses = [];
    for (let i = 0; i < n; i++) { k += r.read(5); pulses.push([k, r.read(4)]); }
  }
  if (r.read(1)) {
    const windows = info.short ? 8 : 1;
    for (let w = 0; w < windows; w++) {
      const nFilt = r.read(info.short ? 1 : 2);
      if (!nFilt) continue;
      const coefRes = r.read(1);
      for (let f = 0; f < nFilt; f++) {
        r.read(info.short ? 4 : 6); // length
        const order = r.read(info.short ? 3 : 5);
        if (!order) continue;
        r.read(1); // direction
        const compress = r.read(1);
        r.skip(order * (coefRes + 3 - compress));
      }
    }
  }
  if (r.read(1)) throw new Error('gain control (not AAC-LC)');

  // spectral_data → signed quantized values
  const q = new Int32Array(1024);
  const off = new Int32Array(bands + 1);
  let pos = 0;
  for (let g = 0; g < groups; g++) {
    for (let b = 0; b < info.maxSfb; b++) {
      const i = g * info.maxSfb + b;
      off[i] = pos;
      const count = (swb[b + 1] - swb[b]) * info.groupLen[g];
      const cb = cbs[i];
      if (cb === ZERO_HCB || cb >= NOISE_HCB) { pos += count; continue; }
      const shape = CB_SHAPE[cb];
      const table = SPECTRAL_LOOKUP[cb];
      for (let k = 0; k < count; k += shape.dim) {
        let sym = r.huff(table, 16);
        for (let d = shape.dim - 1; d >= 0; d--) { q[pos + k + d] = sym % shape.mod; sym = Math.floor(sym / shape.mod); }
        for (let d = 0; d < shape.dim; d++) {
          if (shape.signed) q[pos + k + d] -= shape.lav;
          else if (q[pos + k + d] && r.read(1)) q[pos + k + d] = -q[pos + k + d];
        }
        if (cb === ESC_HCB) {
          for (let d = 0; d < 2; d++) {
            const v = q[pos + k + d];
            if (v !== 16 && v !== -16) continue;
            let n = 4;
            while (r.read(1)) { if (++n > 12) throw new Error('bad escape'); }
            const mag = (1 << n) + r.read(n);
            q[pos + k + d] = v < 0 ? -mag : mag;
          }
        }
      }
      pos += count;
    }
  }
  off[bands] = pos;
  if (pulses) for (const [k, amp] of pulses) if (k < 1024) q[k] += q[k] < 0 ? -amp : amp;

  // dequantize: sign(q) * |q|^(4/3) * step
  const coef = new Float64Array(pos);
  for (let i = 0; i < bands; i++) {
    const st = step[i];
    if (!st) continue;
    for (let k = off[i]; k < off[i + 1]; k++) {
      const v = q[k];
      if (v) coef[k] = (v < 0 ? -1 : 1) * (POW43[v < 0 ? -v : v] ?? Math.pow(Math.abs(v), 4 / 3)) * st;
    }
  }
  return { info, swb, cbs, extra, coef, off };
}

// ─── Loudness weighting (ITU-R BS.1770 K-weighting) ─────────────────

const kCache = new Map();
/**
 * |K(f)|² per MDCT line for a sample rate and transform size, from the two
 * BS.1770 biquads (high shelf + high pass) as libebur128 derives them for
 * any rate. Weighting each line's energy by this is K-weighting in the
 * frequency domain.
 */
function kWeights(fs, n) {
  const key = `${fs}:${n}`;
  if (kCache.has(key)) return kCache.get(key);
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = { b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0], a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const hp = { b: [1, -2, 1], a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
  const mag2 = ({ b, a }, w) => {
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = b[0] + b[1] * c1 + b[2] * c2, ni = -(b[1] * s1 + b[2] * s2);
    const dr = 1 + a[0] * c1 + a[1] * c2, di = -(a[0] * s1 + a[1] * s2);
    return (nr * nr + ni * ni) / (dr * dr + di * di);
  };
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const w = Math.PI * (k + 0.5) / n; // MDCT line k sits at (k + 0.5) * fs / (2n)
    out[k] = mag2(shelf, w) * mag2(hp, w);
  }
  kCache.set(key, out);
  return out;
}

/** Plain and K-weighted energy of coefficients [from, to) of one band (window-interleaved for short blocks). */
function bandSums(values, from, to, swbStart, width, kw) {
  let e = 0, w = 0;
  for (let k = from, t = 0; k < to; k++, t++) {
    const v = values[k];
    if (!v) continue;
    const v2 = v * v;
    e += v2;
    w += v2 * kw[swbStart + (t % width)];
  }
  return [e, w];
}

/**
 * Energy per channel of one frame: { e: [L, R?], w: [L, R?] } (w is
 * K-weighted). Mid/side and intensity stereo are undone, so a dead right
 * channel reads as dead. Throws on anything it can't parse.
 */
function frameEnergies(r, config) {
  for (;;) {
    const id = r.read(3);
    if (id === 0 || id === 3) { // SCE / LFE: mono
      r.read(4);
      const c = decodeIcs(r, null, config);
      const [e, w] = channelSums(c, config);
      return { e: [e], w: [w] };
    }
    if (id === 1) { // CPE
      r.read(4);
      let info = null, ms = null;
      if (r.read(1)) { // common_window
        info = icsInfo(r);
        const msPresent = r.read(2);
        const n = info.groupLen.length * info.maxSfb;
        if (msPresent === 1) { ms = new Uint8Array(n); for (let i = 0; i < n; i++) ms[i] = r.read(1); }
        else if (msPresent === 2) ms = new Uint8Array(n).fill(1);
      }
      const a = decodeIcs(r, info, config);
      const b = decodeIcs(r, info, config);
      return pairSums(a, b, ms, config);
    }
    if (id === 4) { // DSE
      r.read(4);
      const align = r.read(1);
      let count = r.read(8);
      if (count === 255) count += r.read(8);
      if (align) r.align();
      r.skip(count * 8);
      continue;
    }
    if (id === 6) { // FIL
      let count = r.read(4);
      if (count === 15) count += r.read(8) - 1;
      r.skip(count * 8);
      continue;
    }
    if (id === 7) return { e: [0], w: [0] }; // END with no channel element
    throw new Error(`unsupported syntax element ${id}`);
  }
}

function channelSums(c, config) {
  const { info, swb } = c;
  const kw = kWeights(config.sampleRate, info.short ? 128 : 1024);
  let e = 0, w = 0;
  for (let g = 0, i = 0; g < info.groupLen.length; g++) {
    for (let b = 0; b < info.maxSfb; b++, i++) {
      const width = swb[b + 1] - swb[b];
      if (c.cbs[i] === NOISE_HCB) { e += c.extra[i]; w += c.extra[i] * kw[swb[b] + (width >> 1)]; continue; }
      const [be, bw] = bandSums(c.coef, c.off[i], c.off[i + 1], swb[b], width, kw);
      e += be; w += bw;
    }
  }
  return [e, w];
}

function pairSums(a, b, ms, config) {
  // Without a common window the two channels are simply independent
  if (!ms && (a.info.short !== b.info.short || a.info.maxSfb !== b.info.maxSfb || a.info.groupLen.length !== b.info.groupLen.length)) {
    const [eL, wL] = channelSums(a, config);
    const [eR, wR] = channelSums(b, config);
    return { e: [eL, eR], w: [wL, wR] };
  }
  const { info, swb } = a;
  const kw = kWeights(config.sampleRate, info.short ? 128 : 1024);
  let eL = 0, wL = 0, eR = 0, wR = 0;
  for (let g = 0, i = 0; g < info.groupLen.length; g++) {
    for (let bnd = 0; bnd < info.maxSfb; bnd++, i++) {
      const width = swb[bnd + 1] - swb[bnd];
      const kMid = kw[swb[bnd] + (width >> 1)];
      const cbA = a.cbs[i], cbB = b.cbs[i];
      const [aE, aW] = cbA === NOISE_HCB ? [a.extra[i], a.extra[i] * kMid] : bandSums(a.coef, a.off[i], a.off[i + 1], swb[bnd], width, kw);
      if (cbB === INTENSITY_HCB || cbB === INTENSITY_HCB2) {
        // Right is the left band scaled by 2^(-pos/4)
        const s2 = Math.pow(2, -b.extra[i] / 2);
        eL += aE; wL += aW; eR += aE * s2; wR += aW * s2;
        continue;
      }
      if (ms && ms[i] && cbA !== NOISE_HCB && cbB !== NOISE_HCB) {
        // Mid/side: L = M + S, R = M - S
        for (let k = a.off[i], t = 0; k < a.off[i + 1]; k++, t++) {
          const m = a.coef[k], sd = b.coef[k];
          if (!m && !sd) continue;
          const l = m + sd, rr = m - sd, kk = kw[swb[bnd] + (t % width)];
          eL += l * l; wL += l * l * kk; eR += rr * rr; wR += rr * rr * kk;
        }
        continue;
      }
      const [bE, bW] = cbB === NOISE_HCB ? [b.extra[i], b.extra[i] * kMid] : bandSums(b.coef, b.off[i], b.off[i + 1], swb[bnd], width, kw);
      eL += aE; wL += aW; eR += bE; wR += bW;
    }
  }
  return { e: [eL, eR], w: [wL, wR] };
}

// ─── Summaries ──────────────────────────────────────────────────────

const toDb = (energy) => (energy > 0 ? 10 * Math.log10(energy) + CAL_DB : -Infinity);
const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

/** Level of one raw AAC-LC frame in dBFS RMS, loudest channel (-Infinity for digital silence). */
export function frameLevelDb(frame, config) {
  const { e } = frameEnergies(new Bits(toBytes(frame)), config);
  return toDb(Math.max(...e));
}

/**
 * BS.1770 gated loudness over a run of frames. Blocks are 400 ms with 75 %
 * overlap; absolute gate -70 LUFS, relative gate 10 LU under the ungated
 * mean. → { integrated, maxMomentary } in LUFS (-Infinity when all gated out).
 */
function gatedLoudness(weighted, frameSec) {
  const len = Math.max(1, Math.round(0.4 / frameSec));
  const hop = Math.max(1, Math.round(len / 4));
  const blocks = [];
  for (let s = 0; s + len <= weighted.length || (s === 0 && weighted.length); s += hop) {
    const end = Math.min(weighted.length, s + len);
    let sum = 0;
    for (let i = s; i < end; i++) sum += weighted[i];
    blocks.push(sum / (end - s));
    if (end === weighted.length) break;
  }
  const lufs = (p) => (p > 0 ? -0.691 + 10 * Math.log10(p) + CAL_DB : -Infinity);
  const loud = blocks.filter((p) => lufs(p) > -70);
  const maxMomentary = blocks.length ? Math.max(...blocks.map(lufs)) : -Infinity;
  if (!loud.length) return { integrated: -Infinity, maxMomentary };
  const gate = lufs(loud.reduce((a, p) => a + p, 0) / loud.length) - 10;
  const kept = loud.filter((p) => lufs(p) > gate);
  return { integrated: lufs(kept.reduce((a, p) => a + p, 0) / kept.length), maxMomentary };
}

/**
 * Loudness summary for one or more consecutive HLS audio segments.
 *   init      fMP4 init segment (omit for MPEG-TS / ADTS)
 *   segments  media segment bytes, oldest first
 * → { supported, frames, channels, levelDb, leftDb, rightDb, peakDb, lufs, lufsMax, silentPct, error }
 *   levelDb    RMS dBFS, averaged over channels and the whole window
 *   leftDb/rightDb  per channel (rightDb null for mono)
 *   peakDb     loudest single frame (≈ 21 ms RMS, not sample peak)
 *   lufs       integrated loudness over the window (BS.1770 gating)
 *   lufsMax    loudest 400 ms block
 *   silentPct  share of frames where every channel is below SILENT_DB
 */
export function analyzeSegments({ init = null, segments }) {
  let config = null;
  let frames = [];
  const initConfig = init ? configFromInit(init) : null;
  for (const segment of segments) {
    const seg = toBytes(segment);
    if (seg[0] === 0x47 && seg[188] === 0x47) {
      const adts = adtsFromTs(seg);
      if (adts) { const r = framesFromAdts(adts); config ||= r.config; frames = frames.concat(r.frames); }
    } else if (seg[0] === 0xff && (seg[1] & 0xf6) === 0xf0) {
      const r = framesFromAdts(seg); config ||= r.config; frames = frames.concat(r.frames);
    } else {
      config ||= initConfig;
      frames = frames.concat(framesFromFmp4(seg, initConfig?.trackId ?? null));
    }
  }
  if (!config) return { supported: false, frames: frames.length, error: 'no AAC config found' };
  if (config.aot !== 2) return { supported: false, frames: frames.length, error: `audio object type ${config.aot} (only AAC-LC is read)` };
  if (!config.sampleRate || config.sfIndex < 0) return { supported: false, frames: frames.length, error: 'unknown sample rate' };
  if (!frames.length) return { supported: true, frames: 0, levelDb: null, peakDb: null, lufs: null, silentPct: null, error: 'no audio frames' };

  const sums = [0, 0];
  const weighted = [];
  let channels = 1, peak = -Infinity, silent = 0, failed = 0;
  for (const f of frames) {
    let fe;
    try { fe = frameEnergies(new Bits(f), config); } catch { failed++; continue; }
    if (fe.e.length === 2) channels = 2;
    sums[0] += fe.e[0];
    sums[1] += fe.e[1] ?? fe.e[0];
    weighted.push(fe.w.reduce((a, x) => a + x, 0));
    const loudest = toDb(Math.max(...fe.e));
    if (loudest > peak) peak = loudest;
    if (loudest < SILENT_DB) silent++;
  }
  const parsed = weighted.length;
  if (!parsed) return { supported: true, frames: frames.length, failed, levelDb: null, peakDb: null, lufs: null, silentPct: null, error: 'could not read any frame' };
  const g = gatedLoudness(weighted, 1024 / config.sampleRate);
  return {
    supported: true,
    frames: parsed,
    failed,
    sampleRate: config.sampleRate,
    channels,
    levelDb: round1(toDb((sums[0] + sums[1]) / 2 / parsed)),
    leftDb: round1(toDb(sums[0] / parsed)),
    rightDb: channels === 2 ? round1(toDb(sums[1] / parsed)) : null,
    peakDb: round1(peak),
    lufs: round1(g.integrated),
    lufsMax: round1(g.maxMomentary),
    silentPct: Math.round((silent / parsed) * 100),
    error: null,
  };
}

/** One segment; see analyzeSegments. */
export function analyzeSegment({ init = null, segment }) {
  return analyzeSegments({ init, segments: [segment] });
}
