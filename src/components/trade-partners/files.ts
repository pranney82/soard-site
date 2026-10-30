/**
 * Getting a vendor's file ready to send (the trade-partner page):
 *   - an iPhone photo (HEIC) becomes a JPEG: Safari draws it itself, any other
 *     browser fetches libheif (src/utils/heic-to.js, 3 MB) the first time
 *   - every photo goes up as a JPEG at most 2400 px across, on white
 *   - a PDF goes as it is, with its first pages drawn as pictures by pdf.js
 *     (public/trade-partners/pdf/), because a W-9's signature and what's typed
 *     into a form's boxes aren't in a PDF's text
 * Files are read into memory first, so one that moves or changes after it's
 * picked fails here, in words, not halfway through sending.
 */

const MAX_SIDE = 2400;
export const MAX_BYTES = 15 * 1024 * 1024;
const PDF_BASE = '/trade-partners/pdf/';
const PAGE_SIDE = 2000;

/** An iPhone photo (HEIC), by its first bytes as well as its name */
export async function isHeic(f: File) {
  if (/^image\/hei[cf]/.test(f.type) || /\.hei[cf]$/i.test(f.name)) return true;
  const s = String.fromCharCode(...new Uint8Array(await f.slice(0, 12).arrayBuffer()));
  return s.slice(4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1|heif)$/.test(s.slice(8, 12));
}

export const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

/** A photo as a JPEG no bigger than the reader needs; one already small enough goes as it is unless `always`; null when this browser can't draw it */
export async function toJpeg(f: Blob, name: string, always = false): Promise<File | null> {
  const url = URL.createObjectURL(f);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth) return null;
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && !always && f.size < 4 * 1024 * 1024 && f instanceof File) return new File([await f.arrayBuffer()], f.name, { type: f.type });
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    // White under it: a JPEG has no see-through, and a transparent PNG would come out black
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.88));
    return blob ? new File([blob], `${name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`, { type: 'image/jpeg' }) : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** What goes up: a PDF as it is, a photo as a JPEG → File, or null for an iPhone photo nothing could open */
export async function prepare(f: File): Promise<File | null> {
  if (await isHeic(f)) {
    const own = await toJpeg(f, f.name, true);
    if (own) return own;
    try {
      const { heicTo } = await import('../../utils/heic-to.js');
      return toJpeg(await heicTo({ blob: f, type: 'image/jpeg', quality: 0.92 }), f.name, true);
    } catch {
      return null;
    }
  }
  if (!f.type.startsWith('image/')) return new File([await f.arrayBuffer()], f.name, { type: f.type });
  return (await toJpeg(f, f.name)) || new File([await f.arrayBuffer()], f.name, { type: f.type });
}

let pdfjs: Promise<any> | null = null;
const loadPdf = () => (pdfjs ||= import(/* @vite-ignore */ `${PDF_BASE}pdf.js`).then((m) => {
  m.GlobalWorkerOptions.workerSrc = `${PDF_BASE}pdf.worker.js`;
  return m;
}).catch((e) => { pdfjs = null; throw e; }));

/**
 * A PDF's first pages as JPEG pictures (print mode: form boxes drawn with what's typed in them).
 * side: the long side in pixels. [] when this browser can't draw it, and the server reads the PDF's text instead.
 */
export async function pagePictures(f: File, max: number, side = PAGE_SIDE): Promise<Blob[]> {
  try {
    const lib = await loadPdf();
    const task = lib.getDocument({ data: new Uint8Array(await f.arrayBuffer()), standardFontDataUrl: `${PDF_BASE}standard_fonts/`, wasmUrl: `${PDF_BASE}wasm/`, useWasm: false, enableXfa: false });
    const out: Blob[] = [];
    try {
      const doc = await task.promise;
      for (let n = 1; n <= Math.min(max, doc.numPages); n++) {
        const page = await doc.getPage(n);
        const one = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: side / Math.max(one.width, one.height) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvas, viewport, background: 'white', annotationMode: lib.AnnotationMode.ENABLE_STORAGE }).promise;
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
        if (blob) out.push(blob);
      }
    } finally {
      task.destroy();
    }
    return out;
  } catch {
    return [];
  }
}

/** A small picture of a file for its card: a photo itself, a PDF's first page; null when there's none */
export async function thumbnail(f: File): Promise<string | null> {
  if (f.type.startsWith('image/')) return URL.createObjectURL(f);
  if (!isPdf(f)) return null;
  const [p] = await pagePictures(f, 1, 360);
  return p ? URL.createObjectURL(p) : null;
}

export const sizeText = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
