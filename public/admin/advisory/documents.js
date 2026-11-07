/**
 * The advisors' Documents: everything about SOARD they might be asked for, in one place, the way the board page has it.
 *
 * What to sign, SOARD's facts (the board's own card, ../board/facts.js), logos and photos, the shelves staff fill from
 * Documents in Run it or the admin, and SOARD's public filings. A paper opens on its own page, a file in the viewer and a
 * link in a new tab. Only what's allow-listed reaches this page (../../../functions/api/_advisory-portal.js): a board
 * paper is here only when staff turned it on.
 *
 * The photos are here and not on Fundraise: a child's picture never sits beside the dollars.
 */

import { h, htm } from '../vendor.js';
import { viewerLink, sizeText } from '../file-viewer.js';
import { formatOf, shortDate } from '../board-shared.js';
import { Icon, SecHead, More, useKept, sized } from '../board/parts.js';
import { FileBadge, Cover } from '../board/covers.js';
import { OrgFacts, FORM_PAPERS, factsOf, factHay } from '../board/facts.js';
import { prep, termsOf, planOf, matches } from '../board/find.js';

const html = htm.bind(h);
const rise = (i) => `--i:${i}`;
const fileUrl = (f) => `/api/advisory-file?id=${encodeURIComponent(f.id)}`;
const withUrl = (f) => ({ ...f, url: fileUrl(f) });
const viewer = (f, name) => ({ name: name || f.name, filename: f.name, type: f.type, size: f.size, at: f.at, url: fileUrl(f) });
const nameOf = (f) => String(f.name || '').replace(/\.[a-z0-9]{2,5}$/i, '');

/** The board's own finding: "w9" finds W-9, and "soard's" finds SOARD's */
const match = (text, terms) => !terms.length || matches(prep(text), planOf(terms));

/** A staff item: each file gets its own row, and a link beside a file gets one too */
function libraryRows(d, file) {
  const files = d.files.map((f, i) => ({ ...file(i ? `${d.id}-${i}` : d.id, d.shelf, i ? nameOf(f) : d.title, i ? '' : d.note, f), words: `${d.title} ${d.note}` }));
  return d.url ? [...files, { key: `${d.id}-link`, shelf: d.shelf, title: d.title, note: files.length ? 'The link' : d.note, url: d.url, words: `${d.title} ${d.note}` }] : files;
}

/** Every row on the shelves: a paper, a file or a link, each saying how it opens */
function rowsOf(data) {
  const signed = (d) => (d.kind === 'agreement' && d.signedByMe?.at ? `Signed ${shortDate(String(d.signedByMe.at).slice(0, 10))}` : '');
  const paper = (d, shelf, note = '') => ({ key: d.id, shelf, title: d.title, note, words: d.body || '', paper: d.id });
  const file = (key, shelf, title, note, f) => ({ key, shelf, title, note, file: withUrl(f), open: viewer(f, title) });
  return [
    ...data.papers.filter((d) => d.kind === 'overview').map((d) => paper(d, 'about')),
    ...data.papers.filter((d) => d.kind === 'agreement').map((d) => paper(d, 'group', signed(d))),
    ...data.fromBoard.map((d) => file(d.id, 'donors', d.title, '', d.file)),
    ...data.library.flatMap((d) => libraryRows(d, file)),
    ...data.share.map((d) => paper(d, 'marketing')),
    ...(Array.isArray(data.meetings) ? data.meetings : []).flatMap((m) => (m.files || []).filter((f) => f.id).map((f) => file(f.id, 'group', nameOf(f), m.date ? `From the ${shortDate(m.date)} meeting` : '', f))),
  ];
}

function Row({ r, link }) {
  const fmt = r.file ? formatOf(r.file) : '';
  const meta = [r.note, fmt && fmt !== 'File' ? fmt : '', r.file?.size ? sizeText(r.file.size) : ''].filter(Boolean).join(' · ');
  const inner = html`${r.file ? html`<${FileBadge} f=${r.file} />` : html`<span class="bp-badge bp-badge--words" aria-hidden="true"><${Icon} name=${r.url ? 'external' : 'documents'} size=${16} /></span>`}
    <span class="bp-file__text"><span class="bp-file__title">${r.title}</span>${meta ? html`<span class="bp-file__meta">${meta}</span>` : null}</span>`;
  return html`<li class="bp-file bp-doc" key=${r.key} id=${`doc-${r.key}`}>
    ${r.paper ? html`<a class="bp-file__main" href=${`#/papers/${r.paper}`}>${inner}</a>`
    : r.file ? html`<a class="bp-file__main" ...${link(r)}>${inner}</a>`
      : html`<a class="bp-file__main" href=${r.url} target="_blank" rel="noopener">${inner}</a>`}
  </li>`;
}

/** The shelves: each file opens in the viewer with the others beside it */
function Shelves({ data, rows, terms }) {
  const inFiles = rows.filter((r) => r.file);
  const opens = inFiles.map((r) => r.open);
  const link = (r) => viewerLink(opens, inFiles.indexOf(r));
  const shelves = data.shelves.map((sh) => ({ ...sh, list: rows.filter((r) => r.shelf === sh.id) })).filter((sh) => sh.list.length);
  if (!shelves.length) {
    return terms.length ? null : html`<div class="bp-card bp-empty bp-gap"><p class="bp-muted">SOARD’s papers will be here.</p></div>`;
  }
  return html`<section class="bp-card bp-gap bp-papers bp-rise" style=${rise(4)} aria-labelledby="papers-h">
    <${SecHead} id="papers-h" title="SOARD’s papers" />
    <div class="bp-papers__cols">${shelves.map((sh) => html`<div class="bp-papers__col" key=${sh.id}>
      <h3 class="bp-papers__h" id=${`sh-${sh.id}`}>${sh.label}<span class="bp-count">${sh.list.length}</span></h3>
      ${sh.sub ? html`<p class="bp-papers__sub">${sh.sub}</p>` : null}
      <ul class="bp-files__list bp-papers__list" aria-labelledby=${`sh-${sh.id}`}>${sh.list.map((r) => html`<${Row} r=${r} link=${link} key=${r.key} />`)}</ul>
    </div>`)}</div>
  </section>`;
}

/** SOARD's own photos, as /branding/ offers them, to save and post */
function Photos({ photos }) {
  return html`<ul class="ad-shots">${photos.map((p) => html`<li key=${p.download}>
    <a class="ad-shot" href=${p.download} download aria-label=${`Download the photo${p.caption ? ` of ${p.caption}` : ''}`}>
      <img src=${sized(p.photo, 'w=560,h=420,fit=cover,gravity=face')} alt="" loading="lazy" width="280" height="210" />
      <span class="ad-shot__go"><${Icon} name="download" size=${16} />Download</span>
    </a>
    ${p.caption ? html`<span class="bp-muted ad-shot__cap">${p.caption}</span>` : null}
  </li>`)}</ul>`;
}

function BrandPanel({ data }) {
  const { brand, photos } = data;
  return html`<section class="bp-card bp-gap ad-brand bp-rise" style=${rise(2)} aria-labelledby="brand-h">
    <${SecHead} id="brand-h" title="Logos and photos" sub="Official files, ready for a flyer, a slide, or a post." />
    <ul class="ad-logos">
      ${brand.logos.map((l) => html`<li key=${l.key}>
        <a class=${`ad-logo ad-logo--${l.bg}`} href=${l.png} download aria-label=${`Download the ${l.name} logo`}><img src=${l.src} alt="" loading="lazy" /></a>
        <span class="ad-logo__t"><strong>${l.name}</strong><a class="bp-link" href=${l.png} download>Download PNG</a></span>
      </li>`)}
      ${brand.seal ? html`<li key="seal">
        <a class="ad-logo ad-logo--light" href=${brand.seal} target="_blank" rel="noopener" aria-label="Open the Advisory Board seal"><img src=${sized(brand.seal, 'w=320')} alt="" loading="lazy" /></a>
        <span class="ad-logo__t"><strong>Advisory Board seal</strong><a class="bp-link" href=${brand.seal} target="_blank" rel="noopener">Open full size</a></span>
      </li>` : null}
    </ul>
    <p class="ad-brand__more"><a class="bp-btn bp-btn--sm" href=${brand.kit} download><${Icon} name="download" size=${16} />Every logo (${brand.kitSize})</a><a class="bp-btn bp-btn--sm bp-btn--quiet" href="/branding/" target="_blank" rel="noopener">Colors, fonts, and how to use them</a></p>
    ${photos.length ? html`<h3 class="bp-papers__h ad-brand__h">Photos</h3><${Photos} photos=${photos} />` : null}
  </section>`;
}

function Filings({ filings, terms }) {
  const list = filings.filter((f) => match(`${f.title} ${f.year} tax return form 990 audit financial report`, terms));
  if (!list.length) return null;
  const views = list.map((x) => ({ name: x.title, type: 'application/pdf', url: x.url }));
  const row = (d, i) => html`<li class="bp-file bp-doc" key=${d.url}><a class="bp-file__main" ...${viewerLink(views, i)}>
    <span class="bp-badge" data-format="PDF" aria-hidden="true">PDF</span><span class="bp-file__text"><span class="bp-file__title">${d.title}</span>${d.year ? html`<span class="bp-file__meta">${d.year}</span>` : null}</span>
  </a></li>`;
  const first = list.slice(0, 6);
  const rest = list.slice(6);
  return html`<section class="bp-card bp-gap bp-rise" style=${rise(5)} aria-labelledby="filings-h">
    <${SecHead} id="filings-h" title="Public filings" sub="SOARD’s tax returns and audits, for anyone who asks." count=${list.length} />
    <ul class="bp-files__list ad-filings">${first.map(row)}</ul>
    ${rest.length && !terms.length ? html`<${More} k="filings" summary=${`${rest.length} more`}><ul class="bp-files__list ad-filings">${rest.map((d, i) => row(d, i + 6))}</ul><//>`
    : rest.length ? html`<ul class="bp-files__list ad-filings">${rest.map((d, i) => row(d, i + 6))}</ul>` : null}
  </section>`;
}

export function DocumentsPage({ ctx }) {
  const { data } = ctx;
  const [q, setQ] = useKept('q', '');
  const terms = termsOf(q);
  const due = new Set(data.todos.filter((t) => t.kind === 'sign').map((t) => t.id));
  const toSign = data.papers.filter((d) => due.has(d.id) && match(`${d.title} ${d.body || ''} sign signature agreement`, terms));
  const shelfWords = (id) => { const sh = data.shelves.find((x) => x.id === id); return sh ? `${sh.label} ${sh.sub}` : ''; };
  const rows = rowsOf(data).filter((r) => !due.has(r.paper)).filter((r) => match(`${r.title} ${r.note} ${r.words || ''} ${r.file?.name || ''} ${shelfWords(r.shelf)}`, terms));
  // The papers a form asks for next, opened from the facts
  const forms = FORM_PAPERS.map(([re, word]) => { const i = data.fromBoard.findIndex((d) => re.test(d.title)); return i < 0 ? null : { word, x: data.fromBoard[i], link: viewerLink(data.fromBoard.map((d) => viewer(d.file, d.title)), i) }; }).filter(Boolean)
    .filter((p, i, list) => list.findIndex((o) => o.x.id === p.x.id) === i);
  const facts = factsOf(data.org, { impact: data.impact });
  const matchFact = (hay, t) => match(`SOARD’s facts ${hay}`, t);
  const brandShown = match(`logo logos photo photos picture pictures brand branding marketing seal advisory board colors fonts flyer ${data.brand.logos.map((l) => l.name).join(' ')} ${data.photos.map((p) => p.caption).join(' ')}`, terms);
  const nothing = terms.length && !rows.length && !toSign.length && !brandShown && !facts.some((x) => matchFact(factHay(x), terms)) && !data.filings.some((f) => match(`${f.title} ${f.year} tax return form 990 audit financial report`, terms));
  return html`<div class="ad-docs">
    <header class="bp-pagehead bp-rise" style=${rise(0)}>
      <div><h1 class="bp-h1">Documents</h1><p class="bp-lede">SOARD’s facts, logos, and photos, and the papers people ask for.</p></div>
      <label class="bp-filter">
        <${Icon} name="search" size=${18} /><span class="sr-only">Find a document</span>
        <input type="search" placeholder="Find a document or a fact" value=${q} onInput=${(e) => setQ(e.target.value)} />
      </label>
    </header>
    ${nothing ? html`<p class="bp-found" role="status">Nothing here matches “${q.trim()}”.</p>` : null}
    ${toSign.length ? html`<section class="bp-card bp-gap bp-tosign bp-rise" style=${rise(1)} aria-labelledby="sign-h">
      <${SecHead} id="sign-h" title="To read and sign" sub="Each advisor signs once a term." />
      <ul class="bp-signlist">${toSign.map((d) => html`<li key=${d.id} class="bp-doc" id=${`doc-${d.id}`}>
        <a class="bp-signlist__cover" href=${`#/papers/${d.id}`} aria-hidden="true" tabindex="-1"><${Cover} x=${d} shelf="status" /></a>
        <div class="bp-signlist__body">
          <p class="bp-doc__title">${d.title}</p>
          <p class="bp-btns bp-btns--tight"><a class="bp-btn bp-btn--sm bp-btn--primary" href=${`#/papers/${d.id}`}>Read and sign</a></p>
        </div>
      </li>`)}</ul>
    </section>` : null}
    <${OrgFacts} ctx=${{ ...ctx, data: { ...data, numbers: { impact: data.impact } } }} terms=${terms} match=${matchFact} papers=${forms} />
    ${brandShown ? html`<${BrandPanel} data=${data} />` : null}
    <${Shelves} data=${data} rows=${rows} terms=${terms} />
    <${Filings} filings=${data.filings} terms=${terms} />
  </div>`;
}
