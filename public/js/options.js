/* Satisfunction — The Mode switch, clocks, and the canvas display options. */

import { DATA, fmtNum, stage, state } from './core.js';
import { save, writeNow } from './store.js';
import { changed } from './history.js';
import { fitView } from './view.js';
import { recompute } from './solve.js';
import { hideHoverInfo } from './nodes.js';
import { renderWires } from './wires.js';
import { clearSelection } from './canvas.js';
import { closeAll, openCtx } from './menus.js';
import { refreshRecipeControls } from './recipes.js';
import { floorsUsed, palette } from './model.js';
import { setTool, toolsEl } from './notes.js';

/* ------------------------------------------------------ view and clocks */

// Model is where the factory is made. Item (one card per recipe) and
// Machine (every building at its real footprint) are views of it, worked
// out from the model and not edited directly. One switch holds all three.
var viewSeg = document.getElementById('view-seg');
var balanceSeg = document.getElementById('balance');
var floorPick = document.getElementById('floor-pick');

function currentView() { return state.build === 'custom' ? 'model' : state.mode; }

function refreshModeSeg() {
  var model = state.build === 'custom';
  var machinesOn = !model && state.mode === 'machines';
  viewSeg.querySelectorAll('.seg-btn').forEach(function (b) {
    b.classList.toggle('on', b.dataset.view === currentView());
  });
  // Beside the options button: Manifold or Balancer in the Machine view,
  // Curved or Straight lines in the Item view.
  balanceSeg.hidden = !machinesOn;
  document.getElementById('lines-seg').hidden = model || state.mode !== 'items';
  balanceSeg.querySelectorAll('.seg-btn').forEach(function (b) {
    b.classList.toggle('on', b.dataset.balance === state.balance);
  });
  // A building with floors: all of them, or one at a time.
  var floors = floorsUsed();
  floorPick.hidden = !machinesOn || floors.length < 2;
  document.getElementById('floor-pick-text').textContent =
    floors.indexOf(state.floorShown) >= 0 ? 'Floor ' + state.floorShown : 'All floors';
  document.getElementById('view-note').hidden = model;
  document.getElementById('view-note-text').textContent = state.custom.nodes.length
    ? (machinesOn ? 'Viewing your model, laid out for you · edit it in Model'
      : 'Viewing your model · edit it in Model')
    : 'Nothing to view yet · make something in Model';
  document.body.classList.add('custom-build');
  document.body.classList.toggle('model-canvas', model);
  palette.hidden = !model;
  toolsEl.hidden = !model;
  if (!model) setTool('select');
}

/** Switches between Model and its two views. Nothing in the model changes. */
function setView(v) {
  if (v === currentView()) return;
  closeAll();
  clearSelection();
  hideHoverInfo();
  if (v === 'model') {
    state.build = 'custom';
  } else {
    state.build = 'auto';
    state.mode = v;
  }
  refreshModeSeg();
  refreshRecipeControls();
  recompute();
  fitView();
  save();
}

// One toggle like the others: pressing the view that's on goes back to
// Model, or from Model to the Item view.
viewSeg.addEventListener('click', function (e) {
  var btn = e.target.closest('.seg-btn');
  if (!btn) return;
  var v = btn.dataset.view;
  if (v === currentView()) v = v === 'model' ? 'items' : 'model';
  setView(v);
});

// Manifold: one belt past every machine, a splitter at each. Balancer: a
// tree of splitters giving every machine exactly the same share.
balanceSeg.addEventListener('click', function (e) {
  var btn = e.target.closest('.seg-btn');
  if (!btn || btn.disabled) return;
  state.balance = btn.dataset.balance === state.balance
    ? (state.balance === 'manifold' ? 'balancer' : 'manifold')
    : btn.dataset.balance;
  refreshModeSeg();
  recompute();
  fitView();
});

floorPick.addEventListener('click', function () {
  var r = floorPick.getBoundingClientRect();
  var floors = floorsUsed();
  var shown = floors.indexOf(state.floorShown) >= 0 ? state.floorShown : 0;
  function show(f) {
    state.floorShown = f;
    refreshModeSeg();
    recompute();
    fitView();
  }
  openCtx(r.left, r.bottom + 4, [{ label: 'All floors', note: 'Stacked, the top floor highest', on: !shown, run: function () { show(0); } }]
    .concat(floors.map(function (f) {
      return { label: 'Floor ' + f, on: f === shown, run: function () { show(f); } };
    })), false, Math.max(r.width, 180));
});

var clockSeg = document.getElementById('clock-seg');

function refreshClockSeg() {
  clockSeg.querySelectorAll('.seg-btn').forEach(function (b) {
    b.classList.toggle('on', b.dataset.clock === state.clock);
  });
}

clockSeg.addEventListener('click', function (e) {
  var btn = e.target.closest('.seg-btn');
  if (!btn || btn.dataset.clock === state.clock) return;
  state.clock = btn.dataset.clock;
  refreshClockSeg();
  changed();
});

/* -------------------------------------------------------- canvas labels */

// What the canvas spells out: what each building makes, the rates on the
// lines, and full or two-letter building names. Pure display, so it's all
// CSS classes on the stage and nothing is re-solved.
var viewOpts = document.getElementById('view-opts');
var voBtn = document.getElementById('view-opts-btn');
var voMenu = document.getElementById('vo-menu');
var linesSeg = document.getElementById('lines-seg');

function applyShow() {
  stage.classList.toggle('hide-products', !state.show.products);
  stage.classList.toggle('hide-rates', !state.show.rates);
  stage.classList.toggle('short-names', state.show.short);
  stage.classList.toggle('hide-clocks', !state.show.clocks);
  linesSeg.querySelectorAll('[data-lines]').forEach(function (b) {
    b.classList.toggle('on', b.dataset.lines === state.show.lines);
  });
  voMenu.querySelectorAll('[data-show]').forEach(function (b) {
    var on = !!state.show[b.dataset.show];
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

function setOptsOpen(open) {
  voMenu.hidden = !open;
  voBtn.classList.toggle('primary', open);
  voBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

voBtn.addEventListener('click', function () { setOptsOpen(voMenu.hidden); });
// Curved or straight (Item view): one toggle, pressing either side.
linesSeg.addEventListener('click', function (e) {
  var l = e.target.closest('[data-lines]');
  if (!l) return;
  state.show.lines = l.dataset.lines === state.show.lines
    ? (state.show.lines === 'curved' ? 'straight' : 'curved')
    : l.dataset.lines;
  applyShow();
  writeNow();
  if (state.mode === 'items') renderWires();
});
voMenu.addEventListener('click', function (e) {
  var b = e.target.closest('[data-show]');
  if (!b) return;
  state.show[b.dataset.show] = !state.show[b.dataset.show];
  applyShow();
  writeNow();
});
document.addEventListener('pointerdown', function (e) {
  if (!voMenu.hidden && !viewOpts.contains(e.target)) setOptsOpen(false);
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && !voMenu.hidden) setOptsOpen(false);
});

// The fastest belt and pipe the build may use. A line of machines whose
// belts would need more is split into parallel lines.
var beltSeg = document.getElementById('belt-seg');
var pipeSeg = document.getElementById('pipe-seg');

function buildTierSegs() {
  [[beltSeg, DATA.logistics.belts, 'belt'], [pipeSeg, DATA.logistics.pipes, 'pipe']].forEach(function (set) {
    set[0].innerHTML = '';
    set[1].forEach(function (rate, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn';
      b.dataset.tier = i + 1;
      b.textContent = 'Mk.' + (i + 1);
      b.title = fmtNum(rate) + (set[2] === 'pipe' ? ' m³' : '') + '/min';
      set[0].appendChild(b);
    });
    set[0].addEventListener('click', function (e) {
      var btn = e.target.closest('.seg-btn');
      if (!btn) return;
      var tier = Number(btn.dataset.tier);
      if (state[set[2]] === tier) return;
      state[set[2]] = tier;
      refreshTierSegs();
      changed();
    });
  });
}

function refreshTierSegs() {
  beltSeg.querySelectorAll('.seg-btn').forEach(function (b) {
    b.classList.toggle('on', Number(b.dataset.tier) === state.belt);
  });
  pipeSeg.querySelectorAll('.seg-btn').forEach(function (b) {
    b.classList.toggle('on', Number(b.dataset.tier) === state.pipe);
  });
}

export { applyShow, buildTierSegs, refreshClockSeg, refreshModeSeg, refreshTierSegs };
