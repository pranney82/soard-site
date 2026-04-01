/**
 * GET /api/download-branding-photos
 *
 * Streams a ZIP of all branding photos currently selected in the admin panel.
 * Reads brandingPhotos from D1 (source of truth), fetches full-res images from
 * CF Images, bundles them with a credits.txt, and returns a streaming ZIP.
 *
 * GET /api/download-branding-photos?photo=0
 *
 * Downloads a single branding photo by index with a clean filename.
 *
 * No auth required — this is a public endpoint linked from the branding page.
 * Images are already compressed (JPEG), so ZIP uses STORE (no deflation).
 *
 * Env bindings: DB (D1)
 */

const CF_IMAGES_HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';

// ─── CRC32 ───────────────────────────────────────────────
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ─── ZIP helpers (STORE, no compression) ─────────────────
function toBytes2(n) { return new Uint8Array([n & 0xFF, (n >> 8) & 0xFF]); }

function dosDateTime() {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: toBytes2(time), date: toBytes2(date) };
}

function localFileHeader(filename, crc, size) {
  const { time, date } = dosDateTime();
  const nameBytes = new TextEncoder().encode(filename);
  const header = new Uint8Array(30 + nameBytes.length);
  const v = new DataView(header.buffer);
  v.setUint32(0, 0x04034B50, true);   // signature
  v.setUint16(4, 20, true);           // version needed
  v.setUint16(6, 0, true);            // flags
  v.setUint16(8, 0, true);            // compression: STORE
  header.set(time, 10);
  header.set(date, 12);
  v.setUint32(14, crc, true);
  v.setUint32(18, size, true);        // compressed
  v.setUint32(22, size, true);        // uncompressed
  v.setUint16(26, nameBytes.length, true);
  v.setUint16(28, 0, true);           // extra field length
  header.set(nameBytes, 30);
  return header;
}

function centralDirEntry(filename, crc, size, offset) {
  const { time, date } = dosDateTime();
  const nameBytes = new TextEncoder().encode(filename);
  const entry = new Uint8Array(46 + nameBytes.length);
  const v = new DataView(entry.buffer);
  v.setUint32(0, 0x02014B50, true);   // signature
  v.setUint16(4, 20, true);           // version made by
  v.setUint16(6, 20, true);           // version needed
  v.setUint16(8, 0, true);            // flags
  v.setUint16(10, 0, true);           // compression: STORE
  entry.set(time, 12);
  entry.set(date, 14);
  v.setUint32(16, crc, true);
  v.setUint32(20, size, true);        // compressed
  v.setUint32(24, size, true);        // uncompressed
  v.setUint16(28, nameBytes.length, true);
  v.setUint16(30, 0, true);           // extra field length
  v.setUint16(32, 0, true);           // file comment length
  v.setUint16(34, 0, true);           // disk number
  v.setUint16(36, 0, true);           // internal file attributes
  v.setUint32(38, 0, true);           // external file attributes
  v.setUint32(42, offset, true);      // local header offset
  entry.set(nameBytes, 46);
  return entry;
}

function endOfCentralDir(cdSize, cdOffset, count) {
  const eocd = new Uint8Array(22);
  const v = new DataView(eocd.buffer);
  v.setUint32(0, 0x06054B50, true);   // signature
  v.setUint16(4, 0, true);            // disk number
  v.setUint16(6, 0, true);            // central dir start disk
  v.setUint16(8, count, true);        // entries on this disk
  v.setUint16(10, count, true);       // total entries
  v.setUint32(12, cdSize, true);
  v.setUint32(16, cdOffset, true);
  v.setUint16(20, 0, true);           // comment length
  return eocd;
}

// ─── Helpers ─────────────────────────────────────────────

/** Clean a kid name + metadata into a filename-safe string */
function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9\-_ ]/g, '').replace(/\s+/g, '-').slice(0, 80);
}

/** Extract bare CF Images ID from a full URL or bare ID */
function extractCfId(url) {
  if (!url) return '';
  if (!url.startsWith('http')) return url;
  if (!url.includes('imagedelivery.net')) return url;
  let id = url.replace(`https://imagedelivery.net/${CF_IMAGES_HASH}/`, '');
  const lastSlash = id.lastIndexOf('/');
  if (lastSlash > 0) {
    const suffix = id.slice(lastSlash + 1);
    if (['public', 'nav', 'footer', 'og'].includes(suffix) || suffix.includes('=')) {
      id = id.slice(0, lastSlash);
    }
  }
  return id;
}

/** Build a clean filename: SOARD-KidName-RoomType-Year.jpg */
function buildFilename(kid, index) {
  const parts = ['SOARD'];
  if (kid?.name) parts.push(sanitizeFilename(kid.name));
  if (kid?.roomTypes?.length) parts.push(sanitizeFilename(kid.roomTypes[0]));
  if (kid?.year) parts.push(String(kid.year));
  if (parts.length === 1) parts.push(`Photo-${index + 1}`);
  return parts.join('-') + '.jpg';
}

/** Build credits.txt content */
function buildCredits(photos, kids) {
  const lines = [
    'SUNSHINE ON A RANNEY DAY',
    'Press Photo Credits & Usage Rights',
    '═'.repeat(48),
    '',
    'These photos are provided for press, media, and editorial use in connection',
    'with coverage of Sunshine on a Ranney Day. Commercial use requires written',
    'permission. Please credit the photographer when specified.',
    '',
    'Contact: info@sunshineonaranneyday.com',
    'Website: sunshineonaranneyday.com',
    '',
    '─'.repeat(48),
    '',
  ];

  for (let i = 0; i < photos.length; i++) {
    const bp = photos[i];
    const kid = kids[i];
    const filename = buildFilename(kid, i);
    lines.push(`${filename}`);
    if (kid?.name) lines.push(`  Child: ${kid.name}`);
    if (kid?.diagnosis) lines.push(`  Diagnosis: ${kid.diagnosis}`);
    if (kid?.roomTypes?.length) lines.push(`  Room: ${kid.roomTypes.join(', ')}`);
    if (kid?.year) lines.push(`  Year: ${kid.year}`);
    if (kid?.photographer) lines.push(`  Photographer: ${kid.photographer}`);
    if (bp.caption) lines.push(`  Caption: ${bp.caption}`);
    lines.push('');
  }

  lines.push('─'.repeat(48));
  lines.push('');
  lines.push('Sunshine on a Ranney Day is a 501(c)(3) nonprofit (EIN 45-4773997)');
  lines.push('that renovates homes for children with special needs at no cost to families.');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString().slice(0, 10)}`);

  return new TextEncoder().encode(lines.join('\n'));
}

// ─── Main handler ────────────────────────────────────────

export async function onRequestGet(context) {
  const { DB } = context.env;
  const url = new URL(context.request.url);

  // 1. Read brandingPhotos from D1
  const row = await DB.prepare("SELECT data FROM site_config WHERE key = 'media'").first();
  if (!row) return new Response('Not configured', { status: 404 });

  const media = JSON.parse(row.data);
  const brandingPhotos = media.brandingPhotos || [];
  if (!brandingPhotos.length) return new Response('No branding photos configured', { status: 404 });

  // 2. Look up kid data for filenames, credits
  const kidSlugs = [...new Set(brandingPhotos.map(bp => bp.kidSlug).filter(Boolean))];
  const kidMap = {};
  if (kidSlugs.length) {
    const placeholders = kidSlugs.map(() => '?').join(',');
    const kidRows = await DB.prepare(`SELECT slug, data FROM kids WHERE slug IN (${placeholders})`)
      .bind(...kidSlugs).all();
    for (const r of (kidRows.results || [])) {
      try { kidMap[r.slug] = JSON.parse(r.data); } catch {}
    }
  }

  const kids = brandingPhotos.map(bp => kidMap[bp.kidSlug] || null);

  // ─── Single photo download ───
  const photoIndex = url.searchParams.get('photo');
  if (photoIndex !== null) {
    const idx = parseInt(photoIndex, 10);
    if (isNaN(idx) || idx < 0 || idx >= brandingPhotos.length) {
      return new Response('Photo not found', { status: 404 });
    }
    const bp = brandingPhotos[idx];
    const cfId = extractCfId(bp.cfId);
    if (!cfId) return new Response('Photo not found', { status: 404 });

    const imageUrl = `https://imagedelivery.net/${CF_IMAGES_HASH}/${cfId}/w=2400,q=95,fit=scale-down`;
    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) return new Response('Image not found', { status: 404 });

    const filename = buildFilename(kids[idx], idx);
    return new Response(imageRes.body, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  // ─── ZIP download (all photos) ───

  // 3. Fetch all images in parallel
  const imagePromises = brandingPhotos.map(async (bp, i) => {
    const cfId = extractCfId(bp.cfId);
    if (!cfId) return null;
    const imageUrl = `https://imagedelivery.net/${CF_IMAGES_HASH}/${cfId}/w=2400,q=95,fit=scale-down`;
    try {
      const res = await fetch(imageUrl);
      if (!res.ok) return null;
      return {
        filename: buildFilename(kids[i], i),
        data: new Uint8Array(await res.arrayBuffer()),
      };
    } catch {
      return null;
    }
  });

  const images = (await Promise.all(imagePromises)).filter(Boolean);
  if (!images.length) return new Response('No images available', { status: 404 });

  // 4. Deduplicate filenames (same kid picked twice → append -2, -3, etc.)
  const usedNames = new Set();
  for (const img of images) {
    let name = img.filename;
    if (usedNames.has(name)) {
      const base = name.replace(/\.jpg$/, '');
      let n = 2;
      while (usedNames.has(`${base}-${n}.jpg`)) n++;
      name = `${base}-${n}.jpg`;
      img.filename = name;
    }
    usedNames.add(name);
  }

  // 5. Build credits.txt
  const creditsData = buildCredits(brandingPhotos, kids);
  const allFiles = [
    ...images,
    { filename: 'credits.txt', data: creditsData },
  ];

  // 6. Build ZIP in memory (images are already compressed, total ~20-40MB max for 8 photos)
  const cdEntries = [];

  // Calculate total size for pre-allocation
  let totalSize = 0;
  for (const file of allFiles) {
    const nameLen = new TextEncoder().encode(file.filename).length;
    totalSize += 30 + nameLen + file.data.length; // local header + data
    totalSize += 46 + nameLen; // central dir entry
  }
  totalSize += 22; // EOCD

  const zipBuffer = new Uint8Array(totalSize);
  let pos = 0;

  for (const file of allFiles) {
    const fileCrc = crc32(file.data);
    const header = localFileHeader(file.filename, fileCrc, file.data.length);

    zipBuffer.set(header, pos);
    const localOffset = pos;
    pos += header.length;

    zipBuffer.set(file.data, pos);
    pos += file.data.length;

    cdEntries.push({ filename: file.filename, crc: fileCrc, size: file.data.length, offset: localOffset });
  }

  const cdStart = pos;
  for (const entry of cdEntries) {
    const cd = centralDirEntry(entry.filename, entry.crc, entry.size, entry.offset);
    zipBuffer.set(cd, pos);
    pos += cd.length;
  }
  const cdSize = pos - cdStart;

  const eocd = endOfCentralDir(cdSize, cdStart, cdEntries.length);
  zipBuffer.set(eocd, pos);
  pos += eocd.length;

  // Log download (non-blocking)
  try {
    const { logAudit } = await import('./_audit.js');
    const userIp = context.request.headers.get('CF-Connecting-IP') || 'unknown';
    context.waitUntil(logAudit(DB, {
      userEmail: `public:${userIp}`,
      action: 'download',
      entityType: 'branding-photos',
      entitySlug: 'zip',
      entityName: `${images.length} photos`,
      changes: null,
      path: '/api/download-branding-photos',
      gitStatus: null,
    }));
  } catch {}

  return new Response(zipBuffer.slice(0, pos), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="SOARD-Press-Photos.zip"',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
