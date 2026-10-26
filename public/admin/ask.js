/**
 * Ask before a step that can't be taken back, in the admin's own dialog,
 * never the browser's confirm(). Every area uses this, so every confirmation
 * reads and works the same way: what happens, then Cancel and the action.
 *
 *   if (!(await ask({ title: 'Delete this question?', text: 'Applications already submitted keep their answer.', yes: 'Delete', danger: true }))) return;
 *
 * Resolves true for the action; false for Cancel, Escape or a click outside.
 * A danger dialog opens with the focus on the safe choice. The look is the
 * shared dialog (kd-dialog classes in index.html).
 */
import { h, htm, render } from './vendor.js';

const html = htm.bind(h);
let seq = 0;

export function ask({ title, text = '', yes = 'OK', no = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.append(host);
    const opener = document.activeElement;
    const id = `ask-${++seq}`;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey, true);
      render(null, host);
      host.remove();
      if (!document.querySelector('.modal-overlay')) document.body.classList.remove('modal-open');
      if (opener?.isConnected) opener.focus?.();
      resolve(ok);
    };
    // On window, capturing: it runs before a dialog underneath this one sees the key
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); return; }
      if (e.key !== 'Tab') return;
      const f = [...host.querySelectorAll('button')];
      const i = f.indexOf(document.activeElement);
      e.stopPropagation();
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    document.body.classList.add('modal-open');
    render(html`<div class="modal-overlay kd-overlay ask-overlay" onClick=${(e) => { if (e.target === e.currentTarget) finish(false); }}>
      <div class="modal kd-dialog kd-dialog--sm ask" role=${danger ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby=${id} aria-describedby=${text ? `${id}-text` : null}>
        <header class="kd-dialog__head"><div class="kd-dialog__titles"><h2 id=${id}>${title}</h2></div></header>
        ${text ? html`<div class="kd-dialog__body"><p class="ask__text" id=${`${id}-text`}>${text}</p></div>` : null}
        <footer class="kd-dialog__foot">
          <button type="button" class="btn btn-ghost" data-ask="no" onClick=${() => finish(false)}>${no}</button>
          <button type="button" class=${`btn ${danger ? 'btn-danger' : 'btn-primary'}`} data-ask="yes" onClick=${() => finish(true)}>${yes}</button>
        </footer>
      </div>
    </div>`, host);
    host.querySelector(danger ? '[data-ask="no"]' : '[data-ask="yes"]')?.focus();
  });
}

/** Unsaved changes: the one question every editor asks before it closes. where: "Site Config", "this story"… */
export const askToLeave = (where = '') => ask({
  title: 'Leave without saving?',
  text: where ? `The changes in ${where} aren’t saved yet. Leaving drops them.` : 'Your changes aren’t saved yet. Leaving drops them.',
  yes: 'Leave without saving',
  no: 'Keep editing',
  danger: true,
});
