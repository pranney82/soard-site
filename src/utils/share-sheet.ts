/**
 * share-sheet.ts — opens ShareSheet.astro with what to share
 * ==========================================================
 * openShareSheet({ title, text, url, eyebrow, onShare }): the page's sheet
 * offers Text message (phones and Macs), Email, Facebook, Copy link, and on a
 * phone its own share menu too. onShare(how) is called for each way used, for
 * the page's counts. Returns false when the page has no sheet.
 */
interface ShareOpts {
  /** The sheet's heading: "Share Dylan's reveal" */
  title: string;
  /** What the message says before the link: "Watch Dylan's room reveal live" */
  text: string;
  url: string;
  eyebrow?: string;
  /** A line under the heading */
  lead?: string;
  onShare?: (how: string) => void;
}

const enc = encodeURIComponent;
// A text can be sent from a phone, a tablet or a Mac (Messages); not from a Windows or Linux browser
const canText = () => /iPhone|iPad|iPod|Android|Macintosh/i.test(navigator.userAgent);
const touch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

let wired: HTMLDialogElement | null = null;
let current: ShareOpts | null = null;

function wire(dialog: HTMLDialogElement) {
  if (wired === dialog) return;
  wired = dialog;
  const note = dialog.querySelector<HTMLElement>('[data-shs="note"]');
  const copyLabel = dialog.querySelector<HTMLElement>('[data-shs="copy-label"]');
  dialog.addEventListener('click', async (e) => {
    if (e.target === dialog) { dialog.close(); return; }
    const opt = (e.target as HTMLElement).closest<HTMLElement>('[data-how]');
    if (!opt || !current) return;
    const how = opt.dataset.how || '';
    if (how === 'copy') {
      try {
        await navigator.clipboard.writeText(current.url);
        if (copyLabel) copyLabel.textContent = 'Link copied';
        if (note) note.textContent = 'Copied. Paste it anywhere.';
        setTimeout(() => { if (copyLabel) copyLabel.textContent = 'Copy link'; }, 2500);
      } catch {
        if (note) note.textContent = 'Copy the link above.';
      }
    } else if (how === 'more') {
      try { await navigator.share({ title: current.text, text: current.text, url: current.url }); } catch { return; }
    }
    current.onShare?.(how);
  });
  dialog.addEventListener('close', () => { if (note) note.textContent = ''; if (copyLabel) copyLabel.textContent = 'Copy link'; });
}

export function openShareSheet(opts: ShareOpts): boolean {
  const dialog = document.querySelector<HTMLDialogElement>('[data-share-sheet]');
  if (!dialog || typeof dialog.showModal !== 'function') return false;
  wire(dialog);
  current = opts;
  const q = <T extends Element>(k: string) => dialog.querySelector<T>(`[data-shs="${k}"]`);
  const set = (k: string, v: string) => { const el = q<HTMLElement>(k); if (el) el.textContent = v; };
  set('eyebrow', opts.eyebrow || 'Invite someone to watch');
  set('title', opts.title);
  set('text', opts.lead || '');
  set('link', opts.url.replace(/^https?:\/\//, ''));
  const message = `${opts.text}: ${opts.url}`;
  const link = (how: string, href: string, show = true) => {
    const a = dialog.querySelector<HTMLAnchorElement>(`[data-how="${how}"]`);
    if (!a) return;
    a.href = href;
    a.hidden = !show;
  };
  // (sms:&body= is the form both iPhone and Android read)
  link('text', `sms:&body=${enc(message)}`, canText());
  link('email', `mailto:?subject=${enc(opts.text)}&body=${enc(`${opts.text}.\n\n${opts.url}`)}`);
  link('facebook', `https://www.facebook.com/sharer/sharer.php?u=${enc(opts.url)}`);
  const more = dialog.querySelector<HTMLElement>('[data-how="more"]');
  if (more) more.hidden = !(typeof navigator.share === 'function' && touch());
  dialog.showModal();
  return true;
}
