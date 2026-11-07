/**
 * A link in an email or on a calendar invite (/advisory/<id>, public/_redirects) arrives as ?meeting=<id>: a query
 * survives the sign-in, where a #/ address lands on Home. Runs before anything else on the page reads the address.
 */
const q = new URLSearchParams(location.search);
const id = q.get('meeting');
if (id !== null) {
  q.delete('meeting');
  const to = /^m_[a-z0-9]{4,24}$/.test(id) ? `#/meetings/${id}` : /^ad_[a-z2-7]{4,24}$/.test(id) ? `#/papers/${id}` : id === 'run' ? '#/run' : id === 'documents' ? '#/documents' : location.hash || '#/';
  history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}${to}`);
}
