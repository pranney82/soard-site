// What a person does on a check's card in Donors & Partners → Checks (public/admin/checks.js), for tests: take what the site filled
// in, change what the test says to, and press Send to Zeffy. It mirrors the page's own defaults, so a test that sends "as the
// card says" sends what a person pressing Send would. A card that asks a person to pick (a donor, a name) throws unless the
// test picks. Names and amounts in tests are made up.
import * as CG from '../../functions/api/_check-gifts.js';

/** One check as the Checks page shows it */
export async function cardOf(env, id) {
  const v = await CG.checksView(env);
  return v.list.find((c) => c.id === id) || null;
}

/** One name, however it's spaced or capitalized (as the page compares them) */
const sameName = (a, b) => { const k = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); return !!k(a) && k(a) === k(b); };
const plain = (a) => (a ? { line1: a.line1, city: a.city, state: a.state, postal_code: a.postal_code } : null);

/** The address the page starts on: the letter's or the check's only when it's the address of whoever the gift is going to, else none */
export const pageAddress = (k, name) => {
  if (k.letterAddress && sameName(k.letterAddressFor, name)) return plain(k.letterAddress);
  if (k.checkAddress && sameName(k.checkAddressFor, name)) return plain(k.checkAddress);
  return null;
};

/**
 * Press Send to Zeffy on a check's card → personSend's answer (it throws as the page's call would fail). `over` changes a
 * field: name, donor ('new' or a Zeffy contact id), formId, day, email, address (null for none), notThose, shown, donorsShown
 * (the donors the page showed: the card's), by, now
 */
export async function approveWith(env, fetchImpl, id, over = {}) {
  const c = await cardOf(env, id);
  if (!c?.card) throw new Error(`No card to send for ${id}: it's "${c?.state}"${c?.reason ? ` (${c.reason})` : ''}`);
  const k = c.card;
  const donor = over.donor ?? k.donor;
  if (!donor) throw new Error('The card asks a person to pick the Zeffy donor');
  const name = over.name ?? k.name;
  if (!name) throw new Error('The card asks a person to say who it’s from');
  const picked = (k.donors || []).find((d) => d.id === donor);
  return CG.personSend(env, id, {
    name, donor, formId: over.formId ?? k.formId, day: over.day ?? k.day,
    email: 'email' in over ? over.email : picked?.email ? '' : k.email,
    address: 'address' in over ? over.address : pageAddress(k, name),
    notThose: !!over.notThose, shown: over.shown || [], donorsShown: over.donorsShown ?? (k.donors || []).map((d) => d.id), saw: over.saw ?? c.ver, by: over.by ?? 'staff@example.com',
    now: over.now ?? Date.now(), fetchImpl,
  });
}

/** Press Don't send to Zeffy, with why */
export async function dontSendWith(env, id, reason, over = {}) {
  const c = await cardOf(env, id);
  return CG.personDontSend(env, id, { reason, saw: over.saw ?? c?.ver, by: over.by ?? 'staff@example.com', now: over.now ?? Date.now() });
}
