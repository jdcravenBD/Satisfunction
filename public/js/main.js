/* Satisfunction — Settings, the game version, and starting the app. */

import { DATA } from './core.js';
import { load, setDirty } from './store.js';
import { refreshHistoryButtons, setLastSnap, snapshot } from './history.js';
import { fitView } from './view.js';
import { recompute } from './solve.js';
import { ctx, openCtx } from './menus.js';
import { refreshAll } from './factories.js';
import { buildTierSegs } from './options.js';
import { penCursor, tool } from './notes.js';

/* ------------------------------------------------------------- settings */

// Kept in this browser, apart from the saves: how the app looks isn't part
// of any plan. index.html reads it before anything is drawn.
var THEME_KEY = 'satisfunction.theme';

function currentTheme() { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; }

/** Dark or light, crossfading the whole page where the browser can. */
function setTheme(theme) {
  var root = document.documentElement;
  if (theme === currentTheme()) return;
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* kept for this visit only */ }
  var apply = function () {
    if (theme === 'light') root.dataset.theme = 'light';
    else delete root.dataset.theme;
    if (tool === 'pencil') penCursor();
  };
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still) { apply(); return; }
  if (document.startViewTransition) {
    // A hidden tab skips the crossfade (the theme still changes): nothing to report.
    document.startViewTransition(apply).ready.catch(function () {});
    return;
  }
  // Elsewhere, every colour eases across instead.
  root.classList.add('theme-fade');
  apply();
  clearTimeout(setTheme.timer);
  setTheme.timer = setTimeout(function () { root.classList.remove('theme-fade'); }, 420);
}

var settingsBtn = document.getElementById('settings');
settingsBtn.addEventListener('click', function () {
  var r = settingsBtn.getBoundingClientRect();
  openCtx(r.left, r.bottom + 6, [
    { head: 'Settings' },
    {
      toggle: true,
      label: 'Light mode',
      note: 'A light canvas and panels',
      on: currentTheme() === 'light',
      run: function (on) { setTheme(on ? 'light' : 'dark'); }
    }
  ], false, 230);
  ctx.style.left = Math.max(8, r.right - ctx.offsetWidth) + 'px';
});

/* ------------------------------------------------------------- versions */

// The game versions there have been. Only the data from the user's own
// install is loaded; the rest are listed but can't be picked yet.
var VERSIONS = ['1.2', '1.1', '1.0', 'Update 8', 'Update 7', 'Update 6', 'Update 5', 'Update 4',
  'Update 3', 'Update 2', 'Update 1'];
var versionBtn = document.getElementById('save-version');
// "1.2.4.0" is shown as 1.2, the version players know.
var GAME_VERSION = DATA.gameVersion ? String(DATA.gameVersion).split('.').slice(0, 2).join('.') : '';
document.getElementById('version-num').textContent = GAME_VERSION;
versionBtn.addEventListener('click', function () {
  var r = versionBtn.getBoundingClientRect();
  var items = [];
  VERSIONS.forEach(function (v) {
    var current = v === GAME_VERSION;
    items.push({
      label: v,
      note: current ? 'The data in use' : 'Not supported yet',
      on: current,
      disabled: !current,
      run: function () {}
    });
  });
  openCtx(r.left, r.bottom + 6, items, true);
});

/* ------------------------------------------------------------- tooltips */

// No browser tooltips anywhere: the moment the pointer reaches something
// with a title, the title moves to aria-label (for screen readers, where
// there's no visible text) and is dropped.
document.addEventListener('mouseover', function (e) {
  for (var el = e.target; el && el.getAttribute; el = el.parentNode) {
    var t = el.getAttribute('title');
    if (t == null) continue;
    if (t && !el.hasAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', t);
    el.removeAttribute('title');
  }
}, true);

/* ----------------------------------------------------------------- boot */

var firstVisit = load();
buildTierSegs();
refreshAll();
if (firstVisit) fitView();
setDirty(false);

// Web fonts can land after the first layout and change node heights.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(function () { recompute(); });
}

// Baseline for the history stack: the plan as it was loaded.
setLastSnap(snapshot());
refreshHistoryButtons();
