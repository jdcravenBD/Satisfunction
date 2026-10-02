/* Satisfunction — Saving and loading: saves, factories and their format in localStorage. */

import { BUILDINGS, DATA, DEFAULTS, KEY, SOLVER, clamp, state, unlockable } from './core.js';
import { scheduleCommit } from './history.js';
import { RULE_NAMES, isRuled, slotsOf } from './model.js';

/* ---------------------------------------------------------------- store */

/*
 * Plans are kept as main saves, each holding factories. A save is one game:
 * what the player has unlocked (alternates, buildings, the fastest belt and
 * pipe, the miner new resources start on) is shared by all its factories.
 * A factory is one production line: its outputs, recipes, nodes, clocks
 * and view. `state` is always the open factory with its save's progress
 * folded in; writeNow() files it back.
 */
var STORE_KEY = 'satisfunction.saves.v1';
var PROGRESS = ['unlocked', 'altsSet', 'unavailable', 'belt', 'pipe', 'defaultMiner'];
var FACTORY = ['targets', 'recipes', 'imports', 'supply', 'clock', 'picker', 'goal',
  'pins', 'view', 'mode', 'balance', 'build', 'custom', 'optKey', 'modelled', 'noUse'];
var store = null;  // { active, saves: [{ id, name, active, progress, factories: [{ id, name, plan }] }], prefs }

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function pick(obj, keys) {
  var out = {};
  keys.forEach(function (k) { if (obj[k] !== undefined) out[k] = clone(obj[k]); });
  return out;
}

function newFactoryRecord(name) { return { id: uid(), name: name || '', plan: {} }; }
function newSaveRecord(name) {
  var f = newFactoryRecord('New factory');
  return { id: uid(), name: name || '', active: f.id, progress: {}, factories: [f] };
}

function currentSave() {
  return store.saves.filter(function (sv) { return sv.id === store.active; })[0] || store.saves[0];
}
function currentFactory() {
  var sv = currentSave();
  return sv.factories.filter(function (f) { return f.id === sv.active; })[0] || sv.factories[0];
}

/** Reads the saves, turning a plan from before saves existed into the first one. */
function load() {
  try {
    var raw = localStorage.getItem(STORE_KEY);
    if (raw) store = JSON.parse(raw);
  } catch (e) {
    console.warn('Could not read saves:', e);
  }
  if (!store || !Array.isArray(store.saves) || !store.saves.length) {
    store = { active: null, saves: [], prefs: {} };
    var sv = newSaveRecord('My save');
    try {
      var old = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (old && Array.isArray(old.targets)) {
        sv.progress = pick(old, PROGRESS);
        sv.factories[0].plan = pick(old, FACTORY);
        sv.factories[0].name = old.name || '';
        store.prefs = pick(old, ['folds', 'show', 'page']);
      }
    } catch (e) { /* nothing to bring over */ }
    store.saves.push(sv);
    store.active = sv.id;
  }
  store.prefs = store.prefs || {};
  store.saves.forEach(function (sv) {
    sv.progress = sv.progress || {};
    if (!sv.factories || !sv.factories.length) sv.factories = [newFactoryRecord()];
    if (!sv.factories.some(function (f) { return f.id === sv.active; })) sv.active = sv.factories[0].id;
  });
  if (!store.saves.some(function (sv) { return sv.id === store.active; })) store.active = store.saves[0].id;
  return openCurrent();
}

/** Loads the open factory of the open save into `state`. */
function openCurrent() {
  var sv = currentSave();
  var f = currentFactory();
  PROGRESS.concat(FACTORY, ['name']).forEach(function (k) { state[k] = clone(DEFAULTS[k]); });
  adopt(Object.assign({}, store.prefs, sv.progress, f.plan, { name: f.name }));
  return !f.plan.view;
}

/**
 * A saved Custom build, cleaned: cards of a known type with what they
 * need, and lines between slots that exist. (Builds from before Custom
 * placed items, rather than buildings, are left behind.)
 */
// Past any real factory; beyond these a typo (1e9 machines) would hang the
// page working out every machine.
var MAX_SET = 10000;      // machines on one Set card
var MAX_NODES = 1000;     // resource nodes on one card
var MAX_RATE = 1000000;   // per minute, brought in or asked for

function readCustom(c) {
  var out = { nodes: [], links: [], notes: [], strokes: [] };
  if (!c || !Array.isArray(c.nodes)) return out;
  (Array.isArray(c.notes) ? c.notes : []).forEach(function (n) {
    if (!n || !isFinite(n.x) || !isFinite(n.y)) return;
    out.notes.push({ id: String(n.id || uid()), x: Math.round(n.x), y: Math.round(n.y), text: String(n.text || '').slice(0, 5000) });
  });
  (Array.isArray(c.strokes) ? c.strokes : []).forEach(function (k) {
    if (!k || !Array.isArray(k.pts) || k.pts.length < 4 || k.pts.length % 2) return;
    if (!k.pts.every(isFinite)) return;
    var sw = Number(k.w);
    out.strokes.push({ id: String(k.id || uid()), pts: k.pts.slice(0, 8000).map(Math.round), w: sw > 0 && sw < 400 ? sw : 3 });
  });
  var byId = {};
  c.nodes.forEach(function (n) {
    if (!n || !isFinite(n.x) || !isFinite(n.y)) return;
    var q = { id: String(n.id || uid()), type: n.type, x: Math.round(n.x), y: Math.round(n.y) };
    if (n.type === 'recipe') {
      if (!DATA.recipes[n.recipe]) return;
      q.recipe = n.recipe;
      q.item = DATA.items[n.item] ? n.item : DATA.recipes[n.recipe].out[0][0];
      if (n.set) { q.set = true; q.count = clamp(Number(n.count) || 0, 0, MAX_SET); }
      if (Number(n.clock) > 0) q.clock = clamp(Number(n.clock), 0.01, SOLVER.MAX_CLOCK);
      var slots = DATA.machines[DATA.recipes[n.recipe].machine].sloops || 0;
      if (Number(n.sloops) > 0 && slots) q.sloops = clamp(Math.round(Number(n.sloops)), 1, slots);
    } else if (n.type === 'resource') {
      if (!DATA.items[n.item] || !DATA.items[n.item].raw) return;
      q.item = n.item;
      q.purity = SOLVER.PURITIES.indexOf(n.purity) >= 0 ? n.purity : 'normal';
      if (DATA.extractors[n.miner]) q.miner = n.miner;
      q.count = clamp(Math.round(Number(n.count) || 1), 1, MAX_NODES);
      q.clock = clamp(Number(n.clock) || 1, 0.01, SOLVER.MAX_CLOCK);
    } else if (n.type === 'import') {
      if (!DATA.items[n.item]) return;
      q.item = n.item;
      q.rate = clamp(Number(n.rate) || 0, 0, MAX_RATE);
      if (typeof n.from === 'string' && n.from) q.from = n.from;  // another factory in the save
      else if (n.standIn) q.standIn = true;  // in place of something Build couldn't make
    } else if (n.type === 'splitter' || n.type === 'merger') {
      if (n.type === 'splitter' && n.programmable) q.programmable = true;
      else if (n.priority) q.priority = true;  // Smart Splitter, Priority Merger
      // A Smart or Programmable Splitter's rules: per output, items or
      // Any / None / Any Undefined / Overflow (a Smart Splitter's one each).
      if (isRuled(q) && Array.isArray(n.rules) && n.rules.length === 3) {
        q.rules = n.rules.map(function (list) {
          var ok = (Array.isArray(list) ? list : []).filter(function (r, i, all) {
            return typeof r === 'string' && (RULE_NAMES[r] || DATA.items[r]) && r !== 'none' && all.indexOf(r) === i;
          });
          return ok.slice(0, q.programmable ? 64 : 1);
        });
      }
    } else if (n.type !== 'sink' && n.type !== 'awesome') {
      return;
    }
    out.nodes.push(q);
    byId[q.id] = q;
  });
  (c.links || []).forEach(function (l) {
    var a = l && byId[l.from], b = l && byId[l.to];
    if (!a || !b || a === b) return;
    var fk = l.fk | 0, tk = l.tk | 0;
    if (fk < 0 || fk >= slotsOf(a).outs.length || tk < 0 || tk >= slotsOf(b).ins.length) return;
    out.links.push({ id: String(l.id || uid()), from: a.id, fk: fk, to: b.id, tk: tk });
  });
  return out;
}

/** Copies a saved or imported plan into state, dropping anything unknown. */
function adopt(data) {
  if (!data || typeof data !== 'object') return false;
  state.name = typeof data.name === 'string' ? data.name : '';
  state.targets = (Array.isArray(data.targets) ? data.targets : [])
    .filter(function (t) { return t && DATA.items[t.item]; })
    .map(function (t) {
      var out = { item: t.item, rate: clamp(Number(t.rate) || 0, 0, MAX_RATE) };
      if (t.max) out.max = true;
      return out;
    });
  state.recipes = {};
  Object.keys(data.recipes || {}).forEach(function (id) {
    // A recipe id, or a mix of them: { recipeId: share }.
    if (DATA.items[id] && SOLVER.readMix(DATA, id, data.recipes[id])) state.recipes[id] = data.recipes[id];
  });
  state.picker = data.picker === 'optimise' ? 'optimise' : 'manual';
  state.goal = ['resources', 'power', 'machines'].indexOf(data.goal) >= 0 ? data.goal : 'resources';
  state.unlocked = (Array.isArray(data.unlocked) ? data.unlocked : []).filter(function (rid) {
    return DATA.recipes[rid] && unlockable(rid);
  });
  // Older plans had a None / Unlocked / All switch over the ticked list.
  if (data.alts === 'all') state.unlocked = Object.keys(DATA.recipes).filter(unlockable);
  if (data.alts === 'none') state.unlocked = [];
  // A save starts with every alternate ticked; older saves get that once.
  if (!data.altsSet) state.unlocked = Object.keys(DATA.recipes).filter(unlockable);
  state.altsSet = true;
  state.imports = {};
  Object.keys(data.imports || {}).forEach(function (id) {
    if (data.imports[id] && DATA.items[id]) state.imports[id] = true;
  });
  state.supply = {};
  Object.keys(data.supply || {}).forEach(function (id) {
    var s = data.supply[id];
    if (!s || !DATA.items[id] || !DATA.items[id].raw) return;
    var miner = DATA.extractors[s.miner] ? s.miner : undefined;
    state.supply[id] = {
      nodes: (Array.isArray(s.nodes) ? s.nodes : []).map(function (n) {
        var p = typeof n === 'string' ? n : n && n.purity;
        if (SOLVER.PURITIES.indexOf(p) < 0) return null;
        var out = { purity: p };
        var m = n && typeof n === 'object' && DATA.extractors[n.miner] ? n.miner : miner;
        if (m) out.miner = m;
        return out;
      }).filter(Boolean),
      miner: miner
    };
  });
  state.clock = ['none', 'even', 'fill', 'max'].indexOf(data.clock) >= 0 ? data.clock : 'none';
  state.custom = readCustom(data.custom);
  state.optKey = typeof data.optKey === 'string' ? data.optKey : null;
  state.noUse = (Array.isArray(data.noUse) ? data.noUse : []).filter(function (id, i, all) {
    return DATA.items[id] && DATA.items[id].raw && all.indexOf(id) === i;
  });
  // Plans from before the model was the main thing: an Auto plan becomes
  // a model on the first redraw (see recompute), and shows in Model.
  if (data.modelled) {
    state.build = data.build === 'auto' ? 'auto' : 'custom';
    state.legacy = false;
  } else {
    state.build = 'custom';
    state.legacy = data.build !== 'custom' && !state.custom.nodes.length && state.targets.length > 0;
  }
  state.modelled = true;
  state.unavailable = (Array.isArray(data.unavailable) ? data.unavailable : []).filter(function (id) {
    return BUILDINGS.indexOf(id) >= 0;
  });
  var show = data.show || {};
  state.show = {
    products: show.products !== false,
    rates: show.rates !== false,
    clocks: show.clocks !== false,
    short: !!show.short,
    lines: show.lines === 'straight' ? 'straight' : 'curved'
  };
  state.belt = clamp(Math.round(Number(data.belt)) || DATA.logistics.belts.length, 1, DATA.logistics.belts.length);
  state.pipe = clamp(Math.round(Number(data.pipe)) || DATA.logistics.pipes.length, 1, DATA.logistics.pipes.length);
  state.pins = data.pins && typeof data.pins === 'object' ? data.pins : {};
  if (DATA.extractors[data.defaultMiner]) state.defaultMiner = data.defaultMiner;
  if (data.view && isFinite(data.view.s)) state.view = data.view;
  if (data.mode === 'machines' || data.mode === 'items') state.mode = data.mode;
  if (data.balance === 'balancer' || data.balance === 'manifold') state.balance = data.balance;
  if (['details', 'overview', 'power'].indexOf(data.page) >= 0) state.page = data.page;
  state.folds = {};
  Object.keys(data.folds || {}).forEach(function (k) {
    if (typeof data.folds[k] === 'boolean') state.folds[k] = data.folds[k];
  });
  return true;
}

var saveTimer = null;
var SAVE_DELAY = 1500;  // long enough for the save button to show it's pending
var dirty = false;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, SAVE_DELAY);
  setDirty(true);
  scheduleCommit();
}

function setDirty(on) {
  dirty = on;
  var b = document.getElementById('save-now');
  if (!b) return;
  b.classList.toggle('saved', !on);
  b.title = on ? 'Unsaved changes: saving in a moment, or click to save now' : 'All changes saved';
}

function writeNow() {
  clearTimeout(saveTimer);
  if (!store) return;
  var f = currentFactory();
  f.name = state.name;
  f.plan = pick(state, FACTORY);
  currentSave().progress = pick(state, PROGRESS);
  store.prefs = pick(state, ['folds', 'show', 'page']);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
    setDirty(false);
  } catch (e) {
    console.warn('Could not save:', e);
  }
}

// Anything still waiting is written before the page goes.
window.addEventListener('pagehide', function () { if (dirty) writeNow(); });

export { FACTORY, MAX_NODES, MAX_RATE, MAX_SET, PROGRESS, clone, currentFactory, currentSave,
  load, newFactoryRecord, newSaveRecord, openCurrent, pick, readCustom, save, setDirty, store,
  uid, writeNow };
