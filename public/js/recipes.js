/* Satisfunction — Recipe settings: I pick or Optimise, alternates and resources. */

import { DATA, RAW_ITEMS, canBuild, itemName, machineName, solved, state, unlockable } from './core.js';
import { changed } from './history.js';
import { flow, iconOf } from './model.js';
import { refreshRunButton } from './build.js';

/* ------------------------------------------------------------- recipes */

// Who picks recipes. By hand: the standard recipe unless one is picked on
// its node. Optimise: the best mix for the outputs, redone on every change,
// with any recipe picked on a node pinned.
var pickerSeg = document.getElementById('picker-seg');
var goalSeg = document.getElementById('goal-seg');
var optSettings = document.getElementById('opt-settings');
var optNote = document.getElementById('opt-note');
var UNLOCKABLE = Object.keys(DATA.recipes).filter(unlockable).sort(function (a, b) {
  return DATA.recipes[a].name.localeCompare(DATA.recipes[b].name);
});

function markSeg(seg, attr, value) {
  seg.querySelectorAll('.seg-btn').forEach(function (b) {
    b.classList.toggle('on', b.dataset[attr] === value);
  });
}

function refreshRecipeControls() {
  var optimising = state.picker === 'optimise';
  markSeg(pickerSeg, 'picker', state.picker);
  markSeg(goalSeg, 'goal', state.goal);
  // The alternates list always shows: it limits what a card can run. What
  // to aim for only matters to the optimiser.
  optSettings.hidden = false;
  optSettings.querySelector('.aim-head').hidden = !optimising;
  goalSeg.hidden = !optimising;
  optNote.hidden = !optimising;
  document.getElementById('picker-sub').textContent = optimising ? 'picked for you' : 'on each machine';
  if (flow) refreshRunButton();
  altCount.textContent = state.unlocked.length + ' of ' + UNLOCKABLE.length + ' ticked';
  document.getElementById('res-count').textContent = state.noUse.length ? state.noUse.length + ' switched off' : 'all in use';
  renderResList();
}

/** After a solve: what the optimiser ended up using. */
function refreshOptNote() {
  if (state.picker !== 'optimise' || !solved) {
    optNote.textContent = '';
    return;
  }
  var inUse = solved.custom ? flow.recipes : solved.recipes;
  var used = Object.keys(inUse).filter(unlockable);
  var items = {};
  var mixed = 0;
  Object.keys(inUse).forEach(function (rid) {
    var main = DATA.recipes[rid].out[0][0];
    items[main] = (items[main] || 0) + 1;
    if (items[main] === 2) mixed++;
  });
  var bits = [];
  bits.push(used.length ? used.length + ' alternate' + (used.length === 1 ? '' : 's') + ' in use' : 'Standard recipes only');
  if (mixed) bits.push(mixed + ' item' + (mixed === 1 ? '' : 's') + ' made more than one way');
  optNote.textContent = bits.join(' · ') + '.';
}

function segClick(seg, attr, key) {
  seg.addEventListener('click', function (e) {
    var btn = e.target.closest('.seg-btn');
    if (!btn || btn.dataset[attr] === state[key]) return;
    state[key] = btn.dataset[attr];
    refreshRecipeControls();
    changed();
  });
}
segClick(pickerSeg, 'picker', 'picker');
segClick(goalSeg, 'goal', 'goal');

// The alternates the user has unlocked: a ticked list in the panel,
// folded away until wanted, with a search over recipe and item names.
var altFold = document.getElementById('alt-fold');
var altCount = document.getElementById('alts-count');
var altInput = document.getElementById('alt-search');
var altList = document.getElementById('alt-list');

function renderAltList() {
  var q = altInput.value.trim().toLowerCase();
  altList.innerHTML = '';
  UNLOCKABLE.forEach(function (rid) {
    var r = DATA.recipes[rid];
    var makes = r.out.map(function (p) { return itemName(p[0]); }).join(', ');
    if (q && (r.name + ' ' + makes).toLowerCase().indexOf(q) < 0) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'sum-row check-row alt-check' + (state.unlocked.indexOf(rid) >= 0 ? ' on' : '');
    var text = document.createElement('span');
    text.className = 'sum-row-name';
    var main = document.createElement('span');
    main.className = 'ac-main';
    main.textContent = r.name;
    var note = document.createElement('span');
    note.className = 'ac-note';
    note.textContent = makes + ' · ' + machineName(rid) + (canBuild(rid) ? '' : ' (unticked)');
    text.appendChild(main);
    text.appendChild(note);
    b.appendChild(text);
    b.addEventListener('click', function () {
      var at = state.unlocked.indexOf(rid);
      state.unlocked = at >= 0
        ? state.unlocked.filter(function (x) { return x !== rid; })
        : state.unlocked.concat([rid]);
      b.classList.toggle('on', at < 0);
      refreshRecipeControls();
      changed();
    });
    altList.appendChild(b);
  });
  if (!altList.firstChild) {
    var none = document.createElement('div');
    none.className = 'ip-empty';
    none.textContent = 'No alternates match';
    altList.appendChild(none);
  }
}

altInput.addEventListener('input', renderAltList);

// The resources this factory may use: a ticked list, all ticked to start.
var resList = document.getElementById('res-list');
function renderResList() {
  resList.innerHTML = '';
  RAW_ITEMS.slice().sort(function (a, b) { return (DATA.items[a].order || 0) - (DATA.items[b].order || 0); }).forEach(function (id) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'sum-row check-row alt-check res-check' + (state.noUse.indexOf(id) < 0 ? ' on' : '');
    var img = document.createElement('img');
    img.className = 'row-icon';
    img.src = iconOf(id);
    img.alt = '';
    b.appendChild(img);
    var text = document.createElement('span');
    text.className = 'sum-row-name';
    var main = document.createElement('span');
    main.className = 'ac-main';
    main.textContent = itemName(id);
    text.appendChild(main);
    b.appendChild(text);
    b.addEventListener('click', function () {
      var at = state.noUse.indexOf(id);
      state.noUse = at >= 0 ? state.noUse.filter(function (x) { return x !== id; }) : state.noUse.concat([id]);
      b.classList.toggle('on', at >= 0);
      refreshRecipeControls();
      changed();
    });
    resList.appendChild(b);
  });
}
document.querySelector('[data-res-all]').addEventListener('click', function () {
  state.noUse = [];
  refreshRecipeControls();
  changed();
});
altFold.querySelectorAll('[data-all]').forEach(function (b) {
  b.addEventListener('click', function () {
    state.unlocked = b.dataset.all === '1' ? UNLOCKABLE.slice() : [];
    renderAltList();
    refreshRecipeControls();
    changed();
  });
});

export { refreshOptNote, refreshRecipeControls, renderAltList };
