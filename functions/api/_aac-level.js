/**
 * AAC loudness from the bitstream (no audio decoder)
 * ==================================================
 * Workers have no audio decoder, but the server still needs to know whether
 * the reveal has sound, so it can alert someone while nobody has the admin
 * open. Frame sizes say nothing: Stream re-encodes live audio at a constant
 * ~128 kbps, so silence and speech both average ~341 bytes per frame.
 *
 * So this decodes just enough of each AAC-LC frame: the first channel's
 * section data, scale factors and Huffman-coded spectral coefficients, then
 * inverse-quantizes them (|q|^(4/3) * 2^((sf-100)/4)) and sums the energy.
 * The MDCT is energy-preserving, so that is the frame's loudness without
 * running the filterbank. Checked against FFmpeg's decoder on noise, tones
 * and speech from -80 to -10 dBFS (tests/stream-probe.test.mjs).
 *
 * Channel pairs report the first coded channel, which is the mid (L+R)/2
 * signal when M/S stereo is on: exact for a mono mic, close for stereo.
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
// |q|^(8/3): the energy of one dequantized coefficient before the step size
const POW83 = new Float64Array(8192 + 17);
for (let i = 0; i < POW83.length; i++) POW83[i] = Math.pow(i, 8 / 3);

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

// ─── raw_data_block → first-channel energy ──────────────────────────

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

/** Energy of the first coded channel in one frame (0 for digital silence). Throws on anything it can't parse. */
function frameEnergy(r, config) {
  for (;;) {
    const id = r.read(3);
    if (id === 0 || id === 3) { r.read(4); return icsEnergy(r, null, config); } // SCE / LFE
    if (id === 1) { // CPE
      r.read(4);
      let info = null;
      if (r.read(1)) { // common_window
        info = icsInfo(r);
        if (r.read(2) === 1) r.skip(info.groupLen.length * info.maxSfb); // ms_used flags
      }
      return icsEnergy(r, info, config);
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
    if (id === 7) return 0; // END with no channel element
    throw new Error(`unsupported syntax element ${id}`);
  }
}

function icsEnergy(r, commonInfo, config) {
  const globalGain = r.read(8);
  const info = commonInfo || icsInfo(r);
  const swb = info.short ? SWB_SHORT[config.sfIndex] : SWB_LONG[config.sfIndex];
  if (!swb || info.maxSfb > swb.length - 1) throw new Error('band count out of range');
  const groups = info.groupLen.length;

  // section_data: Huffman codebook for every band of every window group
  const sectBits = info.short ? 3 : 5;
  const esc = (1 << sectBits) - 1;
  const cbs = [];
  for (let g = 0; g < groups; g++) {
    const row = new Uint8Array(info.maxSfb);
    let k = 0;
    while (k < info.maxSfb) {
      const cb = r.read(4);
      if (cb === 12) throw new Error('reserved codebook');
      let len = 0, inc;
      while ((inc = r.read(sectBits)) === esc) len += esc;
      len += inc;
      if (k + len > info.maxSfb) throw new Error('section overruns bands');
      row.fill(cb, k, k + len);
      k += len;
    }
    cbs.push(row);
  }

  // scale_factor_data: quantizer step per band; noise (PNS) bands carry their energy directly
  let sf = globalGain, noise = globalGain - 90, firstNoise = true;
  let energy = 0;
  const steps = [];
  for (let g = 0; g < groups; g++) {
    const row = new Float64Array(info.maxSfb);
    for (let b = 0; b < info.maxSfb; b++) {
      const cb = cbs[g][b];
      if (cb === ZERO_HCB) continue;
      if (cb === INTENSITY_HCB || cb === INTENSITY_HCB2) { r.huff(SF_LOOKUP); continue; }
      if (cb === NOISE_HCB) {
        if (firstNoise) { noise += r.read(9) - 256; firstNoise = false; } else noise += r.huff(SF_LOOKUP) - 60;
        energy += info.groupLen[g] * Math.pow(2, noise / 2);
        continue;
      }
      sf += r.huff(SF_LOOKUP) - 60;
      row[b] = Math.pow(2, (sf - 100) / 2); // step²
    }
    steps.push(row);
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

  // spectral_data: |q| per coefficient, band by band (short windows: the group's windows interleaved)
  const q = pulses ? new Int32Array(1024) : null;
  for (let g = 0; g < groups; g++) {
    for (let b = 0; b < info.maxSfb; b++) {
      const cb = cbs[g][b];
      if (cb === ZERO_HCB || cb >= NOISE_HCB) continue;
      const shape = CB_SHAPE[cb];
      const table = SPECTRAL_LOOKUP[cb];
      const count = (swb[b + 1] - swb[b]) * info.groupLen[g];
      let bandSum = 0, pos = swb[b];
      for (let k = 0; k < count; k += shape.dim) {
        let sym = r.huff(table, 16);
        const vals = new Array(shape.dim);
        for (let d = shape.dim - 1; d >= 0; d--) { vals[d] = sym % shape.mod; sym = Math.floor(sym / shape.mod); }
        for (let d = 0; d < shape.dim; d++) {
          let v = shape.signed ? Math.abs(vals[d] - shape.lav) : vals[d];
          if (!shape.signed && v) r.read(1); // sign bit
          vals[d] = v;
        }
        if (cb === ESC_HCB) {
          for (let d = 0; d < 2; d++) {
            if (vals[d] !== 16) continue;
            let n = 4;
            while (r.read(1)) { if (++n > 12) throw new Error('bad escape'); }
            vals[d] = (1 << n) + r.read(n);
          }
        }
        for (let d = 0; d < shape.dim; d++) {
          if (q) q[pos++] = vals[d];
          else bandSum += POW83[vals[d]] ?? Math.pow(vals[d], 8 / 3);
        }
      }
      if (!q) energy += bandSum * steps[g][b];
    }
  }
  if (q) {
    for (const [k, amp] of pulses) if (k < 1024) q[k] += amp;
    for (let b = 0; b < info.maxSfb; b++) {
      if (!steps[0][b]) continue;
      let bandSum = 0;
      for (let k = swb[b]; k < swb[b + 1]; k++) bandSum += POW83[q[k]] ?? Math.pow(q[k], 8 / 3);
      energy += bandSum * steps[0][b];
    }
  }
  return energy;
}

function toDb(energy) {
  return energy > 0 ? 10 * Math.log10(energy) + CAL_DB : -Infinity;
}

/** Level of one raw AAC-LC frame in dBFS (-Infinity for digital silence). */
export function frameLevelDb(frame, config) {
  return toDb(frameEnergy(new Bits(toBytes(frame)), config));
}

/**
 * Loudness summary for one HLS audio segment.
 *   init     fMP4 init segment (omit for MPEG-TS / ADTS)
 *   segment  media segment bytes
 * → { supported, frames, levelDb, peakDb, silentPct, error }
 *   levelDb   energy average over the segment (≈ RMS dBFS)
 *   peakDb    loudest frame (≈ 21 ms RMS, not sample peak)
 *   silentPct share of frames below SILENT_DB
 */
export function analyzeSegment({ init = null, segment }) {
  const seg = toBytes(segment);
  let config = null;
  let frames = [];
  if (seg[0] === 0x47 && seg[188] === 0x47) {
    const adts = adtsFromTs(seg);
    if (adts) ({ frames, config } = framesFromAdts(adts));
  } else if (seg[0] === 0xff && (seg[1] & 0xf6) === 0xf0) {
    ({ frames, config } = framesFromAdts(seg));
  } else {
    config = init ? configFromInit(init) : null;
    frames = framesFromFmp4(seg, config?.trackId ?? null);
  }
  if (!config) return { supported: false, frames: frames.length, error: 'no AAC config found' };
  if (config.aot !== 2) return { supported: false, frames: frames.length, error: `audio object type ${config.aot} (only AAC-LC is read)` };
  if (!frames.length) return { supported: true, frames: 0, levelDb: null, peakDb: null, silentPct: null, error: 'no audio frames' };

  let sum = 0, peak = -Infinity, silent = 0, parsed = 0, failed = 0;
  for (const f of frames) {
    let e;
    try { e = frameEnergy(new Bits(f), config); } catch { failed++; continue; }
    parsed++;
    sum += e;
    const db = toDb(e);
    if (db > peak) peak = db;
    if (db < SILENT_DB) silent++;
  }
  if (!parsed) return { supported: true, frames: frames.length, failed, levelDb: null, peakDb: null, silentPct: null, error: 'could not read any frame' };
  return {
    supported: true,
    frames: parsed,
    failed,
    sampleRate: config.sampleRate,
    channels: config.channels,
    energy: sum / parsed,
    levelDb: round1(toDb(sum / parsed)),
    peakDb: round1(peak),
    silentPct: Math.round((silent / parsed) * 100),
    silentFrames: silent,
    error: null,
  };
}

const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

/** Combine analyzeSegment() results from consecutive segments into one reading. */
export function mergeLevels(results) {
  const ok = results.filter((r) => r?.supported && r.frames > 0 && r.energy != null);
  if (!ok.length) return results.find((r) => r) || { supported: false, frames: 0, error: 'nothing analyzed' };
  const frames = ok.reduce((n, r) => n + r.frames, 0);
  const energy = ok.reduce((s, r) => s + r.energy * r.frames, 0) / frames;
  const silent = ok.reduce((n, r) => n + r.silentFrames, 0);
  const peaks = ok.map((r) => r.peakDb).filter((x) => x != null);
  return {
    supported: true,
    frames,
    failed: ok.reduce((n, r) => n + (r.failed || 0), 0),
    sampleRate: ok[0].sampleRate,
    channels: ok[0].channels,
    energy,
    levelDb: round1(toDb(energy)),
    peakDb: peaks.length ? Math.max(...peaks) : null,
    silentPct: Math.round((silent / frames) * 100),
    silentFrames: silent,
    error: null,
  };
}
