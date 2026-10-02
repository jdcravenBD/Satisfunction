/* Satisfunction — The info menu, and the hover tips that name items. */

import { clamp } from './core.js';
import { ctx, openCtx } from './menus.js';

/* ---------------------------------------------------------------- focus */

// A button keeps focus after it's clicked, and the first key pressed after
// (even Shift) makes the browser draw its focus ring. Pressing anywhere
// else lets go of it.
document.addEventListener('pointerdown', function (e) {
  var a = document.activeElement;
  if (a && a !== document.body && (a.tagName === 'BUTTON' || a.tagName === 'A') && !a.contains(e.target)) a.blur();
}, true);

/* ----------------------------------------------------------------- info */

var REPO_URL = 'https://github.com/jdcravenBD/Satisfunction';
var infoBtn = document.getElementById('info');
infoBtn.addEventListener('click', function () {
  var r = infoBtn.getBoundingClientRect();
  openCtx(r.left, r.bottom + 6, [
    { head: 'Satisfunction' },
    {
      label: 'GitHub',
      note: 'The code behind the app',
      run: function () { window.open(REPO_URL, '_blank', 'noopener'); }
    },
    {
      label: 'Report a problem',
      note: 'Opens a new issue on GitHub',
      run: function () { window.open(REPO_URL + '/issues/new', '_blank', 'noopener'); }
    }
  ]);
  ctx.style.left = Math.max(8, r.right - ctx.offsetWidth) + 'px';
});

/* ------------------------------------------------------------ item tips */

// Hovering an item's icon a moment names it (and what's going through it):
// the app's own small box, never the browser's tooltip.
var tipEl = document.createElement('div');
tipEl.className = 'hover-tip';
tipEl.setAttribute('role', 'tooltip');
document.body.appendChild(tipEl);
var tipTimer = null, tipFor = null;
function hideTip() {
  clearTimeout(tipTimer);
  tipFor = null;
  tipEl.classList.remove('show');
}
document.addEventListener('mouseover', function (e) {
  var t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
  if (t === tipFor) return;
  hideTip();
  if (!t || !t.dataset.tip) return;
  tipFor = t;
  tipTimer = setTimeout(function () {
    if (!document.body.contains(t)) return;
    tipEl.textContent = t.dataset.tip;
    var r = t.getBoundingClientRect();
    tipEl.style.left = '0px';
    tipEl.style.top = '0px';
    tipEl.classList.add('show');
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var below = r.bottom + 8 + h < window.innerHeight;
    tipEl.style.left = Math.round(clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8)) + 'px';
    tipEl.style.top = Math.round(below ? r.bottom + 8 : r.top - h - 8) + 'px';
  }, 600);
});
document.addEventListener('pointerdown', hideTip, true);
window.addEventListener('wheel', hideTip, { passive: true });
window.addEventListener('blur', hideTip);

export { hideTip, tipEl };
