/* Satisfunction — production planner.
   Built on the GCL board shell: same pan/zoom canvas, curved wires, menus and
   history. Instead of cards the user places, the canvas shows a plan the
   solver generates from the outputs asked for. The user steers it by picking
   recipes, importing items, and dragging nodes where they want them. */

(function () {
  'use strict';

  var DATA = window.SF_DATA;
  var SOLVER = window.SF_SOLVER;
  var OPTIMISE = window.SF_OPTIMISE;

  var KEY = 'satisfunction.plan.v1';
  var EPS = 1e-9;

  var NODE_W = 224;
  var COL_GAP = 150;   // room between columns for the rate labels
  var ROW_GAP = 34;
  var MIN_ZOOM = 0.1;
  var MAX_ZOOM = 2.5;
  var NEW_TARGET_RATE = 10;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  var stage = document.getElementById('stage');
  var world = document.getElementById('world');
  var labelsEl = document.getElementById('labels');
  var emptyHint = document.getElementById('empty');
  var tpl = document.getElementById('node-tpl');
  var importFile = document.getElementById('import-file');
  var undoBtn = document.getElementById('undo');
  var redoBtn = document.getElementById('redo');
  var errorEl = document.getElementById('solve-error');

  var state = {
    name: '',
    targets: [],   // [{ item, rate, max }] — what the plan is for, per minute
    recipes: {},   // item -> recipe id, where the user overrode the default
    imports: {},   // item -> true, when it comes from outside this factory
    supply: {},    // raw item -> { nodes: [{ purity, miner }], miner }
    clock: 'none', // how work is split over machines: 'none', 'even', 'fill' or 'max'
    unavailable: [], // buildings the user doesn't have yet
    belt: 6,       // fastest conveyor tier the build may use, 1–6
    pipe: 2,       // fastest pipeline tier, 1–2
    picker: 'manual',     // who picks recipes: 'manual' or 'optimise'
    goal: 'resources',    // what the optimiser minimises after max outputs
    unlocked: [],         // alternate (and converter) recipes the user has
    pins: {},      // node key -> { x, y }, for nodes moved in the item view
    defaultMiner: 'Build_MinerMk1_C',
    view: { x: 60, y: 40, s: 1 },
    mode: 'items', // 'items' or 'machines'
    folds: {},     // panel sections the user has collapsed: { inputs: true }
    show: { products: true, rates: true, clocks: true, short: false }, // what the canvas labels
    page: 'details', // the plan panel's page: 'details', 'overview' or 'power'
    balance: 'manifold' // machine view inputs: 'manifold' or 'balancer'
  };

  // What a new factory starts from.
  var DEFAULTS = JSON.parse(JSON.stringify(state));

  /** Pins for whichever view is showing. The machine view is laid out
      automatically and can't be rearranged, so it has none. */
  function pins() {
    return state.mode === 'machines' ? {} : state.pins;
  }

  var solved = null;       // last solver result
  var graph = { nodes: [], edges: [], byKey: {} };

  /* ------------------------------------------------------------- lookups */

  // Every recipe that makes an item, main product or not.
  var producersOf = {};
  Object.keys(DATA.recipes).forEach(function (rid) {
    DATA.recipes[rid].out.forEach(function (p) {
      (producersOf[p[0]] = producersOf[p[0]] || []).push(rid);
    });
  });

  // What can be asked for: anything the factory can make.
  var PICKABLE = Object.keys(DATA.defaults)
    .filter(function (id) { return !DATA.items[id].raw; })
    .sort(function (a, b) { return itemName(a).localeCompare(itemName(b)); });

  function itemName(id) {
    var it = DATA.items[id];
    return it ? it.name : id;
  }

  function isFluid(id) {
    var it = DATA.items[id];
    return !!it && it.form !== 'solid';
  }

  function machineName(rid) {
    return DATA.machines[DATA.recipes[rid].machine].name;
  }

  /** The recipe the plan uses for an item right now, or null. */
  /** Recipes the game makes you unlock: alternates, and the Converter's. */
  function unlockable(rid) {
    var r = DATA.recipes[rid];
    return !!r && (!!r.alt || r.machine === 'Build_Converter_C');
  }

  /** Whether the optimiser may use a recipe, given the alternates setting. */
  function recipeAllowed(rid) {
    if (!unlockable(rid)) return true;
    return state.unlocked.indexOf(rid) >= 0;
  }

  /**
   * The recipes an item uses as picked: a recipe id, or a mix of them, or in
   * optimise mode only what the user pinned (null: the optimiser decides).
   */
  function currentRecipe(id) {
    if (state.imports[id]) return null;
    var pick = state.recipes[id];
    if (pick) return pick;
    return state.picker === 'optimise' ? null : DATA.defaults[id] || null;
  }

  function isPicked(pick, rid) {
    if (!pick) return false;
    return typeof pick === 'string' ? pick === rid : pick[rid] > 0;
  }

  /** The user's supply setting for a raw input, with plan defaults filled in. */
  // A resource the user hasn't set up is assumed to come from one normal node.
  var DEFAULT_NODES = ['normal'];

  function supplyOf(id) {
    var s = state.supply[id];
    var miner = availableMiner((s && s.miner) || state.defaultMiner);
    return {
      nodes: storedNodes(id).map(function (n) {
        return { purity: n.purity, miner: availableMiner(n.miner || miner) };
      }),
      miner: miner
    };
  }

  /** A resource's nodes as the user set them: [{ purity, miner? }]. */
  function storedNodes(id) {
    var s = state.supply[id];
    var list = s ? s.nodes || [] : DEFAULT_NODES;
    return list.map(function (n) {
      return typeof n === 'string' ? { purity: n } : { purity: n.purity, miner: n.miner };
    });
  }

  /** How a raw input is extracted, or null if the user lacks the building. */
  function supplyInfo(id) {
    var info = SOLVER.supplyInfo(DATA, id, supplyOf(id));
    return info && hasBuilding(info.extractor) ? info : null;
  }

  /* ------------------------------------------------------------ buildings */

  // Every building a plan can place, in roughly the order the game unlocks them.
  var MINERS = ['Build_MinerMk1_C', 'Build_MinerMk2_C', 'Build_MinerMk3_C'];
  var BUILDINGS = ['Build_SmelterMk1_C', 'Build_ConstructorMk1_C', 'Build_AssemblerMk1_C',
    'Build_FoundryMk1_C', 'Build_ManufacturerMk1_C', 'Build_OilRefinery_C', 'Build_Packager_C',
    'Build_Blender_C', 'Build_HadronCollider_C', 'Build_Converter_C', 'Build_QuantumEncoder_C']
    .concat(Object.keys(DATA.machines))
    .concat(MINERS, ['Build_WaterPump_C', 'Build_OilPump_C', 'Build_FrackingExtractor_C'])
    .concat(Object.keys(DATA.extractors))
    .filter(function (id, i, all) {
      return (DATA.machines[id] || DATA.extractors[id]) && all.indexOf(id) === i;
    });

  function buildingName(id) {
    return (DATA.machines[id] || DATA.extractors[id]).name;
  }

  function hasBuilding(id) { return state.unavailable.indexOf(id) < 0; }
  function canBuild(rid) { return hasBuilding(DATA.recipes[rid].machine); }

  /** The miner picked, or the nearest one the user has: down a mark, else up. */
  function availableMiner(mid) {
    if (hasBuilding(mid)) return mid;
    var i = MINERS.indexOf(mid);
    for (var d = i - 1; d >= 0; d--) if (hasBuilding(MINERS[d])) return MINERS[d];
    for (var u = i + 1; u < MINERS.length; u++) if (hasBuilding(MINERS[u])) return MINERS[u];
    return mid;  // none at all: supplyInfo turns the resource into a plain input
  }

  // Two letters in place of a building's name, when the user asks for them.
  var SHORT_NAMES = {
    'Smelter': 'SM', 'Constructor': 'CN', 'Assembler': 'AS', 'Foundry': 'FD',
    'Manufacturer': 'MF', 'Refinery': 'RF', 'Packager': 'PK', 'Blender': 'BL',
    'Particle Accelerator': 'PA', 'Converter': 'CV', 'Quantum Encoder': 'QE',
    'Miner Mk.1': 'M1', 'Miner Mk.2': 'M2', 'Miner Mk.3': 'M3',
    'Water Extractor': 'WE', 'Oil Extractor': 'OE', 'Resource Well Extractor': 'RW',
    'Storage Container': 'SC', 'Fluid Buffer': 'FB', 'AWESOME Sink': 'SK'
  };

  function shortName(name) {
    return SHORT_NAMES[name] || name.split(/\s+/).map(function (w) { return w.charAt(0); }).join('').toUpperCase();
  }

  /** A building's name that the "Short names" option swaps for its letters. */
  function nameSpans(parent, name) {
    var full = document.createElement('span');
    full.className = 'nm-full';
    full.textContent = name;
    var abbr = document.createElement('span');
    abbr.className = 'nm-short';
    abbr.textContent = shortName(name);
    parent.appendChild(full);
    parent.appendChild(abbr);
    return parent;
  }

  /**
   * A pick (a recipe id, or a mix of them) with any recipe the user can't
   * build dropped; null if that leaves nothing.
   */
  function buildablePick(pick) {
    if (!pick) return null;
    if (typeof pick === 'string') return canBuild(pick) ? pick : null;
    var out = null;
    Object.keys(pick).forEach(function (rid) {
      if (DATA.recipes[rid] && canBuild(rid)) (out = out || {})[rid] = pick[rid];
    });
    return out;
  }

  /**
   * In place of a recipe needing a building the user lacks: another that
   * makes the item without it. Standard recipes first, then unlocked
   * alternates, then any alternate, then ones that make it on the side.
   */
  function fallbackRecipe(id) {
    var list = (producersOf[id] || []).filter(canBuild);
    function rank(rid) {
      var r = DATA.recipes[rid];
      if (r.out[0][0] !== id) return 3;
      if (!unlockable(rid)) return 0;
      return state.unlocked.indexOf(rid) >= 0 ? 1 : 2;
    }
    list.sort(function (a, b) {
      return rank(a) - rank(b) || DATA.recipes[a].name.localeCompare(DATA.recipes[b].name);
    });
    return list[0] || null;
  }

  // Items no building the user has can make: they're brought in instead,
  // mapped to the building their usual recipe needs. Set by recompute().
  var blocked = {};

  /**
   * The recipes and imports the solver works from, given the buildings the
   * user has. In optimise mode only the user's own picks are passed (as
   * pins), unless `fallbacks` asks for the manual stand-ins as well; the
   * optimiser skips anything it can't build by itself.
   */
  function buildablePlan(fallbacks) {
    var recipes = {};
    var imports = {};
    blocked = {};
    Object.keys(state.imports).forEach(function (id) { imports[id] = true; });
    Object.keys(state.recipes).forEach(function (id) {
      var pick = buildablePick(state.recipes[id]);
      if (pick) recipes[id] = pick;
    });
    Object.keys(producersOf).forEach(function (id) {
      if (imports[id] || DATA.items[id].raw) return;
      if (!(producersOf[id] || []).some(canBuild)) {
        var def = DATA.defaults[id] || producersOf[id][0];
        blocked[id] = DATA.recipes[def].machine;
        imports[id] = true;
        delete recipes[id];
        return;
      }
      if ((state.picker === 'optimise' && !fallbacks) || recipes[id]) return;
      var def2 = DATA.defaults[id];
      if (def2 && canBuild(def2) && !state.recipes[id]) return;
      var alt = fallbackRecipe(id);
      if (alt) recipes[id] = alt;
    });
    return { recipes: recipes, imports: imports };
  }

  /* ---------------------------------------------------------------- clocks */

  /**
   * Most a recipe's machines may be overclocked: 250%, less if one of its
   * belts or pipes couldn't carry what an overclocked machine moves.
   */
  function clockTop(rid) {
    var r = DATA.recipes[rid];
    var k = 60 / r.time;
    var top = SOLVER.MAX_CLOCK;
    r.in.concat(r.out).forEach(function (p) {
      var cap = isFluid(p[0]) ? DATA.logistics.pipes[state.pipe - 1] : DATA.logistics.belts[state.belt - 1];
      if (p[1] > 0) top = Math.min(top, cap / (p[1] * k));
    });
    return Math.max(1, top);
  }

  function recipeClocks(rid, count) {
    return SOLVER.clocks(count, state.clock, clockTop(rid));
  }

  /** Power Shards a machine at clock `c` needs: one per 50% past 100%. */
  function shardsFor(c) {
    return c > 1 + 1e-6 ? Math.ceil((c - 1) / 0.5 - 1e-6) : 0;
  }

  /** Most each raw input can supply, for the ones with resource nodes set. */
  var RAW_ITEMS = Object.keys(DATA.items).filter(function (id) { return DATA.items[id].raw; });

  function currentCaps() {
    var caps = {};
    RAW_ITEMS.forEach(function (id) {
      var info = supplyInfo(id);
      if (info && info.capacity != null) caps[id] = info.capacity;
    });
    return caps;
  }

  /**
   * The extractors behind a raw input, each with its purity and clock, or null
   * when they aren't known yet ("any node"). Miners on a site share the load
   * evenly, so they all run at the same clock.
   */
  function extractorsFor(id, used) {
    var info = supplyInfo(id);
    if (!info) return null;
    if (!info.purity) {
      // Water Extractors go anywhere, so the plan simply uses enough of them.
      return {
        info: info,
        list: SOLVER.clocks(used / info.baseRate, state.clock,
          DATA.logistics.pipes[state.pipe - 1] / info.baseRate).map(function (c) {
          return { purity: null, clock: c, extractor: info.extractor, rate: info.baseRate };
        })
      };
    }
    if (!info.nodeList.length) return null;
    var ratio = info.capacity > EPS ? Math.min(1, used / info.capacity) : 0;
    return {
      info: info,
      list: info.nodeList.map(function (nd) {
        return { purity: nd.purity, clock: ratio, extractor: nd.extractor, rate: nd.rate };
      })
    };
  }

  function titleCase(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  /**
   * A machine's clock label for `c` machines' worth of work. With "All at
   * 100%" nothing is clocked: a machine with less to do idles part-time.
   */
  function clockLabel(c) {
    if (state.clock !== 'none') return fmtClock(c);
    return c < 1 - 1e-6 ? '100% · ' + fmtClock(c) + ' busy' : '100%';
  }

  /** What the clock is set to in game: the work share, or 100% when unclocked. */
  function clockSetting(c) { return state.clock === 'none' ? 1 : c; }

  /** "83.33%": clock speeds to two places, which is plenty to set in game. */
  function fmtClock(c) {
    return Number((c * 100).toFixed(2)) + '%';
  }

  /* ------------------------------------------------------------ numbers */

  function fmtNum(n) {
    var a = Math.abs(n);
    var digits = a >= 100 ? 1 : a >= 10 ? 2 : 3;
    var parts = Number(n.toFixed(digits)).toString().split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  /** "30/min", or "30 m³/min" for fluids. */
  function rateText(id, n) {
    return fmtNum(n) + (isFluid(id) ? ' m³' : '') + '/min';
  }

  function fmtPower(mw) {
    if (mw >= 1000) return fmtNum(mw / 1000) + ' GW';
    return fmtNum(mw) + ' MW';
  }

  /** Machine count: whole numbers bare, fractions to two places. */
  function fmtCount(n) {
    var r = Math.round(n);
    if (Math.abs(n - r) < 1e-6) return String(r);
    return Number(n.toFixed(2)).toString();
  }

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
  var PROGRESS = ['unlocked', 'unavailable', 'belt', 'pipe', 'defaultMiner'];
  var FACTORY = ['targets', 'recipes', 'imports', 'supply', 'clock', 'picker', 'goal',
    'pins', 'view', 'mode', 'balance'];
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

  /** Copies a saved or imported plan into state, dropping anything unknown. */
  function adopt(data) {
    if (!data || typeof data !== 'object') return false;
    state.name = typeof data.name === 'string' ? data.name : '';
    state.targets = (Array.isArray(data.targets) ? data.targets : [])
      .filter(function (t) { return t && DATA.items[t.item]; })
      .map(function (t) {
        var out = { item: t.item, rate: Number(t.rate) || 0 };
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
    state.unavailable = (Array.isArray(data.unavailable) ? data.unavailable : []).filter(function (id) {
      return BUILDINGS.indexOf(id) >= 0;
    });
    var show = data.show || {};
    state.show = {
      products: show.products !== false,
      rates: show.rates !== false,
      clocks: show.clocks !== false,
      short: !!show.short
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

  /* --------------------------------------------------------------- history */

  // Snapshot-based undo. The camera, the panel and which view is showing are
  // deliberately left out — looking around isn't an edit.
  var undoStack = [];
  var redoStack = [];
  var lastSnap = null;
  var commitTimer = null;
  var MAX_HISTORY = 80;

  var UNDOABLE = ['name', 'targets', 'recipes', 'imports', 'supply', 'clock', 'belt', 'pipe',
    'picker', 'goal', 'unlocked', 'unavailable', 'pins'];

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

  /* ----------------------------------------------------------------- view */

  var CELL = 44;           // must match --cell in styles.css
  var FOUNDATION_PX = 64;  // machine view: one 8 m foundation at 8 px/m

  function applyView() {
    var v = state.view;
    world.style.transform =
      'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.s + ')';

    // Drag the plus field along with the nodes, and scale it with the zoom,
    // so the canvas reads as one surface rather than a fixed backdrop. In the
    // machine view the pluses mark the corners of 8 m foundations.
    var machines = state.mode === 'machines';
    var cell = (machines ? FOUNDATION_PX : CELL) * v.s;
    var shift = machines ? cell / 2 : 0;
    stage.style.backgroundSize = cell + 'px ' + cell + 'px';
    stage.style.backgroundPosition = (v.x - shift) + 'px ' + (v.y - shift) + 'px';

    document.getElementById('zoom-fit').textContent =
      Math.round(v.s * 100) + '%';
  }

  function zoomAt(screenX, screenY, factor) {
    var v = state.view;
    var next = clamp(v.s * factor, MIN_ZOOM, MAX_ZOOM);
    if (next === v.s) return;
    var rect = stage.getBoundingClientRect();
    var px = screenX - rect.left;
    var py = screenY - rect.top;
    // Keep the world point under the cursor pinned in place.
    v.x = px - (px - v.x) * (next / v.s);
    v.y = py - (py - v.y) * (next / v.s);
    v.s = next;
    applyView();
    writeNow();
  }

  /** Width of canvas not covered by the plan panel. */
  function usableWidth() {
    return stage.clientWidth;
  }

  /** Frames the whole plan in whatever part of the canvas is visible. */
  function fitView() {
    var nodes = graph.nodes;
    if (!nodes.length) {
      state.view = { x: 60, y: 40, s: 1 };
      applyView();
      writeNow();
      return;
    }
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    nodes.forEach(function (n) {
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h);
    });
    var pad = 60;
    var w = usableWidth();
    var h = stage.clientHeight;
    var s = clamp(Math.min((w - pad * 2) / (x1 - x0), (h - pad * 2) / (y1 - y0)), MIN_ZOOM, 1.1);
    state.view = {
      s: s,
      x: w / 2 - ((x0 + x1) / 2) * s,
      y: h / 2 - ((y0 + y1) / 2) * s
    };
    applyView();
    writeNow();
  }

  function toWorld(clientX, clientY) {
    var r = stage.getBoundingClientRect();
    return {
      x: (clientX - r.left - state.view.x) / state.view.s,
      y: (clientY - r.top - state.view.y) / state.view.s
    };
  }

  /* --------------------------------------------------------------- solve */

  /**
   * Re-solves the plan and rebuilds the canvas from it. Nodes are keyed by
   * what they are ("r:<recipe>", "raw:<item>" or "out:<item>"), so a pin
   * survives any change that doesn't remove that step outright.
   */
  function recompute() {
    var built = buildablePlan();
    var plan = {
      targets: state.targets,
      recipes: built.recipes,
      imports: built.imports,
      caps: currentCaps()
    };
    solved = null;
    if (state.picker === 'optimise') {
      // Recipes picked on a node become pins the optimiser has to keep.
      plan.pins = built.recipes;
      solved = OPTIMISE.solveOptimised(DATA, plan, { goal: state.goal, allowed: recipeAllowed, built: canBuild });
      if (!solved) {
        plan.recipes = buildablePlan(true).recipes;
        solved = SOLVER.solve(DATA, plan);
        solved.error = 'The optimiser couldn’t settle this plan, so it’s showing your own recipe picks.';
      }
    } else {
      solved = SOLVER.solve(DATA, plan);
    }

    // An output only an unticked building makes can't be planned at all.
    var stuck = state.targets.filter(function (t) { return blocked[t.item]; })[0];
    if (stuck) {
      solved.error = itemName(stuck.item) + ' needs the ' + buildingName(blocked[stuck.item]) +
        ', which is unticked under Machines in the Plan panel.';
    }

    errorEl.hidden = !solved.error;
    errorEl.textContent = solved.error || '';

    world.classList.toggle('machines', state.mode === 'machines');
    if (state.mode === 'machines') {
      buildMachineGraph();
      mountMachineNodes();
      layout();
      renderMachineView();
    } else {
      world.querySelectorAll('.machine, .part').forEach(function (el) { el.remove(); });
      buildGraph();
      mountNodes();
      layout();
      graph.nodes.forEach(place);
      renderWires();
    }
    keepSelection();
    renderBreakdown();
    refreshMaxRates();
    refreshOptNote();
    refreshEmptyHint();
  }

  function buildGraph() {
    var nodes = [];
    var byKey = {};

    function add(n) {
      nodes.push(n);
      byKey[n.key] = n;
      n.out = [];
      n.inn = [];
    }

    Object.keys(solved.recipes).forEach(function (rid) {
      var r = solved.recipes[rid];
      add({ key: 'r:' + rid, kind: 'recipe', rid: rid, item: r.item, count: r.count });
    });
    // A resource drawn from several nodes shows each node as a block of its
    // own, all running at the same share of what they can give.
    var rawParts = {};
    Object.keys(solved.items).forEach(function (id) {
      var e = solved.items[id];
      if (!(e.supplied > EPS)) return;
      var info = DATA.items[id].raw ? supplyInfo(id) : null;
      if (!info || !info.purity || !info.nodeList.length) {
        add({ key: 'raw:' + id, kind: 'raw', item: id, rate: e.supplied });
        return;
      }
      rawParts[id] = info.nodeList.map(function (nd, i) {
        var share = nd.rate / info.capacity;
        var key = i ? 'raw:' + id + '#' + i : 'raw:' + id;
        add({ key: key, kind: 'raw', item: id, rate: e.supplied * share, slot: i });
        return { key: key, share: share };
      });
    });
    // Each output is a node of its own, fed like any other consumer.
    Object.keys(solved.targets).forEach(function (id) {
      var rate = solved.targets[id];
      if (rate > EPS) add({ key: 'out:' + id, kind: 'output', item: id, rate: rate });
    });

    // One edge per source, destination and item.
    var edgeMap = {};
    var edges = [];
    function addFlow(from, to, item, rate) {
      var k = from + '>' + to + '>' + item;
      if (!edgeMap[k]) {
        edgeMap[k] = { from: from, to: to, item: item, rate: 0 };
        edges.push(edgeMap[k]);
      }
      edgeMap[k].rate += rate;
    }
    solved.flows.forEach(function (f) {
      var parts = f.from === 'raw:' + f.item ? rawParts[f.item] : null;
      if (parts) parts.forEach(function (p) { addFlow(p.key, f.to, f.item, f.rate * p.share); });
      else addFlow(f.from, f.to, f.item, f.rate);
    });
    edges = edges.filter(function (e) { return byKey[e.from] && byKey[e.to]; });
    edges.forEach(function (e) {
      byKey[e.from].out.push(e);
      byKey[e.to].inn.push(e);
    });

    graph = { nodes: nodes, edges: edges, byKey: byKey };
  }

  /* -------------------------------------------------------------- layout */

  var DUMMY_H = 18;  // room a line passing through a column takes up

  /**
   * Left-to-right layering, in four passes.
   *
   *  1. Columns. Every node goes as far left as its inputs allow, then any
   *     node that feeds something slides right to sit just before its first
   *     consumer. So an output stops right after the step that makes it (kept
   *     rods sit level with the screw constructors), and raw inputs sit next
   *     to where they're used.
   *  2. A line that skips columns gets a waypoint in each column it crosses,
   *     so it's routed between nodes rather than through them.
   *  3. Rows are ordered to cut crossings: barycentre sweeps, then swapping
   *     neighbours for as long as that removes crossings. The best order seen
   *     is kept.
   *  4. Each node is placed level with what it connects to, then columns are
   *     spread so nothing overlaps.
   *
   * Pinned nodes keep their spot; the rest flow around them.
   */
  function layout() {
    var nodes = graph.nodes;
    if (!nodes.length) return;
    var byKey = graph.byKey;
    var machines = state.mode === 'machines';
    var colGap = COL_GAP;
    // In the machine view a line passing through a column is one belt, 2 m.
    var rowGap = machines ? 32 : ROW_GAP;
    var dummyH = machines ? 16 : DUMMY_H;

    // Loops (Recycled Plastic and Rubber feeding each other) are cut at the
    // line that closes them, found by a depth-first walk from the sources.
    var mark = {};
    var back = new Set();
    function walk(n) {
      mark[n.key] = 1;
      n.out.forEach(function (e) {
        var t = byKey[e.to];
        if (mark[t.key] === 1) back.add(e);
        else if (!mark[t.key]) walk(t);
      });
      mark[n.key] = 2;
    }
    nodes.forEach(function (n) { if (!n.inn.length) walk(n); });
    nodes.forEach(function (n) { if (!mark[n.key]) walk(n); });

    graph.edges.forEach(function (e) { e.back = back.has(e); });
    var fwd = graph.edges.filter(function (e) { return !e.back; });
    var succ = {};
    var pred = {};
    nodes.forEach(function (n) { succ[n.key] = []; pred[n.key] = []; });
    fwd.forEach(function (e) {
      succ[e.from].push(byKey[e.to]);
      pred[e.to].push(byKey[e.from]);
    });

    // Topological order over the forward lines.
    var order = [];
    var indeg = {};
    var queue = [];
    nodes.forEach(function (n) {
      indeg[n.key] = pred[n.key].length;
      if (!indeg[n.key]) queue.push(n);
    });
    while (queue.length) {
      var q = queue.shift();
      order.push(q);
      succ[q.key].forEach(function (s) { if (--indeg[s.key] === 0) queue.push(s); });
    }

    // 1. Columns: as early as possible, then feeders slide up to their users.
    var col = {};
    order.forEach(function (n) {
      col[n.key] = pred[n.key].reduce(function (c, p) { return Math.max(c, col[p.key] + 1); }, 0);
    });
    for (var i = order.length - 1; i >= 0; i--) {
      var s = succ[order[i].key];
      if (!s.length) continue;
      col[order[i].key] = Math.min.apply(null, s.map(function (t) { return col[t.key]; })) - 1;
    }
    var minC = Infinity;
    var maxC = 0;
    nodes.forEach(function (n) { minC = Math.min(minC, col[n.key]); });
    nodes.forEach(function (n) { n.col = col[n.key] - minC; maxC = Math.max(maxC, n.col); });

    var layers = [];
    for (var c = 0; c <= maxC; c++) layers.push([]);
    nodes
      .slice()
      .sort(function (a, b) { return itemName(a.item).localeCompare(itemName(b.item)); })
      .forEach(function (n) {
        n.lo = [];
        n.li = [];
        layers[n.col].push(n);
      });

    // 2. Waypoints for lines that skip columns. Each hop between neighbouring
    // columns is a link that remembers where on each node it attaches, as an
    // offset from the node's middle: machine lines take belts in at the top
    // and send them out at the bottom, and placement lines those ports up.
    function portOffset(n, side, item) {
      var p = n.ports && n.ports[side][item];
      return p ? p.y - n.h / 2 : 0;
    }
    function hop(a, b, ao, bo) {
      var l = { a: a, b: b, ao: ao, bo: bo };
      a.lo.push(l);
      b.li.push(l);
    }
    var seq = 0;
    graph.edges.forEach(function (e) { e.via = []; });
    fwd.forEach(function (e) {
      var a = byKey[e.from];
      var b = byKey[e.to];
      var prev = a;
      var prevOff = portOffset(a, 'out', e.item);
      for (var c2 = a.col + 1; c2 < b.col; c2++) {
        var d = { key: 'via' + seq++, dummy: true, col: c2, w: 0, h: dummyH, lo: [], li: [] };
        layers[c2].push(d);
        e.via.push(d);
        hop(prev, d, prevOff, 0);
        prev = d;
        prevOff = 0;
      }
      hop(prev, b, prevOff, portOffset(b, 'in', e.item));
    });

    // 3. Order rows to cut crossings.
    function reindex(layer) { layer.forEach(function (n, j) { n.idx = j; }); }
    layers.forEach(reindex);

    function mean(list, fallback) {
      if (!list.length) return fallback;
      return list.reduce(function (sum, v) { return sum + v; }, 0) / list.length;
    }

    /** Crossings between a column and the next one. */
    function crossingsAfter(c3) {
      if (c3 < 0 || c3 >= maxC) return 0;
      var pairs = [];
      layers[c3].forEach(function (u) {
        u.lo.forEach(function (l) { pairs.push([u.idx, l.b.idx]); });
      });
      var count = 0;
      for (var p = 0; p < pairs.length; p++) {
        for (var r = p + 1; r < pairs.length; r++) {
          if ((pairs[p][0] - pairs[r][0]) * (pairs[p][1] - pairs[r][1]) < 0) count++;
        }
      }
      return count;
    }
    function totalCrossings() {
      var t = 0;
      for (var c4 = 0; c4 < maxC; c4++) t += crossingsAfter(c4);
      return t;
    }

    function sortBy(layer, key) {
      layer.forEach(function (n) { n.bary = key(n); });
      layer.sort(function (a, b) { return a.bary - b.bary; });
      reindex(layer);
    }

    function transpose() {
      var improved = true;
      var rounds = 0;
      while (improved && rounds++ < 6) {
        improved = false;
        for (var c5 = 0; c5 <= maxC; c5++) {
          var layer = layers[c5];
          for (var j = 0; j + 1 < layer.length; j++) {
            var before = crossingsAfter(c5 - 1) + crossingsAfter(c5);
            var a = layer[j];
            layer[j] = layer[j + 1];
            layer[j + 1] = a;
            reindex(layer);
            if (crossingsAfter(c5 - 1) + crossingsAfter(c5) < before) {
              improved = true;
            } else {
              layer[j + 1] = layer[j];
              layer[j] = a;
              reindex(layer);
            }
          }
        }
      }
    }

    var best = layers.map(function (l) { return l.slice(); });
    var bestCount = totalCrossings();
    for (var pass = 0; pass < 8 && bestCount > 0; pass++) {
      for (var c6 = maxC - 1; c6 >= 0; c6--) {
        sortBy(layers[c6], function (n) {
          return mean(n.lo.map(function (l) { return l.b.idx; }), n.idx);
        });
      }
      for (var c7 = 1; c7 <= maxC; c7++) {
        sortBy(layers[c7], function (n) {
          return mean(n.li.map(function (l) { return l.a.idx; }), n.idx);
        });
      }
      transpose();
      var count = totalCrossings();
      if (count < bestCount) {
        bestCount = count;
        best = layers.map(function (l) { return l.slice(); });
      }
    }
    layers = best;
    layers.forEach(reindex);

    // 4. Vertical placement.
    function gapBetween(a, b) { return a.dummy || b.dummy ? 12 : rowGap; }

    /** Puts a column as near to where it wants to be as it can without overlaps. */
    function stack(layer, desired) {
      var ys = desired.slice();
      for (var j = 1; j < layer.length; j++) {
        var min = ys[j - 1] + layer[j - 1].h / 2 + gapBetween(layer[j - 1], layer[j]) + layer[j].h / 2;
        if (ys[j] < min) ys[j] = min;
      }
      // Spreading only pushes down; shift back so the column stays centred on
      // where it wanted to be.
      var shift = mean(desired.map(function (d, j) { return d - ys[j]; }), 0);
      layer.forEach(function (n, j) { n.cy = ys[j] + shift; });
    }

    layers.forEach(function (layer) {
      var y = 0;
      stack(layer, layer.map(function (n) {
        var at = y + n.h / 2;
        y += n.h + rowGap;
        return at;
      }));
    });

    // Where a node's middle would have to be for each of its links to run
    // level, averaged.
    function toward(n, outs, ins) {
      var wants = [];
      if (outs) n.lo.forEach(function (l) { wants.push(l.b.cy + l.bo - l.ao); });
      if (ins) n.li.forEach(function (l) { wants.push(l.a.cy + l.ao - l.bo); });
      return mean(wants, n.cy);
    }
    for (var it = 0; it < 4; it++) {
      var both = it >= 2;
      for (var c8 = maxC - 1; c8 >= 0; c8--) {
        stack(layers[c8], layers[c8].map(function (n) { return toward(n, true, both); }));
      }
      for (var c9 = 1; c9 <= maxC; c9++) {
        stack(layers[c9], layers[c9].map(function (n) { return toward(n, both, true); }));
      }
    }

    // The machine view sizes its columns around the belts it routes.
    if (machines) {
      routeMachineView(layers);
      return;
    }

    // Columns are as wide as their widest node.
    var colX = [];
    var colW = [];
    var x = 0;
    layers.forEach(function (layer, j) {
      colX[j] = x;
      colW[j] = layer.reduce(function (w, n) { return Math.max(w, n.w); }, 0);
      x += colW[j] + colGap;
    });

    var pinned = pins();
    nodes.forEach(function (n) {
      var pin = pinned[n.key];
      n.pinned = !!pin;
      if (pin) {
        n.x = pin.x;
        n.y = pin.y;
      } else {
        n.x = colX[n.col];
        n.y = Math.round(n.cy - n.h / 2);
      }
    });
    layers.forEach(function (layer, j) {
      layer.forEach(function (d) {
        if (!d.dummy) return;
        d.x = colX[j] + colW[j] / 2;
        d.y = d.cy;
      });
    });
  }

  /* --------------------------------------------------------------- nodes */

  function mountNodes() {
    world.querySelectorAll('.node').forEach(function (el) { el.remove(); });
    graph.nodes.forEach(function (n) {
      n.el = buildNode(n);
      n.el.style.width = NODE_W + 'px';
      world.appendChild(n.el);
      n.w = NODE_W;
      n.h = n.el.offsetHeight;
    });
  }

  function buildNode(n) {
    var el = tpl.content.firstElementChild.cloneNode(true);
    var title = el.querySelector('.n-title');
    var rate = el.querySelector('.n-rate');
    var recipeBtn = el.querySelector('.n-recipe');
    var machine = el.querySelector('.n-machine');
    var alt = el.querySelector('.n-alt');
    var notes = el.querySelector('.n-notes');
    var badge = el.querySelector('.n-badge');

    el.dataset.key = n.key;
    title.textContent = itemName(n.item);
    title.title = itemName(n.item);

    var entry = solved.items[n.item];
    var menu = openRecipeMenu; // what the machine line and right-click open

    function note(text, cls) {
      var line = document.createElement('span');
      line.textContent = text;
      if (cls) line.className = cls;
      notes.appendChild(line);
      return line;
    }

    var readOnly = state.mode === 'machines';

    if (n.kind === 'recipe' || n.kind === 'bank') {
      var r = DATA.recipes[n.rid];
      var made = 0;
      r.out.forEach(function (p) {
        if (p[0] === n.item) made += p[1] * n.count * 60 / r.time;
      });
      setRate(rate, n.item, made);

      machine.innerHTML = '';
      nameSpans(machine, machineName(n.rid));
      machine.appendChild(document.createTextNode(' '));
      var count = document.createElement('b');
      count.textContent = '×' + fmtCount(n.count);
      machine.appendChild(count);
      recipeBtn.title = 'Change recipe';

      if (r.name !== itemName(n.item)) {
        alt.hidden = false;
        alt.textContent = r.name;
        alt.classList.toggle('is-alt', !!r.alt);
        alt.title = (r.alt ? 'Alternate recipe: ' : 'Recipe: ') + r.name;
      }

      // Anything else this step makes, and how much of it goes spare.
      r.out.forEach(function (p) {
        if (p[0] === n.item) return;
        var amount = p[1] * n.count * 60 / r.time;
        var e = solved.items[p[0]];
        var line = document.createElement('span');
        var text = '+ ' + fmtNum(amount) + (isFluid(p[0]) ? ' m³ ' : ' ') + itemName(p[0]);
        if (e && e.surplus > EPS && e.produced > EPS) {
          var spareHere = e.surplus * amount / e.produced;
          text += Math.abs(spareHere - amount) < 1e-6 ? ' · spare' : ' · ' + fmtNum(spareHere) + ' spare';
        }
        line.textContent = text;
        line.title = rateText(p[0], amount) + ' of ' + itemName(p[0]) + ' made on the side';
        notes.appendChild(line);
      });

      if (entry && entry.surplus > EPS) note(fmtNum(entry.surplus) + ' spare');
    } else if (n.kind === 'spare') {
      // Machine view only: somewhere for an unused byproduct's belt to go.
      el.classList.add('spare');
      setRate(rate, n.item, n.rate);
      machine.textContent = 'Spare · sink or store it';
    } else if (n.kind === 'output') {
      el.classList.add('output');
      setRate(rate, n.item, n.rate);
      var t = targetFor(n.item);
      badge.hidden = false;
      badge.textContent = t && t.max ? 'Output · max' : 'Output';
      recipeBtn.hidden = true;
      if (t && t.max && solved.limitedBy) {
        note('As much as ' + itemName(solved.limitedBy) + ' allows');
      }
      menu = openOutputMenu;
    } else {
      el.classList.add('raw');
      setRate(rate, n.item, n.rate);
      var it = DATA.items[n.item];
      var label;
      if (it.raw) {
        var info = supplyInfo(n.item);
        var nd = info && info.nodeList && n.slot != null ? info.nodeList[n.slot] : null;
        label = nd ? nodeLabel(n.item, nd) : supplyLabel(n.item, info);
        menu = openSupplyMenu;
        recipeBtn.title = 'Purity and miner';
        if (!info || !info.purity) {
          // Water Extractors go anywhere; there's nothing to choose.
          recipeBtn.disabled = true;
          recipeBtn.title = '';
        }
        if (entry && entry.cap != null) {
          if (nd && info.nodeList.length > 1) note('Uses ' + fmtNum(n.rate) + ' of ' + rateText(n.item, nd.rate));
          else note('Uses ' + fmtNum(entry.supplied) + ' of ' + rateText(n.item, entry.cap));
          // What's true of the resource as a whole goes on its first block.
          if (!n.slot && entry.short > EPS) {
            el.classList.add('short');
            note('Short by ' + rateText(n.item, entry.short), 'warn');
          }
          if (!n.slot && solved.limitedBy === n.item) note('Sets the max output');
        }
        if (nd && !readOnly) {
          // A tall, thin + down the block's left side adds another node.
          var more = document.createElement('button');
          more.type = 'button';
          more.className = 'n-add';
          more.textContent = '+';
          more.title = 'Add another ' + itemName(n.item) + ' node';
          more.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
          more.addEventListener('click', function (e) {
            e.stopPropagation();
            addResourceNode(n.item, nd);
          });
          el.appendChild(more);
        }
        if (readOnly && n.kind === 'raw') {
          note('Pick a node purity in the Items view to place its ' +
            (isFluid(n.item) ? 'extractors' : 'miners'));
        }
      } else if (state.imports[n.item]) {
        label = 'Imported';
        recipeBtn.title = 'Make it here instead';
      } else if (blocked[n.item]) {
        // Only a building the user doesn't have makes it.
        label = 'No ' + buildingName(blocked[n.item]);
        el.classList.add('short');
        recipeBtn.disabled = true;
        recipeBtn.title = '';
        note('Tick the ' + buildingName(blocked[n.item]) + ' under Machines to make it here', 'warn');
      } else if (!producersOf[n.item]) {
        label = 'Supplied';
        recipeBtn.disabled = true;
        recipeBtn.title = 'Nothing in the game makes this in a machine';
      } else {
        // Has a recipe, but still comes up short: a byproduct-only item that
        // doesn't make enough.
        label = 'Shortfall';
        el.classList.add('short');
        recipeBtn.title = 'Pick a recipe, or import it';
        var why = document.createElement('span');
        why.className = 'warn';
        why.textContent = 'Byproducts don’t cover this';
        notes.appendChild(why);
      }
      machine.textContent = label;
    }

    // The machine view is a picture of the build: nothing on it is edited or
    // moved. Recipes and nodes are changed in the Items view.
    if (readOnly) {
      recipeBtn.disabled = true;
      recipeBtn.removeAttribute('title');
      return el;
    }

    el.addEventListener('pointerenter', function () { focusNode(n.key, true); });
    el.addEventListener('pointerleave', function () { focusNode(n.key, false); });

    recipeBtn.addEventListener('click', function () {
      if (recipeBtn.disabled) return;
      var rect = recipeBtn.getBoundingClientRect();
      menu(n, rect.left, rect.bottom + 4, false);
    });

    el.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeAll();
      if (selected[n.key] && selectedNodes().length > 1) {
        openSelectionMenu(e.clientX, e.clientY);
        return;
      }
      if (!selected[n.key]) selectOnly(n.key);
      menu(n, e.clientX, e.clientY, true);
    });

    dragBehaviour(el, n);
    return el;
  }

  function setRate(el, id, n) {
    el.innerHTML = '';
    el.appendChild(document.createTextNode(fmtNum(n)));
    var unit = document.createElement('small');
    unit.textContent = (isFluid(id) ? ' m³' : '') + '/min';
    el.appendChild(unit);
  }

  function targetFor(id) {
    return state.targets.filter(function (t) { return t.item === id; })[0] || null;
  }

  /** One resource node's block: "Pure node · Mk.2". */
  function nodeLabel(id, nd) {
    var text = titleCase(nd.purity) + ' node';
    if (!isFluid(id)) text += ' · ' + DATA.extractors[nd.extractor].name.replace(/^Miner\s*/, '');
    return text;
  }

  /** Another node for a resource: normal, with the same miner as the one beside it. */
  function addResourceNode(id, like) {
    var s = state.supply[id] || {};
    var list = storedNodes(id);
    var next = { purity: 'normal' };
    if (!isFluid(id) && like && like.extractor) next.miner = like.extractor;
    list.push(next);
    state.supply[id] = { nodes: list, miner: s.miner };
    changed();
  }

  /** "Pure node · Mk.2", "Mined · any node", "3 nodes · Mk.1". */
  function supplyLabel(id, info) {
    if (!info) return 'Supplied';
    if (!info.purity) return 'Water Extractors';
    var solid = !isFluid(id);
    if (!info.nodes.length) return (solid ? 'Mined' : 'Extracted') + ' · any node';
    var text = info.nodes.length === 1
      ? titleCase(info.nodes[0]) + ' node'
      : info.nodes.length + ' nodes';
    if (solid) text += ' · ' + DATA.extractors[info.extractor].name.replace(/^Miner\s*/, '');
    return text;
  }

  /* ---------------------------------------------------------- machine view */

  /*
   * The machine view is the build itself: every building, splitter, merger
   * and belt at its real size, where it would go. Everything is measured in
   * metres and drawn at PX_PER_M, on whole metres, over the canvas's 8 m
   * foundation grid.
   *
   * Each production step becomes one or more lines: its machines stacked with
   * belts running through them left to right, on a manifold. An input belt
   * comes in at the top left and runs down the machines' input side, where a
   * splitter feeds each machine and the belt's end turns into the last one.
   * Outputs merge in machine by machine on the other side and leave at the
   * bottom right. A step splits into several lines when one line's belts
   * would need more than the fastest belt the plan allows.
   */

  var PX_PER_M = 8;
  var LOG = DATA.logistics;
  var SPLIT_M = LOG.splitter;        // splitters and mergers are 4 m square
  var JUNCTION_M = LOG.junction;     // pipeline junctions, 2.4 m
  var LANE_M = SPLIT_M + 1;          // side-by-side manifold belts, centre to centre
  var BRANCH_M = 2;                  // belt from a manifold to the machine it feeds
  var GAP_M = 2;                     // between neighbouring machines in a line
  var TRACK_M = 2;                   // between parallel belts running through a gap
  var STUB_M = 2;                    // belt run straight off a splitter or merger side
  var MIN_GAP_M = 10;                // between columns, with room for rate labels
  var CARD_W = 176;                  // start and end markers: not buildings, so compact

  function px(m) { return m * PX_PER_M; }
  function snap(v) { return Math.round(v / PX_PER_M) * PX_PER_M; }

  /** Most one belt (or pipe) may carry, given the fastest tier the plan allows. */
  function capacity(id) {
    return isFluid(id) ? LOG.pipes[state.pipe - 1] : LOG.belts[state.belt - 1];
  }

  /** Slowest tier that carries a rate, 1-based, or 0 if none does. */
  function tierFor(id, rate) {
    var tiers = isFluid(id) ? LOG.pipes : LOG.belts;
    for (var i = 0; i < tiers.length; i++) {
      if (rate <= tiers[i] + 1e-6) return i + 1;
    }
    return 0;
  }

  /**
   * The machine view's graph. Lines of machines, splitters and mergers
   * between them, and cards for where things start and end: raw resources
   * whose nodes aren't set, imports, outputs, and spare byproducts.
   */
  function buildMachineGraph() {
    var nodes = [];
    var byKey = {};
    var edges = [];
    var linesOf = {};   // solver node key -> [{ key, share }]
    var seq = 0;

    function add(n) {
      nodes.push(n);
      byKey[n.key] = n;
      n.out = [];
      n.inn = [];
      return n;
    }
    function link(from, to, item, rate) {
      var e = { from: from, to: to, item: item, rate: rate };
      edges.push(e);
      byKey[from].out.push(e);
      byKey[to].inn.push(e);
    }

    /**
     * A step's machines, split into as few lines as keep every belt on each
     * line within the fastest tier allowed. Each machine carries its own
     * belt load, since miners on different purities differ.
     */
    function addLines(baseKey, spec) {
      var chunks = [];
      var cur = [];
      var load = {};
      // A balancer's looped-back outputs ride the input belt a second time,
      // so its first belt carries more than the machines use.
      var balanced = state.balance === 'balancer';
      function boost(id, count) {
        if (!balanced || spec.ins.indexOf(id) < 0 || count < 2) return 1;
        return balancePlan(count).m / count;
      }
      spec.machines.forEach(function (m) {
        var fits = !cur.length || Object.keys(m.load).every(function (id) {
          return ((load[id] || 0) + m.load[id]) * boost(id, cur.length + 1) <= capacity(id) + 1e-6;
        });
        if (!fits) {
          chunks.push(cur);
          cur = [];
          load = {};
        }
        cur.push(m);
        Object.keys(m.load).forEach(function (id) { load[id] = (load[id] || 0) + m.load[id]; });
      });
      if (cur.length) chunks.push(cur);

      function made(list) {
        return list.reduce(function (s, m) { return s + (m.load[spec.item] || 0); }, 0);
      }
      var total = made(spec.machines);
      linesOf[baseKey] = chunks.map(function (chunk, i) {
        var key = chunks.length > 1 ? baseKey + '#' + i : baseKey;
        add({
          key: key, kind: 'line', item: spec.item, name: spec.name, size: spec.size,
          ins: spec.ins.slice(), outs: spec.outs.slice(), machines: chunk
        });
        return { key: key, share: total > EPS ? made(chunk) / total : 1 / chunks.length };
      });
    }

    function endpoint(n) {
      add(n);
      linesOf[n.key] = [{ key: n.key, share: 1 }];
    }

    Object.keys(solved.recipes).forEach(function (rid) {
      var r = DATA.recipes[rid];
      var s = solved.recipes[rid];
      var spec = DATA.machines[r.machine];
      var k = 60 / r.time;
      addLines('r:' + rid, {
        item: s.item, name: spec.name, size: spec.size,
        ins: r.in.map(function (p) { return p[0]; }),
        outs: r.out.map(function (p) { return p[0]; }),
        machines: recipeClocks(rid, s.count).map(function (c) {
          var load = {};
          r.in.concat(r.out).forEach(function (p) { load[p[0]] = (load[p[0]] || 0) + p[1] * k * c; });
          return { clock: clockSetting(c), product: itemName(s.item), pre: '', sub: clockLabel(c), load: load };
        })
      });
    });

    Object.keys(solved.items).forEach(function (id) {
      var e = solved.items[id];
      if (e.supplied > EPS) {
        var ex = DATA.items[id].raw ? extractorsFor(id, e.supplied) : null;
        if (ex) {
          var spec = DATA.extractors[ex.info.extractor];
          addLines('raw:' + id, {
            item: id, name: spec.name, size: spec.size, ins: [], outs: [id],
            machines: ex.list.map(function (m) {
              var rate = m.rate * m.clock;
              var load = {};
              load[id] = rate;
              return {
                clock: clockSetting(m.clock),
                name: DATA.extractors[m.extractor].name,
                product: itemName(id),
                pre: m.purity ? titleCase(m.purity) : '',
                sub: clockLabel(m.clock),
                load: load
              };
            })
          });
        } else {
          endpoint({ key: 'raw:' + id, kind: 'raw', item: id, rate: e.supplied });
        }
      }
      if (e.surplus > EPS) endpoint({ key: 'spare:' + id, kind: 'spare', item: id, rate: e.surplus });
    });

    Object.keys(solved.targets).forEach(function (id) {
      var rate = solved.targets[id];
      if (rate > EPS) endpoint({ key: 'out:' + id, kind: 'output', item: id, rate: rate });
    });

    function isEndpoint(key) { return byKey[key].kind !== 'line'; }

    /** Joins belts on mergers (three in each, chained past that); returns the last. */
    function mergeInto(id, feeds) {
      if (feeds.length === 1) return feeds[0].key;
      var fluid = isFluid(id);
      var carry = null;
      var carried = 0;
      var waiting = feeds.slice();
      while (waiting.length) {
        var m = add({ key: 'mrg:' + id + ':' + seq++, kind: 'merger', item: id, fluid: fluid });
        if (carry) link(carry, m.key, id, carried);
        waiting.splice(0, carry ? 2 : 3).forEach(function (f) {
          link(f.key, m.key, id, f.rate);
          carried += f.rate;
        });
        carry = m.key;
      }
      return carry;
    }

    /**
     * Splits one belt into several (three ways each, chained past that).
     * Returns, for each rate, the node that sends it on.
     */
    function splitFrom(id, from, rates) {
      if (rates.length === 1) return [from];
      var fluid = isFluid(id);
      var emit = [];
      var left = rates.reduce(function (s, r) { return s + r; }, 0);
      var prev = from;
      var i = 0;
      while (i < rates.length) {
        var sp = add({ key: 'spl:' + id + ':' + seq++, kind: 'splitter', item: id, fluid: fluid });
        link(prev, sp.key, id, left);
        var take = rates.length - i <= 3 ? rates.length - i : 2;
        for (var t = 0; t < take; t++) {
          emit[i] = sp.key;
          left -= rates[i];
          i++;
        }
        prev = sp.key;
      }
      return emit;
    }

    Object.keys(solved.items).forEach(function (id) {
      var e = solved.items[id];
      function expand(list) {
        var sums = {};
        list.forEach(function (p) {
          (linesOf[p.node] || []).forEach(function (l) {
            sums[l.key] = (sums[l.key] || 0) + p.rate * l.share;
          });
        });
        return Object.keys(sums)
          .filter(function (k) { return sums[k] > EPS; })
          .map(function (k) { return { key: k, rate: sums[k] }; });
      }
      var src = expand(e.producers);
      var dst = expand(e.consumers.concat(e.surplus > EPS ? [{ node: 'spare:' + id, rate: e.surplus }] : []))
        .filter(function (d) {
          // A step that feeds on its own output keeps that loop internal.
          return !src.some(function (s) { return s.key === d.key; });
        });
      if (!src.length || !dst.length) return;
      var total = dst.reduce(function (s, d) { return s + d.rate; }, 0);

      if (total <= capacity(id) + 1e-6) {
        // It all fits on one belt: merge every source, then split to every user.
        var head = mergeInto(id, src);
        var emit = splitFrom(id, head, dst.map(function (d) { return d.rate; }));
        dst.forEach(function (d, i) { link(emit[i], d.key, id, d.rate); });
        return;
      }

      // Too much for one belt. Pair sources with users in order, each pair on
      // its own belt, and only split or merge where a line meets more than
      // one partner. Starts and ends take several belts as they are.
      var alloc = [];
      var sLeft = src.map(function (s) { return s.rate; });
      var dLeft = dst.map(function (d) { return d.rate; });
      var i = 0;
      var j = 0;
      while (i < src.length && j < dst.length) {
        var a = Math.min(sLeft[i], dLeft[j]);
        if (a > 1e-6) alloc.push({ s: i, d: j, rate: a });
        sLeft[i] -= a;
        dLeft[j] -= a;
        if (sLeft[i] <= 1e-6) i++;
        if (dLeft[j] <= 1e-6) j++;
      }
      src.forEach(function (s, si) {
        var mine = alloc.filter(function (x) { return x.s === si; });
        var from = isEndpoint(s.key)
          ? mine.map(function () { return s.key; })
          : splitFrom(id, s.key, mine.map(function (x) { return x.rate; }));
        mine.forEach(function (x, k) { x.from = from[k]; });
      });
      dst.forEach(function (d, di) {
        var mine = alloc.filter(function (x) { return x.d === di; });
        if (mine.length === 1 || isEndpoint(d.key)) {
          mine.forEach(function (x) { link(x.from, d.key, id, x.rate); });
        } else {
          var sum = mine.reduce(function (s, x) { return s + x.rate; }, 0);
          link(mergeInto(id, mine.map(function (x) { return { key: x.from, rate: x.rate }; })), d.key, id, sum);
        }
      });
    });

    graph = { nodes: nodes, edges: edges, byKey: byKey };
  }

  /**
   * How to split one belt exactly evenly between `n` machines. Splitters go
   * two or three ways, so a tree of them reaches 2^a·3^b outputs. For any
   * other count the tree is built for the next such number up, and the spare
   * outputs loop back to a merger at its start — the standard in-game fix,
   * e.g. five machines on a 1→6 balancer with one output looped back.
   */
  function balancePlan(n) {
    var best = null;
    for (var a = 0; Math.pow(2, a) < n * 2; a++) {
      for (var b = 0; Math.pow(2, a) * Math.pow(3, b) < n * 3; b++) {
        var m = Math.pow(2, a) * Math.pow(3, b);
        if (m >= n && (!best || m < best.m || (m === best.m && a + b < best.a + best.b))) {
          best = { m: m, a: a, b: b };
        }
      }
    }
    var factors = [];
    for (var i = 0; i < best.b; i++) factors.push(3);
    for (var j = 0; j < best.a; j++) factors.push(2);
    return { m: best.m, loops: best.m - n, factors: factors };
  }

  /**
   * Balancer trees feeding a line's inputs, one per input item, side by side
   * with the innermost input nearest the machines. Built in metres against
   * the machines' tops; returns the belts and parts, where the machines must
   * start (mx), and how far down it all reaches.
   *
   * Leaves of each tree run straight to the machine ports, top to bottom.
   * Splitters sit level with the middle of what they feed, nudged clear of the
   * belts from outer trees that run past them to the machines. Spare leaves
   * drop to a floor belt under everything that runs back to the tree's merger.
   */
  function balancerInputs(n, tops, w, pitch) {
    var N = tops.length;
    var nIn = n.ins.length;
    var half = SPLIT_M / 2;
    var LEVEL_W = SPLIT_M + 3;
    var plan = balancePlan(N);
    var depth = plan.factors.length;
    var L = plan.loops;
    var out = { belts: [], parts: [], trees: [] };
    function portY(k, i) { return tops[k] + w * (i + 1) / (nIn + 1); }

    // Bands, outermost input on the left.
    var x = 0;
    for (var i = nIn - 1; i >= 0; i--) {
      var t = { i: i, item: n.ins[i], fluid: isFluid(n.ins[i]) };
      t.entryX = x + 1;
      var cx = t.entryX + 1.5 + half;
      if (L) {
        t.mergerX = cx;
        cx += SPLIT_M + 2;
      }
      t.levelX = [];
      for (var d = 0; d < depth; d++) t.levelX.push(cx + d * LEVEL_W);
      t.lastX = t.levelX[depth - 1];
      // Loop lanes: the first spare leaf takes the rightmost, so no spare
      // belt crosses another on its way down. Each lane ends in a merger on
      // the floor, so they're a merger's width apart.
      t.laneX = function (tree) {
        return function (k) { return tree.lastX + half + 1.5 + (L - 1 - k) * LANE_M; };
      }(t);
      x = (L ? t.laneX(0) : t.lastX + half) + BRANCH_M + 1;
      out.trees[i] = t;
    }
    out.mx = x;

    var bottom = tops[N - 1] + w;
    out.trees.forEach(function (t) {
      var i = t.i;
      // Belts from outer trees cross this band level with their ports.
      var avoid = [];
      for (var j = i + 1; j < nIn; j++) {
        for (var k = 0; k < N; k++) avoid.push(portY(k, j));
      }
      function nudge(want, lo, hi) {
        var min = lo + half + 0.5;
        var max = hi - half - 0.5;
        var snapHalf = function (v) { return Math.round(v * 2) / 2; };
        if (min > max) return snapHalf(want);
        for (var step = 0; step <= (max - min) * 2; step++) {
          var tries = [want + step / 2, want - step / 2];
          for (var q = 0; q < 2; q++) {
            var y = snapHalf(tries[q]);
            if (y < min || y > max) continue;
            if (avoid.every(function (f) { return Math.abs(y - f) > half + 0.5; })) return y;
          }
        }
        return snapHalf(want);
      }

      var leaves = [];
      for (var k = 0; k < N; k++) leaves.push({ y: portY(k, i), machine: k });
      for (var s = 0; s < L; s++) leaves.push({ y: portY(N - 1, i) + (s + 1) * pitch, loop: s });
      leaves.forEach(function (lf) { bottom = Math.max(bottom, lf.y + half); });

      // Build up from the leaves: each level groups its children by that
      // level's factor under one splitter.
      var level = leaves;
      var splitters = [];
      for (var d = depth - 1; d >= 0; d--) {
        var f = plan.factors[d];
        var next = [];
        for (var c = 0; c < level.length; c += f) {
          var kids = level.slice(c, c + f);
          var mean = kids.reduce(function (sum, q) { return sum + q.y; }, 0) / kids.length;
          var sp = { x: t.levelX[d], y: nudge(mean, kids[0].y, kids[kids.length - 1].y), kids: kids };
          next.push(sp);
          splitters.push(sp);
        }
        level = next;
      }
      t.root = level[0];
      t.splitters = splitters;
      t.leaves = leaves;
    });

    out.minY = Infinity;
    out.trees.forEach(function (t) {
      t.splitters.forEach(function (sp) { out.minY = Math.min(out.minY, sp.y - half); });
    });
    out.floorY = Math.ceil(bottom) + 2;
    out.bottom = L ? out.floorY + 1 : bottom;

    /** Corner points from a splitter's port to a point, leaving as a belt would. */
    function leave(sp, side, tx, ty) {
      if (side === 'top') return [[sp.x, sp.y - half], [sp.x, ty], [tx, ty]];
      if (side === 'bottom') return [[sp.x, sp.y + half], [sp.x, ty], [tx, ty]];
      if (Math.abs(ty - sp.y) < 0.01) return [[sp.x + half, sp.y], [tx, ty]];
      var jog = sp.x + half + 1.5;
      return [[sp.x + half, sp.y], [jog, sp.y], [jog, ty], [tx, ty]];
    }

    out.trees.forEach(function (t) {
      var item = t.item;
      var ratio = N + ' machines on a 1→' + plan.m + ' balancer' +
        (L ? ', ' + L + ' output' + (L > 1 ? 's' : '') + ' looped back' : '');
      t.splitters.forEach(function (sp) {
        out.parts.push({ role: 'splitter', fluid: t.fluid, item: item, x: sp.x, y: sp.y,
          note: sp === t.root ? ratio : null });
        var sides = sp.kids.length === 3 ? ['top', 'front', 'bottom'] : ['top', 'bottom'];
        sp.kids.forEach(function (kid, q) {
          var pts;
          if (kid.kids) {
            pts = leave(sp, sides[q], kid.x - half, kid.y);
          } else if (kid.machine != null) {
            pts = leave(sp, sides[q], out.mx, kid.y);
          } else {
            // A spare output: over to its lane, down to the floor, and for the
            // first one along the floor and up into the merger.
            var lane = t.laneX(kid.loop);
            pts = leave(sp, sides[q], lane, kid.y).concat([[lane, out.floorY]]);
            if (kid.loop === 0) {
              pts.push([t.mergerX, out.floorY], [t.mergerX, t.root.y + half]);
            } else {
              out.parts.push({ role: 'merger', fluid: t.fluid, item: item, x: lane, y: out.floorY,
                note: 'Joins the looped-back outputs' });
            }
          }
          out.belts.push({ item: item, pts: pts, branch: !kid.kids });
        });
      });
      if (L) {
        out.parts.push({ role: 'merger', fluid: t.fluid, item: item, x: t.mergerX, y: t.root.y,
          note: 'Feeds the looped-back outputs in again' });
        out.belts.push({ item: item, pts: [[t.mergerX + half, t.root.y], [t.root.x - half, t.root.y]] });
      }
    });
    return out;
  }

  /**
   * Where everything in a line sits, in metres from its top-left corner:
   * machines, belts (as corner points), and the splitters and mergers on
   * them, plus where belts join it from outside. Inputs arrive on a manifold
   * or a balancer; outputs always leave on a manifold, since merging needs
   * no balancing.
   */
  function lineGeometry(n) {
    var N = n.machines.length;
    var nIn = n.ins.length;
    var nOut = n.outs.length;
    var l = n.size ? n.size.l : 10;
    var w = n.size ? n.size.w : 8;
    var g = { machines: [], belts: [], parts: [], ports: { in: {}, out: {} }, l: l, w: w };
    function inAt(top, i) { return top + w * (i + 1) / (nIn + 1); }
    function outAt(top, j) { return top + w * (j + 1) / (nOut + 1); }

    // A lone machine needs no manifold: belts run straight in and out.
    if (N === 1) {
      var mx1 = nIn ? 3 : 0;
      g.machines.push({ x: mx1, y: 0, m: n.machines[0] });
      n.ins.forEach(function (id, i) {
        var y = inAt(0, i);
        g.belts.push({ item: id, pts: [[0, y], [mx1, y]] });
        g.ports.in[id] = { x: 0, y: y };
      });
      var w1 = mx1 + l + (nOut ? 3 : 0);
      n.outs.forEach(function (id, j) {
        var y = outAt(0, j);
        g.belts.push({ item: id, pts: [[mx1 + l, y], [w1, y]] });
        g.ports.out[id] = { x: w1, y: y };
      });
      g.w = w1;
      g.h = w;
      return g;
    }

    var half = SPLIT_M / 2;
    var pitch = Math.ceil(w + GAP_M);
    var last = N - 1;
    // Input belts arrive above everything, the innermost highest, so an
    // arriving belt never crosses one that's already running.
    function entry(i) { return 1 + i * 2; }
    var entryFloor = nIn ? entry(nIn - 1) + 1 : 0;
    var mx;
    var tops;
    var bottom;

    if (state.balance === 'balancer' && nIn) {
      // Built once to see how high the trees reach, then again moved down
      // clear of the arriving belts.
      var tops0 = n.machines.map(function (_, k) { return k * pitch; });
      var probe = balancerInputs(n, tops0, w, pitch);
      var y0 = Math.max(0, Math.ceil(entryFloor + 1 - probe.minY));
      tops = tops0.map(function (t) { return t + y0; });
      var bal = balancerInputs(n, tops, w, pitch);
      mx = bal.mx;
      bottom = bal.bottom;
      bal.trees.forEach(function (t) {
        // Into the loop-back merger if there is one, else straight to the tree.
        var target = t.mergerX != null ? [t.mergerX - half, t.root.y] : [t.root.x - half, t.root.y];
        g.belts.push({ item: t.item, pts: [[0, entry(t.i)], [t.entryX, entry(t.i)], [t.entryX, t.root.y], target] });
        g.ports.in[t.item] = { x: 0, y: entry(t.i) };
      });
      g.belts = g.belts.concat(bal.belts);
      g.parts = g.parts.concat(bal.parts);
    } else {
      var inX = function (i) { return half + (nIn - 1 - i) * LANE_M; };
      mx = nIn ? inX(0) + half + BRANCH_M : 0;
      var y1 = 0;
      n.ins.forEach(function (_, i) {
        y1 = Math.max(y1, entry(i) + 1 + half - w * (i + 1) / (nIn + 1));
      });
      tops = n.machines.map(function (_, k) { return Math.ceil(y1) + k * pitch; });
      bottom = tops[last] + w;
      n.ins.forEach(function (id, i) {
        var x = inX(i);
        var fluid = isFluid(id);
        var ys = tops.map(function (t) { return inAt(t, i); });
        g.belts.push({ item: id, pts: [[0, entry(i)], [x, entry(i)], [x, ys[last]], [mx, ys[last]]] });
        for (var k = 0; k < last; k++) {
          g.belts.push({ item: id, pts: [[x, ys[k]], [mx, ys[k]]], branch: true });
          g.parts.push({ role: 'splitter', fluid: fluid, item: id, x: x, y: ys[k] });
        }
        g.ports.in[id] = { x: 0, y: entry(i) };
      });
    }

    n.machines.forEach(function (m, k) { g.machines.push({ x: mx, y: tops[k], m: m }); });

    function outX(j) { return mx + l + BRANCH_M + half + j * LANE_M; }
    var width = nOut ? outX(nOut - 1) + half : mx + l;
    var outBottom = tops[last] + w;
    n.outs.forEach(function (_, j) { outBottom = Math.max(outBottom, outAt(tops[last], j) + half); });
    // Output belts leave below the last merger, the innermost lowest, so a
    // leaving belt never crosses a manifold that's still running.
    function exit(j) { return Math.ceil(outBottom) + 1 + (nOut - 1 - j) * 2; }

    n.outs.forEach(function (id, j) {
      var x = outX(j);
      var fluid = isFluid(id);
      var ys = tops.map(function (t) { return outAt(t, j); });
      g.belts.push({ item: id, pts: [[mx + l, ys[0]], [x, ys[0]], [x, exit(j)], [width, exit(j)]] });
      for (var k = 1; k <= last; k++) {
        g.belts.push({ item: id, pts: [[mx + l, ys[k]], [x, ys[k]]], branch: true });
        g.parts.push({ role: 'merger', fluid: fluid, item: id, x: x, y: ys[k] });
      }
      g.ports.out[id] = { x: width, y: exit(j) };
    });

    g.w = width;
    g.h = Math.max(nOut ? exit(0) + 1 : outBottom, bottom);
    return g;
  }

  /** Measures everything before layout: lines from their geometry, cards from the page. */
  function mountMachineNodes() {
    world.querySelectorAll('.node, .machine, .part').forEach(function (el) { el.remove(); });
    graph.nodes.forEach(function (n) {
      if (n.kind === 'line') {
        setLineGeometry(n);
      } else if (n.kind === 'splitter' || n.kind === 'merger') {
        var size = px(n.fluid ? JUNCTION_M : SPLIT_M);
        n.w = size;
        // Room above and below for belts leaving or joining at the sides.
        n.part = size;
        n.h = size + 2 * px(STUB_M + 1);
      } else if (n.kind === 'output' || n.kind === 'spare') {
        // One building per belt that arrives: a container takes one belt.
        var b = storageFor(n);
        var k = Math.max(1, n.inn.length);
        n.store = { building: b, w: px(b.size.l), h: px(b.size.w), gap: px(GAP_M) };
        n.el = null;
        n.w = n.store.w;
        n.h = k * n.store.h + (k - 1) * n.store.gap;
        n.slots = [];
        for (var i = 0; i < k; i++) n.slots.push(i * (n.store.h + n.store.gap) + n.store.h / 2);
        n.slotEdges = [];
      } else {
        n.el = buildNode(n);
        n.el.classList.add('endpoint');
        n.el.style.width = CARD_W + 'px';
        world.appendChild(n.el);
        n.w = CARD_W;
        // Tall enough that every belt it sends or takes has its own 2 m.
        var belts = Math.max(n.out.length, n.inn.length);
        n.h = Math.max(n.el.offsetHeight, snap(px(TRACK_M) * (belts + 1)));
        n.el.style.height = n.h + 'px';
      }
    });
  }

  /**
   * Where finished goods and spares end up: a Storage Container for items, a
   * Fluid Buffer for fluids, and spare items into an AWESOME Sink.
   */
  function storageFor(n) {
    var st = DATA.logistics.storage;
    if (isFluid(n.item)) return st.fluids;
    return n.kind === 'spare' ? st.sink : st.items;
  }

  function storageShape(n, rate) {
    var b = n.store.building;
    var el = document.createElement('div');
    el.className = 'machine storage ' + n.kind;
    el.style.width = n.store.w + 'px';
    el.style.height = n.store.h + 'px';
    el.title = b.name + ' · ' + itemName(n.item) + ' · ' + rateText(n.item, rate) +
      ' · ' + b.size.l + ' × ' + b.size.w + ' m' +
      (n.kind === 'spare' ? ' · made but not used' : '');
    // What's in it matters most here, so the item leads and the building follows.
    [['m-name', itemName(n.item)], ['m-product', b.name], ['m-sub', rateText(n.item, rate)]].forEach(function (pair) {
      var sp = document.createElement('span');
      sp.className = pair[0];
      if (pair[0] === 'm-product') nameSpans(sp, pair[1]);
      else sp.textContent = pair[1];
      el.appendChild(sp);
    });
    var dot = document.createElement('span');
    dot.className = 'm-port in' + (isFluid(n.item) ? ' fluid' : '');
    dot.style.top = '50%';
    el.appendChild(dot);
    return el;
  }

  function setLineGeometry(n) {
    n.geo = lineGeometry(n);
    n.w = px(n.geo.w);
    n.h = px(n.geo.h);
    n.ports = { in: {}, out: {} };
    ['in', 'out'].forEach(function (side) {
      Object.keys(n.geo.ports[side]).forEach(function (id) {
        var p = n.geo.ports[side][id];
        n.ports[side][id] = { x: px(p.x), y: px(p.y) };
      });
    });
  }

  /**
   * Once rows are placed, give each item the port that faces where its belt
   * goes: any input port takes any input. Outputs are ordered by what they
   * feed, then inputs by where they come from, so belts fan in and out of a
   * line without crossing.
   */
  function assignPorts() {
    var byKey = graph.byKey;
    function portY(n, side, item) {
      var p = n.ports && n.ports[side][item];
      return n.y + (p ? p.y : n.h / 2);
    }
    function rank(list, yOf) {
      var ys = {};
      list.forEach(function (id) { ys[id] = yOf(id); });
      return list.slice().sort(function (a, b) { return ys[a] - ys[b]; });
    }
    var lines = graph.nodes.filter(function (n) { return n.kind === 'line'; });
    lines.forEach(function (n) {
      n.outs = rank(n.outs, function (id) {
        var e = n.out.filter(function (o) { return o.item === id; })[0];
        if (!e) return Infinity;
        return e.via.length ? e.via[0].y : portY(byKey[e.to], 'in', id);
      });
      setLineGeometry(n);
    });
    lines.forEach(function (n) {
      n.ins = rank(n.ins, function (id) {
        var e = n.inn.filter(function (o) { return o.item === id; })[0];
        if (!e) return Infinity;
        return e.via.length ? e.via[e.via.length - 1].y : portY(byKey[e.from], 'out', id);
      });
      setLineGeometry(n);
    });
  }

  /**
   * A splitter sends belts out its front and both sides; a merger takes them
   * in at its back and both sides. Each belt gets the side facing where it
   * goes, top to bottom.
   */
  function assignSides() {
    var byKey = graph.byKey;
    function sides(n, ys) {
      if (ys.length === 1) return ['front'];
      if (ys.length === 3) return ['top', 'front', 'bottom'];
      var mid = n.y + n.h / 2;
      if (ys[0] >= mid) return ['front', 'bottom'];
      if (ys[1] <= mid) return ['top', 'front'];
      return ['top', 'bottom'];
    }
    graph.nodes.forEach(function (n) {
      if (n.kind === 'splitter') {
        var outs = n.out.map(function (e) {
          var t = byKey[e.to];
          return { e: e, y: e.via.length ? e.via[0].y : t.y + (t.ports && t.ports.in[e.item] ? t.ports.in[e.item].y : t.h / 2) };
        }).sort(function (a, b) { return a.y - b.y; });
        var s = sides(n, outs.map(function (o) { return o.y; }));
        outs.forEach(function (o, i) { o.e.outSide = s[i]; });
      } else if (n.kind === 'merger') {
        var ins = n.inn.map(function (e) {
          var f = byKey[e.from];
          return { e: e, y: e.via.length ? e.via[e.via.length - 1].y : f.y + (f.ports && f.ports.out[e.item] ? f.ports.out[e.item].y : f.h / 2) };
        }).sort(function (a, b) { return a.y - b.y; });
        var s2 = sides(n, ins.map(function (o) { return o.y; }));
        ins.forEach(function (o, i) { o.e.inSide = s2[i]; });
      }
    });
  }

  /**
   * Takes needless kinks out of the belts before they're routed, in two
   * steps, each only where nothing else is in the way:
   *
   *  1. Buildings shift up or down a little (up to 4 m) where that lets more
   *     of their belts run level with what they connect to.
   *  2. A belt passing through columns picks one height per column, so it
   *     changes height as few times as it can: ideally once, straight from
   *     where it leaves to where it arrives. A belt off a splitter's or
   *     merger's side can instead run further out before it turns.
   */
  function straightenBelts(layers, startY, endY, partTop, partBottom, STUB) {
    var byKey = graph.byKey;
    var CLEAR = px(1);        // a belt running past a building
    var SPACE = px(2);        // two buildings in a column
    var BELT_SPACE = px(2);   // two belts running side by side
    var REACH = px(4);        // furthest a building moves
    var edges = graph.edges.filter(function (e) { return !e.back; });
    edges.forEach(function (e) { delete e.y0; delete e.y1; });

    // Distance between a point and a band [y, y + h]; negative inside it.
    function toBand(v, y, h) { return v < y ? y - v : v > y + h ? v - (y + h) : -1; }
    function boxGap(o, y, h) { return Math.max(o.y - (y + h), y - (o.y + o.h)); }

    // 1. Buildings.
    function fits(n, y) {
      return layers[n.col].every(function (o) {
        if (o === n) return true;
        if (o.dummy) {
          var dNew = toBand(o.y, y, n.h);
          return dNew >= CLEAR || dNew >= toBand(o.y, n.y, n.h);
        }
        var gNew = boxGap(o, y, n.h);
        return gNew >= SPACE || gNew >= boxGap(o, n.y, n.h);
      });
    }
    function mine(n) {
      return n.out.concat(n.inn).filter(function (e) { return !e.back; });
    }
    // Level, or a splitter's or merger's side run could reach it by
    // running further out.
    function isLevel(e) {
      var y0 = startY(e);
      var y1 = endY(e);
      if (Math.abs(y0 - y1) < 0.5) return true;
      var ra = sideRange(byKey[e.from], e.outSide);
      var rb = sideRange(byKey[e.to], e.inSide);
      return (!!ra && reaches(ra, y1)) || (!!rb && reaches(rb, y0));
    }
    function reaches(range, y) { return range.dir < 0 ? y <= range.max + 0.5 : y >= range.min - 0.5; }
    function level(n) {
      return mine(n).filter(isLevel).length;
    }
    var sorted = graph.nodes.slice().sort(function (a, b) { return a.col - b.col; });
    [sorted, sorted.slice().reverse(), sorted].forEach(function (order) {
      order.forEach(function (n) {
        var base = n.y;
        var best = level(n);
        var bestY = base;
        mine(n).forEach(function (e) {
          var d = e.from === n.key ? endY(e) - startY(e) : startY(e) - endY(e);
          if (Math.abs(d) < 0.5 || Math.abs(d) > REACH) return;
          var y = base + d;
          if (!fits(n, y)) return;
          n.y = y;
          var c = level(n);
          n.y = base;
          if (c > best) { best = c; bestY = y; }
        });
        n.y = bestY;
      });
    });

    // 2. Heights through the columns. Side runs that were lengthened are
    // kept per column, so the next belt keeps clear of them.
    var runs = layers.map(function () { return []; });   // [{ lo, hi, y }]

    function beltFits(col, y, self) {
      var ok = layers[col].every(function (o) {
        if (o === self) return true;
        if (o.dummy) return Math.abs(o.y - y) >= BELT_SPACE - 0.5;
        return y <= o.y - CLEAR || y >= o.y + o.h + CLEAR;
      });
      return ok && runs[col].every(function (r) { return Math.abs(r.y - y) >= BELT_SPACE - 0.5; });
    }
    // A side run from the part's edge (edgeY) out to y: nothing in between.
    function runFits(n, edgeY, y) {
      var lo = Math.min(edgeY, y);
      var hi = Math.max(edgeY, y);
      var ok = layers[n.col].every(function (o) {
        if (o === n) return true;
        if (o.dummy) return o.y < lo - BELT_SPACE + 0.5 || o.y > hi + BELT_SPACE - 0.5;
        return o.y + o.h + CLEAR <= lo || o.y - CLEAR >= hi;
      });
      return ok && runs[n.col].every(function (r) { return r.hi < lo || r.lo > hi; });
    }
    // Where a side run may end, or null for a belt fixed at its port.
    function sideRange(n, side) {
      if (n.kind !== 'splitter' && n.kind !== 'merger') return null;
      if (side === 'top') return { edge: partTop(n), max: partTop(n) - STUB, dir: -1 };
      if (side === 'bottom') return { edge: partBottom(n), min: partBottom(n) + STUB, dir: 1 };
      return null;
    }
    function runOk(n, range, y) {
      return reaches(range, y) && runFits(n, range.edge, y);
    }

    function settle(e) {
      var a = byKey[e.from];
      var b = byKey[e.to];
      var orig = [startY(e)].concat(e.via.map(function (d) { return d.y; }), [endY(e)]);
      var last = orig.length - 1;
      var kinks = 0;
      for (var k = 0; k < last; k++) if (Math.abs(orig[k] - orig[k + 1]) > 0.5) kinks++;
      if (!kinks) return;
      var outRange = sideRange(a, e.outSide);
      var inRange = sideRange(b, e.inSide);
      var heights = [];
      orig.forEach(function (y) {
        if (!heights.some(function (h) { return Math.abs(h - y) < 0.5; })) heights.push(y);
      });
      var cand = orig.map(function (y0, p) {
        return heights.filter(function (y) {
          if (Math.abs(y - y0) < 0.5) return true;
          if (p === 0) return !!outRange && runOk(a, outRange, y);
          if (p === last) return !!inRange && runOk(b, inRange, y);
          return beltFits(a.col + p, y, e.via[p - 1]);
        });
      });
      // Fewest changes of height; among those, closest to where it was.
      var cost = [];
      var from = [];
      cand.forEach(function (list, p) {
        cost[p] = [];
        from[p] = [];
        list.forEach(function (y, j) {
          var drift = Math.abs(y - orig[p]) * 1e-6;
          if (p === 0) { cost[p][j] = drift; return; }
          var best = Infinity;
          cand[p - 1].forEach(function (yp, i) {
            var c = cost[p - 1][i] + (Math.abs(yp - y) > 0.5 ? 1 : 0);
            if (c < best) { best = c; from[p][j] = i; }
          });
          cost[p][j] = best + drift;
        });
      });
      var j = 0;
      cost[last].forEach(function (c, i) { if (c < cost[last][j]) j = i; });
      if (!(cost[last][j] < kinks - 0.5)) return;
      var pick = [];
      for (var p = last; p >= 0; p--) {
        pick[p] = cand[p][j];
        j = from[p][j];
      }
      e.via.forEach(function (d, i) { d.y = pick[i + 1]; });
      if (Math.abs(pick[0] - orig[0]) > 0.5) {
        e.y0 = pick[0];
        runs[a.col].push({ lo: Math.min(outRange.edge, pick[0]), hi: Math.max(outRange.edge, pick[0]), y: pick[0] });
      }
      if (Math.abs(pick[last] - orig[last]) > 0.5) {
        e.y1 = pick[last];
        runs[b.col].push({ lo: Math.min(inRange.edge, pick[last]), hi: Math.max(inRange.edge, pick[last]), y: pick[last] });
      }
    }
    var byLength = edges.slice().sort(function (x, y) { return y.via.length - x.via.length; });
    byLength.forEach(settle);
    byLength.forEach(settle);
  }

  /**
   * Finishes the machine view's layout once rows are ordered and placed:
   * snaps everything to whole metres, picks ports, runs every belt between
   * columns on its own vertical track in the gap, and sizes each gap to fit
   * its tracks. Belts end up as corner points in e.route.
   */
  function routeMachineView(layers) {
    var byKey = graph.byKey;
    var nodes = graph.nodes;

    nodes.forEach(function (n) { n.y = snap(n.cy - n.h / 2); });
    layers.forEach(function (layer) {
      layer.forEach(function (d) { if (d.dummy) d.y = snap(d.cy); });
    });

    assignPorts();
    assignSides();

    // Card ports spread along the edge, in the order of what's at the other end.
    var cardOut = {};
    var cardIn = {};
    nodes.forEach(function (n) {
      if (n.kind === 'line' || n.kind === 'splitter' || n.kind === 'merger') return;
      function yOther(e, outward) {
        var v = e.via;
        if (v.length) return outward ? v[0].y : v[v.length - 1].y;
        var o = byKey[outward ? e.to : e.from];
        return o.y + o.h / 2;
      }
      n.out.slice().sort(function (a, b) { return yOther(a, true) - yOther(b, true); })
        .forEach(function (e, i, all) { cardOut[edgeId(e)] = snap(n.h * (i + 1) / (all.length + 1)); });
      n.inn.slice().sort(function (a, b) { return yOther(a, false) - yOther(b, false); })
        .forEach(function (e, i, all) {
          if (n.slots) {
            // Each belt into its own container, top to bottom.
            cardIn[edgeId(e)] = n.slots[i];
            n.slotEdges[i] = e;
          } else {
            cardIn[edgeId(e)] = snap(n.h * (i + 1) / (all.length + 1));
          }
        });
    });

    var STUB = px(STUB_M);
    // A splitter or merger sits in the middle of its layout box; sides are its own edges.
    function partTop(n) { return n.y + (n.h - n.part) / 2; }
    function partBottom(n) { return n.y + (n.h + n.part) / 2; }
    // A belt off a splitter's or merger's side runs out STUB, or further
    // (e.y0, e.y1) where that saves it a kink.
    function startY(e) {
      var a = byKey[e.from];
      if (a.kind === 'line') return a.y + a.ports.out[e.item].y;
      if (a.kind === 'splitter' || a.kind === 'merger') {
        if (e.outSide === 'top') return e.y0 != null ? e.y0 : partTop(a) - STUB;
        if (e.outSide === 'bottom') return e.y0 != null ? e.y0 : partBottom(a) + STUB;
        return a.y + a.h / 2;
      }
      return a.y + cardOut[edgeId(e)];
    }
    function endY(e) {
      var b = byKey[e.to];
      if (b.kind === 'line') return b.y + b.ports.in[e.item].y;
      if (b.kind === 'splitter' || b.kind === 'merger') {
        if (e.inSide === 'top') return e.y1 != null ? e.y1 : partTop(b) - STUB;
        if (e.inSide === 'bottom') return e.y1 != null ? e.y1 : partBottom(b) + STUB;
        return b.y + b.h / 2;
      }
      return b.y + cardIn[edgeId(e)];
    }

    straightenBelts(layers, startY, endY, partTop, partBottom, STUB);

    // Every hop between neighbouring columns that changes height needs a
    // vertical track in the gap between them.
    var gaps = layers.map(function () { return []; });
    graph.edges.forEach(function (e) {
      if (e.back) return;
      var a = byKey[e.from];
      e.ys = [startY(e)].concat(e.via.map(function (d) { return d.y; }), [endY(e)]);
      e.tracks = [];
      for (var k = 0; k + 1 < e.ys.length; k++) {
        if (Math.abs(e.ys[k] - e.ys[k + 1]) > 0.5) {
          var hop = { e: e, k: k, ya: e.ys[k], yb: e.ys[k + 1] };
          gaps[a.col + k].push(hop);
          e.tracks[k] = hop;
        }
      }
    });

    /** Crossings if `left` takes a track left of `right`. */
    // Heights closer than a belt and a bit apart count as the same: two belts
    // there would be drawn on top of each other.
    var NEAR = px(1.25);
    function between(y, a, b) { return y > Math.min(a, b) + NEAR && y < Math.max(a, b) - NEAR; }
    function cost(left, right) {
      // Where the left belt leaves its track at the height the right one
      // arrives at, the two would run on top of each other: far worse than
      // a crossing.
      var same = function (a, b) { return Math.abs(a - b) < NEAR; };
      return (between(left.yb, right.ya, right.yb) ? 1 : 0) +
        (between(right.ya, left.ya, left.yb) ? 1 : 0) +
        (same(left.yb, right.ya) ? 5 : 0) +
        (same(left.ya, right.ya) || same(left.yb, right.yb) ? 5 : 0);
    }
    function total(order) {
      var c = 0;
      for (var i = 0; i < order.length; i++) {
        for (var j = i + 1; j < order.length; j++) c += cost(order[i], order[j]);
      }
      return c;
    }
    gaps.forEach(function (hops, g) {
      if (hops.length < 2) {
        gaps[g] = hops;
        return;
      }
      // Try a few natural orders, keep the one with fewest crossings, then
      // swap neighbours while that helps.
      var keys = [
        function (h) { return h.ya; },
        function (h) { return -h.ya; },
        function (h) { return h.yb; },
        function (h) { return -h.yb; },
        function (h) { return h.yb > h.ya ? -h.ya : 1e6 + h.ya; },
        function (h) { return h.yb > h.ya ? h.yb : -1e6 - h.yb; }
      ];
      var best = null;
      var bestCost = Infinity;
      keys.forEach(function (key) {
        var order = hops.slice().sort(function (a, b) { return key(a) - key(b); });
        var c = total(order);
        if (c < bestCost) { bestCost = c; best = order; }
      });
      // Then swap any two tracks while that lowers the total. A swap only
      // changes how the pair sits against each other and against the tracks
      // between them, so that's all that's counted.
      function swapGain(order, i, j) {
        var a = order[i];
        var b = order[j];
        var before = cost(a, b);
        var after = cost(b, a);
        for (var k = i + 1; k < j; k++) {
          var m = order[k];
          before += cost(a, m) + cost(m, b);
          after += cost(m, a) + cost(b, m);
        }
        return before - after;
      }
      var improved = true;
      var rounds = 0;
      var reach = best.length > 120 ? 8 : best.length;  // very wide gaps: nearby swaps only
      while (improved && bestCost > 0 && rounds++ < 12) {
        improved = false;
        for (var i = 0; i < best.length; i++) {
          for (var j = i + 1; j < best.length && j - i <= reach; j++) {
            var gain = swapGain(best, i, j);
            if (gain > 0) {
              var t = best[i];
              best[i] = best[j];
              best[j] = t;
              bestCost -= gain;
              improved = true;
            }
          }
        }
      }
      // Finally, the one rule that must hold: a belt arriving at a height
      // another belt leaves at takes the track to its left, or the two
      // would share a stretch of belt. Keeps the order above wherever the
      // rule allows (a topological sort that always picks the earliest).
      var mustPrecede = best.map(function () { return []; });
      var waitingOn = best.map(function () { return 0; });
      best.forEach(function (x, xi) {
        best.forEach(function (y, yi) {
          if (xi !== yi && Math.abs(x.yb - y.ya) < NEAR) {
            mustPrecede[yi].push(xi);  // y left of x
            waitingOn[xi]++;
          }
        });
      });
      var placed = [];
      var done = best.map(function () { return false; });
      while (placed.length < best.length) {
        var pick = -1;
        for (var q = 0; q < best.length; q++) {
          if (!done[q] && waitingOn[q] === 0) { pick = q; break; }
        }
        if (pick < 0) {
          // A loop of such pairs can't all be met; keep the rest as they were.
          for (var r = 0; r < best.length; r++) if (!done[r]) { pick = r; break; }
        }
        done[pick] = true;
        placed.push(best[pick]);
        mustPrecede[pick].forEach(function (x) { waitingOn[x]--; });
      }
      gaps[g] = placed;
    });

    // Columns, snapped to whole foundations; each gap as wide as its tracks need.
    var FOUNDATION = px(8);
    var colX = [];
    var colW = [];
    var x = 0;
    layers.forEach(function (layer, c) {
      colX[c] = Math.ceil(x / FOUNDATION) * FOUNDATION;
      colW[c] = snap(layer.reduce(function (w, n) { return Math.max(w, n.w); }, 0));
      var tracks = gaps[c] ? gaps[c].length : 0;
      var gapW = px(Math.max(MIN_GAP_M, 4 + tracks * TRACK_M));
      var first = colX[c] + colW[c] + (gapW - px((tracks - 1) * TRACK_M)) / 2;
      (gaps[c] || []).forEach(function (hop, t) { hop.x = snap(first + px(t * TRACK_M)); });
      x = colX[c] + colW[c] + gapW;
    });

    nodes.forEach(function (n) { n.x = colX[n.col]; });
    layers.forEach(function (layer, c) {
      layer.forEach(function (d) { if (d.dummy) d.x = colX[c] + colW[c] / 2; });
    });

    // Corner points for every belt.
    var lowest = nodes.reduce(function (m, n) { return Math.max(m, n.y + n.h); }, 0);
    var loops = 0;
    graph.edges.forEach(function (e) {
      var a = byKey[e.from];
      var b = byKey[e.to];
      var pts = [];
      var ax = a.x + a.w;
      var acx = a.x + a.w / 2;
      var bcx = b.x + b.w / 2;

      if (e.back) {
        // A loop back upstream runs round underneath everything, on its own
        // lanes, and joins at whichever side it was given like any other belt.
        var k = loops++;
        var y0 = startY(e);
        var y1 = endY(e);
        var low = lowest + px(4 + 2 * k);
        var back = [];
        if (e.outSide === 'top') back.push([acx, partTop(a)], [acx, y0]);
        else if (e.outSide === 'bottom') back.push([acx, partBottom(a)], [acx, y0]);
        else back.push([ax, y0]);
        var xr = ax + px(2 + 2 * k);
        var xl = b.x - px(2 + 2 * k);
        back.push([xr, y0], [xr, low], [xl, low], [xl, y1]);
        if (e.inSide === 'top') back.push([bcx, y1], [bcx, partTop(b)]);
        else if (e.inSide === 'bottom') back.push([bcx, y1], [bcx, partBottom(b)]);
        else back.push([b.x, y1]);
        e.route = simplify(back);
        return;
      }

      // Off a splitter's side, the belt runs straight out before turning.
      if (e.outSide === 'top') pts.push([acx, partTop(a)], [acx, e.ys[0]]);
      else if (e.outSide === 'bottom') pts.push([acx, partBottom(a)], [acx, e.ys[0]]);
      else pts.push([ax, e.ys[0]]);

      for (var k = 0; k + 1 < e.ys.length; k++) {
        var hop = e.tracks[k];
        if (hop) pts.push([hop.x, e.ys[k]], [hop.x, e.ys[k + 1]]);
      }

      if (e.inSide === 'top') pts.push([bcx, e.ys[e.ys.length - 1]], [bcx, partTop(b)]);
      else if (e.inSide === 'bottom') pts.push([bcx, e.ys[e.ys.length - 1]], [bcx, partBottom(b)]);
      else pts.push([b.x, e.ys[e.ys.length - 1]]);

      e.route = simplify(pts);
    });
  }

  /** Drops repeated and in-line corner points. */
  function simplify(pts) {
    var out = [];
    pts.forEach(function (p) {
      var last = out[out.length - 1];
      if (last && last[0] === p[0] && last[1] === p[1]) return;
      if (out.length >= 2) {
        var a = out[out.length - 2];
        var b = last;
        if ((a[0] === b[0] && b[0] === p[0]) || (a[1] === b[1] && b[1] === p[1])) {
          out[out.length - 1] = p;
          return;
        }
      }
      out.push(p);
    });
    return out;
  }

  /**
   * One building, drawn top-down at its real footprint with belts running
   * left to right through it: its name, what it makes, and its clock.
   */
  function machineShape(size, name, product, sub, clock, ins, outs, pre) {
    var m = document.createElement('div');
    m.className = 'machine';
    if (clock < 1 - 1e-6) m.classList.add('under');
    if (clock > 1 + 1e-6) m.classList.add('over');
    m.style.width = px(size ? size.l : 10) + 'px';
    m.style.height = px(size ? size.w : 8) + 'px';
    var shards = shardsFor(clock);
    m.title = name + ' · ' + product + ' · ' + Number((clock * 100).toFixed(4)) + '% clock' +
      (shards ? ' (' + shards + ' Power Shard' + (shards > 1 ? 's' : '') + ')' : '') +
      (size ? ' · ' + size.l + ' × ' + size.w + ' m' : '');

    var nm = document.createElement('span');
    nm.className = 'm-name';
    m.appendChild(nameSpans(nm, name));
    var prod = document.createElement('span');
    prod.className = 'm-product';
    prod.textContent = product;
    m.appendChild(prod);
    // The clock speed on its own, so the display options can hide it and
    // leave a miner's node purity.
    var line = document.createElement('span');
    line.className = 'm-sub';
    var clk = document.createElement('span');
    clk.className = 'm-clock';
    clk.textContent = sub;
    if (pre) {
      line.appendChild(document.createTextNode(pre));
      var sep = document.createElement('span');
      sep.className = 'm-clock';
      sep.textContent = ' · ';
      line.appendChild(sep);
    } else {
      line.classList.add('m-clock');
    }
    line.appendChild(clk);
    m.appendChild(line);

    function ports(list, side) {
      list.forEach(function (id, i) {
        var dot = document.createElement('span');
        dot.className = 'm-port ' + side + (isFluid(id) ? ' fluid' : '');
        dot.style.top = ((i + 1) / (list.length + 1)) * 100 + '%';
        m.appendChild(dot);
      });
    }
    ports(ins, 'in');
    ports(outs, 'out');
    return m;
  }

  /**
   * A splitter or merger at its real size, centred on (x, y) px, marked S or
   * M. On a pipe it's a Pipeline Junction doing the same job: round, and the
   * game's 2.4 m.
   */
  function partShape(role, fluid, item, x, y, note) {
    var size = px(fluid ? JUNCTION_M : SPLIT_M);
    var el = document.createElement('div');
    el.className = 'part ' + role + (fluid ? ' junction' : '');
    el.style.width = size + 'px';
    el.style.height = size + 'px';
    el.style.left = x - size / 2 + 'px';
    el.style.top = y - size / 2 + 'px';
    el.textContent = role === 'merger' ? 'M' : 'S';
    el.title = (fluid ? 'Pipeline Junction, ' + (role === 'merger' ? 'joining' : 'splitting') : 'Conveyor ' + titleCase(role)) +
      ' · ' + itemName(item) + (note ? '\n' + note : '');
    return el;
  }

  var CORNER_M = 1.5;   // radius a belt turns on

  /**
   * SVG path along corner points, with each corner rounded: the radius
   * shrinks where the runs either side are too short to take it.
   */
  function roundedPath(pts) {
    var r = px(CORNER_M);
    var d = 'M ' + pts[0][0] + ' ' + pts[0][1];
    for (var i = 1; i < pts.length - 1; i++) {
      var p = pts[i - 1], c = pts[i], q = pts[i + 1];
      var inLen = Math.abs(c[0] - p[0]) + Math.abs(c[1] - p[1]);
      var outLen = Math.abs(q[0] - c[0]) + Math.abs(q[1] - c[1]);
      var k = Math.min(r, inLen / 2, outLen / 2);
      if (k < 0.5) {
        d += ' L ' + c[0] + ' ' + c[1];
        continue;
      }
      var a = [c[0] - Math.sign(c[0] - p[0]) * k, c[1] - Math.sign(c[1] - p[1]) * k];
      var b = [c[0] + Math.sign(q[0] - c[0]) * k, c[1] + Math.sign(q[1] - c[1]) * k];
      d += ' L ' + a[0] + ' ' + a[1] + ' Q ' + c[0] + ' ' + c[1] + ' ' + b[0] + ' ' + b[1];
    }
    var last = pts[pts.length - 1];
    return d + ' L ' + last[0] + ' ' + last[1];
  }

  /** A belt (or pipe) along corner points, over a dark casing so crossings read. */
  function belt(pts, fluid, keys) {
    var d = roundedPath(pts);
    svg('path', { d: d, 'class': 'belt-casing' });
    if (fluid) {
      relate(keys, svg('path', { d: d, 'class': 'belt pipe' }));
      relate(keys, svg('path', { d: d, 'class': 'belt pipe-core' }));
    } else {
      relate(keys, svg('path', { d: d, 'class': 'belt' }));
    }
  }

  function renderMachineView() {
    while (wires.firstChild) wires.removeChild(wires.firstChild);
    labelsEl.innerHTML = '';
    related = {};
    var byKey = graph.byKey;

    // Belts between lines first, so the lines' own belts sit over them.
    graph.edges.forEach(function (e) {
      if (!e.route) return;
      belt(e.route, isFluid(e.item), [e.from, e.to]);
      labelBelt(e, byKey[e.from]);
    });

    graph.nodes.forEach(function (n) {
      if (n.kind === 'line') {
        var g = n.geo;
        var abs = function (p) { return [n.x + px(p[0]), n.y + px(p[1])]; };
        // Manifolds, then the branches that cross over them.
        g.belts.filter(function (b) { return !b.branch; })
          .concat(g.belts.filter(function (b) { return b.branch; }))
          .forEach(function (b) { belt(b.pts.map(abs), isFluid(b.item), []); });
        g.machines.forEach(function (gm) {
          var shape = machineShape(n.size, gm.m.name || n.name, gm.m.product, gm.m.sub, gm.m.clock, n.ins, n.outs, gm.m.pre);
          // Miners and extractors bring things in rather than make them: grey.
          if (n.key.indexOf('raw:') === 0) shape.classList.add('extractor');
          shape.style.left = n.x + px(gm.x) + 'px';
          shape.style.top = n.y + px(gm.y) + 'px';
          world.appendChild(shape);
        });
        g.parts.forEach(function (p) {
          var at = abs([p.x, p.y]);
          world.appendChild(partShape(p.role, p.fluid, p.item, at[0], at[1], p.note));
        });
      } else if (n.kind === 'splitter' || n.kind === 'merger') {
        world.appendChild(partShape(n.kind, n.fluid, n.item, n.x + n.w / 2, n.y + n.h / 2));
      } else if (n.store) {
        n.slots.forEach(function (_, i) {
          var e = n.slotEdges[i];
          var el = storageShape(n, e ? e.rate : n.rate);
          el.style.left = n.x + 'px';
          el.style.top = n.y + i * (n.store.h + n.store.gap) + 'px';
          world.appendChild(el);
        });
      } else {
        place(n);
      }
    });

    graph.edges.forEach(function (e) {
      if (!e.route) return;
      var fluid = isFluid(e.item);
      var keys = [e.from, e.to];
      var ends = [];
      if (byKey[e.from].kind === 'line') ends.push(e.route[0]);
      if (byKey[e.to].kind === 'line') ends.push(e.route[e.route.length - 1]);
      ends.forEach(function (p) {
        var d = 'M ' + (p[0] - 3) + ' ' + p[1] + ' L ' + (p[0] + 3) + ' ' + p[1];
        if (fluid) {
          relate(keys, svg('path', { d: d, 'class': 'belt pipe' }));
          relate(keys, svg('path', { d: d, 'class': 'belt pipe-core' }));
        } else {
          relate(keys, svg('path', { d: d, 'class': 'belt' }));
        }
      });
    });
  }

  /** Rate and belt tier, on the belt's longest straight run. */
  function labelBelt(e, from) {
    var pts = e.route;
    var best = null;
    for (var i = 0; i + 1 < pts.length; i++) {
      var len = Math.abs(pts[i + 1][0] - pts[i][0]) + Math.abs(pts[i + 1][1] - pts[i][1]);
      var flat = pts[i][1] === pts[i + 1][1];
      if (!best || (flat && !best.flat) || (flat === best.flat && len > best.len)) {
        best = { len: len, flat: flat, x: (pts[i][0] + pts[i + 1][0]) / 2, y: (pts[i][1] + pts[i + 1][1]) / 2 };
      }
    }
    if (!best) return;
    var fluid = isFluid(e.item);
    var label = document.createElement('div');
    label.className = 'flow-label';
    label.style.left = best.x + 'px';
    label.style.top = best.y + 'px';
    var b = document.createElement('b');
    b.textContent = fmtNum(e.rate);
    label.appendChild(b);
    label.appendChild(document.createTextNode((fluid ? ' m³' : '') + '/min'));
    if (from.item !== e.item) {
      var name = document.createElement('span');
      name.className = 'fl-item';
      name.textContent = itemName(e.item);
      label.appendChild(name);
    }
    var tier = tierFor(e.item, e.rate);
    var allowed = fluid ? state.pipe : state.belt;
    var t = document.createElement('span');
    var over = !tier || tier > allowed;
    t.className = 'fl-tier' + (over ? ' warn' : '');
    t.textContent = tier ? 'Mk.' + tier : 'too fast';
    t.title = over
      ? 'Needs a faster ' + (fluid ? 'pipe' : 'belt') + ' than the plan allows'
      : (fluid ? 'Pipeline ' : 'Conveyor Belt ') + 'Mk.' + tier + ' or faster';
    label.appendChild(t);
    labelsEl.appendChild(label);
    relate([e.from, e.to], label);
  }

  function place(n) {
    n.el.style.left = n.x + 'px';
    n.el.style.top = n.y + 'px';
    n.el.classList.toggle('pinned', !!n.pinned);
  }

  /* ---------------------------------------------------------------- wires */

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var wires = document.getElementById('wires');
  var related = {};   // node key -> elements to light up on hover

  /** Cubic bezier that leaves both ends along their outward normals. */
  function wirePath(p1, n1, p2, n2) {
    var dx = p2.x - p1.x;
    var dy = p2.y - p1.y;
    // Slack scales with distance, so short hops don't loop and long runs bow.
    var k = Math.max(45, Math.min(Math.sqrt(dx * dx + dy * dy) * 0.45, 220));
    var c1 = { x: p1.x + n1.x * k, y: p1.y + n1.y * k };
    var c2 = { x: p2.x + n2.x * k, y: p2.y + n2.y * k };
    return {
      d: 'M ' + p1.x + ' ' + p1.y +
        ' C ' + c1.x + ' ' + c1.y + ' ' + c2.x + ' ' + c2.y + ' ' + p2.x + ' ' + p2.y,
      // Curve midpoint, where the rate label sits.
      mid: {
        x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8,
        y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8
      }
    };
  }

  /**
   * A line through the waypoints layout left in the columns it crosses. It's
   * level at every point, so the chain of curves reads as one smooth run.
   */
  function routePath(pts) {
    if (pts.length === 2) return wirePath(pts[0], { x: 1, y: 0 }, pts[1], { x: -1, y: 0 });
    var d = 'M ' + pts[0].x + ' ' + pts[0].y;
    var mids = [];
    for (var i = 0; i + 1 < pts.length; i++) {
      var p = pts[i];
      var q = pts[i + 1];
      var k = Math.max(24, Math.abs(q.x - p.x) * 0.5);
      var c1 = { x: p.x + k, y: p.y };
      var c2 = { x: q.x - k, y: q.y };
      d += ' C ' + c1.x + ' ' + c1.y + ' ' + c2.x + ' ' + c2.y + ' ' + q.x + ' ' + q.y;
      mids.push({ x: (p.x + 3 * c1.x + 3 * c2.x + q.x) / 8, y: (p.y + 3 * c1.y + 3 * c2.y + q.y) / 8 });
    }
    return { d: d, mid: mids[Math.floor((mids.length - 1) / 2)] };
  }

  function svg(tag, attrs, layer) {
    var el = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    (layer || wires).appendChild(el);
    return el;
  }

  function relate(keys, el) {
    keys.forEach(function (k) { (related[k] = related[k] || []).push(el); });
  }

  /** A belt, or for fluids a pipe: drawn as a hollow double line. */
  function line(d, fluid, keys, layer) {
    if (fluid) {
      relate(keys, svg('path', { d: d, 'class': 'wire pipe' }, layer));
      relate(keys, svg('path', { d: d, 'class': 'wire pipe-core' }, layer));
    } else {
      relate(keys, svg('path', { d: d, 'class': 'wire' }, layer));
    }
  }

  function renderWires() {
    while (wires.firstChild) wires.removeChild(wires.firstChild);
    labelsEl.innerHTML = '';
    related = {};

    var byKey = graph.byKey;

    // A moved node breaks the route layout planned, so its lines go direct.
    function viaOf(e) {
      if (byKey[e.from].pinned || byKey[e.to].pinned) return [];
      return e.via || [];
    }
    function centerY(key) { var n = byKey[key]; return n.y + n.h / 2; }
    function nextY(e) { var v = viaOf(e); return v.length ? v[0].y : centerY(e.to); }
    function prevY(e) { var v = viaOf(e); return v.length ? v[v.length - 1].y : centerY(e.from); }

    // Each node spreads its lines along its edge, in the order of whatever is
    // at the other end, so they leave and arrive without crossing each other.
    var outPos = {};
    var inPos = {};
    graph.nodes.forEach(function (n) {
      var outs = n.out.slice().sort(function (a, b) { return nextY(a) - nextY(b); });
      outs.forEach(function (e, i) {
        outPos[edgeId(e)] = { x: n.x + n.w, y: n.y + n.h * (i + 1) / (outs.length + 1) };
      });
      var ins = n.inn.slice().sort(function (a, b) { return prevY(a) - prevY(b); });
      ins.forEach(function (e, i) {
        inPos[edgeId(e)] = { x: n.x, y: n.y + n.h * (i + 1) / (ins.length + 1) };
      });
    });

    graph.edges.forEach(function (e) {
      var p1 = outPos[edgeId(e)];
      var p2 = inPos[edgeId(e)];
      var pts = [p1].concat(viaOf(e).map(function (d) { return { x: d.x, y: d.y }; }), [p2]);
      var path = routePath(pts);
      var keys = [e.from, e.to];
      var fluid = isFluid(e.item);

      line(path.d, fluid, keys);
      relate(keys, svg('circle', { cx: p1.x, cy: p1.y, r: 3.5, 'class': 'wire-end' }));
      relate(keys, svg('circle', { cx: p2.x, cy: p2.y, r: 3.5, 'class': 'wire-end' }));

      var label = document.createElement('div');
      label.className = 'flow-label';
      label.style.left = path.mid.x + 'px';
      label.style.top = path.mid.y + 'px';
      var b = document.createElement('b');
      b.textContent = fmtNum(e.rate);
      label.appendChild(b);
      label.appendChild(document.createTextNode((fluid ? ' m³' : '') + '/min'));
      // The line's item is obvious from the node it leaves, unless that node
      // makes more than one thing.
      if (byKey[e.from].item !== e.item) {
        var name = document.createElement('span');
        name.className = 'fl-item';
        name.textContent = itemName(e.item);
        label.appendChild(name);
      }
      labelsEl.appendChild(label);
      relate(keys, label);
    });

    if (hovered) focusNode(hovered, true);
  }

  function edgeId(e) { return e.from + '>' + e.to + '>' + e.item; }

  var hovered = null;
  var dragging = false;

  function focusNode(key, on) {
    if (dragging && !on) return;
    world.querySelectorAll('.hot').forEach(function (el) { el.classList.remove('hot'); });
    hovered = on ? key : null;
    world.classList.toggle('focusing', on);
    if (on) (related[key] || []).forEach(function (el) { el.classList.add('hot'); });
  }

  /* -------------------------------------------------------------- dragging */

  var NO_DRAG = 'INPUT,TEXTAREA,BUTTON,A,SELECT';

  function dragBehaviour(el, n) {
    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      // The machine view can't be rearranged; a press there pans instead.
      if (state.mode === 'machines') return;
      if (e.target.closest(NO_DRAG)) return;
      closeAll();

      e.preventDefault();
      e.stopPropagation();
      // Capture is an optimisation; a browser refusing it must not abort the drag.
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }

      var startX = e.clientX;
      var startY = e.clientY;
      var mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
      // A selected node brings the rest of the selection with it.
      var group = selected[n.key] ? selectedNodes() : [n];
      var origins = group.map(function (g) { return { x: g.x, y: g.y }; });
      var moved = false;

      function onMove(ev) {
        var dx = (ev.clientX - startX) / state.view.s;
        var dy = (ev.clientY - startY) / state.view.s;
        // A few pixels of slop, so a click on a node doesn't pin it.
        if (!moved && Math.abs(dx) + Math.abs(dy) < 3 / state.view.s) return;
        if (!moved) {
          moved = true;
          dragging = true;
          el.classList.add('dragging');
        }
        group.forEach(function (g, i) {
          g.x = Math.round(origins[i].x + dx);
          g.y = Math.round(origins[i].y + dy);
          g.pinned = true;
          pins()[g.key] = { x: g.x, y: g.y };
          place(g);
        });
        renderWires(); // lines follow the nodes as they move
      }

      function onUp(ev) {
        try { el.releasePointerCapture(ev.pointerId); } catch (err) { /* never captured */ }
        el.classList.remove('dragging');
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        dragging = false;
        if (moved) save();
        else pickNode(n, mods);
      }

      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });
  }

  /* ------------------------------------------------------------ selection */

  // Nodes picked in the Items view, by key, so a selection survives any
  // re-solve that keeps them. selAnchor is where a Shift+click range starts.
  var selected = {};
  var selAnchor = null;

  function selectedNodes() {
    return graph.nodes.filter(function (n) { return selected[n.key] && n.el; });
  }
  function applySelection() {
    graph.nodes.forEach(function (n) {
      if (n.el) n.el.classList.toggle('selected', !!selected[n.key]);
    });
  }
  function selectOnly(key) {
    selected = {};
    if (key) selected[key] = true;
    selAnchor = key || null;
    applySelection();
  }
  function clearSelection() { selectOnly(null); }

  /** After a redraw: drop what's gone, and in the Machines view, everything. */
  function keepSelection() {
    if (state.mode !== 'items') {
      selected = {};
      selAnchor = null;
      return;
    }
    Object.keys(selected).forEach(function (k) { if (!graph.byKey[k]) delete selected[k]; });
    if (selAnchor && !graph.byKey[selAnchor]) selAnchor = null;
    applySelection();
  }

  /** A click on a node: select it; Ctrl adds or removes it; Shift takes the range. */
  function pickNode(n, mods) {
    if (mods.shift && selAnchor && graph.byKey[selAnchor] && selAnchor !== n.key) {
      var range = between(graph.byKey[selAnchor], n);
      if (!mods.ctrl) selected = {};
      range.forEach(function (m) { selected[m.key] = true; });
      applySelection();
      return;
    }
    if (mods.ctrl) {
      if (selected[n.key]) delete selected[n.key];
      else selected[n.key] = true;
      selAnchor = n.key;
      applySelection();
      return;
    }
    selectOnly(n.key);
  }

  /**
   * Everything in a line between two nodes. Where belts join them, the one
   * chain of belts that keeps closest to the straight line between the two
   * (Iron Ingot to Reinforced Iron Plate takes the rods and screws in that
   * row, not the plates off to the side). Otherwise, whatever that straight
   * line passes through (the bottom of five stacked ore nodes to the second
   * from the top takes all but the top one).
   */
  function between(a, b) {
    var ax = a.x + a.w / 2, ay = a.y + a.h / 2;
    var bx = b.x + b.w / 2, by = b.y + b.h / 2;
    var len = Math.hypot(bx - ax, by - ay) || 1;
    function offLine(n) {
      var cx = n.x + n.w / 2, cy = n.y + n.h / 2;
      return Math.abs((bx - ax) * (ay - cy) - (ax - cx) * (by - ay)) / len;
    }
    function reach(from, dir) {
      var seen = {};
      var queue = [from];
      seen[from.key] = true;
      while (queue.length) {
        var n = queue.shift();
        n[dir].forEach(function (e) {
          var next = graph.byKey[dir === 'out' ? e.to : e.from];
          if (next && !seen[next.key]) {
            seen[next.key] = true;
            queue.push(next);
          }
        });
      }
      return seen;
    }
    // A chain's score: its furthest node from the line, then its average.
    function better(p, q) {
      if (!q) return true;
      if (Math.abs(p.worst - q.worst) > 0.5) return p.worst < q.worst;
      if (Math.abs(p.mean - q.mean) > 0.5) return p.mean < q.mean;
      return p.nodes.length < q.nodes.length;
    }
    function chain(x, y) {
      var down = reach(x, 'out');
      if (!down[y.key]) return null;
      var up = reach(y, 'inn');
      var best = null;
      var tried = 0;
      (function walk(n, trail) {
        if (tried > 2000) return;
        if (n === y) {
          tried++;
          var offs = trail.slice(1, -1).map(offLine);
          var cand = {
            nodes: trail.slice(),
            worst: offs.length ? Math.max.apply(null, offs) : 0,
            mean: offs.length ? offs.reduce(function (s, o) { return s + o; }, 0) / offs.length : 0
          };
          if (better(cand, best)) best = cand;
          return;
        }
        n.out.forEach(function (e) {
          var next = graph.byKey[e.to];
          if (!next || !down[next.key] || !up[next.key] || trail.indexOf(next) >= 0) return;
          trail.push(next);
          walk(next, trail);
          trail.pop();
        });
      })(x, [x]);
      return best && best.nodes;
    }
    var list = chain(a, b) || chain(b, a);
    if (list) return list;
    // Not joined by belts: what a band along the line, half a node high,
    // passes through.
    var band = Math.min(a.h, b.h) / 4;
    var steps = Math.max(2, Math.ceil(len / 4));
    return graph.nodes.filter(function (n) {
      if (!n.el) return false;
      for (var i = 0; i <= steps; i++) {
        var px = ax + (bx - ax) * i / steps;
        var py = ay + (by - ay) * i / steps;
        if (px >= n.x && px <= n.x + n.w && py >= n.y - band && py <= n.y + n.h + band) return true;
      }
      return false;
    });
  }

  /** Whether a node can be removed: a step, an output, or one of several resource nodes. */
  function canRemove(n) {
    if (n.kind === 'recipe' || n.kind === 'output') return true;
    return n.kind === 'raw' && n.slot != null && storedNodes(n.item).length > 1;
  }

  /**
   * Removes nodes: an output stops being asked for; a step stops being made
   * here and is brought in instead; a resource node comes off its resource.
   */
  function removeNodes(list) {
    list = list.filter(canRemove);
    if (!list.length) return;
    var dropTargets = {};
    var slots = {};
    list.forEach(function (n) {
      if (n.kind === 'output') dropTargets[n.item] = true;
      else if (n.kind === 'recipe') {
        state.imports[n.item] = true;
        delete state.recipes[n.item];
      } else {
        (slots[n.item] = slots[n.item] || []).push(n.slot);
      }
    });
    state.targets = state.targets.filter(function (t) { return !dropTargets[t.item]; });
    Object.keys(slots).forEach(function (id) {
      var s = state.supply[id] || {};
      var nodes = storedNodes(id).filter(function (_, i) { return slots[id].indexOf(i) < 0; });
      if (!nodes.length) return;  // a resource keeps at least one node
      state.supply[id] = { nodes: nodes, miner: s.miner };
    });
    clearSelection();
    renderTargets();
    changed();
  }

  function makeOutputs(items) {
    items.forEach(function (id) {
      if (!targetFor(id)) state.targets.push({ item: id, rate: NEW_TARGET_RATE, max: true });
    });
    renderTargets();
    changed();
  }

  function removeOutputs(items) {
    state.targets = state.targets.filter(function (t) { return items.indexOf(t.item) < 0; });
    clearSelection();
    renderTargets();
    changed();
  }

  function uniq(list) { return list.filter(function (x, i) { return list.indexOf(x) === i; }); }

  /** What can be done to the selection; anything that doesn't apply is shown dimmed. */
  function openSelectionMenu(x, y) {
    var nodes = selectedNodes();
    var removable = nodes.filter(canRemove);
    var toOutput = uniq(nodes.filter(function (n) { return n.kind === 'recipe' && !targetFor(n.item); })
      .map(function (n) { return n.item; }));
    var outputs = uniq(nodes.filter(function (n) { return targetFor(n.item); })
      .map(function (n) { return n.item; }));
    openCtx(x, y, [
      { head: nodes.length + ' selected' },
      {
        label: removable.length === 1 ? 'Remove this node' : 'Remove these nodes',
        note: removable.length ? removable.length + ' · steps are brought in instead' : 'Nothing here can be removed',
        disabled: !removable.length,
        run: function () { removeNodes(removable); }
      },
      {
        label: toOutput.length === 1 ? 'Make this an output' : 'Make these outputs',
        note: toOutput.length ? toOutput.map(itemName).join(', ') : 'Only steps that aren\u2019t outputs yet',
        disabled: !toOutput.length,
        run: function () { makeOutputs(toOutput); }
      },
      {
        label: outputs.length === 1 ? 'Remove output' : 'Remove outputs',
        note: outputs.length ? outputs.map(itemName).join(', ') : 'No outputs selected',
        disabled: !outputs.length,
        run: function () { removeOutputs(outputs); }
      }
    ]);
  }

  // Delete removes the selection; Escape lets it go; Ctrl+A takes every node.
  document.addEventListener('keydown', function (e) {
    var el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
    if (state.mode !== 'items') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNodes().length) {
      e.preventDefault();
      removeNodes(selectedNodes());
    } else if (e.key === 'Escape' && selectedNodes().length) {
      clearSelection();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      graph.nodes.forEach(function (n) { if (n.el) selected[n.key] = true; });
      applySelection();
    }
  });

  function unpin(key) {
    delete pins()[key];
    changed();
  }

  function tidyLayout() {
    state.pins = {};
    changed();
    fitView();
  }

  /** Centre the canvas on a node and pulse it, so a panel row points somewhere. */
  function focusOn(key) {
    // A step split into several machine lines is found by its first.
    var n = graph.byKey[key] || graph.byKey[key + '#0'];
    if (!n) return;
    var v = state.view;
    v.x = usableWidth() / 2 - (n.x + n.w / 2) * v.s;
    v.y = stage.clientHeight / 2 - (n.y + n.h / 2) * v.s;
    applyView();
    writeNow();
    if (!n.el) return;
    n.el.classList.add('flash');
    setTimeout(function () { n.el.classList.remove('flash'); }, 850);
  }

  /* -------------------------------------------------------- canvas panning */

  /**
   * Whether a press counts as on the canvas itself. In the machine view the
   * whole picture does, since nothing on it moves: dragging anywhere pans.
   */
  function onCanvas(target) {
    if (target === stage || target === world || emptyHint.contains(target)) return true;
    return state.mode === 'machines' && world.contains(target);
  }

  // Right-click on bare canvas.
  stage.addEventListener('contextmenu', function (e) {
    if (!onCanvas(e.target)) return;
    e.preventDefault();
    closeAll();

    var items = [
      { label: '+ Add output…', run: function () { askForOutput(null, e.clientX, e.clientY); } },
      { label: 'Fit to view', run: fitView }
    ];
    if (Object.keys(pins()).length) {
      items.push({ label: 'Tidy layout', note: 'Unpins every node you’ve moved', run: tidyLayout });
    }
    items.push('-');
    items.push({ label: 'Clear plan', danger: true, confirm: true, run: clearPlan });
    openCtx(e.clientX, e.clientY, items);
  });

  var marquee = document.getElementById('marquee');

  /**
   * Draws the selection rectangle; on release, the nodes it touches become
   * the selection (Items view).
   */
  function startMarquee(e) {
    var box = stage.getBoundingClientRect();
    var x0 = e.clientX - box.left;
    var y0 = e.clientY - box.top;
    var x1 = x0;
    var y1 = y0;

    marquee.classList.add('on');
    marquee.style.left = x0 + 'px';
    marquee.style.top = y0 + 'px';
    marquee.style.width = '0px';
    marquee.style.height = '0px';

    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }

    function onMove(ev) {
      x1 = ev.clientX - box.left;
      y1 = ev.clientY - box.top;
      marquee.style.left = Math.min(x0, x1) + 'px';
      marquee.style.top = Math.min(y0, y1) + 'px';
      marquee.style.width = Math.abs(x1 - x0) + 'px';
      marquee.style.height = Math.abs(y1 - y0) + 'px';
    }

    function onUp(ev) {
      try { stage.releasePointerCapture(ev.pointerId); } catch (err) { /* never captured */ }
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerup', onUp);
      stage.removeEventListener('pointercancel', onUp);
      marquee.classList.remove('on');
      if (state.mode !== 'items' || Math.abs(x1 - x0) + Math.abs(y1 - y0) < 4) return;
      // The box in world coordinates.
      var v = state.view;
      var wx0 = (Math.min(x0, x1) - v.x) / v.s;
      var wx1 = (Math.max(x0, x1) - v.x) / v.s;
      var wy0 = (Math.min(y0, y1) - v.y) / v.s;
      var wy1 = (Math.max(y0, y1) - v.y) / v.s;
      selected = {};
      graph.nodes.forEach(function (n) {
        if (n.el && n.x < wx1 && n.x + n.w > wx0 && n.y < wy1 && n.y + n.h > wy0) selected[n.key] = true;
      });
      applySelection();
    }

    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
  }

  stage.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 && e.button !== 1) return;
    // The empty-state block is click-through except for its own controls, and
    // those stop the event before it gets here.
    if (!onCanvas(e.target)) return;

    // Touching the background drops focus out of whatever field was being
    // typed in; preventDefault below would otherwise keep the caret there.
    var active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
      active.blur();
    }
    closeAll();

    e.preventDefault();

    // Ctrl or Shift turns the drag into a selection marquee instead of a pan.
    if (e.button === 0 && (e.ctrlKey || e.shiftKey)) {
      startMarquee(e);
      return;
    }

    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }
    stage.classList.add('panning');

    // Panning is applied incrementally from the previous pointer position, so
    // a wheel-zoom mid-drag doesn't make the view lurch.
    var lastX = e.clientX;
    var lastY = e.clientY;
    var panStartX = e.clientX;
    var panStartY = e.clientY;

    function onMove(ev) {
      state.view.x += ev.clientX - lastX;
      state.view.y += ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      applyView();
    }
    function onUp(ev) {
      try { stage.releasePointerCapture(ev.pointerId); } catch (err) { /* never captured */ }
      stage.classList.remove('panning');
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerup', onUp);
      stage.removeEventListener('pointercancel', onUp);
      if (Math.abs(ev.clientX - panStartX) + Math.abs(ev.clientY - panStartY) < 4) clearSelection();
      writeNow();
    }

    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
  });

  // The wheel zooms outright. Panning is dragging the background.
  stage.addEventListener(
    'wheel',
    function (e) {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    },
    { passive: false }
  );

  /* -------------------------------------------------------------- toolbar */

  document.getElementById('zoom-in').addEventListener('click', function () {
    var r = stage.getBoundingClientRect();
    zoomAt(r.left + usableWidth() / 2, r.top + stage.clientHeight / 2, 1.15);
  });
  document.getElementById('zoom-out').addEventListener('click', function () {
    var r = stage.getBoundingClientRect();
    zoomAt(r.left + usableWidth() / 2, r.top + stage.clientHeight / 2, 1 / 1.15);
  });
  document.getElementById('zoom-fit').addEventListener('click', fitView);

  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);

  // Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z). Skipped while a field has focus so the
  // browser's own text undo keeps working inside inputs.
  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key.toLowerCase() === 's') {
      e.preventDefault();  // not the browser's "save page"
      writeNow();
      return;
    }
    var el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;

    var key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
      e.preventDefault();
      redo();
    }
  });

  /* ---------------------------------------------------------- confirmation */

  var confirmEl = document.getElementById('confirm');
  var confirmAction = null;

  /**
   * Position a popup against `anchor`. With `overlap` it is raised by a third
   * of its height so its top sits over the anchor — used from the context
   * menu, where it should read as belonging to the row it came from.
   */
  function placePopup(el, anchor, overlap, alignLeft) {
    // visibility:hidden still lays out, so it measures before being shown.
    el.style.left = '0px';
    el.style.top = '0px';
    var w = el.offsetWidth;
    var h = el.offsetHeight;

    var r = anchor.getBoundingClientRect();
    var left = alignLeft ? r.left : r.right - w;
    left = Math.min(left, window.innerWidth - w - 8);
    var top = overlap ? r.bottom - Math.round(h / 3) : r.bottom + 5;
    if (top + h > window.innerHeight - 8) top = r.top - h - 5; // flip above

    el.style.left = Math.max(8, left) + 'px';
    el.style.top = Math.max(8, top) + 'px';
  }

  function closeConfirm() {
    confirmEl.classList.remove('show');
    confirmAction = null;
    undimCtx();
  }

  /** Drop the shared "Are you sure?" against `anchor`, running `onYes` if taken. */
  function askConfirm(anchor, onYes, overlap) {
    popOpener = clickFrom;
    confirmAction = onYes;
    placePopup(confirmEl, anchor, overlap);
    confirmEl.classList.add('show');
  }

  confirmEl.querySelector('.confirm-yes').addEventListener('click', function () {
    var run = confirmAction;
    closeConfirm();
    closeCtx();
    if (run) run();
  });
  confirmEl.querySelector('.confirm-no').addEventListener('click', closeConfirm);

  /* --------------------------------------------------------- context menu */

  var ctx = document.getElementById('ctx');

  function closeCtx() {
    ctx.classList.remove('show');
    ctx.classList.remove('dimmed');
    ctx.classList.remove('picker');
  }
  function dimCtx() { ctx.classList.add('dimmed'); }
  function undimCtx() { ctx.classList.remove('dimmed'); }

  /**
   * items: array of the string '-' for a separator, { head } for a small
   * section heading, or { label, run, note, tag, on, danger, confirm }.
   * Placed at the point given, nudged back inside the window if it overflows.
   */
  function openCtx(clientX, clientY, items, asPicker) {
    popOpener = clickFrom;
    ctx.innerHTML = '';
    ctx.classList.toggle('picker', !!asPicker);
    items.forEach(function (item) {
      if (item === '-') {
        var sep = document.createElement('div');
        sep.className = 'sep';
        ctx.appendChild(sep);
        return;
      }
      if (item.head) {
        var head = document.createElement('div');
        head.className = 'ctx-head';
        head.textContent = item.head;
        ctx.appendChild(head);
        return;
      }
      var b = document.createElement('button');
      b.type = 'button';
      if (item.note) {
        b.classList.add('two-line');
        var main = document.createElement('span');
        main.className = 'ctx-main';
        main.textContent = item.label;
        if (item.tag) {
          var tag = document.createElement('span');
          tag.className = 'ctx-tag';
          tag.textContent = item.tag;
          main.appendChild(tag);
        }
        var note = document.createElement('span');
        note.className = 'ctx-note';
        note.textContent = item.note;
        b.appendChild(main);
        b.appendChild(note);
      } else {
        b.textContent = item.label;
      }
      if (item.danger) b.classList.add('danger');
      if (item.on) b.classList.add('on');
      if (item.disabled) b.disabled = true;
      b.addEventListener('click', function () {
        // The menu stays open behind the confirmation, dimmed, with the popup
        // straddling the row so the two read as one control.
        if (item.confirm) {
          askConfirm(b, item.run, true);
          dimCtx();
          return;
        }
        closeCtx();
        item.run();
      });
      ctx.appendChild(b);
    });

    // visibility:hidden still lays out, so it can be measured before showing.
    ctx.style.left = '0px';
    ctx.style.top = '0px';
    var w = ctx.offsetWidth;
    var h = ctx.offsetHeight;
    ctx.style.left = Math.max(8, Math.min(clientX, window.innerWidth - w - 8)) + 'px';
    ctx.style.top = Math.max(8, Math.min(clientY, window.innerHeight - h - 8)) + 'px';
    ctx.classList.add('show');
  }

  function closeAll() {
    closeCtx();
    closeConfirm();
    closeItemPicker();
  }

  // Any press outside the popups dismisses them. Right-clicks land here first
  // and the contextmenu event that follows reopens the menu in the new place.
  // A press on the button that opened the popup closes it too, and the click
  // that follows is swallowed so it doesn't open it straight back up.
  document.addEventListener('pointerdown', function (e) {
    if (confirmEl.contains(e.target) || itemPop.contains(e.target)) return;
    var open = ctx.classList.contains('show') || confirmEl.classList.contains('show') ||
      itemPop.classList.contains('show');
    swallow = open && popOpener && popOpener.contains(e.target) ? popOpener : null;
    if (!ctx.contains(e.target)) closeCtx();
    closeConfirm();
    closeItemPicker();
  }, true);

  var popOpener = null;  // the button that opened the popup showing
  var clickFrom = null;  // the button being clicked right now
  var swallow = null;
  document.addEventListener('click', function (e) {
    if (swallow && swallow.contains(e.target)) {
      e.stopPropagation();
      e.preventDefault();
      swallow = null;
      return;
    }
    swallow = null;
    clickFrom = e.target.closest ? e.target.closest('button') : null;
    setTimeout(function () { clickFrom = null; }, 0);
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAll();
  });
  window.addEventListener('blur', closeAll);

  /* --------------------------------------------------------- recipe menu */

  /** "30 Iron Ore → 30 Iron Ingot", per machine at 100%. */
  function recipeSummary(rid) {
    var r = DATA.recipes[rid];
    var k = 60 / r.time;
    function side(list) {
      return list.map(function (p) {
        return fmtNum(p[1] * k) + (isFluid(p[0]) ? ' m³ ' : ' ') + itemName(p[0]);
      }).join(' + ');
    }
    return machineName(rid) + ' · ' + side(r.in) + ' → ' + side(r.out);
  }

  /**
   * Every way to get this item: its recipes (standard first, then alternates,
   * then ones that only make it on the side), or bringing it in from outside.
   * From a right-click, node housekeeping is added underneath.
   */
  function openRecipeMenu(n, x, y, withExtras) {
    var id = n.item;
    var it = DATA.items[id];
    var items = [];
    var current = currentRecipe(id);

    if (!it.raw && producersOf[id]) {
      var def = DATA.defaults[id];
      var list = producersOf[id].slice().sort(function (a, b) {
        function rank(rid) {
          var r = DATA.recipes[rid];
          if (rid === def) return 0;
          if (r.out[0][0] !== id) return 3;
          return r.alt ? 2 : 1;
        }
        return rank(a) - rank(b) || DATA.recipes[a].name.localeCompare(DATA.recipes[b].name);
      });

      var optimising = state.picker === 'optimise';
      items.push({ head: 'Recipe for ' + itemName(id) });
      if (optimising) {
        // In optimise mode a pick is a pin: the optimiser has to use it.
        items.push({
          label: 'Let the optimiser choose',
          note: 'Picking a recipe below pins it',
          on: !current && !state.imports[id],
          run: function () {
            delete state.recipes[id];
            delete state.imports[id];
            changed();
          }
        });
      } else if (current && typeof current !== 'string') {
        items.push({
          label: 'Mixed',
          note: Object.keys(current).map(function (rid) {
            return Math.round(current[rid] * 100) + '% ' + DATA.recipes[rid].name;
          }).join(', '),
          on: true,
          run: function () {}
        });
      }
      list.forEach(function (rid) {
        var r = DATA.recipes[rid];
        var locked = optimising && unlockable(rid) && !recipeAllowed(rid);
        items.push({
          label: r.name,
          tag: r.alt ? 'ALT' : (r.out[0][0] !== id ? 'SIDE' : null),
          note: recipeSummary(rid) + (locked ? ' · not unlocked' : '') +
            (canBuild(rid) ? '' : ' · no ' + machineName(rid)),
          on: typeof current === 'string' ? current === rid : false,
          run: function () {
            if (rid === def && !optimising) delete state.recipes[id];
            else state.recipes[id] = rid;
            delete state.imports[id];
            changed();
          }
        });
      });
      items.push('-');
      items.push({
        label: 'Import from elsewhere',
        note: 'Bring it in rather than make it here',
        on: !!state.imports[id],
        run: function () {
          state.imports[id] = true;
          changed();
        }
      });
    }

    if (withExtras) {
      var extras = [];
      if (!it.raw && !targetFor(id)) {
        extras.push({
          label: 'Also make this an output',
          run: function () { addTarget(id); }
        });
      }
      items = withUnpin(items.concat(extras.length && items.length ? ['-'] : [], extras), n);
    }

    if (!items.length) return;
    openCtx(x, y, items, true);
  }

  /** Adds node housekeeping to the end of a menu. */
  function withUnpin(items, n) {
    if (!pins()[n.key]) return items;
    return items.concat(items.length ? ['-'] : [], [
      { label: 'Unpin', note: 'Let the layout place it again', run: function () { unpin(n.key); } }
    ]);
  }

  /** Switches an output between a set rate and "as much as possible". */
  function toggleMax(t) {
    if (t.max) {
      // Coming back from max, start from the rate it had reached.
      if (solved.maxRate > EPS) t.rate = Number(solved.maxRate.toFixed(3));
      delete t.max;
    } else {
      t.max = true;
    }
    renderTargets();
    changed();
  }

  function removeTarget(t) {
    state.targets = state.targets.filter(function (o) { return o !== t; });
    renderTargets();
    changed();
  }

  function openOutputMenu(n, x, y, withExtras) {
    var t = targetFor(n.item);
    if (!t) return;
    var items = [
      { head: 'Output · ' + itemName(n.item) },
      t.max
        ? { label: 'Set a rate instead', note: 'Make a fixed amount per minute', run: function () { toggleMax(t); } }
        : { label: 'Make as much as possible', note: 'Limited by the resource nodes you set', run: function () { toggleMax(t); } },
      '-',
      { label: 'Remove output', run: function () { removeTarget(t); } }
    ];
    openCtx(x, y, withExtras ? withUnpin(items, n) : items, false);
  }

  /**
   * Where a raw resource comes from: any node the plan needs, or specific
   * resource nodes by purity, which cap how much of it there is. Solids also
   * pick their miner.
   */
  function openSupplyMenu(n, x, y, withExtras) {
    var id = n.item;
    var info = supplyInfo(id);
    var items = [];
    if (info && info.purity) {
      var s = state.supply[id] || {};
      var nodes = storedNodes(id);
      var slot = Math.min(n.slot || 0, Math.max(0, nodes.length - 1));
      var here = nodes[slot];
      var nd = info.nodeList[slot];
      var set = function (list, miner) {
        state.supply[id] = { nodes: list, miner: miner || s.miner };
        changed();
      };
      // This node, changed; the others left alone.
      // Every node keeps the miner it has now, so picking one here doesn't
      // move the others (which may be following the last miner picked).
      var withHere = function (change) {
        var list = nodes.map(function (o, j) {
          var copy = Object.assign({}, o);
          if (!isFluid(id) && info.nodeList[j]) copy.miner = info.nodeList[j].extractor;
          return copy;
        });
        if (!list.length) list = [{ purity: 'normal' }];
        Object.assign(list[slot], change);
        return list;
      };
      var minerHere = nd ? nd.extractor : info.extractor;
      var rateFor = function (mid, p) {
        return rateText(id, DATA.extractors[mid].rate * SOLVER.PURITY[p]) + ' per node';
      };

      items.push({ head: nodes.length > 1
        ? 'Node ' + (slot + 1) + ' of ' + nodes.length + ' · ' + rateText(id, info.capacity) + ' in all'
        : 'Resource node · ' + DATA.extractors[minerHere].name });
      items.push({
        label: 'Any node',
        note: nodes.length > 1 ? 'As much as the plan needs, in place of all ' + nodes.length + ' nodes' : 'As much as the plan needs',
        on: !nodes.length,
        run: function () { set([]); }
      });
      SOLVER.PURITIES.forEach(function (p) {
        items.push({
          label: titleCase(p),
          note: rateFor(minerHere, p),
          on: !!here && here.purity === p,
          run: function () { set(withHere({ purity: p })); }
        });
      });

      if (!isFluid(id)) {
        items.push('-');
        items.push({ head: nodes.length > 1 ? 'Miner on this node' : 'Miner' });
        MINERS.forEach(function (mid) {
          var ex = DATA.extractors[mid];
          if (!ex) return;
          items.push({
            label: ex.name,
            note: rateText(id, ex.rate) + ' on a normal node' + (hasBuilding(mid) ? '' : ' · not available'),
            on: minerHere === mid,
            run: function () {
              // New resources start on whichever miner was picked last.
              state.defaultMiner = mid;
              if (nodes.length) set(withHere({ miner: mid }));
              else set([], mid);
            }
          });
        });
      }

      if (nodes.length > 1) {
        items.push('-');
        items.push({
          label: 'Remove this node',
          run: function () { set(nodes.filter(function (_, j) { return j !== slot; })); }
        });
      }
    }
    if (withExtras) items = withUnpin(items, n);
    if (!items.length) return;
    openCtx(x, y, items, true);
  }

  /* --------------------------------------------------------- item search */

  var itemPop = document.getElementById('item-pop');
  var ipInput = itemPop.querySelector('.ip-input');
  var ipList = itemPop.querySelector('.ip-list');
  var ipPick = null;
  var ipMatches = [];
  var ipSel = 0;

  function closeItemPicker() {
    itemPop.classList.remove('show');
    ipPick = null;
  }

  /**
   * Opens the searchable item list against `anchor` (or at x, y), calling
   * `onPick(itemId)` with the choice.
   */
  function openItemPicker(anchor, onPick, x, y) {
    popOpener = clickFrom;
    closeCtx();
    closeConfirm();
    ipPick = onPick;
    ipInput.value = '';
    renderItemList();
    if (anchor) {
      placePopup(itemPop, anchor, false, true);
    } else {
      itemPop.style.left = Math.max(8, Math.min(x, window.innerWidth - 296)) + 'px';
      itemPop.style.top = Math.max(8, Math.min(y, window.innerHeight - 380)) + 'px';
    }
    itemPop.classList.add('show');
    setTimeout(function () { ipInput.focus(); }, 20);
  }

  function renderItemList() {
    var q = ipInput.value.trim().toLowerCase();
    // Names that start with the query first, then ones that merely contain it.
    ipMatches = !q ? PICKABLE : PICKABLE
      .filter(function (id) { return itemName(id).toLowerCase().indexOf(q) >= 0; })
      .sort(function (a, b) {
        var sa = itemName(a).toLowerCase().indexOf(q) === 0 ? 0 : 1;
        var sb = itemName(b).toLowerCase().indexOf(q) === 0 ? 0 : 1;
        return sa - sb;
      });
    ipSel = 0;
    ipList.innerHTML = '';
    if (!ipMatches.length) {
      var none = document.createElement('div');
      none.className = 'ip-empty';
      none.textContent = 'No item by that name';
      ipList.appendChild(none);
      return;
    }
    ipMatches.forEach(function (id, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = itemName(id);
      if (i === ipSel) b.classList.add('sel');
      b.addEventListener('click', function () { choose(id); });
      b.addEventListener('pointermove', function () { select(i, false); });
      ipList.appendChild(b);
    });
  }

  function select(i, scroll) {
    var rows = ipList.querySelectorAll('button');
    if (!rows.length) return;
    ipSel = clamp(i, 0, rows.length - 1);
    rows.forEach(function (r, j) { r.classList.toggle('sel', j === ipSel); });
    if (scroll) rows[ipSel].scrollIntoView({ block: 'nearest' });
  }

  function choose(id) {
    var run = ipPick;
    closeItemPicker();
    if (run) run(id);
  }

  ipInput.addEventListener('input', renderItemList);
  ipInput.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); select(ipSel + 1, true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(ipSel - 1, true); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (ipMatches[ipSel]) choose(ipMatches[ipSel]);
    } else if (e.key === 'Escape') { e.preventDefault(); closeItemPicker(); }
  });

  /* ------------------------------------------------------------- targets */

  function askForOutput(anchor, x, y) {
    openItemPicker(anchor, addTarget, x, y);
  }

  /** Adds an output (or finds the existing one) and shows it in the panel. */
  function addTarget(id) {
    var wasEmpty = !state.targets.length;
    var index = -1;
    state.targets.forEach(function (t, i) { if (t.item === id) index = i; });
    if (index < 0) {
      // New outputs make as much as the resource nodes allow; the rate is
      // what switching to a fixed rate starts from.
      state.targets.push({ item: id, rate: NEW_TARGET_RATE, max: true });
      index = state.targets.length - 1;
      renderTargets();
      changed();
      if (wasEmpty) fitView();
    }
    // A max output's figure isn't typed, so only a fixed rate gets the caret.
    var input = targetsEl.querySelectorAll('.t-rate')[index];
    if (input && !input.disabled) {
      input.focus();
      input.select();
    }
  }

  var targetsEl = document.getElementById('targets');

  /** Max outputs show what the solver reached, updated after every solve. */
  function refreshMaxRates() {
    targetsEl.querySelectorAll('.t-rate').forEach(function (input) {
      if (!input.dataset.max) return;
      input.value = solved.maxRate != null ? fmtNum(solved.maxRate) : '—';
    });
  }

  /**
   * The output rows. Rebuilt only when the list itself changes — typing a
   * rate re-solves the plan but leaves these fields alone, so the caret stays.
   */
  function renderTargets() {
    targetsEl.innerHTML = '';
    state.targets.forEach(function (t) {
      var row = document.createElement('div');
      row.className = 'target-row';

      var pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 't-item';
      pick.title = 'Change item';
      var name = document.createElement('span');
      name.textContent = itemName(t.item);
      pick.appendChild(name);
      pick.addEventListener('click', function () {
        openItemPicker(pick, function (id) {
          if (id === t.item) return;
          // Picking an item that's already an output merges the two rows.
          var existing = state.targets.filter(function (o) { return o.item === id; })[0];
          if (existing) {
            existing.rate = (Number(existing.rate) || 0) + (Number(t.rate) || 0);
            state.targets = state.targets.filter(function (o) { return o !== t; });
          } else {
            t.item = id;
          }
          renderTargets();
          changed();
        });
      });

      // In max mode the field shows the rate the solver reached, read-only.
      var rate = document.createElement('input');
      rate.type = 'text';
      rate.inputMode = 'decimal';
      rate.className = 't-rate';
      rate.value = String(t.rate);
      rate.disabled = !!t.max;
      rate.dataset.max = t.max ? '1' : '';
      rate.setAttribute('aria-label', itemName(t.item) + ' per minute');
      rate.addEventListener('input', function () {
        var v = parseFloat(rate.value);
        // 0 is allowed: the output stays listed but asks for nothing, so
        // everything made of it goes on to whatever uses it.
        var ok = isFinite(v) && v >= 0;
        rate.classList.toggle('bad', !ok && rate.value.trim() !== '');
        if (!ok) return;
        t.rate = v;
        changed();
      });
      rate.addEventListener('blur', function () {
        rate.classList.remove('bad');
        if (!t.max) rate.value = String(t.rate);
      });
      rate.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); rate.blur(); }
      });

      var unit = document.createElement('button');
      unit.type = 'button';
      unit.className = 't-unit' + (t.max ? ' on' : '');
      unit.textContent = t.max ? 'max' : (isFluid(t.item) ? 'm³/min' : '/min');
      unit.title = t.max
        ? 'Making as much as the resource nodes allow. Click to set a rate.'
        : 'Click to make as much as possible instead';
      unit.addEventListener('click', function () { toggleMax(t); });

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 't-del';
      del.title = 'Remove output';
      del.innerHTML = '&times;';
      del.addEventListener('click', function () { removeTarget(t); });

      row.appendChild(pick);
      row.appendChild(rate);
      row.appendChild(unit);
      row.appendChild(del);
      targetsEl.appendChild(row);
    });
  }

  document.getElementById('add-target').addEventListener('click', function () {
    askForOutput(this);
  });

  /* ---------------------------------------------------------------- panel */

  var breakdownEl = document.getElementById('breakdown');
  var inputsBox = document.getElementById('inputs-box');
  var machinesBox = document.getElementById('machines-box');

  function toggleBuilding(mid) {
    var i = state.unavailable.indexOf(mid);
    if (i >= 0) state.unavailable.splice(i, 1);
    else state.unavailable.push(mid);
    changed();
  }


  /**
   * A panel section. With a fold key its heading is a button that collapses
   * the rows under it, remembered between visits.
   */
  function group(title, sub, rows, fold) {
    var wrap = document.createElement('div');
    wrap.className = 'sum-group';
    var head = document.createElement(fold ? 'button' : 'div');
    head.className = 'sum-group-head';
    if (fold) {
      head.type = 'button';
      head.classList.add('fold-head');
      wrap.dataset.fold = fold;
      wrap.classList.toggle('folded', isFolded(fold));
    }
    var name = document.createElement('span');
    name.className = 'sum-group-name';
    name.textContent = title;
    var count = document.createElement('span');
    count.className = 'sum-group-count';
    count.textContent = sub || '';
    head.appendChild(name);
    head.appendChild(count);
    wrap.appendChild(head);
    var body = wrap;
    if (fold) {
      body = document.createElement('div');
      body.className = 'fold-body';
      wrap.appendChild(body);
    }
    rows.forEach(function (r) { body.appendChild(r); });
    return wrap;
  }

  // Any section heading that folds, whether built here or in the page.
  document.getElementById('panel-list').addEventListener('click', function (e) {
    var head = e.target.closest('.fold-head');
    if (!head) return;
    var wrap = head.closest('[data-fold]');
    var key = wrap.dataset.fold;
    state.folds[key] = !isFolded(key);
    if (state.folds[key] === !!FOLDED_AT_FIRST[key]) delete state.folds[key];
    wrap.classList.toggle('folded', isFolded(key));
    writeNow();
  });

  // Sections that start folded: the long alternates list.
  var FOLDED_AT_FIRST = { alternates: true };

  function isFolded(key) {
    return key in state.folds ? state.folds[key] : !!FOLDED_AT_FIRST[key];
  }

  function applyFolds() {
    document.querySelectorAll('#panel-list [data-fold]').forEach(function (wrap) {
      wrap.classList.toggle('folded', isFolded(wrap.dataset.fold));
    });
  }

  function row(label, note, value, onClick, warn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'sum-row';
    var l = document.createElement('span');
    l.className = 'sum-row-name';
    l.textContent = label;
    b.appendChild(l);
    if (note) {
      var n = document.createElement('span');
      n.className = 'sum-row-note';
      n.textContent = note;
      b.appendChild(n);
    }
    var v = document.createElement('span');
    v.className = 'sum-row-price' + (warn ? ' warn' : '');
    v.textContent = value;
    b.appendChild(v);
    if (onClick) b.addEventListener('click', onClick);
    else b.style.cursor = 'default';
    return b;
  }

  /** Totals, raw inputs, machine counts and spare output. */
  function renderBreakdown() {
    breakdownEl.innerHTML = '';
    inputsBox.innerHTML = '';
    machinesBox.innerHTML = '';

    var power = 0;
    var buildings = 0;
    var shards = 0;
    var byMachine = {};
    var draws = [];   // [{ label, note, power, extraction }]
    function tally(mid, name, exact, built, p) {
      var m = byMachine[mid] || (byMachine[mid] = { name: name, exact: 0, built: 0, power: 0 });
      m.exact += exact;
      m.built += built;
      m.power += p;
      power += p;
      buildings += built;
    }
    Object.keys(solved.recipes).forEach(function (rid) {
      var count = solved.recipes[rid].count;
      var mid = DATA.recipes[rid].machine;
      var list = recipeClocks(rid, count);
      list.forEach(function (c) { shards += shardsFor(c); });
      var p = SOLVER.recipePower(DATA, rid, count, state.clock, clockTop(rid));
      tally(mid, DATA.machines[mid].name, count, list.length, p);
      var r = DATA.recipes[rid];
      draws.push({
        label: itemName(solved.recipes[rid].item) + (r.alt ? ' (' + r.name + ')' : ''),
        note: list.length + ' × ' + DATA.machines[mid].name,
        power: p,
        node: 'r:' + rid
      });
    });
    // Extractors count too, wherever the plan knows what they are.
    Object.keys(solved.items).forEach(function (id) {
      var e = solved.items[id];
      if (!(e.supplied > EPS) || !DATA.items[id].raw) return;
      var ex = extractorsFor(id, e.supplied);
      if (!ex) return;
      var byMark = {};
      ex.list.forEach(function (m) { (byMark[m.extractor] = byMark[m.extractor] || []).push(m.clock); });
      Object.keys(byMark).forEach(function (mid) {
        var clocksList = byMark[mid];
        clocksList.forEach(function (c) { shards += shardsFor(c); });
        var p = SOLVER.extractorPower(DATA, mid, clocksList, state.clock);
        tally(mid, DATA.extractors[mid].name,
          clocksList.reduce(function (s, c) { return s + c; }, 0),
          clocksList.length, p);
        draws.push({
          label: itemName(id),
          note: clocksList.length + ' × ' + DATA.extractors[mid].name,
          power: p,
          extraction: true,
          node: 'raw:' + id
        });
      });
    });

    var steps = Object.keys(solved.recipes).length;
    renderOverview({ power: power, buildings: buildings, shards: shards, byMachine: byMachine, draws: draws });
    renderPower(draws, power);
    document.getElementById('stat-machines').textContent = buildings;
    document.getElementById('stat-power').textContent = fmtPower(power);
    document.getElementById('stat-steps').textContent = steps;

    // Raw inputs: what has to arrive from outside this factory.
    var raws = Object.keys(solved.items)
      .filter(function (id) { return solved.items[id].supplied > EPS; })
      .sort(function (a, b) { return solved.items[b].supplied - solved.items[a].supplied; });
    if (raws.length) {
      inputsBox.appendChild(group('Inputs', 'from outside', raws.map(function (id) {
        var it = DATA.items[id];
        var e = solved.items[id];
        var short = (!it.raw && !state.imports[id] && !!producersOf[id]) || e.short > EPS;
        var note = it.raw
          ? (e.cap != null ? 'of ' + fmtNum(e.cap) : '')
          : state.imports[id] ? 'imported'
          : blocked[id] ? 'no ' + buildingName(blocked[id])
          : short ? 'shortfall' : 'supplied';
        return row(itemName(id), note, rateText(id, e.supplied),
          function () { focusOn('raw:' + id); }, short);
      }), 'inputs'));
    }

    // Every building, ticked if the user has it: what the plan uses shows
    // how many, and unticking one re-plans without it.
    var rows = BUILDINGS.map(function (mid) {
      var m = byMachine[mid];
      var has = hasBuilding(mid);
      var b = row(buildingName(mid), m ? fmtNum(m.exact) + ' · ' + fmtPower(m.power) : '',
        m ? String(m.built) : '', function () { toggleBuilding(mid); });
      b.classList.add('check-row');
      b.classList.toggle('on', has);
      b.classList.toggle('idle', !m);
      b.title = has ? 'Untick if you don’t have it yet' : 'Tick once you have it';
      return b;
    });
    if (shards) {
      var sh = row('Power Shards', 'for overclocking', String(shards));
      sh.classList.add('extra-row');
      rows.push(sh);
    }
    machinesBox.appendChild(group('Machines', 'running · built', rows, 'machines'));

    var spare = Object.keys(solved.items)
      .filter(function (id) { return solved.items[id].surplus > EPS; });
    if (spare.length) {
      breakdownEl.appendChild(group('Spare', 'made but unused', spare.map(function (id) {
        var e = solved.items[id];
        var from = e.producers.filter(function (p) { return p.node.indexOf('r:') === 0; })[0];
        return row(itemName(id), '', rateText(id, e.surplus),
          from ? function () { focusOn(from.node); } : null);
      })));
    }
  }

  /** A section in its own box, for the Overview and Power pages. */
  function boxed(title, sub, rows) {
    var box = document.createElement('div');
    box.className = 'panel-box';
    box.appendChild(group(title, sub, rows));
    return box;
  }

  function quietRow(text) {
    var r = row(text, '', '');
    r.classList.add('quiet');
    return r;
  }

  /** The factory at a glance: resources, production, machines, power, alternates. */
  function renderOverview(t) {
    var el = document.getElementById('overview-list');
    el.innerHTML = '';

    // Resources: what the factory draws from the map, and what it imports.
    var ids = Object.keys(solved.items).filter(function (id) { return solved.items[id].supplied > EPS; })
      .sort(function (a, b) { return solved.items[b].supplied - solved.items[a].supplied; });
    var raw = ids.filter(function (id) { return DATA.items[id].raw; });
    var brought = ids.filter(function (id) { return !DATA.items[id].raw; });
    var rows = raw.map(function (id) {
      var e = solved.items[id];
      return row(itemName(id), e.cap != null ? 'of ' + fmtNum(e.cap) : 'no cap', rateText(id, e.supplied),
        function () { focusOn('raw:' + id); }, e.short > EPS);
    }).concat(brought.map(function (id) {
      return row(itemName(id), state.imports[id] ? 'imported' : blocked[id] ? 'no ' + buildingName(blocked[id]) : 'brought in',
        rateText(id, solved.items[id].supplied), function () { focusOn('raw:' + id); });
    }));
    el.appendChild(boxed('Resources', raw.length + ' from the map' + (brought.length ? ', ' + brought.length + ' brought in' : ''),
      rows.length ? rows : [quietRow('Nothing yet')]));

    // Production: what it's for, and what it makes on the side.
    var outs = Object.keys(solved.targets).filter(function (id) { return solved.targets[id] > EPS; });
    var spare = Object.keys(solved.items).filter(function (id) { return solved.items[id].surplus > EPS; });
    rows = outs.map(function (id) {
      return row(itemName(id), 'output', rateText(id, solved.targets[id]), function () { focusOn('out:' + id); });
    }).concat(spare.map(function (id) {
      var r = row(itemName(id), 'spare', rateText(id, solved.items[id].surplus));
      r.classList.add('quiet');
      return r;
    }));
    el.appendChild(boxed('Production', 'per minute', rows.length ? rows : [quietRow('No outputs yet')]));

    // Machines: how many of each building.
    var mids = Object.keys(t.byMachine).sort(function (a, b) { return t.byMachine[b].built - t.byMachine[a].built; });
    rows = mids.map(function (mid) {
      var m = t.byMachine[mid];
      return row(m.name, fmtNum(m.exact) + ' running', String(m.built));
    });
    if (t.shards) rows.push(row('Power Shards', 'for overclocking', String(t.shards)));
    el.appendChild(boxed('Machines', t.buildings + (t.buildings === 1 ? ' building' : ' buildings'),
      rows.length ? rows : [quietRow('None yet')]));

    // Power: the total, split between making and extracting.
    var made = t.draws.filter(function (d) { return !d.extraction; }).reduce(function (s, d) { return s + d.power; }, 0);
    rows = [
      row('Production buildings', '', fmtPower(made)),
      row('Miners and extractors', '', fmtPower(t.power - made))
    ];
    var total = row('Total', 'average draw', fmtPower(t.power));
    total.classList.add('total-row');
    rows.push(total);
    el.appendChild(boxed('Power', 'itemised under Power', rows));

    // Alternates in use.
    var alts = Object.keys(solved.recipes).filter(unlockable).sort(function (a, b) {
      return DATA.recipes[a].name.localeCompare(DATA.recipes[b].name);
    });
    rows = alts.map(function (rid) {
      return row(DATA.recipes[rid].name, itemName(solved.recipes[rid].item) + ' · ' + machineName(rid),
        '', function () { focusOn('r:' + rid); });
    });
    el.appendChild(boxed('Alternate recipes used', alts.length ? String(alts.length) : '',
      rows.length ? rows : [quietRow('Standard recipes only')]));
  }

  /** Everything that draws power, biggest first, each with its share. */
  function renderPower(draws, total) {
    var el = document.getElementById('power-list');
    el.innerHTML = '';
    var head = row('Total', 'average draw', fmtPower(total));
    head.classList.add('total-row');
    el.appendChild(boxed('Power', draws.length + (draws.length === 1 ? ' step' : ' steps'), [head]));
    if (!draws.length) return;
    var rows = draws.slice().sort(function (a, b) { return b.power - a.power; }).map(function (d) {
      var r = row(d.label, d.note, fmtPower(d.power), function () { focusOn(d.node); });
      var share = total > EPS ? d.power / total : 0;
      r.classList.add('draw-row');
      var bar = document.createElement('span');
      bar.className = 'draw-bar';
      bar.style.width = Math.max(1, share * 100) + '%';
      r.appendChild(bar);
      r.title = d.label + ' · ' + d.note + ' · ' + fmtPower(d.power) + ' (' + Math.round(share * 100) + '% of the total)';
      return r;
    });
    el.appendChild(boxed('Itemised', 'biggest first', rows));
  }

  document.getElementById('data-build').textContent =
    DATA.build ? DATA.build : DATA.generated;

  /* ------------------------------------------------------------- examples */

  function refreshEmptyHint() {
    var empty = state.targets.length === 0;
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
        state.targets = ex.targets.map(function (t) {
          var out = { item: t.item, rate: t.rate || NEW_TARGET_RATE };
          if (t.max) out.max = true;
          return out;
        });
        if (!state.name || /^New factory( \d+)?$/.test(state.name)) {
          state.name = uniqueName(ex.name, currentFactory());
        }
        renderTabs();
        renderTargets();
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

  /** Empties the plan but keeps its name. Callers ask for confirmation. */
  function clearPlan() {
    emptyPlan();
    renderTargets();
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
    selected = {};
    selAnchor = null;
    store.active = saveId;
    var sv = currentSave();
    if (factoryId) sv.active = factoryId;
    var fresh = openCurrent();
    clearTimeout(commitTimer);
    undoStack.length = 0;
    redoStack.length = 0;
    lastSnap = snapshot();
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
    lastSnap = snapshot();
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
      sv.progress = sv.progress || {};
      var activeAt = Math.max(0, sv.factories.findIndex(function (f) { return f.id === sv.active; }));
      sv.factories = sv.factories.filter(function (f) { return f && typeof f === 'object'; }).map(function (f) {
        return { id: uid(), name: typeof f.name === 'string' ? f.name : '', plan: f.plan || {} };
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
    lastSnap = snapshot();
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
    if (!state.targets.length) return;
    askConfirm(clearBtn, clearPlan);
  });

  /* ------------------------------------------------------ view and clocks */

  // Items: one card per step. Machines: every step expanded into its actual
  // buildings. All steps switch together.
  var modeSeg = document.getElementById('mode');

  function refreshModeSeg() {
    modeSeg.querySelectorAll('.seg-btn').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mode === state.mode);
    });
    // How inputs are fed only means something in the machine view, so it's
    // greyed out in the item view; and only the machine view can't be
    // rearranged by hand.
    var machinesOn = state.mode === 'machines';
    balanceSeg.classList.toggle('disabled', !machinesOn);
    balanceSeg.title = machinesOn ? '' : 'Only in the Machines view';
    balanceSeg.querySelectorAll('.seg-btn').forEach(function (b) { b.disabled = !machinesOn; });
    document.getElementById('view-note').hidden = !machinesOn;
    balanceSeg.querySelectorAll('.seg-btn').forEach(function (b) {
      b.classList.toggle('on', b.dataset.balance === state.balance);
    });
  }

  // Manifold: one belt past every machine, a splitter at each. Balancer: a
  // tree of splitters giving every machine exactly the same share.
  var balanceSeg = document.getElementById('balance');
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

  modeSeg.addEventListener('click', function (e) {
    var btn = e.target.closest('.seg-btn');
    if (!btn) return;
    state.mode = btn.dataset.mode === state.mode
      ? (state.mode === 'items' ? 'machines' : 'items')
      : btn.dataset.mode;
    refreshModeSeg();
    closeAll();
    recompute();
    fitView();
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

  function applyShow() {
    stage.classList.toggle('hide-products', !state.show.products);
    stage.classList.toggle('hide-rates', !state.show.rates);
    stage.classList.toggle('short-names', state.show.short);
    stage.classList.toggle('hide-clocks', !state.show.clocks);
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
    optSettings.hidden = !optimising;
    document.getElementById('picker-sub').textContent = optimising ? 'picked for you' : 'picked by you';
    altCount.textContent = state.unlocked.length + ' of ' + UNLOCKABLE.length + ' ticked';
  }

  /** After a solve: what the optimiser ended up using. */
  function refreshOptNote() {
    if (state.picker !== 'optimise' || !solved) {
      optNote.textContent = '';
      return;
    }
    var used = Object.keys(solved.recipes).filter(unlockable);
    var items = {};
    var mixed = 0;
    Object.keys(solved.recipes).forEach(function (rid) {
      var main = DATA.recipes[rid].out[0][0];
      items[main] = (items[main] || 0) + 1;
      if (items[main] === 2) mixed++;
    });
    var bits = [];
    bits.push(used.length ? used.length + ' alternate' + (used.length === 1 ? '' : 's') + ' in use' : 'Standard recipes only');
    if (mixed) bits.push(mixed + ' item' + (mixed === 1 ? '' : 's') + ' made more than one way');
    var pinned = Object.keys(state.recipes).length;
    if (pinned) bits.push(pinned + ' pinned by you');
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
  altFold.querySelectorAll('[data-all]').forEach(function (b) {
    b.addEventListener('click', function () {
      state.unlocked = b.dataset.all === '1' ? UNLOCKABLE.slice() : [];
      renderAltList();
      refreshRecipeControls();
      changed();
    });
  });

  /* ---------------------------------------------------------------- focus */

  // A button keeps focus after it's clicked, and the first key pressed after
  // (even Shift) makes the browser draw its focus ring. Pressing anywhere
  // else lets go of it.
  document.addEventListener('pointerdown', function (e) {
    var a = document.activeElement;
    if (a && a !== document.body && (a.tagName === 'BUTTON' || a.tagName === 'A') && !a.contains(e.target)) a.blur();
  }, true);

  /* -------------------------------------------------------------- support */

  var SUPPORT_URL = 'https://www.paypal.com/donate/?business=D67ZNGBK6W99W&no_recurring=1&item_name=Your+support+is+enough%2C+but+if+you+have+an+abnormally+sized+heart%2C+then+I%27ll+be+more+than+grateful%21&currency_code=USD';
  var supportBtn = document.getElementById('support');
  supportBtn.addEventListener('click', function () {
    var r = supportBtn.getBoundingClientRect();
    openCtx(r.right - 230, r.bottom + 6, [
      { head: 'Support Satisfunction' },
      {
        label: 'Donate with PayPal',
        note: 'Opens PayPal in a new tab',
        run: function () { window.open(SUPPORT_URL, '_blank', 'noopener'); }
      }
    ]);
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
  lastSnap = snapshot();
  refreshHistoryButtons();
})();
