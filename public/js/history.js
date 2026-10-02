/* Satisfunction — Undo and redo. */

import { redoBtn, state, undoBtn } from './core.js';
import { save, writeNow } from './store.js';
import { recompute } from './solve.js';
import { renderTargets } from './panel.js';
import { renderTabs } from './factories.js';
import { refreshClockSeg, refreshTierSegs } from './options.js';
import { refreshRecipeControls, renderAltList } from './recipes.js';

/* --------------------------------------------------------------- history */

// Snapshot-based undo. The camera, the panel and which view is showing are
// deliberately left out — looking around isn't an edit.
var undoStack = [];
var redoStack = [];
var lastSnap = null;
var commitTimer = null;
var MAX_HISTORY = 80;

var UNDOABLE = ['name', 'targets', 'recipes', 'imports', 'supply', 'clock', 'belt', 'pipe',
  'picker', 'goal', 'unlocked', 'unavailable', 'pins', 'custom', 'optKey', 'noUse'];

function snapshot() {
  var snap = {};
  UNDOABLE.forEach(function (k) { snap[k] = state[k]; });
  return JSON.stringify(snap);
}

/** Records the current state as an undo step, if anything actually changed. */
function commitNow() {
  clearTimeout(commitTimer);
  var next = snapshot();
  if (lastSnap === null || next === lastSnap) {
    lastSnap = next;
    return;
  }
  undoStack.push(lastSnap);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  lastSnap = next;
  refreshHistoryButtons();
}

// Delayed so a burst of typing collapses into one undo step rather than one
// per keystroke.
function scheduleCommit() {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(commitNow, 650);
}

function applySnapshot(json) {
  var d = JSON.parse(json);
  UNDOABLE.forEach(function (k) { if (k in d) state[k] = d[k]; });
  renderTabs();
  refreshClockSeg();
  refreshTierSegs();
  refreshRecipeControls();
  renderAltList();
  renderTargets();
  recompute();
  writeNow();
}

function undo() {
  commitNow(); // fold in anything still pending before stepping back
  if (!undoStack.length) return;
  redoStack.push(lastSnap);
  applySnapshot(undoStack.pop());
  lastSnap = snapshot();
  refreshHistoryButtons();
}

function redo() {
  clearTimeout(commitTimer);
  if (!redoStack.length) return;
  undoStack.push(lastSnap);
  applySnapshot(redoStack.pop());
  lastSnap = snapshot();
  refreshHistoryButtons();
}

function refreshHistoryButtons() {
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
}

/** An edit to the plan: re-solve, redraw, save. */
function changed() {
  recompute();
  save();
}

// Other files change these through here: an imported name can't be assigned to.
function setLastSnap(v) { lastSnap = v; return v; }

export { changed, commitTimer, redo, redoStack, refreshHistoryButtons, scheduleCommit,
  setLastSnap, snapshot, undo, undoStack };
