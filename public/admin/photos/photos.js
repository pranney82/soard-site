/**
 * /admin/photos/ — photos onto a JobTread daily log from a phone's browser
 * ===========================================================================
 * The backup for the photo box in Claude (the box's "Buttons not working? Open this in your browser" opens this
 * page on the same job and day), where Claude's "connect your JobTread" link opens (?connect=1 goes straight on to
 * JobTread's sign-in, once the admin's sign-in has let them in), and where "Connect JobTread" comes back to
 * (?jobtread=connected|…). The box
 * itself is the same one Claude shows (/mcp-app/photo-box-1.js); here it reaches the site through
 * /api/field-admin, as the person signed in. ?job=<JobTread job id>&date=YYYY-MM-DD.
 */

import { mountPhotoBox } from '/mcp-app/photo-box-1.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const job = q.get('job') || '';
const date = q.get('date') || '';
const here = `/admin/photos/${job ? `?job=${encodeURIComponent(job)}${date ? `&date=${encodeURIComponent(date)}` : ''}` : ''}`;

const say = (text, strong = '') => {
  const n = $('note');
  n.replaceChildren();
  if (strong) n.append(Object.assign(document.createElement('strong'), { textContent: strong }), ' ');
  n.append(text);
};
const showConnect = (label = 'Connect JobTread') => {
  const a = $('connect');
  a.href = `/api/field-admin?connect=1&back=${encodeURIComponent(here)}`;
  a.textContent = label;
  a.hidden = false;
};

/** Who the connection acts as: their name on everything through Claude. A login that doesn't look like them (Nov 13:
 * Peter's browser was signed in to JobTread as DATAx, an integration's login) says so, with the way to fix it. */
function sayWho(c, fresh) {
  if (!c?.linked) return false;
  if (c.likely === false) {
    say(`Everything you do through Claude shows as “${c.name}” in JobTread, and that doesn’t look like you. If it isn’t you: sign out of JobTread in this browser (app.jobtread.com), sign in as yourself, then press Connect again.`, `Connected as ${c.name}.`);
    showConnect('Connect again');
  } else say(`Your logs, photos and schedule changes through Claude show as ${c.name} in JobTread.${fresh ? ' Go back to Claude and carry on.' : ' Open this page from the photo box in Claude to add photos here.'}`, `Connected as ${c.name}.`);
  return true;
}

const AFTER = {
  connected: ['Your logs, photos and schedule changes through Claude now show your name in JobTread. Go back to Claude and carry on.', 'JobTread is connected.'],
  declined: ['JobTread wasn’t connected: the sign-in was cancelled.', ''],
  expired: ['That sign-in took longer than 15 minutes. Connect again.', ''],
  team: ['That JobTread login isn’t on SOARD’s team. Sign in to JobTread as yourself, then connect again.', ''],
  site: ['That’s the website’s own JobTread login. Sign out of it in JobTread, sign in as yourself, then connect again.', ''],
  failed: ['JobTread didn’t finish connecting. Try again in a minute.', ''],
};

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || 'That didn’t work. Try again.'), { status: res.status, connect: data.connect });
  return data;
}

async function start() {
  const result = q.get('jobtread');
  if (result && AFTER[result]) {
    const [text, strong] = AFTER[result];
    say(text, strong);
    if (result !== 'connected') showConnect(result === 'declined' ? 'Connect JobTread' : 'Connect again');
    else { try { sayWho((await api('/api/field-admin')).connection, true); } catch { /* the words above stay */ } }
    if (!job) return;
  }
  if (!job) {
    const { connection } = await api('/api/field-admin');
    if (sayWho(connection, false)) { /* said */ }
    else {
      say('Connect your JobTread once, so what you add through Claude shows your name.');
      showConnect(connection.broken ? 'Connect again' : 'Connect JobTread');
      // Opened to connect (Claude's link, ./functions/api/_field.js CONNECT_URL): on to JobTread's sign-in without
      // a second tap. Coming back from JobTread carries ?jobtread= and never ?connect=, so this can't go round again.
      if (q.get('connect')) { say('Taking you to JobTread to connect…'); location.replace($('connect').href); }
    }
    return;
  }
  let info;
  try {
    info = await api(`/api/field-admin?job=${encodeURIComponent(job)}${date ? `&date=${encodeURIComponent(date)}` : ''}`);
  } catch (err) {
    if (err.status === 409 && err.connect) { say('Connect your JobTread once, then add the photos.'); showConnect(); return; }
    say(err.message);
    return;
  }
  if (result !== 'connected') $('note').hidden = true;
  $('box').hidden = false;
  mountPhotoBox($('box'), {
    target: { jobId: info.job.id, jobName: info.job.name, date: info.date, logId: info.log?.id || null, who: info.who, jobUrl: info.jobUrl, backupUrl: null },
    slots: async (files) => (await api('/api/field-admin', { action: 'slots', files })).slots || [],
    done: (a) => api('/api/field-admin', { action: 'done', ...a }),
    openLink: (url) => window.open(url, '_blank', 'noopener'),
    theme: 'light',
  });
}

start().catch((err) => say(err.message || 'This page couldn’t load. Try again.'));
