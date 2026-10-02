/* Satisfunction — Examples, the header, saves and factory tabs. */

import { DEFAULTS, NEW_TARGET_RATE, emptyHint, importFile, state } from './core.js';
import { FACTORY, PROGRESS, clone, currentFactory, currentSave, newFactoryRecord, newSaveRecord,
  openCurrent, pick, save, store, uid, writeNow } from './store.js';
import { changed, commitTimer, redoStack, refreshHistoryButtons, setLastSnap, snapshot,
  undoStack } from './history.js';
import { applyView, fitView } from './view.js';
import { recompute } from './solve.js';
import { clearSelection, setSelAnchor, setSelected } from './canvas.js';
import { askConfirm, closeAll, confirmEl, openCtx } from './menus.js';
import { applyFolds, askForOutput, renderTargets } from './panel.js';
import { applyShow, refreshClockSeg, refreshModeSeg, refreshTierSegs } from './options.js';
import { refreshRecipeControls, renderAltList } from './recipes.js';
import { customHint } from './model.js';
import { buildModel } from './build.js';

/* ------------------------------------------------------------- examples */

function refreshEmptyHint() {
  customHint.hidden = true;
  // An empty model offers the examples; the views just say there's nothing yet.
  var empty = state.build === 'custom' && !state.custom.nodes.length;
  emptyHint.hidden = !empty;
  if (empty) {
    renderExamples();
    centreEmptyHint();
  }
}

function centreEmptyHint() {}

function renderExamples() {
  var grid = document.getElementById('tpl-grid');
  var list = window.SF_EXAMPLES || [];
  grid.innerHTML = '';

  list.forEach(function (ex) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tpl';

    var name = document.createElement('span');
    name.className = 'tpl-name';
    name.textContent = ex.name;

    var note = document.createElement('span');
    note.className = 'tpl-note';
    note.textContent = ex.note || '';

    btn.appendChild(name);
    btn.appendChild(note);

    // Stop the press reaching the canvas, which would start a pan.
    btn.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    btn.addEventListener('click', function () {
      emptyPlan();
      state.custom = { nodes: [], links: [], notes: [], strokes: [] };
      state.targets = ex.targets.map(function (t) { return { item: t.item, rate: t.rate || NEW_TARGET_RATE }; });
      if (!state.name || /^New factory( \d+)?$/.test(state.name)) {
        state.name = uniqueName(ex.name, currentFactory());
      }
      renderTabs();
      buildModel();
      changed();
      fitView();
    });
    grid.appendChild(btn);
  });
}

document.getElementById('eh-blank').addEventListener('pointerdown', function (e) {
  e.stopPropagation();
});
document.getElementById('eh-blank').addEventListener('click', function () {
  askForOutput(this);
});

/** Everything a plan holds, except its name and the plan-wide settings. */
function emptyPlan() {
  state.targets = [];
  state.recipes = {};
  state.imports = {};
  state.supply = {};
  state.pins = {};
}

/** Empties the model but keeps its name. Callers ask for confirmation. */
function clearPlan() {
  emptyPlan();
  state.custom = { nodes: [], links: [], notes: [], strokes: [] };
  state.optKey = null;
  clearSelection();
  changed();
  fitView();
}

/* ---------------------------------------------------------- header size */

// The header, tabs and toolbar wrap onto extra rows on a narrow window.
// Publishing their real height as --bar-h keeps the canvas and the plan
// tucked underneath instead of covered.
var barEl = document.getElementById('top');

function syncBarHeight() {
  var root = document.documentElement.style;
  root.setProperty('--bar-h', barEl.offsetHeight + 'px');
  root.setProperty('--head-h', barEl.querySelector('.bar').offsetHeight + 'px');
}

if (window.ResizeObserver) new ResizeObserver(syncBarHeight).observe(barEl);
window.addEventListener('resize', syncBarHeight);
syncBarHeight();

/* ------------------------------------------------- saves and factories */

var tabsEl = document.getElementById('tabs');
var saveNameInput = document.getElementById('save-name');

/** Everything on screen redrawn for the open factory. */
function refreshAll() {
  saveNameInput.value = currentSave().name || '';
  fitSaveName();
  showPage();
  refreshModeSeg();
  applyShow();
  refreshClockSeg();
  refreshTierSegs();
  refreshRecipeControls();
  renderAltList();
  applyFolds();
  renderTargets();
  renderTabs();
  applyView();
  recompute();
}

/** Opens another factory (and save): files this one away, starts a fresh history. */
function switchTo(saveId, factoryId) {
  writeNow();
  closeAll();
  setSelected({});
  setSelAnchor(null);
  store.active = saveId;
  var sv = currentSave();
  if (factoryId) sv.active = factoryId;
  var fresh = openCurrent();
  clearTimeout(commitTimer);
  undoStack.length = 0;
  redoStack.length = 0;
  setLastSnap(snapshot());
  refreshHistoryButtons();
  refreshAll();
  if (fresh) fitView();
  writeNow();
}

/**
 * `name`, or if another factory in this save already has it, the next
 * free number after it: "New factory", "New factory 2", "New factory 3".
 */
function uniqueName(name, except) {
  name = (name || '').trim() || 'New factory';
  var taken = currentSave().factories
    .filter(function (f) { return f !== except; })
    .map(function (f) { return factoryLabel(f).toLowerCase(); });
  if (taken.indexOf(name.toLowerCase()) < 0) return name;
  var m = name.match(/^(.*?)(?: (\d+))?$/);
  var stem = m[1];
  var n = m[2] ? Number(m[2]) : 1;
  do { n++; } while (taken.indexOf((stem + ' ' + n).toLowerCase()) >= 0);
  return stem + ' ' + n;
}

function factoryLabel(f) {
  var name = currentFactory() === f ? state.name : f.name;
  return (name || '').trim() || 'New factory';
}

/* ---- tabs ---- */

function renderTabs() {
  var sv = currentSave();
  tabsEl.innerHTML = '';
  sv.factories.forEach(function (f) {
    var on = f.id === sv.active;
    var tab = document.createElement('div');
    tab.className = 'tab' + (on ? ' on' : '');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.title = on ? 'Double-click to rename' : factoryLabel(f);

    var label = document.createElement('span');
    label.className = 'tab-name';
    label.textContent = factoryLabel(f);
    tab.appendChild(label);

    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'tab-x';
    x.title = 'Delete factory';
    x.setAttribute('aria-label', 'Delete ' + factoryLabel(f));
    x.textContent = '×';
    x.addEventListener('click', function (e) {
      e.stopPropagation();
      askConfirm(x, function () { deleteFactory(f); });
    });
    tab.appendChild(x);

    tab.dataset.id = f.id;
    tab.addEventListener('pointerdown', function (e) { dragTab(tab, e); });
    tab.addEventListener('click', function () {
      if (tabDragged) return;
      if (!on) switchTo(sv.id, f.id);
    });
    tab.addEventListener('dblclick', function () {
      if (on) renameTab(tab, f);
    });
    tab.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      closeAll();
      if (!on) switchTo(sv.id, f.id);
      openFactoryMenu(e.clientX, e.clientY);
    });
    tabsEl.appendChild(tab);
  });

  var add = document.createElement('button');
  add.type = 'button';
  add.className = 'tab-add';
  add.title = 'New factory';
  add.setAttribute('aria-label', 'New factory');
  add.textContent = '+';
  add.addEventListener('click', function () { addFactory(newFactoryRecord(uniqueName('New factory'))); });
  tabsEl.appendChild(add);
}

// Dragging a tab sideways reorders it, the tab following the pointer and
// the others making room, as in a browser.
var tabDragged = false;
function dragTab(tab, e) {
  if (e.button !== 0 || e.target.closest('.tab-x, .tab-input')) return;
  var startX = e.clientX;
  var grab = 0;
  var moved = false;
  function move(ev) {
    if (!moved) {
      if (Math.abs(ev.clientX - startX) < 5) return;
      moved = true;
      grab = startX - tab.getBoundingClientRect().left;
      tab.classList.add('dragging');
    }
    var left = ev.clientX - grab;
    var mid = left + tab.offsetWidth / 2;
    var before = null;
    tabsEl.querySelectorAll('.tab').forEach(function (t) {
      if (t === tab || before) return;
      var r = t.getBoundingClientRect();
      if (mid < r.left + r.width / 2) before = t;
    });
    tabsEl.insertBefore(tab, before || tabsEl.querySelector('.tab-add'));
    tab.style.transform = '';
    tab.style.transform = 'translateX(' + (left - tab.getBoundingClientRect().left) + 'px)';
  }
  function up() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!moved) return;
    tabDragged = true;
    setTimeout(function () { tabDragged = false; }, 0);
    var order = [].map.call(tabsEl.querySelectorAll('.tab'), function (t) { return t.dataset.id; });
    currentSave().factories.sort(function (x, y) { return order.indexOf(x.id) - order.indexOf(y.id); });
    renderTabs();
    save();
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/** Renames the open factory in place, on its tab. */
function renameTab(tab, f) {
  var label = tab.querySelector('.tab-name');
  var input = document.createElement('input');
  input.className = 'tab-input';
  input.value = state.name || '';
  input.placeholder = 'New factory';
  input.spellcheck = false;
  label.replaceWith(input);
  input.focus();
  input.select();
  var done = false;
  function finish(keep) {
    if (done) return;
    done = true;
    if (keep) {
      state.name = uniqueName(input.value, currentFactory());
      // The tabs are drawn from the save's records, so this one takes the
      // name now rather than when the save next lands.
      currentFactory().name = state.name;
      save();
    }
    renderTabs();
  }
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', function () { finish(true); });
  input.addEventListener('click', function (e) { e.stopPropagation(); });
  input.addEventListener('dblclick', function (e) { e.stopPropagation(); });
}

function openFactoryMenu(x, y) {
  var f = currentFactory();
  openCtx(x, y, [
    { head: factoryLabel(f) },
    { label: 'Rename', run: function () {
      var tab = tabsEl.querySelector('.tab.on');
      if (tab) renameTab(tab, f);
    } },
    { label: 'Duplicate', note: 'A copy in a new tab', run: duplicateFactory },
    { label: 'Export', note: 'Save this factory as a file', run: exportFactory },
    '-',
    { label: 'Delete factory', danger: true, confirm: true, run: function () { deleteFactory(f); } }
  ]);
}

/* ---- factories ---- */

function addFactory(f, afterId) {
  writeNow();
  var sv = currentSave();
  var at = sv.factories.findIndex(function (o) { return o.id === afterId; });
  if (at >= 0) sv.factories.splice(at + 1, 0, f);
  else sv.factories.push(f);
  switchTo(sv.id, f.id);
}

function duplicateFactory() {
  writeNow();
  var f = currentFactory();
  var copy = clone(f);
  copy.id = uid();
  copy.name = uniqueName(factoryLabel(f));
  addFactory(copy, f.id);
}

function deleteFactory(f) {
  var sv = currentSave();
  var at = sv.factories.indexOf(f);
  if (at < 0) return;
  writeNow();
  sv.factories.splice(at, 1);
  if (!sv.factories.length) sv.factories.push(newFactoryRecord('New factory'));
  if (sv.active === f.id) sv.active = sv.factories[Math.min(at, sv.factories.length - 1)].id;
  // Nothing of the deleted factory may be written back over its neighbour.
  PROGRESS.concat(FACTORY, ['name']).forEach(function (k) { state[k] = clone(DEFAULTS[k]); });
  store.active = sv.id;
  var fresh = openCurrent();
  undoStack.length = 0;
  redoStack.length = 0;
  setLastSnap(snapshot());
  refreshHistoryButtons();
  refreshAll();
  if (fresh) fitView();
  writeNow();
}

/* ---- files ---- */

/** A name reduced to something safe to use as a filename. */
function exportFilename(name, fallback) {
  var base = (name || '').trim()
    .replace(/[\\/:*?"<>|]+/g, '')  // characters filesystems reject
    .replace(/\s+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 60);
  return (base || fallback) + '.json';
}

function download(data, filename) {
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}

// A factory file carries its save's progress too, so it still makes sense
// opened on its own; imported into a save, the save's progress wins.
function exportFactory() {
  writeNow();
  var f = currentFactory();
  download(Object.assign({ app: 'satisfunction', kind: 'factory', version: 3, name: f.name },
    currentSave().progress, f.plan), exportFilename(f.name, 'satisfunction-factory'));
}

function exportSave() {
  writeNow();
  var sv = currentSave();
  download({ app: 'satisfunction', kind: 'save', version: 1, save: sv },
    exportFilename(sv.name, 'satisfunction-save'));
}

document.getElementById('import').addEventListener('click', function () {
  importFile.click();
});

// One button for both: a save file becomes a new save, anything else that
// reads as a plan becomes a new factory in the open save.
importFile.addEventListener('change', async function () {
  var file = importFile.files && importFile.files[0];
  importFile.value = '';
  if (!file) return;
  var data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    data = null;
  }
  if (data && data.kind === 'save' && data.save && Array.isArray(data.save.factories)) {
    writeNow();
    var sv = clone(data.save);
    sv.id = uid();
    sv.name = typeof sv.name === 'string' ? sv.name : '';
    sv.progress = sv.progress && typeof sv.progress === 'object' ? sv.progress : {};
    var isObj = function (v) { return v && typeof v === 'object' && !Array.isArray(v); };
    var kept = sv.factories.filter(isObj);
    var activeAt = Math.max(0, kept.findIndex(function (f) { return f.id === sv.active; }));
    // Fresh ids, with Imports from one factory to another following them.
    var newId = {};
    kept.forEach(function (f) { if (typeof f.id === 'string') newId[f.id] = uid(); });
    sv.factories = kept.map(function (f) {
      var plan = isObj(f.plan) ? f.plan : {};
      ((plan.custom && Array.isArray(plan.custom.nodes)) ? plan.custom.nodes : []).forEach(function (n) {
        if (n && n.type === 'import' && newId[n.from]) n.from = newId[n.from];
      });
      return { id: newId[f.id] || uid(), name: typeof f.name === 'string' ? f.name : '', plan: plan };
    });
    if (!sv.factories.length) sv.factories.push(newFactoryRecord());
    sv.active = sv.factories[Math.min(activeAt, sv.factories.length - 1)].id;
    store.saves.push(sv);
    switchTo(sv.id);
  } else if (data && Array.isArray(data.targets)) {
    var f = newFactoryRecord(uniqueName(typeof data.name === 'string' ? data.name : ''));
    f.plan = pick(data, FACTORY);
    addFactory(f, currentFactory().id);
  } else {
    alert('That file is not a Satisfunction save or factory export.');
  }
});

/* ---- saves ---- */

var saveNameFit = document.getElementById('save-name-fit');
function fitSaveName() {
  saveNameFit.textContent = saveNameInput.value || saveNameInput.placeholder;
  saveNameInput.style.width = Math.min(340, saveNameFit.offsetWidth + 20) + 'px';
}
if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitSaveName);

saveNameInput.addEventListener('input', function () {
  currentSave().name = saveNameInput.value;
  fitSaveName();
  save();
});
saveNameInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveNameInput.blur();
  }
});

function saveLabel(sv) { return (sv.name || '').trim() || 'Untitled save'; }

function newSave() {
  writeNow();
  var sv = newSaveRecord('Save ' + (store.saves.length + 1));
  store.saves.push(sv);
  switchTo(sv.id);
  saveNameInput.focus();
  saveNameInput.select();
}

/** Deletes a save; if it's the open one, the next one along opens. */
function deleteSave(sv) {
  var at = store.saves.indexOf(sv);
  if (at < 0) return;
  if (sv !== currentSave()) {
    store.saves.splice(at, 1);
    writeNow();
    return;
  }
  store.saves.splice(at, 1);
  if (!store.saves.length) store.saves.push(newSaveRecord('My save'));
  store.active = store.saves[Math.min(at, store.saves.length - 1)].id;
  PROGRESS.concat(FACTORY, ['name']).forEach(function (k) { state[k] = clone(DEFAULTS[k]); });
  var fresh = openCurrent();
  undoStack.length = 0;
  redoStack.length = 0;
  setLastSnap(snapshot());
  refreshHistoryButtons();
  refreshAll();
  if (fresh) fitView();
  writeNow();
}

document.getElementById('save-now').addEventListener('click', writeNow);
document.getElementById('save-export').addEventListener('click', exportSave);
document.getElementById('save-import').addEventListener('click', function () { importFile.click(); });

// Browse: every save in a scrolling list, to open or delete, and a new one.
var savePop = document.getElementById('save-pop');
var saveList = document.getElementById('save-list');
var browseBtn = document.getElementById('save-browse');

function renderSaveList() {
  var cur = currentSave();
  saveList.innerHTML = '';
  store.saves.forEach(function (sv) {
    var row = document.createElement('div');
    row.className = 'sp-row' + (sv === cur ? ' on' : '');
    var open = document.createElement('button');
    open.type = 'button';
    open.className = 'sp-open';
    var name = document.createElement('span');
    name.className = 'sp-name';
    name.textContent = saveLabel(sv);
    var n = sv.factories.length;
    var note = document.createElement('span');
    note.className = 'sp-note';
    note.textContent = n + (n === 1 ? ' factory' : ' factories') + (sv === cur ? ' · open' : '');
    open.appendChild(name);
    open.appendChild(note);
    open.addEventListener('click', function () {
      closeSavePop();
      if (sv !== cur) switchTo(sv.id);
    });
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'sp-del';
    del.title = 'Delete ' + saveLabel(sv) + ' and all its factories';
    del.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>';
    del.addEventListener('click', function () {
      askConfirm(del, function () {
        deleteSave(sv);
        renderSaveList();
      });
    });
    row.appendChild(open);
    row.appendChild(del);
    saveList.appendChild(row);
  });
}

function openSavePop() {
  closeAll();
  writeNow();
  renderSaveList();
  var r = browseBtn.getBoundingClientRect();
  savePop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 300)) + 'px';
  savePop.style.top = r.bottom + 6 + 'px';
  savePop.classList.add('show');
  browseBtn.classList.add('open');
}
function closeSavePop() {
  savePop.classList.remove('show');
  browseBtn.classList.remove('open');
}
browseBtn.addEventListener('click', function () {
  if (savePop.classList.contains('show')) closeSavePop();
  else openSavePop();
});
document.getElementById('save-new').addEventListener('click', function () {
  closeSavePop();
  newSave();
});
// Closes on any press outside it, except on the confirmation it raised.
document.addEventListener('pointerdown', function (e) {
  if (!savePop.classList.contains('show')) return;
  if (savePop.contains(e.target) || browseBtn.contains(e.target) || confirmEl.contains(e.target)) return;
  closeSavePop();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeSavePop();
});

/* ---- plan panel pages ---- */

var ptabs = document.getElementById('ptabs');
function showPage() {
  ptabs.querySelectorAll('.ptab').forEach(function (b) {
    var on = b.dataset.page === state.page;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('#panel .ptab-page').forEach(function (p) {
    p.hidden = p.dataset.page !== state.page;
  });
}
ptabs.addEventListener('click', function (e) {
  var b = e.target.closest('.ptab');
  if (!b || b.dataset.page === state.page) return;
  state.page = b.dataset.page;
  showPage();
  writeNow();
});

/* ---- toolbar ---- */

document.getElementById('rename').addEventListener('click', function () {
  var tab = tabsEl.querySelector('.tab.on');
  if (tab) renameTab(tab, currentFactory());
});
document.getElementById('duplicate').addEventListener('click', duplicateFactory);
document.getElementById('export').addEventListener('click', exportFactory);
var deleteBtn = document.getElementById('delete');
deleteBtn.addEventListener('click', function () {
  askConfirm(deleteBtn, function () { deleteFactory(currentFactory()); });
});

var clearBtn = document.getElementById('clear');
clearBtn.addEventListener('click', function () {
  if (!state.custom.nodes.length) return;
  askConfirm(clearBtn, clearPlan);
});

export { clearPlan, factoryLabel, refreshAll, refreshEmptyHint, renderTabs };
