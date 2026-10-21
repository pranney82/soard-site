/**
 * A Slack post as a person reads it, one line per part, for assertions:
 * header, context lines, section text, "Label: value" for each fact, and
 * "[Button]" for buttons. A post without blocks is its `text`.
 */
export function renderSlack(body) {
  if (!body?.blocks?.length) return body?.text ?? '';
  const out = [];
  for (const b of body.blocks) {
    if (b.type === 'header') out.push(b.text.text);
    else if (b.type === 'context') out.push(b.elements.map((e) => e.text).join(' '));
    else if (b.type === 'section') {
      if (b.text) out.push(b.text.text);
      for (const f of b.fields || []) out.push(f.text.replace(/^\*(.+?)\*\n/, '$1: '));
    } else if (b.type === 'actions') out.push(b.elements.map((e) => `[${e.text.text}]`).join(' '));
  }
  return out.join('\n');
}

/** Every button on a post → [{ label, url }] */
export function slackButtons(body) {
  return (body?.blocks || []).filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e) => ({ label: e.text.text, url: e.url })));
}
