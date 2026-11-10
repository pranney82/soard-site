/**
 * Whose photos are these? (public/admin/kid-guess.js) and where each kid's
 * home is (functions/api/kid-homes.js), for Admin → Kids → Upload photos and
 * videos. The photo and video files are built here byte by byte: a JPEG and a
 * HEIC with EXIF GPS (both byte orders), and a MOV with the place an iPhone writes.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as KG from '../public/admin/kid-guess.js';
import { kidHomes } from '../functions/api/kid-homes.js';
import { tiff, jpeg, box, heic } from './lib/exif-fixtures.mjs';

const KIDS = [
  { slug: 'summer', name: 'Summer', year: 2025, status: 'completed' },
  { slug: 'axel', name: 'Axel', year: 2026, status: 'in-progress' },
  { slug: 'dylan', name: 'Dylan', year: 2023, status: 'completed' },
  { slug: 'dylan-2026', name: 'Dylan', year: 2026, status: 'in-progress' },
  { slug: 'caleb', name: 'Caleb', year: 2024, status: 'completed' },
  { slug: 'amanda-caleb-and-isaac', name: 'Amanda, Caleb & Isaac', year: 2023, status: 'completed' },
  { slug: 'remi-and-nico', name: 'Remi & Nico', year: 2025, status: 'completed' },
  { slug: 'aj', name: 'AJ', year: 2014, status: 'completed' },
  { slug: 'josue', name: 'Josué', year: 2025, status: 'completed' },
  { slug: 'max', name: 'Max', year: 2026, status: 'in-progress' },
];
const slugOf = (path, taken) => KG.guessFromName(path, KIDS, taken)?.slug || null;

// ── Names ──
test('a folder or file with a kid’s name in it is theirs; the nearest folder counts first', () => {
  assert.equal(slugOf('/Summer Reveal/IMG_0001.JPG'), 'summer');
  assert.equal(KG.guessFromName('/Summer Reveal/IMG_0001.JPG', KIDS).where, 'folder');
  assert.equal(slugOf('summer-reveal-01.jpg'), 'summer');
  assert.equal(KG.guessFromName('summer-reveal-01.jpg', KIDS).where, 'file');
  assert.equal(slugOf('/2026 Reveals/Axel/IMG_1.HEIC'), 'axel');
  assert.equal(slugOf('/Summer/Axel/IMG_1.HEIC'), 'axel', 'the folder nearest the file wins');
  assert.equal(slugOf('IMG_0001.JPG'), null);
  assert.equal(slugOf('/Photos/Exports/IMG_0001.JPG'), null);
});

test('whole words only, accents folded, two-letter names only from a folder', () => {
  assert.equal(slugOf('maxresdefault.jpg'), null, 'max inside a longer word is not Max');
  assert.equal(slugOf('/Josue room/1.jpg'), 'josue');
  assert.equal(slugOf('/AJ/1.jpg'), 'aj');
  assert.equal(slugOf('aj-1.jpg'), null);
});

test('two kids named in one folder: the one whose name has both, else no guess', () => {
  assert.equal(slugOf('/Summer and Axel/1.jpg'), null);
  assert.equal(slugOf('/Amanda Caleb Isaac/1.jpg'), 'amanda-caleb-and-isaac');
  assert.equal(slugOf('/Caleb/1.jpg'), 'caleb', 'a name on its own is the kid with just that name');
  assert.equal(slugOf('/Remi & Nico/1.jpg'), 'remi-and-nico');
  assert.equal(slugOf('/Nico/1.jpg'), 'remi-and-nico');
});

test('kids with the same name: a year in the path, then the year taken, then the one in build', () => {
  assert.equal(slugOf('/Dylan 2023/1.jpg'), 'dylan');
  assert.equal(slugOf('/Dylan/1.jpg', new Date(2023, 5, 1)), 'dylan');
  assert.equal(slugOf('/Dylan/1.jpg'), 'dylan-2026', 'in build now');
});

test('a name that fits more than one page: the kid already chosen wins, an initial decides, the guess says it’s unsure', () => {
  const kids = [
    { slug: 'ellie', name: 'Ellie', year: 2022, status: 'completed' },
    { slug: 'ellie-2023', name: 'Ellie', year: 2023, status: 'completed' },
    { slug: 'hannah', name: 'Hannah', year: 2024, status: 'completed' },
    { slug: 'hannah-and-austin', name: 'Hannah & Austin', year: 2019, status: 'completed' },
    { slug: 'christian-b', name: 'Christian B', year: 2021, status: 'completed' },
    { slug: 'christian-v', name: 'Christian V', year: 2019, status: 'completed' },
    { slug: 'mattie-and-nathan', name: 'Mattie & Nathan', year: 2018, status: 'completed' },
    { slug: 'nathan', name: 'Nathan', year: 2022, status: 'completed' },
  ];
  const g = (path, prefer, taken = null) => KG.guessFromName(path, kids, taken, prefer);
  assert.equal(g('/Ellie/1.png', 'ellie').slug, 'ellie', 'Ellie (2022) chosen: an “Ellie” folder is hers');
  assert.equal(g('/Ellie/1.png', '').others, 1, 'nothing chosen: the guess says another page matches');
  assert.equal(g('/Ellie/1.png', '', new Date(2022, 4, 1)).others, 0, 'the year taken settles it');
  assert.equal(g('/Hannah/1.png', 'hannah-and-austin').slug, 'hannah-and-austin');
  assert.equal(g('/Nathan/1.png', 'mattie-and-nathan').slug, 'mattie-and-nathan');
  assert.equal(g('/Nathan/1.png', '').slug, 'nathan', 'nothing chosen: the page with just that name');
  assert.equal(g('/Christian V Reveal/1.png', '').slug, 'christian-v');
  assert.equal(g('/Christian V Reveal/1.png', 'christian-b').slug, 'christian-v', 'an initial beats the kid chosen');
  assert.equal(g('/Christian B/1.png', '').slug, 'christian-b');
  assert.equal(g('/Christian Academy/1.png', ''), null, 'an everyday word with something else around it is no name');
  assert.equal(KG.guessKid({ path: '/Ellie/1.png' }, kids, [], 'ellie').slug, 'ellie', 'guessKid passes the kid chosen on');
});

test('everyday words aren’t names unless the rest is filler', () => {
  const kids = [...KIDS, { slug: 'glass-family', name: 'Glass Family', year: 2012, status: 'completed' }, { slug: 'angel', name: 'Angel', year: 2015, status: 'completed' },
    { slug: 'mason', name: 'Mason', year: 2020, status: 'completed' }, { slug: 'peter', name: 'Peter', year: 2026, status: 'in-progress' }, { slug: 'damon-dj', name: 'Damon (DJ)', year: 2021, status: 'completed' }];
  const g = (path) => KG.guessFromName(path, kids)?.slug || null;
  for (const path of ['/Family Day 2025/1.jpg', '/Summer 2026 events/1.jpg', '/Angel Tree/1.jpg', '/Mason jars/1.jpg', '/Peter iPhone/1.jpg', '/DJ Booth/1.jpg']) {
    assert.equal(g(path), null, path);
  }
  assert.equal(g('/Summer Reveal 2025/1.jpg'), 'summer');
  // A photographer's own words are filler too ("Max Resolution" now reads as Max: the check card catches it)
  for (const [path, slug] of [['/Summer reveal - full resolution/1.jpg', 'summer'], ['/Max Reveal Proofs/1.jpg', 'max'], ['/Max Oct 25/1.jpg', 'max'], ['/Mason session/1.jpg', 'mason']]) assert.equal(g(path), slug, path);
  // An everyday word elsewhere in the name doesn't cancel a clear one; joined on with "and", it's a second kid
  assert.equal(g('/Axel Reveal Summer 2026/1.jpg'), 'axel');
  assert.equal(g('/Axel Reveal - Photos by Grace Lee/1.jpg'), 'axel');
  assert.equal(g('/Summer and Axel/1.jpg'), null);
  assert.equal(g('/Summer & Axel/1.jpg'), null);
  // A photographer's credit, a resolution folder, "photos for …" aren't names; an everyday-word folder doesn't beat a kid further out
  const more = [...kids, { slug: 'kyle', name: 'Kyle', year: 2017, status: 'completed' }, { slug: 'lizzie', name: 'Lizzie', year: 2026, status: 'in-progress' }];
  const h = (path) => KG.guessFromName(path, more)?.slug || null;
  assert.equal(h('/Lizzie Reveal/Kyle Thomas Photography - Web/IMG_1.jpg'), 'lizzie');
  assert.equal(h('/Lizzie/Max Resolution/IMG_1.jpg'), 'lizzie');
  assert.equal(h('/Max Resolution/IMG_1.jpg'), null);
  assert.equal(h('/Photos for Peter/IMG.jpg'), null);
  assert.equal(h('/Axel Reveal - Smith Photography/1.jpg'), 'axel');
  assert.equal(h('/Max Reveal by Madison Lee/1.jpg'), 'max', 'Madison is the photographer');
  assert.equal(h('/Lizzie/Summer reveal/1.jpg'), 'lizzie', 'an everyday-word folder inside a kid’s folder is the kid’s');
  assert.equal(h('/Summer reveal/1.jpg'), 'summer');
  // Rooms, relatives, helpers and businesses inside a kid's folder aren't other kids
  const kin = [...more, { slug: 'colin', name: 'Colin', year: 2026, status: 'in-progress' }, { slug: 'jack', name: 'Jack', year: 2016, status: 'completed' },
    { slug: 'logan', name: 'Logan', year: 2019, status: 'completed' }, { slug: 'jackson', name: 'Jackson', year: 2026, status: 'needs-funding' }, { slug: 'ben', name: 'Ben', year: 2020, status: 'completed' }];
  const c = (path, prefer = '') => KG.guessFromName(path, kin, null, prefer)?.slug || null;
  assert.equal(c('/Colin Reveal/Jack and Jill Bathroom/1.jpg'), 'colin');
  assert.equal(c('/Colin Reveal/Brother Jack/1.jpg'), 'colin');
  assert.equal(c('/Colin Reveal/Second shooter - Logan/1.jpg'), 'colin');
  assert.equal(c('/Hartsfield Jackson Airport trip/1.jpg'), null);
  assert.equal(c('/Ben Franklin Plumbing/1.jpg'), null);
  assert.equal(c('/Summer with mom/1.jpg'), 'summer', 'a relative after a name takes nothing from it');
  // The kid chosen, named further out, wins; otherwise a guess says a folder further out names someone else
  assert.equal(c('/Lizzie Reveal/Kyle Thomas/001.jpg', 'lizzie'), 'lizzie');
  const k2 = KG.guessFromName('/Lizzie Reveal/Kyle Thomas/001.jpg', kin);
  assert.ok(k2.slug === 'kyle' && k2.outer === 'lizzie' && k2.outerPart === 'Lizzie Reveal', JSON.stringify(k2));
  assert.equal(g('/Summer’s room - edited/1.jpg'), 'summer');
  assert.equal(g('mason-03.jpg'), 'mason');
  assert.equal(g('/Glass Family Reveal/1.jpg'), 'glass-family');
  assert.equal(g('/Peter reveal/1.jpg'), 'peter');
  assert.equal(g('/Damon DJ room/1.jpg'), 'damon-dj', 'a strong name in it carries the weak one');
});

test('a year in the folder beats the kid chosen; the address counts as a name; one house with two pages', () => {
  const kids = [
    { slug: 'ellie', name: 'Ellie', year: 2022, status: 'completed' },
    { slug: 'ellie-2023', name: 'Ellie', year: 2023, status: 'completed' },
    { slug: 'junializ', name: 'Junailiz', year: 2025, status: 'completed' },
    { slug: 'lyric', name: 'Lyric', year: 2018, status: 'completed' },
    { slug: 'anthony-jr-and-lyric', name: 'Anthony Jr. & Lyric', year: 2021, status: 'completed' },
  ];
  assert.equal(KG.guessFromName('/Ellie 2023 Reveal/1.jpg', kids, null, 'ellie').slug, 'ellie-2023');
  assert.equal(KG.guessFromName('/Ellie 2022 Reveal/1.jpg', kids, null, 'ellie').slug, 'ellie');
  assert.equal(KG.guessFromName('/Junializ/1.jpg', kids).slug, 'junializ');
  assert.equal(KG.guessFromName('/Junailiz/1.jpg', kids).slug, 'junializ');
  const homes = [{ slug: 'lyric', lat: 33.7, lng: -84.3 }, { slug: 'anthony-jr-and-lyric', lat: 33.7, lng: -84.3 }];
  const spot = { lat: 33.7001, lng: -84.3001 };
  assert.deepEqual(KG.guessKid({ path: 'IMG_1.HEIC', facts: spot }, kids, homes, 'anthony-jr-and-lyric'), { slug: 'anthony-jr-and-lyric', by: 'home', others: 0 });
  assert.equal(KG.guessKid({ path: 'IMG_1.HEIC', facts: spot }, kids, homes).others, 1, 'nothing chosen: it says another page shares the house');
  assert.equal(KG.guessKid({ path: '/Anthony and Lyric/IMG_1.HEIC', facts: spot }, kids, homes).slug, 'anthony-jr-and-lyric', 'the name settles which of the two');
});

test('taken at a home beats a name; a home only counts within HOME_METERS', () => {
  const homes = [{ slug: 'axel', lat: 33.7490, lng: -84.3880 }, { slug: 'max', lat: 34.0, lng: -84.0 }];
  const near = { lat: 33.7492, lng: -84.3883 };
  assert.ok(KG.meters({ lat: 33.749, lng: -84.388 }, near) < 50);
  assert.deepEqual(KG.guessKid({ path: '/Summer/IMG_1.HEIC', facts: near }, KIDS, homes), { slug: 'axel', by: 'home', others: 0 });
  assert.equal(KG.guessKid({ path: '/Summer/IMG_1.HEIC', facts: { lat: 33.80, lng: -84.3880 } }, KIDS, homes).slug, 'summer', '5.6 km away is not at the home');
  assert.equal(KG.guessKid({ path: 'IMG_1.HEIC', facts: { lat: 33.80, lng: -84.388 } }, KIDS, homes), null);
  assert.equal(KG.guessKid({ path: 'IMG_1.HEIC', facts: near }, KIDS.filter((k) => k.slug !== 'axel'), homes), null, 'a home whose kid isn’t listed');
  assert.equal(KG.homeAt({ lat: 33.7490, lng: -84.3880 }, [...homes, { slug: 'next-door', lat: 33.7491, lng: -84.3881 }]).slug, 'axel', 'the nearest of two');
});

// ── Reading the files ──
const file = (bytes, name, type) => new File([bytes], name, { type });

test('a JPEG says where and when it was taken (both byte orders)', async () => {
  for (const le of [false, true]) {
    const f = await KG.readFacts(file(jpeg(tiff({ lat: 33.749, lng: -84.388, taken: '2026:10:25 14:30:00', le })), 'IMG_1.JPG', 'image/jpeg'));
    assert.ok(Math.abs(f.lat - 33.749) < 1e-4 && Math.abs(f.lng + 84.388) < 1e-4, JSON.stringify(f));
    assert.equal(f.taken.getFullYear(), 2026);
    assert.equal(f.taken.getMonth(), 9);
  }
  const south = await KG.readFacts(file(jpeg(tiff({ lat: -33.86, lng: 151.21, taken: '2025:01:02 03:04:05' })), 'x.jpg', 'image/jpeg'));
  assert.ok(south.lat < 0 && south.lng > 0);
});

test('an iPhone photo (HEIC) says where it was taken, iloc versions 0 and 1', async () => {
  for (const v of [0, 1]) {
    const f = await KG.readFacts(file(heic(tiff({ lat: 33.749, lng: -84.388, taken: '2026:10:25 14:30:00' }), v), 'IMG_2.HEIC', 'image/heic'));
    assert.ok(Math.abs(f.lat - 33.749) < 1e-4 && Math.abs(f.lng + 84.388) < 1e-4, `iloc v${v}: ${JSON.stringify(f)}`);
    assert.equal(f.taken.getFullYear(), 2026);
  }
  // Chrome gives an iPhone photo no type: the name is enough
  assert.ok((await KG.readFacts(file(heic(tiff({ lat: 33.749, lng: -84.388, taken: '2026:10:25 14:30:00' })), 'IMG_3.heic', ''))).lat);
});

test('a phone video says where it was taken, even with its moov after the media', async () => {
  const mdat = box('mdat', new Uint8Array(5000));
  const moov = box('moov', box('udta', [0xa9, ...'xyz'].map((c) => (typeof c === 'number' ? c : c.charCodeAt(0))), [...'+33.7490-084.3880+300.000/'].map((c) => c.charCodeAt(0))));
  const f = await KG.readFacts(file(new Uint8Array([...box('ftyp', [...'qt  '].map((c) => c.charCodeAt(0))), ...mdat, ...moov]), 'IMG_4.MOV', 'video/quicktime'));
  assert.deepEqual(f, { lat: 33.749, lng: -84.388 });
});

test('files that don’t say, or are cut short, give no facts and never throw', async () => {
  assert.deepEqual(await KG.readFacts(file(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]), 'a.jpg', 'image/jpeg')), {});
  assert.deepEqual(await KG.readFacts(file(jpeg(tiff({ lat: 33.749, lng: -84.388, taken: '2026:10:25 14:30:00' })).slice(0, 40), 'cut.jpg', 'image/jpeg')), {});
  assert.deepEqual(await KG.readFacts(file(new Uint8Array(10), 'x.heic', 'image/heic')), {});
  assert.deepEqual(await KG.readFacts(file(new Uint8Array([1, 2, 3]), 'x.png', 'image/png')), {});
  assert.deepEqual(await KG.readFacts(file(new Uint8Array(0), 'empty.mov', 'video/quicktime')), {});
});

// ── Homes ──
test('kid-homes: each kid’s job location, matched as Reveals matches them; map points only', () => {
  const jobs = [
    { id: 'j1', name: 'Axel Rivera (2026)', closedOn: null, customFieldValues: { nodes: [] }, location: { latitude: 33.749, longitude: -84.388, address: '1 Main St' } },
    { id: 'j2', name: 'Summer Jones (2025)', closedOn: '2025-11-01', customFieldValues: { nodes: [] }, location: { latitude: 34.1, longitude: -84.2 } },
    { id: 'j3', name: 'Max Sample (2026)', closedOn: null, customFieldValues: { nodes: [] }, location: { latitude: null, longitude: null } },
    { id: 'j4', name: 'Office Renovation (2026)', closedOn: null, customFieldValues: { nodes: [] }, location: { latitude: 33.9, longitude: -84.1 } },
  ];
  const kids = [
    { slug: 'axel', name: 'Axel', year: 2026, data: {} },
    { slug: 'summer', name: 'Summer', year: 2025, data: {} },
    { slug: 'max', name: 'Max', year: 2026, data: {} },
  ];
  const homes = kidHomes(jobs, kids);
  assert.deepEqual(homes.sort((a, b) => a.slug.localeCompare(b.slug)), [{ slug: 'axel', lat: 33.749, lng: -84.388 }, { slug: 'summer', lat: 34.1, lng: -84.2 }]);
  assert.ok(!JSON.stringify(homes).includes('Main St'), 'no address');
});
