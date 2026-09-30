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
    // The plan the Item and Machine views draw, worked out from the model
    // (see syncPlan); and what Optimize and Build aim for.
    targets: [],   // [{ item, rate, max }] — what the plan is for, per minute
    recipes: {},   // item -> recipe id (or a mix of them)
    imports: {},   // item -> true, when it comes from outside this factory
    supply: {},    // raw item -> { nodes: [{ purity, miner }], miner }
    clock: 'none', // how work is split over machines: 'none', 'even', 'fill' or 'max'
    unavailable: [], // buildings the user doesn't have yet
    belt: 6,       // fastest conveyor tier the build may use, 1–6
    pipe: 2,       // fastest pipeline tier, 1–2
    picker: 'manual',     // who picks recipes: 'manual' or 'optimise'
    goal: 'resources',    // what the optimiser minimises after max outputs
    unlocked: Object.keys(DATA.recipes).filter(unlockable), // alternates (and converter recipes) ticked: all, to start
    altsSet: true,        // the list above has been through its first default (every one ticked)
    pins: {},      // node key -> { x, y }, for nodes moved in the item view
    defaultMiner: 'Build_MinerMk1_C',
    view: { x: 60, y: 40, s: 1 },
    mode: 'items', // the view of the model shown when build is 'auto': 'items' or 'machines'
    folds: {},     // panel sections the user has collapsed: { inputs: true }
    show: { products: true, rates: true, clocks: true, short: false, lines: 'curved' }, // what the canvas labels
    page: 'details', // the plan panel's page: 'details', 'overview' or 'power'
    balance: 'manifold', // machine view inputs: 'manifold' or 'balancer'
    build: 'custom', // 'custom': the Model canvas; 'auto': one of its views (Item or Machine)
    optKey: null,  // planKey() when the model was last optimized or built
    clockOf: {},   // recipe -> the clock its model steps are set to (from syncPlan)
    boostOf: {},   // recipe -> { out, power }: its steps' Somersloop boost (from syncPlan)
    modelled: true, // saved from a version where the model is the main thing
    legacy: false,  // an older Auto plan, still to be laid out as a model
    // the model: cards [{ id, type, x, y, … }], lines [{ id, from, fk, to, tk }],
    // notes [{ id, x, y, text }] and pencil strokes [{ id, pts: [x, y, x, y, …] }]
    custom: { nodes: [], links: [], notes: [], strokes: [] }
  };

  // What a new factory starts from.
  var DEFAULTS = JSON.parse(JSON.stringify(state));

  /** Where cards were moved to by hand. The views are laid out for you and
      can't be rearranged, so none are kept any more. */
  function pins() {
    return {};
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
    return stepClocks(rid, count, state.clockOf[rid]);
  }

  /**
   * A step's machines and their clocks. With a clock of its own (k, 1 =
   * 100%), it gets as few machines as that allows, sharing the work evenly,
   * so none runs faster than k. Otherwise the Speed setting decides.
   */
  function stepClocks(rid, count, k) {
    if (!k) return SOLVER.clocks(count, state.clock, clockTop(rid));
    if (!(count > 1e-9)) return [];
    var m = Math.max(1, Math.ceil(count / k - 1e-6));
    var out = [];
    for (var i = 0; i < m; i++) out.push(count / m);
    return out;
  }

  /**
   * Somersloops in each of a step's machines: how much more it makes (0 to
   * 1, so +100% at most) and how much more power it draws (the game squares
   * it: double the output, four times the power).
   */
  function sloopsOf(n) {
    var r = nodeRecipe(n);
    var m = r && DATA.machines[r.machine];
    var used = m ? clamp(n.sloops || 0, 0, m.sloops || 0) : 0;
    var boost = used * ((m && m.sloopBoost) || 0);
    return { used: used, boost: boost, power: Math.pow(1 + boost, (m && m.sloopPowerExp) || 2) };
  }

  /** Average draw of a step running `count` machines' worth, over `built` machines. */
  function stepPower(rid, count, k, built) {
    if (!k) return SOLVER.recipePower(DATA, rid, count, state.clock, clockTop(rid));
    if (!(count > 1e-9)) return 0;
    var r = DATA.recipes[rid];
    var mach = DATA.machines[r.machine];
    var base = r.power != null ? r.power : mach.power;
    var m = built || Math.max(1, Math.ceil(count / k - 1e-6));
    return m * base * Math.pow(count / m, mach.powerExp);
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
  var PROGRESS = ['unlocked', 'altsSet', 'unavailable', 'belt', 'pipe', 'defaultMiner'];
  var FACTORY = ['targets', 'recipes', 'imports', 'supply', 'clock', 'picker', 'goal',
    'pins', 'view', 'mode', 'balance', 'build', 'custom', 'optKey', 'modelled'];
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
        if (n.set) { q.set = true; q.count = Math.max(0, Number(n.count) || 0); }
        if (Number(n.clock) > 0) q.clock = clamp(Number(n.clock), 0.01, SOLVER.MAX_CLOCK);
        var slots = DATA.machines[DATA.recipes[n.recipe].machine].sloops || 0;
        if (Number(n.sloops) > 0 && slots) q.sloops = clamp(Math.round(Number(n.sloops)), 1, slots);
      } else if (n.type === 'resource') {
        if (!DATA.items[n.item] || !DATA.items[n.item].raw) return;
        q.item = n.item;
        q.purity = SOLVER.PURITIES.indexOf(n.purity) >= 0 ? n.purity : 'normal';
        if (DATA.extractors[n.miner]) q.miner = n.miner;
        q.count = Math.max(1, Math.round(Number(n.count) || 1));
        q.clock = clamp(Number(n.clock) || 1, 0.01, SOLVER.MAX_CLOCK);
      } else if (n.type === 'import') {
        if (!DATA.items[n.item]) return;
        q.item = n.item;
        q.rate = Math.max(0, Number(n.rate) || 0);
        if (typeof n.from === 'string' && n.from) q.from = n.from;  // another factory in the save
      } else if (n.type === 'splitter' || n.type === 'merger') {
        if (n.priority) q.priority = true;  // Smart Splitter (overflow), Priority Merger
      } else if (n.type !== 'sink') {
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

  /* --------------------------------------------------------------- history */

  // Snapshot-based undo. The camera, the panel and which view is showing are
  // deliberately left out — looking around isn't an edit.
  var undoStack = [];
  var redoStack = [];
  var lastSnap = null;
  var commitTimer = null;
  var MAX_HISTORY = 80;

  var UNDOABLE = ['name', 'targets', 'recipes', 'imports', 'supply', 'clock', 'belt', 'pipe',
    'picker', 'goal', 'unlocked', 'unavailable', 'pins', 'custom'];

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
    // Text outlines stay one pixel on screen at any zoom; the pencil's
    // cursor follows how wide its line looks now.
    world.style.setProperty('--zoom', v.s);
    if (typeof tool !== 'undefined' && tool === 'pencil') penCursor();

    // Drag the plus field along with the nodes, and scale it with the zoom,
    // so the canvas reads as one surface rather than a fixed backdrop. In the
    // machine view the pluses mark the corners of 8 m foundations.
    var machines = state.mode === 'machines' && state.build !== 'custom';
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
    var nodes = state.build === 'custom' ? customBoxes() : graph.nodes;
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
    // An Auto plan from before the model: laid out as one, once.
    if (state.legacy) {
      state.legacy = false;
      buildModel();
    }
    if (state.build === 'custom') {
      renderCustomView();
      return;
    }
    // Item and Machine: the model's own steps at the counts they're sized
    // for, balanced item by item (nothing re-solved, so the figures match
    // the model's exactly, loops and all), and drawn the way the plan used
    // to be.
    flow = modelFlow();
    syncPlan(flow);
    buildablePlan(true);
    var counts = {}, owner = {}, outs = {};
    state.custom.nodes.forEach(function (n) {
      var st = flow.nodes[n.id];
      if (!nodeRecipe(n) || !st || !(st.count > 0)) return;
      counts[n.recipe] = (counts[n.recipe] || 0) + st.count;
      owner[n.recipe] = nodeRecipe(n).out[0][0];
    });
    state.targets.forEach(function (t) { outs[t.item] = t.rate; });
    var mult = {};
    Object.keys(state.boostOf).forEach(function (rid) { mult[rid] = state.boostOf[rid].out; });
    solved = SOLVER.assemble(DATA, counts, owner, outs, currentCaps(), mult);

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
      world.querySelectorAll('.machine, .part, .cnode, .cnote').forEach(function (el) { el.remove(); });
      inkEl.innerHTML = '';
      buildGraph();
      mountNodes();
      layout();
      graph.nodes.forEach(place);
      renderWires();
    }
    keepSelection();
    lowestAdders();
    hideHoverInfo();
    renderBreakdown();
    renderCustomPanel();
    refreshOptNote();
    refreshRunButton();
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

    // The views are pictures of the model: nothing on them is edited.
    var readOnly = true;

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
          // A thin + along the bottom of the resource's lowest block adds
          // another node (which block that is is settled after layout).
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
          note('Set its node purity in Model to place its ' +
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

    el.addEventListener('pointerenter', function () {
      focusNode(n.key, true);
      showHoverInfo(n);
    });
    el.addEventListener('pointerleave', function () {
      focusNode(n.key, false);
      if (!dragging) hideHoverInfo();
    });

    // Recipes and nodes are changed in Model.
    if (readOnly) {
      recipeBtn.disabled = true;
      recipeBtn.removeAttribute('title');
      el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      return el;
    }

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

  /* ------------------------------------------------------------ hover info */

  // The hovered node's figures, bottom left of the canvas: what it is, how
  // fast, which machines, what they draw, and what goes in and out.
  var hoverInfo = document.getElementById('hover-info');

  function hideHoverInfo() { hoverInfo.hidden = true; }

  function showHoverInfo(n) {
    if (!solved) return;
    var lines = [];
    function add(text, cls) { lines.push({ text: text, cls: cls || '' }); }
    function flows(net, sign) {
      return Object.keys(net).filter(function (id) { return net[id] * sign > EPS; })
        .map(function (id) { return rateText(id, Math.abs(net[id])) + ' ' + itemName(id); });
    }

    if (n.kind === 'recipe') {
      var r = DATA.recipes[n.rid];
      var per = SOLVER.perMinute(r);
      var net = {};
      Object.keys(per).forEach(function (id) { net[id] = per[id] * n.count; });
      var clocks = recipeClocks(n.rid, n.count);
      add(itemName(n.item), 'hi-title');
      add(rateText(n.item, net[n.item] || 0) + (r.name !== itemName(n.item) ? ' · ' + r.name : ''));
      add(clocks.length + ' × ' + machineName(n.rid) + ' · ' + fmtNum(n.count) + ' running');
      add(fmtPower(stepPower(n.rid, n.count, state.clockOf[n.rid]) * (state.boostOf[n.rid] ? state.boostOf[n.rid].power : 1)) + ' average');
      var ins = flows(net, -1);
      var outs = flows(net, 1);
      if (ins.length) add('In: ' + ins.join(', '));
      if (outs.length) add('Out: ' + outs.join(', '));
    } else if (n.kind === 'output') {
      var t = targetFor(n.item);
      add(itemName(n.item), 'hi-title');
      add(rateText(n.item, n.rate) + ' · ' + (t && t.max ? 'output, as much as possible' : 'output'));
      if (t && t.max && solved.limitedBy) add('Limited by ' + itemName(solved.limitedBy));
    } else if (n.kind === 'raw') {
      var e = solved.items[n.item];
      add(itemName(n.item), 'hi-title');
      add(rateText(n.item, n.rate));
      if (DATA.items[n.item].raw) {
        var info = supplyInfo(n.item);
        var nd = info && info.nodeList && n.slot != null ? info.nodeList[n.slot] : null;
        if (nd) {
          add(nodeLabel(n.item, nd) + ' · gives up to ' + rateText(n.item, nd.rate));
        } else if (info) {
          add(supplyLabel(n.item, info));
        }
        if (e && e.cap != null) add('Resource in use: ' + fmtNum(e.supplied) + ' of ' + rateText(n.item, e.cap));
      } else {
        add(state.imports[n.item] ? 'Imported' : blocked[n.item] ? 'No ' + buildingName(blocked[n.item]) : 'Brought in');
      }
    } else {
      return;
    }

    hoverInfo.innerHTML = '';
    lines.forEach(function (l) {
      var div = document.createElement('div');
      div.className = 'hi-line ' + l.cls;
      div.textContent = l.text;
      hoverInfo.appendChild(div);
    });
    hoverInfo.hidden = false;
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
    world.querySelectorAll('.node, .machine, .part, .cnode, .cnote').forEach(function (el) { el.remove(); });
    inkEl.innerHTML = '';
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
  function line(d, fluid, keys, layer, extra) {
    var more = extra ? ' ' + extra : '';
    if (fluid) {
      relate(keys, svg('path', { d: d, 'class': 'wire pipe' + more }, layer));
      relate(keys, svg('path', { d: d, 'class': 'wire pipe-core' + more }, layer));
    } else {
      relate(keys, svg('path', { d: d, 'class': 'wire' + more }, layer));
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

    var straight = state.show.lines === 'straight';

    graph.edges.forEach(function (e) {
      if (straight) {
        straightWire(e);
        return;
      }
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

    /**
     * Straight: from the middle of the node it leaves (hidden under that
     * node) to the edge of the node it feeds, where a long, narrow arrow
     * points in.
     */
    function straightWire(e) {
      var a = byKey[e.from];
      var b = byKey[e.to];
      var ax = a.x + a.w / 2, ay = a.y + a.h / 2;
      var bx = b.x + b.w / 2, by = b.y + b.h / 2;
      var dx = bx - ax, dy = by - ay;
      var len = Math.hypot(dx, dy);
      if (len < 1) return;
      var ux = dx / len, uy = dy / len;
      // How far along the line each box's edge is.
      function exitAt(n, fromEnd) {
        var tx = ux ? (n.w / 2) / Math.abs(ux) : Infinity;
        var ty = uy ? (n.h / 2) / Math.abs(uy) : Infinity;
        return Math.min(tx, ty) + (fromEnd ? 3 : 0);
      }
      var tipD = len - exitAt(b, true);
      var startD = exitAt(a, false);
      if (tipD <= startD + 4) return;
      var ARROW = 20, HALF = 5;
      var tip = { x: ax + ux * tipD, y: ay + uy * tipD };
      var base = { x: tip.x - ux * ARROW, y: tip.y - uy * ARROW };
      var keys = [e.from, e.to];
      var fluid = isFluid(e.item);
      line('M ' + ax + ' ' + ay + ' L ' + base.x + ' ' + base.y, fluid, keys, null, 'thin');
      var px = -uy * HALF, py = ux * HALF;
      relate(keys, svg('path', {
        d: 'M ' + tip.x + ' ' + tip.y + ' L ' + (base.x + px) + ' ' + (base.y + py) +
          ' L ' + (base.x - px) + ' ' + (base.y - py) + ' Z',
        'class': 'wire-arrow' + (fluid ? ' pipe' : '')
      }));

      // The rate, halfway along the part that shows.
      var mid = (startD + tipD) / 2;
      var label = document.createElement('div');
      label.className = 'flow-label';
      label.style.left = ax + ux * mid + 'px';
      label.style.top = ay + uy * mid + 'px';
      var bold = document.createElement('b');
      bold.textContent = fmtNum(e.rate);
      label.appendChild(bold);
      label.appendChild(document.createTextNode((fluid ? ' m³' : '') + '/min'));
      if (a.item !== e.item) {
        var nm = document.createElement('span');
        nm.className = 'fl-item';
        nm.textContent = itemName(e.item);
        label.appendChild(nm);
      }
      labelsEl.appendChild(label);
      relate(keys, label);
    }

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
        if (moved) {
          lowestAdders();
          save();
        } else {
          pickNode(n, mods);
        }
      }

      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });
  }

  /** Shows each resource's + only under its lowest block. */
  function lowestAdders() {
    if (state.mode !== 'items') return;
    var lowest = {};
    graph.nodes.forEach(function (n) {
      if (!n.el || !n.el.querySelector('.n-add')) return;
      if (!lowest[n.item] || n.y + n.h > lowest[n.item].y + lowest[n.item].h) lowest[n.item] = n;
    });
    graph.nodes.forEach(function (n) {
      var add = n.el && n.el.querySelector('.n-add');
      if (add) add.hidden = lowest[n.item] !== n;
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
    world.querySelectorAll('.cpart').forEach(function (el) {
      el.classList.toggle('selected', !!selected[el.dataset.id]);
    });
    wires.querySelectorAll('[data-link]').forEach(function (el) {
      el.classList.toggle('selected', !!selected[el.dataset.link]);
    });
    if (state.build === 'custom' && flow) renderInspector();
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
   * The nodes in a list that can go. A resource keeps at least one node, so
   * if all of one's nodes are listed, its first stays.
   */
  function removableOf(list) {
    list = list.filter(canRemove);
    var perItem = {};
    list.forEach(function (n) { if (n.kind === 'raw') perItem[n.item] = (perItem[n.item] || 0) + 1; });
    return list.filter(function (n) {
      return n.kind !== 'raw' || perItem[n.item] < storedNodes(n.item).length || n.slot !== 0;
    });
  }

  /**
   * Removes nodes: an output stops being asked for; a step stops being made
   * here and is brought in instead; a resource node comes off its resource.
   */
  function removeNodes(list) {
    list = removableOf(list);
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
    var removable = removableOf(nodes);
    var toOutput = uniq(nodes.filter(function (n) { return n.kind === 'recipe' && !targetFor(n.item); })
      .map(function (n) { return n.item; }));
    var outputs = uniq(nodes.filter(function (n) { return targetFor(n.item); })
      .map(function (n) { return n.item; }));
    // Inputs and outputs on their own can only be removed. Once a step in
    // between is selected too, the other options show, dimmed where they
    // don't apply (an input can't be made an output).
    var inside = nodes.some(function (n) { return n.kind === 'recipe'; });
    var hasInput = nodes.some(function (n) { return n.kind === 'raw'; });
    var items = [
      { head: nodes.length + ' selected' },
      {
        label: removable.length === 1 ? 'Remove node' : 'Remove nodes',
        note: removable.length
          ? (inside ? removable.length + ' · steps are brought in instead' : String(removable.length))
          : 'A resource keeps at least one node',
        disabled: !removable.length,
        run: function () { removeNodes(removable); }
      }
    ];
    if (inside) {
      items.push({
        label: toOutput.length === 1 ? 'Make this an output' : 'Make these outputs',
        note: hasInput ? 'Not with an input selected' : toOutput.length ? toOutput.map(itemName).join(', ') : 'Already outputs',
        disabled: hasInput || !toOutput.length,
        run: function () { makeOutputs(toOutput); }
      });
      items.push({
        label: outputs.length === 1 ? 'Remove output' : 'Remove outputs',
        note: outputs.length ? outputs.map(itemName).join(', ') : 'No outputs selected',
        disabled: !outputs.length,
        run: function () { removeOutputs(outputs); }
      });
    }
    openCtx(x, y, items);
  }

  // Delete removes the selection; Escape lets it go; Ctrl+A takes every node.
  // In Custom, Ctrl+C, X and V copy, cut and paste cards; V, P, E and T pick
  // the select, pencil, eraser and text tools.
  document.addEventListener('keydown', function (e) {
    var el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
    if (state.build === 'custom') {
      var keyTool = { v: 'select', p: 'pencil', e: 'eraser', t: 'note' }[e.key.toLowerCase()];
      if (keyTool && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setTool(keyTool);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && (selectedParts().length || selectedLinks().length)) {
        e.preventDefault();
        removeParts(selectedParts(), selectedLinks());
      } else if (e.key === 'Escape') {
        setTool('select');
        clearSelection();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        state.custom.nodes.forEach(function (n) { selected[n.id] = true; });
        applySelection();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'x') && selectedParts().length) {
        e.preventDefault();
        copyParts(selectedParts());
        if (e.key.toLowerCase() === 'x') removeParts(selectedParts(), []);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && clip) {
        e.preventDefault();
        pasteParts();
      }
      return;
    }
    if (state.mode !== 'items') return;
    if (e.key === 'Escape' && selectedNodes().length) {
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
    if (customHint.contains(target)) return true;
    // In Model, and in both views (which can't be edited), a press anywhere
    // in the world counts: on a view's card it pans.
    return world.contains(target);
  }

  // Right-click on bare canvas.
  stage.addEventListener('contextmenu', function (e) {
    if (!onCanvas(e.target)) return;
    e.preventDefault();
    closeAll();

    if (state.build === 'custom') {
      if (dragMenuSkip()) return;
      var at = { x: e.clientX, y: e.clientY };
      var menuItems = [
        { label: 'Paste', kbd: 'Ctrl+V', disabled: !clip, run: function () { pasteParts(at); } },
        '-',
        { label: '+ Add output…', run: function () { askForOutput(null, e.clientX, e.clientY); } },
        { label: 'Add a note', run: function () { var w = toWorld(at.x, at.y); addNote(w.x, w.y); } },
        { label: 'Fit to view', run: fitView }
      ];
      menuItems.push('-');
      menuItems.push({ label: 'Clear model', note: 'Removes every card', danger: true, confirm: true, run: clearPlan });
      openCtx(e.clientX, e.clientY, menuItems);
      return;
    }
    // The views only look.
    openCtx(e.clientX, e.clientY, [{ label: 'Fit to view', run: fitView }]);
  });

  var marquee = document.getElementById('marquee');

  // After a right-button drag, the context menu that follows is skipped.
  var skipMenuUntil = 0;
  function dragMenuSkip() {
    if (Date.now() < skipMenuUntil) { skipMenuUntil = 0; return true; }
    return false;
  }

  /**
   * Draws the selection rectangle; on release, the nodes it touches become
   * the selection (Items view).
   */
  function startMarquee(e, rightButton) {
    var box = stage.getBoundingClientRect();
    var x0 = e.clientX - box.left;
    var y0 = e.clientY - box.top;
    var x1 = x0;
    var y1 = y0;

    // With the right button, the box only shows once the pointer moves.
    if (!rightButton) marquee.classList.add('on');
    marquee.style.left = x0 + 'px';
    marquee.style.top = y0 + 'px';
    marquee.style.width = '0px';
    marquee.style.height = '0px';

    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }

    function onMove(ev) {
      x1 = ev.clientX - box.left;
      y1 = ev.clientY - box.top;
      if (rightButton && !marquee.classList.contains('on') && Math.abs(x1 - x0) + Math.abs(y1 - y0) >= 4) {
        marquee.classList.add('on');
        closeAll();
      }
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
      if (Math.abs(x1 - x0) + Math.abs(y1 - y0) < 4) return;
      // The menu a right-button release would open isn't wanted after a box.
      if (rightButton) skipMenuUntil = Date.now() + 600;
      if (state.build === 'custom') {
        var cv = state.view;
        var cx0 = (Math.min(x0, x1) - cv.x) / cv.s, cx1 = (Math.max(x0, x1) - cv.x) / cv.s;
        var cy0 = (Math.min(y0, y1) - cv.y) / cv.s, cy1 = (Math.max(y0, y1) - cv.y) / cv.s;
        selected = {};
        customBoxes().forEach(function (b) {
          if (b.x < cx1 && b.x + b.w > cx0 && b.y < cy1 && b.y + b.h > cy0) selected[b.id] = true;
        });
        applySelection();
        return;
      }
      if (state.mode !== 'items') return;
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
    // In Model, holding the right button and dragging draws a selection box;
    // a right-click that doesn't move still opens the menu.
    if (e.button === 2 && state.build === 'custom' && onCanvas(e.target)) {
      startMarquee(e, true);
      return;
    }
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
    // Panning is applied incrementally from the previous pointer position, so
    // a wheel-zoom mid-drag doesn't make the view lurch. The hand shows once
    // it's really moving, not on a plain click.
    var lastX = e.clientX;
    var lastY = e.clientY;
    var panStartX = e.clientX;
    var panStartY = e.clientY;

    function onMove(ev) {
      if (!stage.classList.contains('panning') && Math.abs(ev.clientX - panStartX) + Math.abs(ev.clientY - panStartY) >= 3) {
        stage.classList.add('panning');
      }
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

  /** The confirmation's wording: its question and buttons, or the usual. */
  function confirmWords(w) {
    w = w || {};
    confirmEl.querySelector('.confirm-q').textContent = w.q || 'Are you sure?';
    confirmEl.querySelector('.confirm-yes').textContent = w.yes || 'Yes';
    confirmEl.querySelector('.confirm-no').textContent = w.no || 'No';
    confirmEl.classList.toggle('wordy', !!w.q);
  }

  /**
   * Drop the shared "Are you sure?" just under the pointer, with the pointer
   * centred between Yes and No, running `onYes` if taken. From the keyboard
   * (no pointer), it drops against `anchor`.
   */
  function askConfirm(anchor, onYes, overlap, words) {
    popOpener = clickFrom;
    confirmAction = onYes;
    confirmWords(words);
    if (lastPress && Date.now() - lastPress.t < 1500) {
      var yes = confirmEl.querySelector('.confirm-yes');
      var no = confirmEl.querySelector('.confirm-no');
      var mid = (yes.offsetLeft + yes.offsetWidth + no.offsetLeft) / 2;
      var w = confirmEl.offsetWidth;
      var h = confirmEl.offsetHeight;
      var left = Math.max(8, Math.min(lastPress.x - mid, window.innerWidth - w - 8));
      var top = lastPress.y + 12;
      if (top + h > window.innerHeight - 8) top = lastPress.y - h - 12;
      confirmEl.style.left = left + 'px';
      confirmEl.style.top = top + 'px';
    } else {
      placePopup(confirmEl, anchor, overlap);
    }
    confirmEl.classList.add('show');
  }

  // Where the pointer last pressed, for popups that open under it.
  var lastPress = null;
  document.addEventListener('pointerdown', function (e) {
    lastPress = { x: e.clientX, y: e.clientY, t: Date.now() };
  }, true);
  document.addEventListener('keydown', function () { lastPress = null; }, true);

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
  function openCtx(clientX, clientY, items, asPicker, minWidth) {
    popOpener = clickFrom;
    ctx.innerHTML = '';
    ctx.classList.toggle('picker', !!asPicker);
    ctx.style.minWidth = minWidth ? minWidth + 'px' : '';
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
      if (item.icon) {
        var ic = document.createElement('img');
        ic.className = 'ctx-icon';
        ic.src = item.icon;
        ic.alt = '';
        b.classList.add('with-icon');
        b.insertBefore(ic, b.firstChild);
      }
      if (item.kbd) {
        var kbd = document.createElement('span');
        kbd.className = 'ctx-kbd';
        kbd.textContent = item.kbd;
        b.appendChild(kbd);
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
    openItemPicker(anchor, addModelOutput, x, y);
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


  /* ---------------------------------------------------------- panel icons */

  // Small line icons for the panel's section headings (16 × 16, drawn in the
  // heading's own colour).
  var ICONS = {
    recipe: '<rect x="3.5" y="2.5" width="9" height="11.5" rx="1.5"/><path d="M6 2.5h4v2H6zM6 7.5h4M6 10.5h4"/>',
    target: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2.2"/>',
    shuffle: '<path d="M2.5 5h2.8l5.2 6h3M2.5 11h2.8l5.2-6h3M11.8 3.2l1.7 1.8-1.7 1.8M11.8 9.2l1.7 1.8-1.7 1.8"/>',
    gauge: '<path d="M2.5 11.5a5.5 5.5 0 1 1 11 0"/><path d="M8 11.5l2.8-3.3"/>',
    belt: '<rect x="1.5" y="5" width="13" height="6" rx="3"/><circle cx="4.5" cy="8" r="1"/><circle cx="11.5" cy="8" r="1"/><path d="M7 8h2"/>',
    pipe: '<path d="M8 2.5c2.2 2.8 3.8 4.9 3.8 6.8a3.8 3.8 0 0 1-7.6 0c0-1.9 1.6-4 3.8-6.8z"/>',
    box: '<path d="M2.5 5.2L8 2.8l5.5 2.4v5.6L8 13.2l-5.5-2.4z"/><path d="M2.5 5.2L8 7.6l5.5-2.4M8 7.6v5.6"/>',
    ore: '<path d="M4.5 3h7l2.5 3.5L8 13.5 2 6.5z"/><path d="M2 6.5h12M6.2 3L8 13.5 9.8 3"/>',
    factory: '<path d="M2 13.5V7l4 2.5V7l4 2.5V3.5h4v10z"/>',
    gear: '<circle cx="8" cy="8" r="2"/><circle cx="8" cy="8" r="4.4"/><path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3"/>',
    bolt: '<path d="M9 1.8L3.8 9h3.8l-.8 5.2L12.2 7H8.4z"/>',
    list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.8" cy="4" r=".6"/><circle cx="2.8" cy="8" r=".6"/><circle cx="2.8" cy="12" r=".6"/>'
  };
  // Headings built in code, by title. Inputs, Outputs and Machines on the
  // Details page go without.
  var ICON_FOR = {
    'Spare': 'box', 'Resources': 'ore', 'Production': 'factory', 'Machines': 'gear',
    'Power': 'bolt', 'Alternate recipes used': 'shuffle', 'Itemised': 'list'
  };

  function iconEl(name) {
    var span = document.createElement('span');
    span.className = 'sg-icon';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" ' +
      'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
    return span;
  }

  // The headings written in the page.
  document.querySelectorAll('#panel .sum-group-name[data-icon]').forEach(function (el) {
    el.parentNode.insertBefore(iconEl(el.dataset.icon), el);
  });

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
    var fixed = fold === 'inputs' || fold === 'outputs' || fold === 'machines';
    if (!fixed && ICON_FOR[title]) head.appendChild(iconEl(ICON_FOR[title]));
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
      var p = stepPower(rid, count, state.clockOf[rid], list.length) * (state.boostOf[rid] ? state.boostOf[rid].power : 1);
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
      if (solved.custom) return;
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

    // In Custom, every placed building counts, running as the flow found.
    if (solved.custom) {
      flow.tally.forEach(function (t) {
        shards += t.shards;
        tally(t.mid, t.name, t.exact, t.built, t.power);
        if (t.power > EPS) draws.push({ label: t.label, note: t.note, power: t.power, extraction: !!t.extraction, part: t.id });
      });
      renderCustomPanel();
    }
    var steps = solved.custom ? flow.steps : Object.keys(solved.recipes).length;
    var sloops = flow ? flow.tally.reduce(function (sum, t) { return sum + (t.sloops || 0); }, 0) : 0;
    renderOverview({ power: power, buildings: buildings, shards: shards, sloops: sloops, byMachine: byMachine, draws: draws });
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
        var short = !e.imported && ((!it.raw && !state.imports[id] && !!producersOf[id]) || e.short > EPS);
        var note = e.imported ? 'brought in' : it.raw
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
    if (sloops) {
      var sls = row('Somersloops', 'for more output', String(sloops));
      sls.classList.add('extra-row');
      rows.push(sls);
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
  /**
   * Every building the model needs, from its cards: machines and extractors
   * as built (a Resource Well also needs its Pressurizer), splitters and
   * mergers (Pipeline Junctions on fluids), and Storage Containers (Fluid
   * Buffers). Returns their total and the items they cost.
   */
  function buildCost() {
    var buildings = {};
    function add(id, k) { if (k > 0) buildings[id] = (buildings[id] || 0) + k; }
    if (flow) flow.tally.forEach(function (t) { add(t.mid, t.built); });
    state.custom.nodes.forEach(function (n) {
      if (n.type === 'resource' && extractorOf(n) === 'Build_FrackingExtractor_C') add('Build_FrackingSmasher_C', 1);
      if (n.type !== 'splitter' && n.type !== 'merger' && n.type !== 'sink') return;
      var item = slotItem(n, 'in', 0) || slotItem(n, 'out', 0);
      var fluid = item && isFluid(item);
      if (n.type === 'sink') add(fluid ? 'Build_PipeStorageTank_C' : 'Build_StorageContainerMk1_C', 1);
      else if (fluid) add('Build_PipelineJunction_Cross_C', 1);
      else if (n.type === 'splitter') add(n.priority ? 'Build_ConveyorAttachmentSplitterSmart_C' : 'Build_ConveyorAttachmentSplitter_C', 1);
      else add(n.priority ? 'Build_ConveyorAttachmentMergerPriority_C' : 'Build_ConveyorAttachmentMerger_C', 1);
    });
    var items = {}, count = 0;
    Object.keys(buildings).forEach(function (id) {
      count += buildings[id];
      (DATA.buildCosts[id] || []).forEach(function (q) { items[q[0]] = (items[q[0]] || 0) + q[1] * buildings[id]; });
    });
    return { buildings: buildings, items: items, count: count };
  }

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
    if (t.sloops) rows.push(row('Somersloops', 'for more output', String(t.sloops)));
    el.appendChild(boxed('Machines', t.buildings + (t.buildings === 1 ? ' building' : ' buildings'),
      rows.length ? rows : [quietRow('None yet')]));

    // Build cost: what it takes to place every building, from the game's
    // build recipes. Belts, pipes and foundations aren't counted.
    var cost = buildCost();
    var costIds = Object.keys(cost.items).sort(function (a, b) { return cost.items[b] - cost.items[a]; });
    rows = costIds.map(function (id) {
      var r = row(itemName(id), '', fmtNum(cost.items[id]));
      var ic = document.createElement('img');
      ic.className = 'row-icon';
      ic.src = iconOf(id);
      ic.alt = '';
      r.insertBefore(ic, r.firstChild);
      return r;
    });
    if (costIds.length) {
      var q = quietRow('Not counting belts, pipes or foundations');
      rows.push(q);
    }
    el.appendChild(boxed('Build cost', cost.count ? cost.count + (cost.count === 1 ? ' building' : ' buildings') : '',
      rows.length ? rows : [quietRow('Nothing to build yet')]));

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
    var used = solved.custom ? flow.recipes : solved.recipes;
    var alts = Object.keys(used).filter(unlockable).sort(function (a, b) {
      return DATA.recipes[a].name.localeCompare(DATA.recipes[b].name);
    });
    rows = alts.map(function (rid) {
      return row(DATA.recipes[rid].name, itemName(used[rid].item) + ' · ' + machineName(rid),
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
      var r = row(d.label, d.note, fmtPower(d.power), function () { if (d.part) focusPart(d.part); else focusOn(d.node); });
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
    if (!state.custom.nodes.length) return;
    askConfirm(clearBtn, clearPlan);
  });

  /* ------------------------------------------------------ view and clocks */

  // Model is where the factory is made. Item (one card per recipe) and
  // Machine (every building at its real footprint) are views of it, worked
  // out from the model and not edited directly. One switch holds all three.
  var viewSeg = document.getElementById('view-seg');
  var balanceSeg = document.getElementById('balance');

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
  altFold.querySelectorAll('[data-all]').forEach(function (b) {
    b.addEventListener('click', function () {
      state.unlocked = b.dataset.all === '1' ? UNLOCKABLE.slice() : [];
      renderAltList();
      refreshRecipeControls();
      changed();
    });
  });

  /* ========================================================= custom build */

  // Custom works like Satisfactory Modeler: you place items, not machines.
  // Each node is one step (a recipe, a resource, something brought in), drawn
  // as a card with its building's picture and its items' icons at the inputs
  // and outputs. How many machines a step needs is worked out for you: from
  // what flows into it (Auto), or fixed by you (Set), in which case the Auto
  // steps feeding it size themselves to what it asks for. Splitters share
  // evenly, as in the game; Storage takes whatever's left.
  var palette = document.getElementById('palette');
  var customHint = document.getElementById('custom-hint');
  var flow = null;   // the last Custom flow: see customFlow()

  var CNODE_W = { recipe: 170, resource: 156, import: 132, sink: 120, splitter: 64, merger: 64 };
  var SLOT = 38;       // room for each input or output
  var CARD_TOP = 28;   // room above the slots for the count
  var STRIP = 36;      // the inputs' and outputs' strips down the card's sides
  var STRIP_LOGI = 20; // the same on a splitter or merger

  function iconOf(id) { return 'icons/' + id + '.png'; }

  // A rounded diamond with "!" in it, as on the Machines view's note.
  var PROBLEM_ICON = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">' +
    '<rect x="4.1" y="4.1" width="11.8" height="11.8" rx="2.6" transform="rotate(45 10 10)" fill="#1e1e1e" stroke="currentColor" stroke-width="1.6"/>' +
    '<path d="M10 6.7v4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    '<circle cx="10" cy="13.5" r="1.05" fill="currentColor"/></svg>';
  function isLogistic(n) { return n.type === 'splitter' || n.type === 'merger'; }

  /** A card's building by its in-game name. */
  function partName(n) {
    if (n.type === 'splitter') return n.priority ? 'Smart Splitter' : 'Splitter';
    if (n.type === 'merger') return n.priority ? 'Priority Merger' : 'Merger';
    if (n.type === 'sink') return 'Storage Container';
    return titleCase(n.type);
  }

  function nodeRecipe(n) {
    return n.type === 'recipe' && DATA.recipes[n.recipe] ? DATA.recipes[n.recipe] : null;
  }

  /** A node's inputs and outputs, each an item (null: whatever its line carries). */
  function slotsOf(n) {
    var r = nodeRecipe(n);
    if (r) return { ins: r.in.map(function (q) { return q[0]; }), outs: r.out.map(function (q) { return q[0]; }) };
    if (n.type === 'resource' || n.type === 'import') return { ins: [], outs: [n.item] };
    if (n.type === 'sink') return { ins: [null], outs: [] };
    if (n.type === 'splitter') return { ins: [null], outs: [null, null, null] };
    if (n.type === 'merger') return { ins: [null, null, null], outs: [null] };
    return { ins: [], outs: [] };
  }

  /** A card's size: as tall as its most inputs or outputs need. */
  function nodeSize(n) {
    var s = slotsOf(n);
    var rows = Math.max(1, s.ins.length, s.outs.length);
    var w = CNODE_W[n.type] || 140;
    if (isLogistic(n)) return { w: w, h: rows * 24 + 12 };
    return { w: w, h: Math.max(86, CARD_TOP + rows * SLOT + 8) };
  }

  /**
   * Where an input (side 'in') or output ('out') meets its line: the card's
   * edge, level with the middle of its cell. The cells share their strip's
   * height evenly.
   */
  function slotAt(n, side, k) {
    var s = slotsOf(n);
    var count = (side === 'in' ? s.ins : s.outs).length;
    var size = nodeSize(n);
    return { x: side === 'in' ? n.x : n.x + size.w, y: n.y + size.h * (k + 0.5) / count };
  }

  /** The building a node stands for: a recipe's machine, or the extractor on a resource. */
  function buildingOf(n) {
    var r = nodeRecipe(n);
    if (r) return r.machine;
    if (n.type === 'resource') return extractorOf(n);
    return null;
  }

  function extractorOf(n) {
    if (!n.item) return null;
    if (!isFluid(n.item)) return DATA.extractors[n.miner] ? n.miner : 'Build_MinerMk1_C';
    var ids = Object.keys(DATA.extractors).filter(function (id) {
      var x = DATA.extractors[id];
      return x.resources && x.resources.indexOf(n.item) >= 0;
    });
    return ids.filter(function (id) { return id !== 'Build_FrackingExtractor_C'; })[0] || ids[0] || null;
  }

  /** Most a resource node gives: its nodes at their purity, its miner, its clock. */
  function resourceCap(n) {
    var ex = DATA.extractors[extractorOf(n)];
    if (!ex) return 0;
    var purity = n.item === 'Desc_Water_C' ? 1 : SOLVER.PURITY[n.purity || 'normal'];
    return ex.rate * purity * (n.count || 1) * (n.clock || 1);
  }

  function nodeById(id) {
    return state.custom.nodes.filter(function (n) { return n.id === id; })[0] || null;
  }

  /** The item a slot carries: its own, or for splitters and mergers, their line's. */
  function slotItem(n, side, k, guard) {
    var s = slotsOf(n);
    var it = (side === 'in' ? s.ins : s.outs)[k];
    if (it) return it;
    return isLogistic(n) || n.type === 'sink' ? lineItem(n, guard) : null;
  }

  function lineItem(n, guard) {
    guard = guard || {};
    if (guard[n.id]) return null;
    guard[n.id] = true;
    var links = state.custom.links;
    for (var i = 0; i < links.length; i++) {
      var l = links[i];
      if (l.to === n.id) {
        var src = nodeById(l.from);
        var a = src && slotItem(src, 'out', l.fk, guard);
        if (a) return a;
      }
    }
    for (var j = 0; j < links.length; j++) {
      var m = links[j];
      if (m.from === n.id) {
        var dst = nodeById(m.to);
        var b = dst && slotItem(dst, 'in', m.tk, guard);
        if (b) return b;
      }
    }
    return null;
  }

  function linkOn(n, side, k) {
    return state.custom.links.filter(function (l) {
      return side === 'out' ? l.from === n.id && l.fk === k : l.to === n.id && l.tk === k;
    })[0] || null;
  }

  /* ---- flow ---- */

  /** Shares F out evenly; what one branch can't take goes to the others. */
  function evenShare(F, caps) {
    var got = caps.map(function () { return 0; });
    var open = caps.map(function (_, i) { return i; });
    var left = F;
    for (var guard = 0; left > 1e-9 && open.length && guard < 20; guard++) {
      var each = left / open.length;
      var still = [];
      open.forEach(function (i) {
        var give = Math.min(each, caps[i] - got[i]);
        got[i] += give;
        left -= give;
        if (caps[i] - got[i] > 1e-9) still.push(i);
      });
      if (still.length === open.length) break;
      open = still;
    }
    return got;
  }

  /**
   * The whole build's rates. First what each Set step asks for is passed up
   * through the Auto steps feeding it (their "wanted" counts). Then items are
   * pushed forward from the resources: every step takes what it needs, an
   * Auto step with nothing asked of it grows to use all it's given, splitters
   * share evenly, and Storage takes what's left over.
   */
  function customFlow() {
    var nodes = state.custom.nodes;
    var links = state.custom.links;
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });
    var outL = {}, inL = {};
    links.forEach(function (l) {
      (outL[l.from] = outL[l.from] || []).push(l);
      (inL[l.to] = inL[l.to] || []).push(l);
    });
    var itemOf = {};
    links.forEach(function (l) { itemOf[l.id] = byId[l.from] ? slotItem(byId[l.from], 'out', l.fk) : null; });
    var perOf = {};
    nodes.forEach(function (n) {
      var r = nodeRecipe(n);
      var per = r ? SOLVER.perMinute(r) : {};
      // Somersloops multiply what comes out, not what goes in.
      var b = r ? sloopsOf(n).boost : 0;
      if (b) {
        per = Object.assign({}, per);
        Object.keys(per).forEach(function (id) { if (per[id] > 0) per[id] *= 1 + b; });
      }
      perOf[n.id] = per;
    });
    function need(n, item) { return Math.max(0, -(perOf[n.id][item] || 0)); }
    function make(n, item) { return Math.max(0, perOf[n.id][item] || 0); }
    function outLink(n, k) { return (outL[n.id] || []).filter(function (l) { return l.fk === k; })[0] || null; }
    function inLink(n, k) { return (inL[n.id] || []).filter(function (l) { return l.tk === k; })[0] || null; }

    // 1. Demand, passed upstream from Set steps.
    var wantMemo = {};
    var asking = {};
    function request(l, depth) {
      if (depth > 60) return 0;
      var n = byId[l.to];
      if (!n) return 0;
      if (n.type === 'recipe') {
        if (!nodeRecipe(n)) return 0;
        var c = n.set ? (n.count || 0) : wanted(n, depth + 1);
        return c * need(n, itemOf[l.id]);
      }
      if (n.type === 'splitter') {
        return (outL[n.id] || []).reduce(function (s, o) { return s + request(o, depth + 1); }, 0);
      }
      if (n.type === 'merger') {
        var o1 = (outL[n.id] || [])[0];
        if (!o1) return 0;
        // A Priority Merger asks its top input for everything.
        if (n.priority && inLink(n, 0)) return l.tk === 0 ? request(o1, depth + 1) : 0;
        var ins = (inL[n.id] || []).length || 1;
        return request(o1, depth + 1) / ins;
      }
      return 0;
    }
    function wanted(n, depth) {
      if (wantMemo[n.id] != null) return wantMemo[n.id];
      if (asking[n.id]) return 0;
      asking[n.id] = true;
      var w = 0;
      slotsOf(n).outs.forEach(function (item, k) {
        var l = outLink(n, k);
        if (l && make(n, item) > 0) w = Math.max(w, request(l, depth) / make(n, item));
      });
      asking[n.id] = false;
      wantMemo[n.id] = w;
      return w;
    }
    // The count each step aims for (null: Auto with nothing asked of it,
    // settled by its inputs below).
    var aim = {};
    nodes.forEach(function (n) {
      if (!nodeRecipe(n)) return;
      if (n.set) aim[n.id] = n.count || 0;
      else { var w = wanted(n, 0); aim[n.id] = w > 1e-9 ? w : null; }
    });

    // How much a link's far end will take.
    function accept(l, depth) {
      if ((depth || 0) > 60) return Infinity;
      var n = byId[l.to];
      if (!n) return 0;
      if (n.type === 'recipe') {
        if (!nodeRecipe(n)) return 0;
        var nd = need(n, itemOf[l.id]);
        if (!nd) return 0;
        return aim[n.id] == null ? Infinity : nd * aim[n.id];
      }
      if (n.type === 'sink') return Infinity;
      if (n.type === 'splitter') {
        return (outL[n.id] || []).reduce(function (s, o) { return s + accept(o, (depth || 0) + 1); }, 0);
      }
      if (n.type === 'merger') {
        var o1 = (outL[n.id] || [])[0];
        if (!o1) return 0;
        var room = accept(o1, (depth || 0) + 1);
        // A Priority Merger's top input comes first; any other input gets
        // what the line out has left after the rest.
        if (n.priority && l.tk === 0) return room;
        var others = (inL[n.id] || []).reduce(function (sum, x) { return x === l || !flowOf ? sum : sum + (flowOf[x.id] || 0); }, 0);
        return Math.max(0, room - others);
      }
      return 0;
    }

    // 2. Items pushed forward, sources first. The order is a depth-first
    // one from the sources, so a loop (a step feeding back into its own
    // supply) is cut at one line and everything after it still comes in
    // order; passes repeat until the flows stop changing.
    var order = [];
    var visited = {};
    function visit(n) {
      if (visited[n.id]) return;
      visited[n.id] = true;
      (outL[n.id] || []).forEach(function (l) { if (byId[l.to]) visit(byId[l.to]); });
      order.push(n);
    }
    nodes.filter(function (n) { return !(inL[n.id] || []).length; }).forEach(visit);
    nodes.forEach(visit);
    order.reverse();

    var flowOf = {};
    links.forEach(function (l) { flowOf[l.id] = 0; });
    var count = {}, run = {}, avail = {};
    for (var pass = 0; pass < 40; pass++) {
      var before = links.map(function (l) { return flowOf[l.id]; });
      order.forEach(function (n) {
        var ins = inL[n.id] || [];
        var outs = [];
        if (n.type === 'recipe') {
          var r = nodeRecipe(n);
          if (!r) { count[n.id] = 0; run[n.id] = 0; avail[n.id] = []; return; }
          var got = {};
          ins.forEach(function (l) { got[itemOf[l.id]] = (got[itemOf[l.id]] || 0) + flowOf[l.id]; });
          var limit = Infinity;
          r.in.forEach(function (q) { var nd = need(n, q[0]); if (nd > 0) limit = Math.min(limit, (got[q[0]] || 0) / nd); });
          var c = aim[n.id] != null ? aim[n.id] : (limit === Infinity ? 0 : limit);
          // The first pass runs every sized step at full, as if its loop
          // (if it's in one) were already primed; later passes settle from
          // there, and a loop that can't keep itself going runs down.
          var a = pass === 0 && aim[n.id] != null ? c : Math.min(c, limit);
          count[n.id] = c;
          run[n.id] = a;
          // What it can't use backs up on its belts.
          r.in.forEach(function (q) {
            var use = need(n, q[0]) * a;
            var into = ins.filter(function (l) { return itemOf[l.id] === q[0]; });
            var total = into.reduce(function (s, l) { return s + flowOf[l.id]; }, 0);
            if (total > use + 1e-9) into.forEach(function (l) { flowOf[l.id] *= use / total; });
          });
          slotsOf(n).outs.forEach(function (item, k) { outs[k] = make(n, item) * a; });
        } else if (n.type === 'resource') {
          outs[0] = resourceCap(n);
        } else if (n.type === 'import') {
          outs[0] = n.rate || 0;
        } else if (n.type === 'splitter') {
          var F = ins.reduce(function (s, l) { return s + flowOf[l.id]; }, 0);
          var branches = (outL[n.id] || []).slice().sort(function (a2, b2) { return a2.fk - b2.fk; });
          // Branches to Storage only take the overflow.
          var main = branches.filter(function (l) { return !(byId[l.to] && byId[l.to].type === 'sink'); });
          var spill = branches.filter(function (l) { return byId[l.to] && byId[l.to].type === 'sink'; });
          var left = F;
          // A Smart Splitter fills its top output first; the rest overflow.
          if (n.priority && main.length && main[0].fk === 0) {
            var first = main.shift();
            outs[0] = Math.min(F, accept(first));
            left -= outs[0];
          }
          var shares = evenShare(left, main.map(function (l) { return accept(l); }));
          main.forEach(function (l, i) { outs[l.fk] = shares[i]; left -= shares[i]; });
          var spillShares = evenShare(Math.max(0, left), spill.map(function () { return Infinity; }));
          spill.forEach(function (l, i) { outs[l.fk] = spillShares[i]; });
        } else if (n.type === 'merger') {
          outs[0] = ins.reduce(function (s, l) { return s + flowOf[l.id]; }, 0);
        }
        avail[n.id] = outs;
        (outL[n.id] || []).forEach(function (l) {
          flowOf[l.id] = Math.min(outs[l.fk] || 0, accept(l));
        });
        // A merger that can't pass everything on backs up evenly.
        if (n.type === 'merger') {
          var o1 = (outL[n.id] || [])[0];
          var sent = o1 ? flowOf[o1.id] : 0;
          var total2 = outs[0] || 0;
          if (total2 > sent + 1e-9) {
            var top = n.priority ? inLink(n, 0) : null;
            if (top) {
              var keep = Math.min(flowOf[top.id], sent);
              var rest = total2 - flowOf[top.id];
              flowOf[top.id] = keep;
              ins.forEach(function (l) { if (l !== top) flowOf[l.id] *= rest > 0 ? (sent - keep) / rest : 0; });
            } else {
              ins.forEach(function (l) { flowOf[l.id] *= total2 > 0 ? sent / total2 : 0; });
            }
          }
        }
      });
      // Settled: another pass wouldn't change anything.
      if (pass >= 3 && links.every(function (l, i) { return Math.abs(flowOf[l.id] - before[i]) <= 1e-9 + before[i] * 1e-9; })) break;
    }

    // 3. What it comes to.
    var res = { nodes: {}, links: {}, items: {}, outputs: {}, recipes: {}, problems: [], bad: {}, steps: 0, tally: [] };
    links.forEach(function (l) {
      var it = itemOf[l.id];
      res.links[l.id] = { total: flowOf[l.id], item: it, fluid: it ? isFluid(it) : false };
    });
    function problem(n, text) {
      res.problems.push({ part: n.id, text: text });
      res.bad[n.id] = true;
    }
    nodes.forEach(function (n) {
      var s = slotsOf(n);
      var st = { count: 0, run: 0, ins: [], outs: [] };
      s.ins.forEach(function (item, k) { var l = inLink(n, k); st.ins[k] = l ? flowOf[l.id] : 0; });
      s.outs.forEach(function (item, k) { st.outs[k] = (avail[n.id] || [])[k] || 0; });
      if (n.type === 'recipe') {
        var r = nodeRecipe(n);
        if (!r) {
          problem(n, 'A step has no recipe');
        } else {
          var c = count[n.id] || 0, a = run[n.id] || 0;
          st.count = c;
          st.run = a;
          var label = itemName(n.item || r.out[0][0]);
          var list = stepClocks(n.recipe, c, n.clock);
          var m = DATA.machines[r.machine];
          var sl = sloopsOf(n);
          res.tally.push({
            mid: r.machine, name: m.name, exact: a, built: list.length,
            power: stepPower(n.recipe, a, n.clock, list.length) * sl.power,
            sloops: sl.used * list.length,
            label: label, note: list.length + ' × ' + m.name, id: n.id,
            shards: list.reduce(function (t, x) { return t + shardsFor(x); }, 0)
          });
          var main = r.out[0][0];
          res.recipes[n.recipe] = res.recipes[n.recipe] || { item: main, count: 0 };
          res.recipes[n.recipe].count += a;
          res.steps++;
          r.in.forEach(function (q, k) {
            var wantIn = need(n, q[0]) * c;
            if (!inLink(n, k)) {
              problem(n, label + ': nothing brings in ' + itemName(q[0]));
            } else if (c > 1e-9 && st.ins[k] < wantIn * (1 - 1e-3) - 1e-6) {
              problem(n, label + ': gets ' + fmtNum(st.ins[k]) + ' of the ' + fmtNum(wantIn) + '/min ' + itemName(q[0]) + ' it needs');
            }
          });
          s.outs.forEach(function (item, k) {
            var l = outLink(n, k);
            if (!l) {
              if (st.outs[k] > 1e-6) res.outputs[item] = (res.outputs[item] || 0) + st.outs[k];
            } else if (st.outs[k] - flowOf[l.id] > Math.max(0.01, st.outs[k] * 1e-3)) {
              problem(n, fmtNum(st.outs[k] - flowOf[l.id]) + '/min ' + itemName(item) + ' backs up');
            }
          });
        }
      } else if (n.type === 'resource') {
        var cap = resourceCap(n);
        var lo = outLink(n, 0);
        var used = lo ? flowOf[lo.id] : 0;
        st.count = n.count || 1;
        st.run = used;
        var exId = extractorOf(n);
        var ex = DATA.extractors[exId];
        if (ex) {
          var util = cap > 0 ? used / cap : 0;
          var each = SOLVER.clocks(n.count || 1, 'even').map(function () { return n.clock || 1; });
          res.tally.push({
            mid: exId, name: ex.name, exact: (n.count || 1) * util, built: n.count || 1,
            power: SOLVER.extractorPower(DATA, exId, each, state.clock) * util,
            label: itemName(n.item), note: (n.count || 1) + ' × ' + ex.name, id: n.id, extraction: true,
            shards: each.reduce(function (t, x) { return t + shardsFor(x); }, 0)
          });
        }
        if (used > 1e-6) {
          var it = res.items[n.item] || (res.items[n.item] = { supplied: 0, cap: 0, short: 0, surplus: 0, producers: [] });
          it.supplied += used;
          it.cap += cap;
        }
        if (!lo) problem(n, itemName(n.item) + ' isn’t connected to anything');
        else if (!(byId[lo.to] && byId[lo.to].type === 'merger' && byId[lo.to].priority)) {
          // (Into a Priority Merger, the other inputs make up any shortfall;
          // a step left short says so itself.)
          var asked = request(lo, 0);
          if (asked > cap * (1 + 1e-3) + 1e-6) problem(n, itemName(n.item) + ': the steps ask for ' + fmtNum(asked) + '/min, but its nodes give ' + fmtNum(cap));
        }
      } else if (n.type === 'import') {
        var li = outLink(n, 0);
        var brought = li ? flowOf[li.id] : 0;
        st.run = brought;
        if (brought > 1e-6) {
          var bi = res.items[n.item] || (res.items[n.item] = { supplied: 0, short: 0, surplus: 0, producers: [], imported: true });
          bi.supplied += brought;
          bi.imported = true;
        }
        if (!li) problem(n, itemName(n.item) + ' (brought in) isn’t connected to anything');
      } else if (n.type === 'sink') {
        var ls = inLink(n, 0);
        if (ls && flowOf[ls.id] > 1e-6) {
          var si = itemOf[ls.id];
          res.outputs[si] = (res.outputs[si] || 0) + flowOf[ls.id];
        }
      } else if (isLogistic(n)) {
        // One item per line: a splitter or merger can't mix them.
        var kinds = {};
        (inL[n.id] || []).concat(outL[n.id] || []).forEach(function (l) { if (itemOf[l.id]) kinds[itemOf[l.id]] = true; });
        if (Object.keys(kinds).length > 1) problem(n, 'A ' + partName(n) + ' mixes ' + Object.keys(kinds).map(itemName).join(' and '));
      }
      res.nodes[n.id] = st;
    });
    return res;
  }

  /* ---- notes, and the pencil ---- */

  // In Model, a strip of tools at the canvas's top left says what a press
  // does: select (the usual), draw with the pencil, rub drawings out, or
  // drop a note. Notes and drawings are saved with the model and only show
  // there.
  var inkEl = document.getElementById('ink');

  // The canvas clips rather than scrolls, but focusing something near its
  // edge (a note) can still scroll it; that would shift everything, so any
  // scroll is put straight back.
  stage.addEventListener('scroll', function () {
    if (stage.scrollLeft || stage.scrollTop) { stage.scrollLeft = 0; stage.scrollTop = 0; }
  });
  var toolsEl = document.getElementById('model-tools');
  var tool = 'select';
  var PEN = 5;     // pencil width on the canvas (so on screen, times the zoom)
  var RUB = 4;     // eraser reach from the pointer, px (its cursor is a square twice this)

  /** The pencil's cursor: a circle as wide as its line looks at this zoom. */
  function penCursor() {
    var d = clamp(PEN * state.view.s, 2, 100);
    var size = Math.ceil(d + 4);
    var c = size / 2;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '">' +
      '<circle cx="' + c + '" cy="' + c + '" r="' + (d / 2 + 1) + '" fill="none" stroke="#000" stroke-opacity=".55" stroke-width="1"/>' +
      '<circle cx="' + c + '" cy="' + c + '" r="' + (d / 2) + '" fill="none" stroke="#fff" stroke-width="1"/></svg>';
    stage.style.setProperty('--pen-cursor', 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '") ' + Math.round(c) + ' ' + Math.round(c));
  }

  function setTool(t) {
    tool = t;
    if (t === 'pencil') penCursor();
    toolsEl.querySelectorAll('.mt-btn').forEach(function (b) { b.classList.toggle('on', b.dataset.tool === t); });
    stage.classList.toggle('tool-pencil', t === 'pencil');
    stage.classList.toggle('tool-eraser', t === 'eraser');
    stage.classList.toggle('tool-note', t === 'note');
  }
  toolsEl.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
  toolsEl.addEventListener('click', function (e) {
    var b = e.target.closest('.mt-btn');
    if (b) setTool(b.dataset.tool === tool && tool !== 'select' ? 'select' : b.dataset.tool);
  });

  /** A stroke's points as a smooth path: straight to each midpoint, curving through the points. */
  function inkPath(pts) {
    if (pts.length < 4) return '';
    var d = 'M' + pts[0] + ' ' + pts[1];
    if (pts.length === 4) return d + ' L' + pts[2] + ' ' + pts[3];
    for (var i = 2; i < pts.length - 2; i += 2) {
      var mx = (pts[i] + pts[i + 2]) / 2, my = (pts[i + 1] + pts[i + 3]) / 2;
      d += ' Q' + pts[i] + ' ' + pts[i + 1] + ' ' + mx + ' ' + my;
    }
    return d + ' L' + pts[pts.length - 2] + ' ' + pts[pts.length - 1];
  }

  function renderInk() {
    inkEl.innerHTML = '';
    (state.custom.strokes || []).forEach(function (k) {
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', inkPath(k.pts));
      p.setAttribute('class', 'ink-stroke');
      p.dataset.id = k.id;
      inkEl.appendChild(p);
    });
  }

  function renderNotes() {
    world.querySelectorAll('.cnote').forEach(function (el) { el.remove(); });
    (state.custom.notes || []).forEach(function (n) { world.appendChild(noteEl(n)); });
  }

  /**
   * A note: white text in a thin outline, the box growing with what's typed.
   * Click the text to type; drag by the outline around it. A note left empty
   * goes away.
   */
  function noteEl(n) {
    var el = document.createElement('div');
    el.className = 'cnote';
    el.dataset.id = n.id;
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    var text = document.createElement('textarea');
    text.className = 'cnote-text';
    text.value = n.text || '';
    text.placeholder = 'Text';
    text.spellcheck = false;
    text.rows = 1;
    el.appendChild(text);
    function fit() {
      // Browsers without field-sizing grow it by hand.
      if (CSS.supports && CSS.supports('field-sizing', 'content')) return;
      text.style.height = 'auto';
      text.style.height = text.scrollHeight + 'px';
    }
    requestAnimationFrame(fit);
    // The note as it is in the model now (a redraw or undo may have swapped the object).
    function live() { return (state.custom.notes || []).filter(function (m) { return m.id === n.id; })[0]; }
    function remove() {
      state.custom.notes = (state.custom.notes || []).filter(function (m) { return m.id !== n.id; });
      changed();
    }
    text.addEventListener('input', function () { var m = live(); if (m) m.text = text.value; fit(); save(); });
    // While typing, presses in the text are the text's own (caret, selection).
    text.addEventListener('pointerdown', function (e) {
      if (document.activeElement === text) e.stopPropagation();
    });
    text.addEventListener('blur', function () {
      if (!text.value.trim() && live()) remove();
    });
    text.addEventListener('keydown', function (e) {
      // Enter finishes; Shift+Enter starts a new line.
      if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        text.blur();
      }
    });
    // Otherwise a press anywhere on it drags it, or, if it doesn't move,
    // starts typing at the end.
    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || document.activeElement === text) return;
      e.preventDefault();
      e.stopPropagation();
      closeAll();
      var m = live() || n;
      var sx = e.clientX, sy = e.clientY, ox = m.x, oy = m.y, moved = false;
      function move(ev) {
        var dx = (ev.clientX - sx) / state.view.s, dy = (ev.clientY - sy) / state.view.s;
        if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 3) return;
        if (!moved) { stage.classList.add('moving-note'); el.classList.add('moving'); }
        moved = true;
        m.x = Math.round(ox + dx);
        m.y = Math.round(oy + dy);
        el.style.left = m.x + 'px';
        el.style.top = m.y + 'px';
      }
      function up() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        stage.classList.remove('moving-note');
        el.classList.remove('moving');
        if (moved) { save(); return; }
        var at = caretAt(text, sx, sy);
        text.focus({ preventScroll: true });
        text.setSelectionRange(at, at);
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    el.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (document.activeElement === text) return;
      closeAll();
      openCtx(e.clientX, e.clientY, [
        { head: 'Text' },
        { label: 'Remove', run: remove }
      ]);
    });
    return el;
  }

  /**
   * Where in a text box's text a screen point falls: its line from the
   * height, then the nearest gap between letters along it, measured in the
   * box's own font (the canvas zoom taken out).
   */
  var measureCtx = null;
  function caretAt(ta, x, y) {
    var cs = getComputedStyle(ta);
    var r = ta.getBoundingClientRect();
    var z = state.view.s;
    var lx = (x - r.left) / z - parseFloat(cs.paddingLeft);
    var ly = (y - r.top) / z - parseFloat(cs.paddingTop);
    var lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25;
    var lines = ta.value.split('\n');
    var row = clamp(Math.floor(ly / lh), 0, lines.length - 1);
    measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
    measureCtx.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    var line = lines[row], col = line.length;
    for (var i = 0; i < line.length; i++) {
      var mid = (measureCtx.measureText(line.slice(0, i)).width + measureCtx.measureText(line.slice(0, i + 1)).width) / 2;
      if (lx < mid) { col = i; break; }
    }
    var at = col;
    for (var j = 0; j < row; j++) at += lines[j].length + 1;
    return at;
  }

  /** A new note at a point on the canvas, ready to type in. */
  function addNote(wx, wy) {
    var n = { id: 'm' + uid(), x: Math.round(wx), y: Math.round(wy), text: '' };
    state.custom.notes = (state.custom.notes || []).concat([n]);
    changed();
    var el = world.querySelector('.cnote[data-id="' + n.id + '"] .cnote-text');
    if (el) el.focus({ preventScroll: true });
  }

  // With the pencil, eraser or note tool, a press on the canvas (cards
  // included) is theirs, caught before anything else sees it.
  stage.addEventListener('pointerdown', function (e) {
    if (state.build !== 'custom' || tool === 'select' || e.button !== 0) return;
    if (e.target.closest('.view-opts, .model-tools, .cnote, .empty-hint')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    closeAll();
    var w = toWorld(e.clientX, e.clientY);
    if (tool === 'note') {
      addNote(w.x, w.y);
      setTool('select');
      return;
    }
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }
    if (tool === 'pencil') {
      var pts = [Math.round(w.x), Math.round(w.y)];
      var live = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      live.setAttribute('class', 'ink-stroke live');
      inkEl.appendChild(live);
      var draw = function (ev) {
        var p = toWorld(ev.clientX, ev.clientY);
        var lx = pts[pts.length - 2], ly = pts[pts.length - 1];
        // Points closer than a couple of pixels on screen add nothing.
        if (Math.hypot(p.x - lx, p.y - ly) * state.view.s < 2.5) return;
        pts.push(Math.round(p.x), Math.round(p.y));
        live.setAttribute('d', inkPath(pts));
      };
      var done = function () {
        stage.removeEventListener('pointermove', draw);
        stage.removeEventListener('pointerup', done);
        stage.removeEventListener('pointercancel', done);
        if (pts.length < 4) pts.push(pts[0] + 1, pts[1]);  // a dot
        state.custom.strokes = (state.custom.strokes || []).concat([{ id: 'k' + uid(), pts: pts }]);
        changed();
      };
      stage.addEventListener('pointermove', draw);
      stage.addEventListener('pointerup', done);
      stage.addEventListener('pointercancel', done);
      return;
    }
    // Eraser: any stroke passing near the pointer goes.
    var gone = {};
    var rub = function (ev) {
      var p = toWorld(ev.clientX, ev.clientY);
      var r = RUB / state.view.s;
      (state.custom.strokes || []).forEach(function (k) {
        if (gone[k.id]) return;
        for (var i = 0; i < k.pts.length; i += 2) {
          if (Math.abs(k.pts[i] - p.x) <= r && Math.abs(k.pts[i + 1] - p.y) <= r) {
            gone[k.id] = true;
            var el = inkEl.querySelector('[data-id="' + k.id + '"]');
            if (el) el.remove();
            return;
          }
        }
      });
    };
    rub(e);
    var stop = function () {
      stage.removeEventListener('pointermove', rub);
      stage.removeEventListener('pointerup', stop);
      stage.removeEventListener('pointercancel', stop);
      if (Object.keys(gone).length) {
        state.custom.strokes = state.custom.strokes.filter(function (k) { return !gone[k.id]; });
        changed();
      }
    };
    stage.addEventListener('pointermove', rub);
    stage.addEventListener('pointerup', stop);
    stage.addEventListener('pointercancel', stop);
  }, true);

  /* ---- factories feeding each other ---- */

  // An Import card can come from another factory in the same save. That
  // factory's outputs say how much there is; every factory importing from
  // it shares that, and asking for more is a problem on the importing side.

  var outputsMemo = null;  // factory id -> its outputs, for one redraw

  /** The model's flow, with problems about imports from other factories. */
  function modelFlow() {
    outputsMemo = null;
    var f = customFlow();
    linkProblems(f);
    return f;
  }

  function factoryLabel(f) { return f.name || 'Untitled factory'; }

  function factoryById(id) {
    return currentSave().factories.filter(function (f) { return f.id === id; })[0] || null;
  }

  /** The other factories in this save. */
  function otherFactories() {
    var me = currentFactory();
    return currentSave().factories.filter(function (f) { return f !== me; });
  }

  /** What another factory sends out, per minute: its model's outputs. */
  function factoryOutputs(f) {
    outputsMemo = outputsMemo || {};
    if (outputsMemo[f.id]) return outputsMemo[f.id];
    var plan = f.plan || {};
    var out = {};
    var mine = state.custom;
    try {
      state.custom = readCustom(plan.custom);
      if (state.custom.nodes.length) out = customFlow().outputs;
      else (plan.targets || []).forEach(function (t) {
        if (t && DATA.items[t.item]) out[t.item] = (out[t.item] || 0) + (Number(t.rate) || 0);
      });
    } finally {
      state.custom = mine;
    }
    outputsMemo[f.id] = out;
    return out;
  }

  /** Every Import in this save taking from factory `fid`: [{ factory, item, rate }]. */
  function requestsOf(fid) {
    var me = currentFactory();
    var list = [];
    currentSave().factories.forEach(function (f) {
      var nodes = f === me ? state.custom.nodes : ((f.plan && f.plan.custom && f.plan.custom.nodes) || []);
      nodes.forEach(function (n) {
        if (n && n.type === 'import' && n.from === fid && DATA.items[n.item]) list.push({ factory: f, item: n.item, rate: Number(n.rate) || 0 });
      });
    });
    return list;
  }

  function linkProblems(f) {
    state.custom.nodes.forEach(function (n) {
      if (n.type !== 'import' || !n.from) return;
      function problem(text) { f.problems.push({ part: n.id, text: text }); f.bad[n.id] = true; }
      var src = factoryById(n.from);
      if (!src || src === currentFactory()) { problem('The factory it comes from is gone'); return; }
      var makes = factoryOutputs(src)[n.item] || 0;
      var asked = requestsOf(src.id).filter(function (r) { return r.item === n.item; })
        .reduce(function (sum, r) { return sum + r.rate; }, 0);
      if (asked > makes * (1 + 1e-3) + 1e-6) {
        problem(factoryLabel(src) + ' makes ' + rateText(n.item, makes) + ', but ' +
          (Math.abs(asked - (n.rate || 0)) < 1e-9 ? 'this asks for ' : 'imports ask for ') + rateText(n.item, asked));
      }
    });
  }

  /* ---- palette ---- */

  var palQuery = '';

  /** The items panel: resources, parts, and the logistics nodes, with a search. */
  function renderPalette() {
    if (palette.dataset.built) { filterPalette(); return; }
    palette.dataset.built = '1';
    palette.innerHTML = '';
    // The title and search stay at the top while the items scroll under them.
    var top = document.createElement('div');
    top.className = 'pal-top';
    var title = document.createElement('div');
    title.className = 'pal-title';
    title.textContent = 'Items';
    top.appendChild(title);
    var field = document.createElement('div');
    field.className = 'pal-field';
    var search = document.createElement('input');
    search.type = 'text';
    search.className = 'pal-search';
    search.placeholder = 'Search items';
    search.spellcheck = false;
    var clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'pal-clear';
    clear.setAttribute('aria-label', 'Clear the search');
    clear.textContent = '×';
    clear.hidden = true;
    function query() {
      palQuery = search.value.trim().toLowerCase();
      clear.hidden = !search.value;
      filterPalette();
    }
    search.addEventListener('input', query);
    clear.addEventListener('click', function () { search.value = ''; query(); search.focus(); });
    field.appendChild(search);
    field.appendChild(clear);
    top.appendChild(field);
    palette.appendChild(top);
    // In the order the game brings them in (see order in tools/extract-data.mjs).
    function progression(a, b) { return (DATA.items[a].order || 0) - (DATA.items[b].order || 0); }
    var sections = [
      { head: 'Logistics', kinds: ['splitter', 'smart', 'merger', 'priority', 'sink'] },
      { head: 'Resources', kinds: RAW_ITEMS.slice().sort(progression) },
      { head: 'Parts', kinds: PICKABLE.slice().sort(progression) }
    ];
    var NAMES = { splitter: 'Splitter', smart: 'Smart Splitter', merger: 'Merger',
      priority: 'Priority Merger', sink: 'Storage Container' };
    var ICONS = { splitter: 'splitter', smart: 'splitter', merger: 'merger', priority: 'merger', sink: 'storage' };
    sections.forEach(function (sec) {
      var wrap = document.createElement('div');
      wrap.className = 'pal-section';
      var head = document.createElement('div');
      head.className = 'pal-head';
      head.textContent = sec.head;
      wrap.appendChild(head);
      var grid = document.createElement('div');
      grid.className = 'pal-grid';
      sec.kinds.forEach(function (kind) {
        var name = NAMES[kind] || itemName(kind);
        var tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'pal-tile';
        tile.dataset.kind = kind;
        tile.dataset.name = name.toLowerCase();
        var img = document.createElement('img');
        img.src = iconOf(ICONS[kind] || kind);
        img.alt = '';
        img.draggable = false;
        var label = document.createElement('span');
        label.className = 'pal-name';
        label.textContent = name;
        tile.appendChild(img);
        tile.appendChild(label);
        tile.setAttribute('aria-label', name);
        tile.addEventListener('pointerdown', function (e) { dragFromPalette(kind, e); });
        grid.appendChild(tile);
      });
      wrap.appendChild(grid);
      palette.appendChild(wrap);
    });
    filterPalette();
  }

  function filterPalette() {
    palette.querySelectorAll('.pal-section').forEach(function (sec) {
      var any = false;
      sec.querySelectorAll('.pal-tile').forEach(function (t) {
        var show = !palQuery || t.dataset.name.indexOf(palQuery) >= 0;
        t.hidden = !show;
        if (show) any = true;
      });
      sec.hidden = !any;
    });
  }

  /** Drag an item off the panel onto the canvas; a plain click drops it mid-view. */
  function dragFromPalette(kind, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    closeAll();
    var startX = e.clientX, startY = e.clientY;
    var moved = false;
    var ghost = document.createElement('img');
    ghost.className = 'pal-ghost';
    ghost.src = e.currentTarget.querySelector('img').src;
    ghost.alt = '';
    function move(ev) {
      if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 4) return;
      if (!moved) { moved = true; document.body.appendChild(ghost); }
      ghost.style.left = ev.clientX + 'px';
      ghost.style.top = ev.clientY + 'px';
      // A splitter or merger held over a line goes into it when dropped.
      if (SPLICERS[kind]) markSplice(linkAt(ev.clientX, ev.clientY));
    }
    function up(ev) {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      ghost.remove();
      markSplice(null);
      if (!moved) {
        var r = stage.getBoundingClientRect();
        var mid = toWorld(r.left + r.width / 2, r.top + r.height / 2);
        placeItem(kind, mid.x, mid.y);
        return;
      }
      var over = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!over || !stage.contains(over) || over.closest('.view-opts, .hover-info')) return;
      var at = toWorld(ev.clientX, ev.clientY);
      placeItem(kind, at.x, at.y, SPLICERS[kind] ? linkAt(ev.clientX, ev.clientY) : null);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /** The recipe a new step for an item starts on: its usual one if you can build it. */
  function startRecipe(item) {
    var def = DATA.defaults[item];
    if (def && canBuild(def) && recipeAllowed(def)) return def;
    var list = (producersOf[item] || []).filter(function (rid) {
      return canBuild(rid) && recipeAllowed(rid) && DATA.recipes[rid].out[0][0] === item;
    });
    return list[0] || fallbackRecipe(item);
  }

  /** A new node for an item (a step, a resource, or something brought in), centred on a point. */
  function newNode(kind, wx, wy) {
    var n;
    if (kind === 'splitter' || kind === 'merger' || kind === 'sink') {
      n = { type: kind };
    } else if (kind === 'smart') {
      n = { type: 'splitter', priority: true };
    } else if (kind === 'priority') {
      n = { type: 'merger', priority: true };
    } else if (DATA.items[kind].raw) {
      n = { type: 'resource', item: kind, purity: 'normal', count: 1, clock: 1 };
      if (!isFluid(kind)) n.miner = availableMiner(state.defaultMiner);
    } else {
      var rid = startRecipe(kind);
      n = rid ? { type: 'recipe', recipe: rid, item: kind } : { type: 'import', item: kind, rate: 60 };
    }
    n.id = 'n' + uid();
    var size = nodeSize(n);
    n.x = Math.round(wx - size.w / 2);
    n.y = Math.round(wy - size.h / 2);
    state.custom.nodes.push(n);
    return n;
  }

  function placeItem(kind, wx, wy, onLink) {
    var n = newNode(kind, wx, wy);
    if (onLink) splice(onLink, n);
    selectOnly(n.id);
    changed();
  }

  /* ---- splitters and mergers dropped onto a line ---- */

  var SPLICERS = { splitter: true, smart: true, merger: true, priority: true };

  /** The line under a screen point, if any. */
  function linkAt(x, y) {
    var el = document.elementFromPoint(x, y);
    var hit = el && el.closest && el.closest('.belt-hit');
    return hit ? state.custom.links.filter(function (l) { return l.id === hit.dataset.hit; })[0] || null : null;
  }

  /** Marks the line a drop would go into (or none). */
  function markSplice(l) {
    wires.querySelectorAll('.cwire.splice').forEach(function (p) { p.classList.remove('splice'); });
    if (!l) return;
    var p = wires.querySelector('.cwire[data-link="' + l.id + '"]');
    if (p) p.classList.add('splice');
  }

  /** Puts a splitter or merger into a line: the line's start feeds it, and it feeds the line's end. */
  function splice(l, n) {
    state.custom.links = state.custom.links.filter(function (x) { return x !== l; });
    state.custom.links.push({ id: 'l' + uid(), from: l.from, fk: l.fk, to: n.id, tk: 0 });
    state.custom.links.push({ id: 'l' + uid(), from: n.id, fk: 0, to: l.to, tk: l.tk });
  }

  /** Whether a card could go into a line: a splitter or merger with nothing joined yet. */
  function canSplice(n) {
    return isLogistic(n) && !state.custom.links.some(function (l) { return l.from === n.id || l.to === n.id; });
  }

  /* ---- selection helpers ---- */

  function selectedParts() {
    return state.custom.nodes.filter(function (n) { return selected[n.id]; });
  }
  function selectedLinks() {
    return state.custom.links.filter(function (l) { return selected[l.id]; });
  }

  /** Removes nodes, with every line on them, and any lines listed. */
  function removeParts(list, links) {
    var gone = {};
    list.forEach(function (n) { gone[n.id] = true; });
    var cut = {};
    (links || []).forEach(function (l) { cut[l.id] = true; });
    state.custom.nodes = state.custom.nodes.filter(function (n) { return !gone[n.id]; });
    state.custom.links = state.custom.links.filter(function (l) {
      return !cut[l.id] && !gone[l.from] && !gone[l.to];
    });
    clearSelection();
    changed();
  }

  /* ---- copy and paste ---- */

  // Copied cards, with the lines between them. Kept for the session, so they
  // paste into another factory too.
  var clip = null;
  var pastes = 0;
  var pointerOnStage = null;   // where the pointer last was over the canvas
  stage.addEventListener('pointermove', function (e) { pointerOnStage = { x: e.clientX, y: e.clientY }; });
  stage.addEventListener('pointerleave', function () { pointerOnStage = null; });

  function copyParts(list) {
    if (!list.length) return;
    var ids = {};
    list.forEach(function (n) { ids[n.id] = true; });
    clip = {
      nodes: clone(list),
      links: clone(state.custom.links.filter(function (l) { return ids[l.from] && ids[l.to]; }))
    };
    pastes = 0;
  }

  /** New copies of the copied cards: under the pointer, or a step along from the last. */
  function pasteParts(atScreen) {
    if (!clip || !clip.nodes.length) return;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    clip.nodes.forEach(function (n) {
      var size = nodeSize(n);
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + size.w); y1 = Math.max(y1, n.y + size.h);
    });
    var dx, dy;
    var point = atScreen || pointerOnStage;
    if (point) {
      var w = toWorld(point.x, point.y);
      dx = Math.round(w.x - (x0 + x1) / 2);
      dy = Math.round(w.y - (y0 + y1) / 2);
    } else {
      pastes++;
      dx = dy = 40 * pastes;
    }
    var newId = {};
    clearSelection();
    clip.nodes.forEach(function (n) {
      var m = clone(n);
      m.id = 'n' + uid();
      m.x = n.x + dx;
      m.y = n.y + dy;
      newId[n.id] = m.id;
      state.custom.nodes.push(m);
      selected[m.id] = true;
    });
    clip.links.forEach(function (l) {
      state.custom.links.push({ id: 'l' + uid(), from: newId[l.from], fk: l.fk, to: newId[l.to], tk: l.tk });
    });
    changed();
  }

  /** Every card's box on the canvas. */
  function customBoxes() {
    return state.custom.nodes.map(function (n) {
      var size = nodeSize(n);
      return { id: n.id, x: n.x, y: n.y, w: size.w, h: size.h };
    });
  }

  /** Centres the view on a node and selects it. */
  function focusPart(id) {
    var n = nodeById(id);
    if (!n) return;
    var size = nodeSize(n);
    var v = state.view;
    v.x = usableWidth() / 2 - (n.x + size.w / 2) * v.s;
    v.y = stage.clientHeight / 2 - (n.y + size.h / 2) * v.s;
    applyView();
    selectOnly(id);
    writeNow();
  }

  /* ---- cards ---- */

  function cardEl(n) {
    var size = nodeSize(n);
    var st = (flow && flow.nodes[n.id]) || { ins: [], outs: [] };
    var s = slotsOf(n);
    var strip = isLogistic(n) ? STRIP_LOGI : STRIP;
    var el = document.createElement('div');
    el.className = 'cpart cnode cnode-' + n.type;
    el.dataset.id = n.id;
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    el.style.width = size.w + 'px';
    el.style.height = size.h + 'px';

    // The middle: the building's picture with the count over it, between
    // the inputs' strip and the outputs'.
    var body = document.createElement('div');
    body.className = 'cn-body';
    body.style.left = (s.ins.length ? strip : 0) + 'px';
    body.style.right = (s.outs.length ? strip : 0) + 'px';
    el.appendChild(body);
    if (isLogistic(n)) {
      var letter = document.createElement('span');
      letter.className = 'cn-letter' + (n.priority ? ' small' : '');
      letter.textContent = n.type === 'splitter' ? (n.priority ? 'SS' : 'S') : (n.priority ? 'PM' : 'M');
      body.appendChild(letter);
    } else {
      var badge = document.createElement('span');
      badge.className = 'cn-count';
      if (n.type === 'recipe') {
        badge.textContent = nodeRecipe(n) ? '×' + fmtCount(st.count || 0) : '?';
        if (n.set) badge.classList.add('set');
        if (st.run < (st.count || 0) - 1e-6) badge.classList.add('short');
      } else if (n.type === 'resource') {
        badge.textContent = '×' + (n.count || 1);
      } else if (n.type === 'import') {
        badge.textContent = fmtNum(n.rate || 0) + '/min';
      } else {
        badge.textContent = 'Storage';
      }
      body.appendChild(badge);
      var b = buildingOf(n);
      var pic = document.createElement('img');
      pic.className = 'cn-icon';
      pic.src = iconOf(b || (n.type === 'import' && isFluid(n.item) ? 'buffer' : 'storage'));
      pic.alt = '';
      pic.draggable = false;
      body.appendChild(pic);
      if (n.type === 'import') {
        var from = n.from && factoryById(n.from);
        var fromCap = document.createElement('span');
        fromCap.className = 'cn-caption cn-from';
        fromCap.textContent = n.from ? 'from ' + (from ? factoryLabel(from) : 'a deleted factory') : 'from elsewhere';
        body.appendChild(fromCap);
      } else if (n.type === 'resource' && n.item !== 'Desc_Water_C') {
        var cap = document.createElement('span');
        cap.className = 'cn-caption';
        cap.textContent = titleCase(n.purity || 'normal') + (isFluid(n.item) ? '' : ' · ' + DATA.extractors[extractorOf(n)].name.replace(/^Miner\s*/, ''));
        body.appendChild(cap);
      } else if (n.type === 'recipe' && nodeRecipe(n) && (nodeRecipe(n).alt || n.clock || sloopsOf(n).used)) {
        var alt = document.createElement('span');
        alt.className = 'cn-caption alt';
        var used = sloopsOf(n).used;
        alt.textContent = [nodeRecipe(n).alt ? 'ALT' : '', n.clock ? Math.round(n.clock * 100) + '%' : '',
          used ? used + (used === 1 ? ' sloop' : ' sloops') : ''].filter(Boolean).join(' · ');
        body.appendChild(alt);
      }
    }

    // Inputs in a strip down the left, outputs down the right: a cell each,
    // showing its item. The line joins the card's edge level with it.
    [['in', s.ins], ['out', s.outs]].forEach(function (side) {
      if (!side[1].length) return;
      var col = document.createElement('div');
      col.className = 'cn-side ' + side[0];
      col.style.width = strip + 'px';
      side[1].forEach(function (item, k) {
        var shown = item || slotItem(n, side[0], k);
        var slot = document.createElement('div');
        slot.className = 'cn-slot ' + side[0] + (shown && isFluid(shown) ? ' fluid' : '') + (linkOn(n, side[0], k) ? ' linked' : '') +
          (n.priority && k === 0 && side[0] === (n.type === 'splitter' ? 'out' : 'in') ? ' prio' : '');
        slot.dataset.node = n.id;
        slot.dataset.side = side[0];
        slot.dataset.k = k;
        if (shown) {
          var img = document.createElement('img');
          img.src = iconOf(shown);
          img.alt = '';
          img.draggable = false;
          slot.appendChild(img);
        }
        slot.setAttribute('aria-label', (shown ? itemName(shown) : 'Any item') + (side[0] === 'in' ? ' in' : ' out'));
        slot.addEventListener('pointerdown', function (e) { dragFromSlot(n, side[0], k, e); });
        col.appendChild(slot);
        // Where the chain ends, what comes out, just past the card's edge
        // (lines carry their own figure).
        if (side[0] === 'out' && !isLogistic(n) && !linkOn(n, 'out', k)) {
          var end = document.createElement('div');
          end.className = 'flow-label cflow cn-end';
          end.style.top = (slotAt(n, 'out', k).y - n.y) + 'px';
          var bold = document.createElement('b');
          bold.textContent = fmtNum(st.outs[k] || 0);
          end.appendChild(bold);
          end.appendChild(document.createTextNode((shown && isFluid(shown) ? ' m³' : '') + '/min'));
          el.appendChild(end);
        }
      });
      el.appendChild(col);
    });

    // Something wrong: a flag off the top right corner. Hovering it says what.
    var mine = flow ? flow.problems.filter(function (pr) { return pr.part === n.id; }) : [];
    if (mine.length) {
      el.classList.add('has-problem');
      var flag = document.createElement('span');
      flag.className = 'cn-flag';
      flag.innerHTML = PROBLEM_ICON;
      flag.addEventListener('pointerenter', function () {
        hoverInfo.innerHTML = '';
        var head = document.createElement('div');
        head.className = 'hi-line hi-title';
        head.textContent = n.item ? itemName(n.item) : titleCase(n.type);
        hoverInfo.appendChild(head);
        mine.forEach(function (pr) {
          var div = document.createElement('div');
          div.className = 'hi-line';
          div.textContent = pr.text;
          hoverInfo.appendChild(div);
        });
        hoverInfo.hidden = false;
      });
      flag.addEventListener('pointerleave', hideHoverInfo);
      el.appendChild(flag);
    }
    el.setAttribute('aria-label', n.item ? itemName(n.item) : partName(n));
    el.addEventListener('pointerdown', function (e) { dragCard(el, n, e); });
    el.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (dragMenuSkip()) return;
      closeAll();
      if (!selected[n.id]) selectOnly(n.id);
      var list = selectedParts();
      openCtx(e.clientX, e.clientY, [
        { head: list.length > 1 ? list.length + ' selected' : (n.item ? itemName(n.item) : partName(n)) },
        { label: 'Cut', kbd: 'Ctrl+X', run: function () { copyParts(list); removeParts(list, []); } },
        { label: 'Copy', kbd: 'Ctrl+C', run: function () { copyParts(list); } },
        // Pasting goes where you right-click empty canvas.
        { label: 'Paste', kbd: 'Ctrl+V', disabled: true, run: function () {} },
        '-',
        { label: list.length > 1 ? 'Remove these' : 'Remove', kbd: 'Del', run: function () { removeParts(list, selectedLinks()); } }
      ]);
    });
    return el;
  }

  /** Moves a card (and the rest of the selection, if it's in it). */
  function dragCard(el, n, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    closeAll();
    var mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
    var group = selected[n.id] ? selectedParts() : [n];
    var origins = group.map(function (g) { return { x: g.x, y: g.y }; });
    var startX = e.clientX, startY = e.clientY;
    var moved = false;
    // A splitter or merger with nothing joined, dragged on its own, can go
    // into a line: the card lets the pointer through to find it.
    var splicing = group.length === 1 && canSplice(n);
    var target = null;
    function move(ev) {
      var dx = (ev.clientX - startX) / state.view.s;
      var dy = (ev.clientY - startY) / state.view.s;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3 / state.view.s) return;
      if (!moved) {
        moved = true;
        el.classList.add('dragging');
        if (splicing) el.style.pointerEvents = 'none';
      }
      group.forEach(function (g, i) {
        g.x = Math.round(origins[i].x + dx);
        g.y = Math.round(origins[i].y + dy);
        var ge = world.querySelector('.cnode[data-id="' + g.id + '"]');
        if (ge) { ge.style.left = g.x + 'px'; ge.style.top = g.y + 'px'; }
      });
      renderLinks();
      if (splicing) {
        target = linkAt(ev.clientX, ev.clientY);
        markSplice(target);
      }
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      el.style.pointerEvents = '';
      markSplice(null);
      if (moved && target) {
        splice(target, n);
        selectOnly(n.id);
        changed();
        return;
      }
      if (moved) { save(); return; }
      if (mods.ctrl || mods.shift) {
        if (selected[n.id]) delete selected[n.id];
        else selected[n.id] = true;
        applySelection();
      } else {
        selectOnly(n.id);
      }
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /* ---- lines ---- */

  /** Every line between cards: a curve from an output to an input, with its rate. */
  function renderLinks() {
    while (wires.firstChild) wires.removeChild(wires.firstChild);
    labelsEl.innerHTML = '';
    state.custom.links.forEach(function (l) {
      var a = nodeById(l.from), b = nodeById(l.to);
      if (!a || !b) return;
      var p1 = slotAt(a, 'out', l.fk), p2 = slotAt(b, 'in', l.tk);
      var path = wirePath(p1, { x: 1, y: 0 }, p2, { x: -1, y: 0 });
      var f = flow && flow.links[l.id];
      var fluid = f ? f.fluid : false;
      svg('path', { d: path.d, 'class': 'wire cwire' + (fluid ? ' pipe' : ''), 'data-link': l.id });
      if (fluid) svg('path', { d: path.d, 'class': 'wire pipe-core' });
      if (f) {
        var label = document.createElement('div');
        label.className = 'flow-label cflow';
        label.style.left = path.mid.x + 'px';
        label.style.top = path.mid.y + 'px';
        if (f.item) {
          var icon = document.createElement('img');
          icon.className = 'fl-icon';
          icon.src = iconOf(f.item);
          icon.alt = '';
          label.appendChild(icon);
        }
        var bold = document.createElement('b');
        bold.textContent = fmtNum(f.total);
        label.appendChild(bold);
        label.appendChild(document.createTextNode((fluid ? ' m³' : '') + '/min'));
        labelsEl.appendChild(label);
      }
      var hit = svg('path', { d: path.d, 'class': 'belt-hit', 'data-hit': l.id });
      hit.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        closeAll();
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
          if (selected[l.id]) delete selected[l.id];
          else selected[l.id] = true;
          applySelection();
        } else {
          selectOnly(l.id);
        }
      });
      hit.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        closeAll();
        if (!selected[l.id]) selectOnly(l.id);
        openCtx(e.clientX, e.clientY, [
          { head: 'Line' },
          { label: 'Remove', run: function () { removeParts([], selectedLinks()); } }
        ]);
      });
    });
    applySelection();
  }

  /** Whether two slots can be joined: one in and one out, both free, the same item. */
  function fits(f, t) {
    if (!f || !t || f.node === t.node || f.side === t.side) return false;
    if (linkOn(t.node, t.side, t.k)) return false;
    var a = slotItem(f.node, f.side, f.k), b = slotItem(t.node, t.side, t.k);
    return !a || !b || a === b;
  }

  function join(f, t) {
    var out = f.side === 'out' ? f : t, inn = f.side === 'out' ? t : f;
    state.custom.links.push({ id: 'l' + uid(), from: out.node.id, fk: out.k, to: inn.node.id, tk: inn.k });
  }

  /**
   * Drag from an input or output to connect it: onto a matching slot, onto a
   * card (its first free matching slot), or onto empty canvas for a menu of
   * steps that use (or make) the item, placed there and joined up. Pressing
   * a slot that's already joined picks that line's end up.
   */
  function dragFromSlot(n, side, k, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    closeAll();
    var from = { node: n, side: side, k: k };
    var existing = linkOn(n, side, k);
    if (existing) {
      state.custom.links = state.custom.links.filter(function (l) { return l !== existing; });
      from = side === 'out'
        ? { node: nodeById(existing.to), side: 'in', k: existing.tk }
        : { node: nodeById(existing.from), side: 'out', k: existing.fk };
      renderLinks();
    }
    var A = slotAt(from.node, from.side, from.k);
    var preview = svg('path', { d: '', 'class': 'belt-preview' });
    function target(ev) {
      var el = document.elementFromPoint(ev.clientX, ev.clientY);
      var slotEl = el && el.closest && el.closest('.cn-slot');
      if (slotEl) return { node: nodeById(slotEl.dataset.node), side: slotEl.dataset.side, k: Number(slotEl.dataset.k) };
      var card = el && el.closest && el.closest('.cnode');
      if (card) {
        var m = nodeById(card.dataset.id);
        var s = slotsOf(m);
        var list = from.side === 'out' ? s.ins : s.outs;
        for (var j = 0; j < list.length; j++) {
          var t = { node: m, side: from.side === 'out' ? 'in' : 'out', k: j };
          if (fits(from, t)) return t;
        }
      }
      return null;
    }
    function move(ev) {
      var w = toWorld(ev.clientX, ev.clientY);
      var t = target(ev);
      var ok = t && fits(from, t);
      var B = ok ? slotAt(t.node, t.side, t.k) : w;
      var path = from.side === 'out'
        ? wirePath(A, { x: 1, y: 0 }, B, { x: -1, y: 0 })
        : wirePath(B, { x: 1, y: 0 }, A, { x: -1, y: 0 });
      preview.setAttribute('d', path.d);
      preview.classList.toggle('ok', !!ok);
    }
    function up(ev) {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      preview.remove();
      var t = target(ev);
      if (t && fits(from, t)) {
        join(from, t);
        changed();
        return;
      }
      var over = document.elementFromPoint(ev.clientX, ev.clientY);
      if (over && stage.contains(over) && !over.closest('.cnode, .view-opts')) {
        quickAdd(from, toWorld(ev.clientX, ev.clientY), ev.clientX, ev.clientY, !!existing);
        return;
      }
      if (existing) changed();
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /** The menu for a line dropped on empty canvas: what could take (or give) its item. */
  function quickAdd(from, w, cx, cy, dropped) {
    var item = slotItem(from.node, from.side, from.k);
    var items = [{ head: item ? itemName(item) : 'Connect' }];
    function make(kind, recipe, extra) {
      return function () {
        var n = newNode(kind, w.x, w.y);
        if (recipe) { n.type = 'recipe'; n.recipe = recipe; n.item = kind; }
        Object.assign(n, extra || {});
        var size = nodeSize(n);
        // Line the new card's slot up with the drop point.
        if (from.side === 'out') n.x = Math.round(w.x); else n.x = Math.round(w.x - size.w);
        var s = slotsOf(n);
        var list = from.side === 'out' ? s.ins : s.outs;
        var k = Math.max(0, item ? list.indexOf(item) : 0);
        if (k < 0 || k >= list.length) k = 0;
        var at = slotAt(n, from.side === 'out' ? 'in' : 'out', k);
        n.y = Math.round(n.y + (w.y - at.y));
        var t = { node: n, side: from.side === 'out' ? 'in' : 'out', k: k };
        if (fits(from, t)) join(from, t);
        selectOnly(n.id);
        changed();
      };
    }
    if (item) {
      var rids = Object.keys(DATA.recipes).filter(function (rid) {
        var r = DATA.recipes[rid];
        if (!canBuild(rid) || !recipeAllowed(rid)) return false;
        var list = from.side === 'out' ? r.in : r.out;
        return list.some(function (q) { return q[0] === item; });
      }).sort(function (a, b) {
        var ra = DATA.recipes[a], rb = DATA.recipes[b];
        return (ra.alt ? 1 : 0) - (rb.alt ? 1 : 0) || ra.name.localeCompare(rb.name);
      });
      if (from.side === 'in') {
        if (DATA.items[item].raw) items.push({ label: 'Resource node', note: 'Mine or extract it', icon: iconOf(item), run: make(item) });
      }
      rids.forEach(function (rid) {
        var r = DATA.recipes[rid];
        var product = itemName(r.out[0][0]);
        items.push({
          label: from.side === 'out' ? product : r.name,
          note: (from.side === 'out' && r.name !== product ? r.name + ' · ' : '') + machineName(rid) + (r.alt ? ' · alternate' : ''),
          icon: iconOf(r.out[0][0]),
          run: make(from.side === 'out' ? r.out[0][0] : item, rid)
        });
      });
    }
    items.push('-');
    if (item && from.side === 'in') {
      items.push({ label: 'Import', note: 'From outside this save', icon: iconOf(item), run: make(item, null, { type: 'import', rate: 60 }) });
      otherFactories().forEach(function (f) {
        var makes = factoryOutputs(f)[item] || 0;
        if (!(makes > EPS)) return;
        var taken = requestsOf(f.id).filter(function (r) { return r.item === item; }).reduce(function (sum, r) { return sum + r.rate; }, 0);
        var left = Math.max(0, makes - taken);
        items.push({
          label: 'Import from \u201c' + factoryLabel(f) + '\u201d', note: fmtNum(left) + ' of ' + rateText(item, makes) + ' free', icon: iconOf(item),
          run: make(item, null, { type: 'import', rate: Number((left || makes).toFixed(4)), from: f.id })
        });
      });
    }
    if (from.side === 'out') {
      items.push({ label: 'Splitter', note: 'Shares evenly', icon: iconOf('splitter'), run: make('splitter') });
      items.push({ label: 'Smart Splitter', note: 'Top output first, the rest overflow', icon: iconOf('splitter'), run: make('smart') });
    } else {
      items.push({ label: 'Merger', note: 'Joins evenly', icon: iconOf('merger'), run: make('merger') });
      items.push({ label: 'Priority Merger', note: 'Top input first', icon: iconOf('merger'), run: make('priority') });
    }
    openCtx(cx, cy, items);
    if (dropped) changed();
  }

  /* ---- panel: inspector, problems, outputs ---- */

  var inspectorEl = document.getElementById('inspector');
  var problemsEl = document.getElementById('problems');

  function renderCustomPanel() {
    var outEl = document.getElementById('custom-outputs');
    outEl.innerHTML = '';
    Object.keys(flow.outputs).sort().forEach(function (id) {
      outEl.appendChild(row(itemName(id), '', rateText(id, flow.outputs[id])));
    });
    // Other factories importing from this one, and whether it keeps up.
    var asked = requestsOf(currentFactory().id);
    if (asked.length) {
      var sub = document.createElement('p');
      sub.className = 'custom-note sent-head';
      sub.textContent = 'Sent to other factories';
      outEl.appendChild(sub);
      var per = {};
      asked.forEach(function (r) { per[r.item] = (per[r.item] || 0) + r.rate; });
      asked.forEach(function (r) {
        var over = per[r.item] > (flow.outputs[r.item] || 0) * (1 + 1e-3) + 1e-6;
        outEl.appendChild(row(factoryLabel(r.factory), itemName(r.item), rateText(r.item, r.rate), null, over));
      });
    }
    problemsEl.innerHTML = '';
    // One orange box per card, its problems listed inside; pressing it
    // brings the card into view.
    var byPart = {};
    var order = [];
    flow.problems.forEach(function (pr) {
      if (!byPart[pr.part]) { byPart[pr.part] = []; order.push(pr.part); }
      byPart[pr.part].push(pr.text);
    });
    var rows = order.map(function (id) {
      var n = nodeById(id);
      var title = n ? cardTitle(n) : '';
      var box = document.createElement('button');
      box.type = 'button';
      box.className = 'problem-box';
      var head = document.createElement('span');
      head.className = 'problem-head';
      if (n) {
        var icon = document.createElement('img');
        icon.src = iconOf(n.item || (n.type === 'sink' ? 'storage' : n.type));
        icon.alt = '';
        head.appendChild(icon);
      }
      var name = document.createElement('span');
      name.textContent = title || 'Step';
      head.appendChild(name);
      box.appendChild(head);
      byPart[id].forEach(function (text) {
        var line = document.createElement('span');
        line.className = 'problem-line';
        // The box already says which card: drop it from the front.
        line.textContent = title && text.indexOf(title + ': ') === 0 ? titleCase(text.slice(title.length + 2)) : text;
        box.appendChild(line);
      });
      box.addEventListener('click', function () { focusPart(id); });
      return box;
    });
    if (!rows.length && state.custom.nodes.length) {
      var ok = row('No problems', '', '');
      ok.classList.add('quiet');
      rows.push(ok);
    }
    if (rows.length) problemsEl.appendChild(group('Problems', flow.problems.length ? String(flow.problems.length) : '', rows, 'problems'));
    renderInspector();
  }

  /** What a card is called: its item, or what kind of part it is. */
  function cardTitle(n) {
    if (n.item) return itemName(n.item);
    var r = nodeRecipe(n);
    if (r) return itemName(r.out[0][0]);
    return partName(n);
  }

  /**
   * A clock speed, like the game's: the percentage to type on the left, and
   * a long rounded bar filled up to it, with a tall handle and marks at
   * 100%, 150%, 200% and 250%. Dragging updates the figure; letting go (or
   * typing) sets it.
   */
  function clockSlider(k, onSet) {
    var MAX = SOLVER.MAX_CLOCK * 100;
    var wrap = document.createElement('div');
    wrap.className = 'clk';
    var field = document.createElement('label');
    field.className = 'clk-num';
    var num = document.createElement('input');
    num.type = 'number';
    num.min = 1;
    num.max = MAX;
    num.step = 1;
    num.value = Number((k * 100).toFixed(2));
    var pct = document.createElement('span');
    pct.textContent = '%';
    field.appendChild(num);
    field.appendChild(pct);
    wrap.appendChild(field);

    var bar = document.createElement('div');
    bar.className = 'clk-bar';
    var range = document.createElement('input');
    range.type = 'range';
    range.className = 'clk-range';
    range.min = 1;
    range.max = MAX;
    range.step = 1;
    range.value = Math.round(k * 100);
    bar.appendChild(range);
    // Where a value sits along the bar: the handle's centre travels between
    // half its width in from each end.
    function at(v) { return 'calc(5px + ' + ((v - 1) / (MAX - 1)) + ' * (100% - 10px))'; }
    var marks = [100, 150, 200, 250].filter(function (v) { return v <= MAX; });
    var labels = [];
    // The marks are drawn into the bar itself, so the handle covers them.
    var ticks = marks.filter(function (v) { return v < MAX; }).map(function (v) {
      var x = at(v);
      return 'linear-gradient(to right, transparent calc(' + x + ' - 1px), rgba(0, 0, 0, .5) calc(' + x + ' - 1px), ' +
        'rgba(0, 0, 0, .5) calc(' + x + ' + 1px), transparent calc(' + x + ' + 1px))';
    }).join(', ');
    var scale = document.createElement('div');
    scale.className = 'clk-scale';
    [1].concat(marks).forEach(function (v) {
      var l = document.createElement('button');
      l.type = 'button';
      l.textContent = (v === 1 ? 0 : v) + '%';
      l.style.left = at(v);
      // Pressing a mark snaps to it (0% is as low as the game goes: 1%).
      l.addEventListener('click', function () {
        range.value = v;
        num.value = v;
        paint(v);
        onSet(v / 100);
      });
      scale.appendChild(l);
      labels.push({ el: l, v: v });
    });
    bar.appendChild(scale);
    wrap.appendChild(bar);

    function paint(v) {
      bar.style.setProperty('--fill', at(v));
      bar.style.setProperty('--ticks', ticks);
      labels.forEach(function (l) { l.el.classList.toggle('on', l.v <= v); });
    }
    paint(Number(range.value));
    range.addEventListener('input', function () { num.value = range.value; paint(Number(range.value)); });
    range.addEventListener('change', function () { onSet(clamp(Number(range.value) / 100, 0.01, SOLVER.MAX_CLOCK)); });
    num.addEventListener('change', function () {
      var v = clamp(Number(num.value) || 100, 1, MAX);
      onSet(v / 100);
    });
    return wrap;
  }

  /** The selected card's settings and rates. */
  function renderInspector() {
    inspectorEl.innerHTML = '';
    if (state.build !== 'custom' || !flow) return;
    var sel = selectedParts();
    if (sel.length !== 1) return;
    var n = sel[0];
    var st = flow.nodes[n.id] || { ins: [], outs: [] };
    var box = document.createElement('div');
    box.className = 'sum-group inspector';
    var head = document.createElement('div');
    head.className = 'sum-group-head insp-head';
    var img = document.createElement('img');
    img.className = 'insp-icon';
    img.alt = '';
    img.src = iconOf(n.item || (n.type === 'sink' ? 'storage' : n.type));
    var title = document.createElement('span');
    title.className = 'sum-group-name';
    title.textContent = n.item ? itemName(n.item) : partName(n);
    head.appendChild(img);
    head.appendChild(title);
    box.appendChild(head);

    function field(label, control) {
      var wrap = document.createElement('label');
      wrap.className = 'insp-field';
      var l = document.createElement('span');
      l.className = 'insp-label';
      l.textContent = label;
      wrap.appendChild(l);
      wrap.appendChild(control);
      box.appendChild(wrap);
    }
    // A button showing the current choice, opening the app's own menu of
    // the rest (with icons and a second line where they help).
    function select(options, value, onPick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'insp-drop';
      var cur = options.filter(function (o) { return o.value === value; })[0] || options[0];
      if (cur && cur.icon) {
        var ic = document.createElement('img');
        ic.src = cur.icon;
        ic.alt = '';
        b.appendChild(ic);
      }
      var t = document.createElement('span');
      t.className = 'insp-drop-text';
      t.textContent = cur ? (cur.short || cur.label) : '';
      b.appendChild(t);
      if (cur && cur.tag) {
        var tg = document.createElement('span');
        tg.className = 'insp-drop-tag';
        tg.textContent = cur.tag;
        b.appendChild(tg);
      }
      var chev = document.createElement('span');
      chev.className = 'insp-drop-chev';
      chev.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      b.appendChild(chev);
      b.addEventListener('click', function () {
        var r = b.getBoundingClientRect();
        openCtx(r.left, r.bottom + 4, options.map(function (o) {
          return { label: o.label, note: o.note, icon: o.icon, tag: o.tag, on: o.value === value, run: function () { onPick(o.value); } };
        }), false, r.width);
      });
      return b;
    }
    function number(value, min, step, onSet) {
      var i = document.createElement('input');
      i.type = 'number';
      i.className = 'insp-number';
      i.min = min;
      i.step = step;
      i.value = value;
      i.addEventListener('change', function () { onSet(Number(i.value)); });
      return i;
    }
    function note(text) {
      var p = document.createElement('p');
      p.className = 'insp-note';
      p.textContent = text;
      box.appendChild(p);
    }

    if (n.type === 'recipe') {
      var r = nodeRecipe(n);
      var rids = (producersOf[n.item] || []).filter(function (rid) {
        return (canBuild(rid) && recipeAllowed(rid)) || rid === n.recipe;
      });
      field('Recipe', select(rids.map(function (rid) {
        var q = DATA.recipes[rid];
        var per = SOLVER.perMinute(q);
        var side = function (list) {
          return list.map(function (x) { return fmtNum(Math.abs(per[x[0]])) + ' ' + itemName(x[0]); }).join(' + ');
        };
        return {
          value: rid, label: q.name, tag: q.alt ? 'ALT' : '', icon: iconOf(q.machine),
          note: machineName(rid) + ' · ' + side(q.in) + ' → ' + side(q.out)
        };
      }), n.recipe, function (v) {
        // Lines on slots the new recipe doesn't have come off.
        n.recipe = v;
        var s = slotsOf(n);
        state.custom.links = state.custom.links.filter(function (l) {
          if (l.to === n.id) return l.tk < s.ins.length && s.ins[l.tk] === slotItem(nodeById(l.from), 'out', l.fk);
          if (l.from === n.id) return l.fk < s.outs.length;
          return true;
        });
        changed();
      }));
      // Auto, or Set: a count, or a rate of the item it's for.
      var seg = document.createElement('div');
      seg.className = 'seg insp-seg';
      ['auto', 'set'].forEach(function (mode) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'seg-btn' + ((mode === 'set') === !!n.set ? ' on' : '');
        b.textContent = mode === 'auto' ? 'Auto' : 'Set';
        b.addEventListener('click', function () {
          if (mode === 'set' && !n.set) { n.set = true; n.count = Number((st.count || 1).toFixed(4)) || 1; }
          else if (mode === 'auto') { n.set = false; delete n.count; }
          changed();
        });
        seg.appendChild(b);
      });
      field('Production', seg);
      if (n.set && r) {
        // One setting, shown two ways: typing either side updates the other
        // as you go, and the step takes it when you leave the field.
        var per = (SOLVER.perMinute(r)[n.item] || SOLVER.perMinute(r)[r.out[0][0]]) * (1 + sloopsOf(n).boost);
        var pair = document.createElement('div');
        pair.className = 'insp-pair';
        var cells = [
          { value: n.count || 0, step: 0.01, unit: 'machines', toCount: function (v) { return v; } },
          { value: (n.count || 0) * per, step: 0.1, unit: itemName(n.item) + '/min', icon: iconOf(n.item), toCount: function (v) { return v / per; } }
        ];
        var inputs = [];
        cells.forEach(function (c, i) {
          if (i) {
            var eq = document.createElement('span');
            eq.className = 'ip-eq';
            eq.textContent = '=';
            pair.appendChild(eq);
          }
          var cell = document.createElement('label');
          cell.className = 'ip-cell';
          var inp = document.createElement('input');
          inp.type = 'number';
          inp.min = 0;
          inp.step = c.step;
          inp.value = Number(c.value.toFixed(4));
          cell.appendChild(inp);
          var unit = document.createElement('span');
          unit.className = 'ip-unit';
          if (c.icon) {
            var ui = document.createElement('img');
            ui.src = c.icon;
            ui.alt = '';
            unit.appendChild(ui);
          }
          unit.appendChild(document.createTextNode(c.unit));
          cell.appendChild(unit);
          pair.appendChild(cell);
          inputs.push(inp);
          inp.addEventListener('input', function () {
            var count = Math.max(0, c.toCount(Number(inp.value) || 0));
            var other = inputs[1 - i];
            other.value = Number((i ? count : count * per).toFixed(4));
            pair.classList.add('live');
          });
          inp.addEventListener('change', function () {
            n.count = Math.max(0, c.toCount(Number(inp.value) || 0));
            changed();
          });
        });
        box.appendChild(pair);
      }
      if (r) {
        // Its own clock speed (Custom), or the Speed setting's (Auto).
        var cseg = document.createElement('div');
        cseg.className = 'seg insp-seg';
        [['auto', 'Auto'], ['own', 'Custom']].forEach(function (o) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'seg-btn' + ((o[0] === 'own') === !!n.clock ? ' on' : '');
          b.textContent = o[1];
          b.addEventListener('click', function () {
            if (o[0] === 'own' && !n.clock) n.clock = 1;
            else if (o[0] === 'auto') delete n.clock;
            else return;
            changed();
          });
          cseg.appendChild(b);
        });
        field('Clock speed', cseg);
        if (n.clock) {
          box.appendChild(clockSlider(n.clock, function (k) { n.clock = k; changed(); }));
        }
        // Somersloops in each machine, as many as the building has slots for.
        var slots = DATA.machines[r.machine].sloops || 0;
        if (slots) {
          var sseg = document.createElement('div');
          sseg.className = 'seg insp-seg';
          for (var sv = 0; sv <= slots; sv++) {
            (function (v) {
              var b = document.createElement('button');
              b.type = 'button';
              b.className = 'seg-btn' + ((n.sloops || 0) === v ? ' on' : '');
              b.textContent = v ? String(v) : 'None';
              b.addEventListener('click', function () {
                if (v) n.sloops = v; else delete n.sloops;
                changed();
              });
              sseg.appendChild(b);
            })(sv);
          }
          field('Somersloops', sseg);
          var sl = sloopsOf(n);
          if (sl.used) {
            var hint = document.createElement('p');
            hint.className = 'insp-hint';
            hint.textContent = '+' + Math.round(sl.boost * 100) + '% output, ' + fmtNum(sl.power) + '× power, in each machine';
            box.appendChild(hint);
          }
        }
        r.in.forEach(function (q, k) {
          var wantIn = Math.abs(SOLVER.perMinute(r)[q[0]]) * (st.count || 0);
          box.appendChild(row(itemName(q[0]), 'in', fmtNum(st.ins[k] || 0) + ' of ' + rateText(q[0], wantIn), null, (st.ins[k] || 0) < wantIn - 1e-6));
        });
        r.out.forEach(function (q, k) {
          box.appendChild(row(itemName(q[0]), 'out', rateText(q[0], st.outs[k] || 0)));
        });
      }
    } else if (n.type === 'resource') {
      if (!isFluid(n.item)) {
        field('Miner', select(MINERS.filter(function (m) { return DATA.extractors[m] && (hasBuilding(m) || m === n.miner); }).map(function (m) {
          return { value: m, label: DATA.extractors[m].name, icon: iconOf(m) };
        }), extractorOf(n), function (v) { n.miner = v; state.defaultMiner = v; changed(); }));
      }
      if (n.item !== 'Desc_Water_C') {
        field('Purity', select(SOLVER.PURITIES.map(function (q) { return { value: q, label: titleCase(q) }; }),
          n.purity || 'normal', function (v) { n.purity = v; changed(); }));
      }
      field(n.item === 'Desc_Water_C' ? 'Extractors' : 'Nodes', number(n.count || 1, 1, 1, function (v) {
        n.count = Math.max(1, Math.round(v || 1));
        changed();
      }));
      field('Clock speed', document.createElement('span'));
      box.appendChild(clockSlider(n.clock || 1, function (k) { n.clock = k; changed(); }));
      note('Gives ' + fmtNum(st.run || 0) + ' of ' + rateText(n.item, resourceCap(n)) +
        (shardsFor(n.clock || 1) ? ' · ' + shardsFor(n.clock || 1) * (n.count || 1) + ' Power Shards' : ''));
    } else if (n.type === 'import') {
      var sources = [{ value: '', label: 'Elsewhere', note: 'A train, truck or drone from outside this save' }];
      otherFactories().forEach(function (f) {
        var makes = factoryOutputs(f)[n.item] || 0;
        if (makes > EPS || f.id === n.from) {
          sources.push({ value: f.id, label: factoryLabel(f), note: 'Makes ' + rateText(n.item, makes) });
        }
      });
      if (n.from && !factoryById(n.from)) sources.push({ value: n.from, label: 'A deleted factory', note: '' });
      field('From', select(sources, n.from || '', function (v) {
        if (v) n.from = v; else delete n.from;
        changed();
      }));
      field(itemName(n.item) + '/min', number(n.rate || 0, 0, 1, function (v) { n.rate = Math.max(0, v || 0); changed(); }));
    } else {
      note(n.type === 'splitter' && n.priority ? 'Its top output takes all it can; what it can’t take is shared by the others, as the game’s Overflow setting does.'
        : n.type === 'splitter' ? 'Shares what comes in evenly across its outputs; anything a branch can’t take goes to the others.'
        : n.type === 'merger' && n.priority ? 'Joins up to three lines into one, its top input first: when the line out is full, the others back up.'
        : n.type === 'merger' ? 'Joins up to three lines into one.'
        : 'Collects whatever reaches it. From a splitter, it only takes what the other branches leave.');
    }
    inspectorEl.appendChild(box);
  }

  /* ---- the model's plan, and rebuilding the model ---- */

  /**
   * The model as a plan, written to state.targets, supply, imports and
   * recipes: what the Item and Machine views draw, and what Optimize and
   * Build aim for. Outputs are the surplus of what the steps are for;
   * resource nodes and imports are the inputs; each item's recipes, the
   * recipe picks.
   */
  function syncPlan(f) {
    f = f || customFlow();
    // What the steps make, less what they use, at the counts they're sized
    // for (not what a short supply lets through, or a rebuild would aim
    // lower each time). A surplus of an item some step is for is an output;
    // one only made on the side is spare.
    var net = {}, mainOf = {};
    state.custom.nodes.forEach(function (n) {
      var r = nodeRecipe(n);
      var st = f.nodes[n.id];
      if (!r || !st) return;
      mainOf[r.out[0][0]] = true;
      var per = SOLVER.perMinute(r);
      var boost = 1 + sloopsOf(n).boost;
      Object.keys(per).forEach(function (id) { net[id] = (net[id] || 0) + per[id] * (per[id] > 0 ? boost : 1) * st.count; });
    });
    var byItem = {};
    Object.keys(net).forEach(function (id) {
      if (mainOf[id] && net[id] > 1e-4) byItem[id] = net[id];
    });
    var supply = {}, imports = {}, mixes = {};
    state.custom.nodes.forEach(function (n) {
      if (n.type === 'resource' && n.item !== 'Desc_Water_C') {
        var sp = supply[n.item] || (supply[n.item] = { nodes: [] });
        for (var i = 0; i < (n.count || 1); i++) {
          var node = { purity: n.purity || 'normal' };
          if (!isFluid(n.item)) node.miner = extractorOf(n);
          sp.nodes.push(node);
        }
      }
      if (n.type === 'import') imports[n.item] = true;
      var r = nodeRecipe(n);
      if (r) {
        var main = r.out[0][0];
        var m = mixes[main] || (mixes[main] = {});
        m[n.recipe] = (m[n.recipe] || 0) + Math.max(0.0001, (f.nodes[n.id] && f.nodes[n.id].count) || 1);
      }
    });
    var recipes = {};
    Object.keys(mixes).forEach(function (id) {
      var rids = Object.keys(mixes[id]);
      recipes[id] = rids.length === 1 ? rids[0] : mixes[id];
    });
    // A recipe whose steps all share a clock of their own keeps it in the views.
    var clocks = {};
    state.custom.nodes.forEach(function (n) {
      if (!nodeRecipe(n)) return;
      var k = n.clock || 0;
      clocks[n.recipe] = clocks[n.recipe] == null ? k : clocks[n.recipe] === k ? k : 0;
    });
    state.clockOf = {};
    Object.keys(clocks).forEach(function (rid) { if (clocks[rid]) state.clockOf[rid] = clocks[rid]; });
    // Somersloops, averaged over each recipe's steps by how much they run.
    var boosts = {};
    state.custom.nodes.forEach(function (n) {
      var st = f.nodes[n.id];
      if (!nodeRecipe(n) || !st) return;
      var sl = sloopsOf(n);
      var b = boosts[n.recipe] || (boosts[n.recipe] = { count: 0, out: 0, power: 0 });
      b.count += st.count;
      b.out += st.count * (1 + sl.boost);
      b.power += st.count * sl.power;
    });
    state.boostOf = {};
    Object.keys(boosts).forEach(function (rid) {
      var b = boosts[rid];
      if (b.count > 0 && b.out > b.count * (1 + 1e-9)) state.boostOf[rid] = { out: b.out / b.count, power: b.power / b.count };
    });
    state.targets = Object.keys(byItem).sort().map(function (id) { return { item: id, rate: Number(byItem[id].toFixed(4)) }; });
    state.supply = supply;
    state.imports = imports;
    state.recipes = recipes;
  }

  /**
   * Everything a rebuild depends on, as one string: the outputs, what's
   * brought in, the recipes in use (with I pick), and the recipe settings.
   * When it matches the one saved at the last rebuild, the model is as
   * Optimize (or Build) left it.
   */
  function planKey() {
    var optimising = state.picker === 'optimise';
    return JSON.stringify({
      t: state.targets.map(function (t) { return t.item + '@' + Number(t.rate.toPrecision(4)); }),
      i: Object.keys(state.imports).sort(),
      r: optimising ? null : state.recipes,
      p: state.picker,
      g: optimising ? state.goal : null,
      a: optimising ? state.unlocked.slice().sort() : null,
      u: state.unavailable.slice().sort()
    });
  }

  /**
   * Rebuilds the model's machines for its outputs: the optimiser's pick of
   * recipes (Optimise), or the ones already in the model and the standard
   * ones for the rest (I pick). Resource nodes are added as needed, at the
   * purity and miner the model already uses for that resource. Returns
   * false when there's nothing to aim for.
   */
  function buildModel() {
    if (state.custom.nodes.length) syncPlan();
    if (!state.targets.length) return false;
    var targets = state.targets.map(function (t) { return { item: t.item, rate: t.rate }; });
    // Clocks set on steps stay with their recipes.
    var clockWas = {}, sloopsWas = {};
    state.custom.nodes.forEach(function (n) {
      if (nodeRecipe(n) && n.clock) clockWas[n.recipe] = n.clock;
      if (nodeRecipe(n) && n.sloops) sloopsWas[n.recipe] = n.sloops;
    });
    // How the model mines each resource, kept for the new nodes.
    var how = {};
    state.custom.nodes.forEach(function (n) {
      if (n.type === 'resource' && !how[n.item]) how[n.item] = { purity: n.purity || 'normal', miner: n.miner, clock: n.clock || 1 };
    });
    // An old plan's resource settings count too.
    Object.keys(state.supply).forEach(function (id) {
      var sp = state.supply[id];
      if (!how[id] && sp && sp.nodes && sp.nodes.length) how[id] = { purity: sp.nodes[0].purity, miner: sp.nodes[0].miner || sp.miner, clock: 1 };
    });
    // Resources aren't capped: the new model gets the nodes it needs.
    state.supply = {};
    var built = buildablePlan(state.picker !== 'optimise');
    var plan = { targets: targets, recipes: built.recipes, imports: built.imports, caps: {} };
    solved = null;
    if (state.picker === 'optimise') {
      plan.pins = {};
      solved = OPTIMISE.solveOptimised(DATA, plan, { goal: state.goal, allowed: recipeAllowed, built: canBuild });
    }
    if (!solved) {
      plan.recipes = buildablePlan(true).recipes;
      solved = SOLVER.solve(DATA, plan);
    }
    autoToCustom();
    // Each resource's card mines the way the model did, with as many nodes
    // as the new plan takes.
    state.custom.nodes.forEach(function (n) {
      if (n.type !== 'resource') return;
      if (how[n.item]) {
        n.purity = how[n.item].purity;
        if (how[n.item].miner && !isFluid(n.item)) n.miner = how[n.item].miner;
        n.clock = how[n.item].clock;
      }
      var e = solved.items[n.item];
      var one = resourceCap(Object.assign({}, n, { count: 1 }));
      if (e && one > 0) n.count = Math.max(1, Math.ceil(e.supplied / one - 1e-6));
    });
    state.custom.nodes.forEach(function (n) {
      if (nodeRecipe(n) && clockWas[n.recipe]) n.clock = clockWas[n.recipe];
      if (nodeRecipe(n) && sloopsWas[n.recipe]) n.sloops = sloopsWas[n.recipe];
    });
    state.pins = {};
    keyAfterRender = true;
    return true;
  }

  // Set by buildModel: the next Model redraw records the new planKey.
  var keyAfterRender = false;

  var runBtn = document.getElementById('opt-run');
  var runNeed = document.getElementById('opt-need');

  /** "Optimize", "Optimized" or "Reoptimize" (Build, Built, Rebuild with I pick). */
  function refreshRunButton() {
    var optimising = state.picker === 'optimise';
    var none = !state.targets.length;
    var key = none ? null : planKey();
    var fresh = !!key && state.optKey === key;
    var again = !!state.optKey && !fresh;
    runBtn.textContent = optimising
      ? (fresh ? 'Optimized' : again ? 'Reoptimize' : 'Optimize')
      : (fresh ? 'Built' : again ? 'Rebuild' : 'Build');
    runBtn.classList.toggle('done', fresh);
    // With I pick there's nothing to press until an output or recipe changes.
    runBtn.hidden = !optimising && fresh;
    runBtn.disabled = none;
    runNeed.hidden = !none;
    runNeed.textContent = 'You need an output in order to ' + (optimising ? 'optimize.' : 'build.');
  }

  runBtn.addEventListener('click', function () {
    if (!state.targets.length) return;
    var optimising = state.picker === 'optimise';
    var go = function () {
      if (!buildModel()) return;
      clearSelection();
      changed();
      fitView();
    };
    if (!state.custom.nodes.length) { go(); return; }
    askConfirm(runBtn, go, false, {
      q: (optimising ? 'Optimize' : 'Rebuild') + ' your model? It keeps your outputs and replaces the machines in between.',
      yes: optimising ? 'Optimize' : 'Rebuild',
      no: 'Cancel'
    });
  });

  /**
   * A new output: in an empty model, its whole chain is built straight
   * away; otherwise its step is placed to the right of everything, set to
   * make the usual starting rate, for Optimize (or you) to feed.
   */
  function addModelOutput(id) {
    if (!state.custom.nodes.length) {
      state.targets = [{ item: id, rate: NEW_TARGET_RATE }];
      state.imports = {};
      state.recipes = {};
      if (buildModel()) {
        changed();
        fitView();
      }
      return;
    }
    var right = -Infinity, top = Infinity;
    customBoxes().forEach(function (b) { right = Math.max(right, b.x + b.w); top = Math.min(top, b.y); });
    var n = newNode(id, 0, 0);
    n.x = Math.round(right + 140);
    n.y = Math.round(top);
    var r = nodeRecipe(n);
    if (r) {
      var per = SOLVER.perMinute(r)[r.out[0][0]] || 1;
      n.set = true;
      n.count = NEW_TARGET_RATE / per;
    }
    selectOnly(n.id);
    changed();
  }

  /**
   * The solved plan as cards: resources and imports on the left, one card per
   * step (Set to the plan's count) in columns by how far it is from the raw
   * resources, Storage for the outputs and spares. Lines pair producers with
   * consumers, through splitters and mergers where one feeds several.
   */
  function autoToCustom() {
    if (!solved || solved.custom) return;
    var nodes = [], links = [];
    var planned = {};  // card id -> the count the plan gives it
    function node(obj) { obj.id = 'n' + uid(); obj.x = 0; obj.y = 0; nodes.push(obj); return obj; }
    var prod = {}, cons = {};
    function give(item, n, k, rate) { (prod[item] = prod[item] || []).push({ n: n, k: k, rate: rate }); }
    function take(item, n, k, rate) { (cons[item] = cons[item] || []).push({ n: n, k: k, rate: rate }); }
    var cols = {};
    function place(col, n) { (cols[col] = cols[col] || []).push(n); }

    // Resources, grouped by purity and miner; and what's brought in.
    Object.keys(solved.items).forEach(function (id) {
      var e = solved.items[id];
      if (!(e.supplied > EPS)) return;
      if (DATA.items[id].raw && supplyInfo(id)) {
        var info = supplyInfo(id);
        var groups = {};
        if (info.nodeList.length) {
          info.nodeList.forEach(function (nd) {
            var key = nd.purity + '|' + nd.extractor;
            (groups[key] = groups[key] || { purity: nd.purity, extractor: nd.extractor, count: 0, cap: 0 });
            groups[key].count++;
            groups[key].cap += nd.rate;
          });
        } else {
          var per = info.perNode('normal');
          var cnt = Math.max(1, Math.ceil(e.supplied / per - 1e-6));
          groups.any = { purity: 'normal', extractor: info.extractor, count: cnt, cap: per * cnt };
        }
        var capAll = Object.keys(groups).reduce(function (s, k) { return s + groups[k].cap; }, 0);
        Object.keys(groups).forEach(function (k) {
          var g = groups[k];
          var n = node({ type: 'resource', item: id, purity: g.purity, count: g.count, clock: 1 });
          if (!isFluid(id)) n.miner = g.extractor;
          give(id, n, 0, e.supplied * g.cap / capAll);
          place(0, n);
        });
      } else {
        var im = node({ type: 'import', item: id, rate: e.supplied });
        give(id, im, 0, e.supplied);
        place(0, im);
      }
    });
    // Steps, by how far they are from the raw resources. The optimiser can
    // leave recipes in at a thousandth of a machine or less; they aren't steps.
    var used = Object.keys(solved.recipes).filter(function (rid) { return solved.recipes[rid].count > 1e-3; });
    var madeBy = {};
    used.forEach(function (rid) {
      DATA.recipes[rid].out.forEach(function (o) { (madeBy[o[0]] = madeBy[o[0]] || []).push(rid); });
    });
    var depth = {};
    function stepDepth(rid, guard) {
      if (depth[rid] != null) return depth[rid];
      if (guard[rid]) return 1;
      guard[rid] = true;
      var d = 1;
      DATA.recipes[rid].in.forEach(function (q) {
        (madeBy[q[0]] || []).forEach(function (other) { if (other !== rid) d = Math.max(d, stepDepth(other, guard) + 1); });
      });
      depth[rid] = d;
      return d;
    }
    var last = 1;
    used.forEach(function (rid) {
      var r = DATA.recipes[rid];
      var count = solved.recipes[rid].count;
      // Only the steps making an output are Set; the rest size themselves
      // (Auto) to what those ask for.
      var item = solved.recipes[rid].item;
      var n = node(solved.targets[item] > EPS
        ? { type: 'recipe', recipe: rid, item: item, set: true, count: count }
        : { type: 'recipe', recipe: rid, item: item });
      planned[n.id] = count;
      var col = stepDepth(rid, {});
      last = Math.max(last, col);
      place(col, n);
      var per = SOLVER.perMinute(r);
      r.in.forEach(function (q, k) { take(q[0], n, k, -per[q[0]] * count); });
      r.out.forEach(function (q, k) { if (per[q[0]] > 0) give(q[0], n, k, per[q[0]] * count); });
    });
    // Outputs and spares into Storage.
    var end = last + 1;
    function collect(id, rate) {
      var s = node({ type: 'sink' });
      take(id, s, 0, rate);
      place(end, s);
    }
    Object.keys(solved.targets).forEach(function (id) { if (solved.targets[id] > EPS) collect(id, solved.targets[id]); });
    // A spare byproduct nothing else uses stays at its output; one that
    // shares a line with a user needs Storage to take the rest.
    Object.keys(solved.items).forEach(function (id) {
      if (solved.items[id].surplus > EPS && cons[id] && cons[id].length) collect(id, solved.items[id].surplus);
    });

    // Lines, first as pairs of producer and consumer for each item: which
    // cards are joined decides where they go.
    var plans = [];
    Object.keys(prod).forEach(function (item) {
      var P = prod[item], C = cons[item] || [];
      if (!C.length) return;
      var pairs = [];
      var pi = 0, ci = 0, pl = P[0].rate, cl = C[0].rate;
      // What's left under a ten-thousandth of a rate is rounding, not a
      // share of its own (the optimiser's figures are seldom exact).
      function spent(left, all) { return left <= Math.max(1e-6, all * 1e-4); }
      var paired = {};
      while (pi < P.length && ci < C.length) {
        var q = Math.min(pl, cl);
        pairs.push({ p: P[pi], c: C[ci] });
        paired[ci] = true;
        pl -= q; cl -= q;
        if (spent(pl, P[pi].rate)) { pi++; pl = P[pi] ? P[pi].rate : 0; }
        if (spent(cl, C[ci].rate)) { ci++; cl = C[ci] ? C[ci].rate : 0; }
      }
      // Anything still wanting some takes it from the last producer.
      for (; ci < C.length; ci++) if (!paired[ci]) pairs.push({ p: P[P.length - 1], c: C[ci] });
      plans.push({ item: item, pairs: pairs });
    });

    // Who feeds whom, card to card.
    var outTo = new Map(), inFrom = new Map();
    function note(map, a, b) { if (!map.has(a)) map.set(a, []); if (map.get(a).indexOf(b) < 0) map.get(a).push(b); }
    plans.forEach(function (pl) {
      pl.pairs.forEach(function (pr) { note(outTo, pr.p.n, pr.c.n); note(inFrom, pr.c.n, pr.p.n); });
    });

    // Columns: every card as far right as the cards it feeds allow, so a
    // line reaches the next column wherever it can; Storage last.
    var colOf = new Map();
    Object.keys(cols).forEach(function (c) { cols[c].forEach(function (n) { colOf.set(n, Number(c)); }); });
    for (var sweep = 0; sweep < nodes.length + 2; sweep++) {
      var shifted = false;
      nodes.forEach(function (n) {
        if (n.type === 'sink') return;
        var outs = outTo.get(n) || [];
        if (!outs.length) return;
        var lim = Math.min.apply(null, outs.map(function (m) { return colOf.get(m); })) - 1;
        if (lim > colOf.get(n)) { colOf.set(n, lim); shifted = true; }
      });
      if (!shifted) break;
    }
    var colNums = [];
    nodes.forEach(function (n) { if (colOf.has(n) && colNums.indexOf(colOf.get(n)) < 0) colNums.push(colOf.get(n)); });
    colNums.sort(function (a, b) { return a - b; });
    var columns = colNums.map(function (c) { return nodes.filter(function (n) { return colOf.get(n) === c; }); });
    columns.forEach(function (list, i) { list.forEach(function (n) { colOf.set(n, i); }); });

    // Order within each column: by where its neighbours sit (a few sweeps
    // each way), which untangles most crossings.
    function rank(n) { var list = columns[colOf.get(n)]; return (list.indexOf(n) + 0.5) / list.length; }
    function sortBy(list, near) {
      var key = new Map();
      list.forEach(function (n, i) {
        var ns = near(n);
        key.set(n, ns.length ? ns.reduce(function (s, m) { return s + rank(m); }, 0) / ns.length : (i + 0.5) / list.length);
      });
      list.sort(function (a, b) { return key.get(a) - key.get(b); });
    }
    for (var it = 0; it < 4; it++) {
      for (var cf = 1; cf < columns.length; cf++) {
        sortBy(columns[cf], function (n) { return (inFrom.get(n) || []).filter(function (m) { return colOf.get(m) < cf; }); });
      }
      for (var cb = columns.length - 2; cb >= 0; cb--) {
        sortBy(columns[cb], function (n) { return (outTo.get(n) || []).filter(function (m) { return colOf.get(m) > cb; }); });
      }
    }

    // Room between columns for the splitters and mergers each gap holds.
    function chainLength(k) { return k <= 1 ? 0 : 1 + Math.ceil(Math.max(0, k - 3) / 2); }
    var splitOut = new Map(), mergeIn = new Map();  // "card|slot" -> how many lines
    plans.forEach(function (pl) {
      pl.pairs.forEach(function (pr) {
        var a = pr.p.n.id + '|' + pr.p.k, b = pr.c.n.id + '|' + pr.c.k;
        splitOut.set(a, (splitOut.get(a) || 0) + 1);
        mergeIn.set(b, (mergeIn.get(b) || 0) + 1);
      });
    });
    var lanesAfter = columns.map(function () { return 0; });
    var lanesBefore = columns.map(function () { return 0; });
    splitOut.forEach(function (k, key) {
      var n = nodes.filter(function (m) { return m.id === key.split('|')[0]; })[0];
      lanesAfter[colOf.get(n)] = Math.max(lanesAfter[colOf.get(n)], chainLength(k));
    });
    mergeIn.forEach(function (k, key) {
      var n = nodes.filter(function (m) { return m.id === key.split('|')[0]; })[0];
      lanesBefore[colOf.get(n)] = Math.max(lanesBefore[colOf.get(n)], chainLength(k));
    });
    var LANE = 100, GAP_X = 150, GAP_Y = 70;
    var x = 0;
    columns.forEach(function (list, c) {
      var wMax = 0;
      list.forEach(function (n) { n.x = x; wMax = Math.max(wMax, nodeSize(n).w); });
      var lanes = lanesAfter[c] + (c + 1 < columns.length ? lanesBefore[c + 1] : 0);
      x += wMax + GAP_X + lanes * LANE;
    });

    // Heights: each card level with the middle of what it's joined to, kept
    // in its column's order without overlapping; a few passes each way.
    function mid(n) { return n.y + nodeSize(n).h / 2; }
    columns.forEach(function (list) {
      var y = 0;
      list.forEach(function (n) { n.y = y; y += nodeSize(n).h + GAP_Y; });
      list.forEach(function (n) { n.y -= y / 2; });
    });
    function settle(list, near) {
      var want = list.map(function (n) {
        var ns = near(n);
        var centre = ns.length ? ns.reduce(function (s, m) { return s + mid(m); }, 0) / ns.length : mid(n);
        return centre - nodeSize(n).h / 2;
      });
      var bottom = -Infinity;
      list.forEach(function (n, i) {
        n.y = Math.max(want[i], bottom + GAP_Y);
        bottom = n.y + nodeSize(n).h;
      });
      // Pushing down drifts the column; move it back by the average drift.
      var drift = list.reduce(function (s, n, i) { return s + (n.y - want[i]); }, 0) / (list.length || 1);
      list.forEach(function (n) { n.y = Math.round(n.y - drift); });
    }
    for (var pass = 0; pass < 3; pass++) {
      for (var c1 = 1; c1 < columns.length; c1++) {
        settle(columns[c1], function (n) { return (inFrom.get(n) || []).filter(function (m) { return colOf.get(m) < c1; }); });
      }
      for (var c2 = columns.length - 2; c2 >= 0; c2--) {
        settle(columns[c2], function (n) { return (outTo.get(n) || []).filter(function (m) { return colOf.get(m) > c2; }); });
      }
    }

    // Now the lines, with a chain of splitters (or mergers) where one card
    // pairs with several: splitters just past the producer, mergers just
    // before the consumer, each branch in the order its far end sits.
    var LOGI_H = nodeSize({ type: 'splitter' }).h;
    var LOGI_W = nodeSize({ type: 'splitter' }).w;
    plans.forEach(function (pl) {
      var pairs = pl.pairs;
      var from = [], to = [];
      var byP = new Map(), byC = new Map();
      pairs.forEach(function (pr, i) {
        if (!byP.has(pr.p)) byP.set(pr.p, []);
        byP.get(pr.p).push(i);
        if (!byC.has(pr.c)) byC.set(pr.c, []);
        byC.get(pr.c).push(i);
      });
      byP.forEach(function (list, end) {
        if (list.length === 1) { from[list[0]] = { n: end.n, k: end.k }; return; }
        var at = slotAt(end.n, 'out', end.k);
        var feed = { n: end.n, k: end.k };
        var left = list.slice().sort(function (a, b) { return slotAt(pairs[a].c.n, 'in', pairs[a].c.k).y - slotAt(pairs[b].c.n, 'in', pairs[b].c.k).y; });
        var step = 0;
        var sy = at.y - LOGI_H / 2;
        while (left.length) {
          var sp = node({ type: 'splitter' });
          sp.x = Math.round(at.x + 48 + step * LANE);
          sp.y = Math.round(sy);
          sy += LOGI_H * (2.5 / 3) - LOGI_H / 2;  // the next hangs off this one's bottom output
          step++;
          links.push({ id: 'l' + uid(), from: feed.n.id, fk: feed.k, to: sp.id, tk: 0 });
          var room = left.length <= 3 ? left.length : 2;
          for (var t = 0; t < room; t++) from[left.shift()] = { n: sp, k: t };
          feed = { n: sp, k: 2 };
        }
      });
      byC.forEach(function (list, end) {
        if (list.length === 1) { to[list[0]] = { n: end.n, k: end.k }; return; }
        var at = slotAt(end.n, 'in', end.k);
        var into = { n: end.n, k: end.k };
        // Made items before mined or bought ones: where a byproduct is
        // topped up from a resource, a Priority Merger takes the byproduct
        // first, as it would be built, so nothing backs up.
        var fromSource = function (i) { var t = pairs[i].p.n.type; return t === 'resource' || t === 'import'; };
        var left = list.slice().sort(function (a, b) {
          return (fromSource(a) ? 1 : 0) - (fromSource(b) ? 1 : 0) ||
            slotAt(pairs[a].p.n, 'out', pairs[a].p.k).y - slotAt(pairs[b].p.n, 'out', pairs[b].p.k).y;
        });
        var topUp = left.some(fromSource) && !left.every(fromSource);
        var step = 0;
        var my = at.y - LOGI_H / 2;
        while (left.length) {
          var mg = node(topUp && step === 0 ? { type: 'merger', priority: true } : { type: 'merger' });
          mg.x = Math.round(at.x - 48 - LOGI_W - step * LANE);
          mg.y = Math.round(my);
          my += LOGI_H * (2.5 / 3) - LOGI_H / 2;
          step++;
          links.push({ id: 'l' + uid(), from: mg.id, fk: 0, to: into.n.id, tk: into.k });
          var room = left.length <= 3 ? 3 : 2;
          for (var t = 0; t < room && left.length; t++) to[left.shift()] = { n: mg, k: t };
          into = { n: mg, k: 2 };
        }
      });
      pairs.forEach(function (pr, i) {
        if (from[i] && to[i]) links.push({ id: 'l' + uid(), from: from[i].n.id, fk: from[i].k, to: to[i].n.id, tk: to[i].k });
      });
    });

    // Splitters and mergers moved down off anything they'd sit on.
    function box(n) { var sz = nodeSize(n); return { x: n.x, y: n.y, w: sz.w, h: sz.h }; }
    function hits(a, b) { return a.x < b.x + b.w + 12 && b.x < a.x + a.w + 12 && a.y < b.y + b.h + 12 && b.y < a.y + a.h + 12; }
    var logi = nodes.filter(isLogistic);
    for (var round = 0; round < 40; round++) {
      var clear = true;
      logi.forEach(function (n, i) {
        nodes.forEach(function (m) {
          if (m === n || (isLogistic(m) && logi.indexOf(m) > i)) return;
          var a = box(n), b = box(m);
          if (hits(a, b)) { n.y = b.y + b.h + 14; clear = false; }
        });
      });
      if (clear) break;
    }

    state.custom = { nodes: nodes, links: links, notes: state.custom.notes || [], strokes: state.custom.strokes || [] };

    // A step on Auto sizes itself from what's asked of it, which a loop (a
    // recipe feeding back into its own supply) can't settle. Any step that
    // doesn't come to its planned count is Set to it instead.
    for (var pass = 0; pass < 6; pass++) {
      var f = customFlow();
      var off = nodes.filter(function (n) {
        if (n.type !== 'recipe' || n.set) return false;
        var got = (f.nodes[n.id] && f.nodes[n.id].count) || 0;
        return Math.abs(got - planned[n.id]) > Math.max(1e-4, planned[n.id] * 1e-3);
      });
      if (!off.length) break;
      off.forEach(function (n) { n.set = true; n.count = planned[n.id]; });
    }
  }

  /* ---- the view ---- */

  /** Custom's canvas: the cards and lines, and the panel worked out from them. */
  function renderCustomView() {
    flow = modelFlow();
    syncPlan(flow);
    if (keyAfterRender) {
      keyAfterRender = false;
      state.optKey = state.targets.length ? planKey() : null;
    }
    solved = { recipes: {}, items: flow.items, targets: flow.outputs, flows: [], custom: true };
    graph = { nodes: [], edges: [], byKey: {} };
    errorEl.hidden = true;
    world.classList.remove('machines');
    world.querySelectorAll('.node, .machine, .part, .cnode').forEach(function (el) { el.remove(); });
    state.custom.nodes.forEach(function (n) { world.appendChild(cardEl(n)); });
    Object.keys(selected).forEach(function (k) {
      var alive = state.custom.nodes.some(function (n) { return n.id === k; }) ||
        state.custom.links.some(function (l) { return l.id === k; });
      if (!alive) delete selected[k];
    });
    renderLinks();
    renderNotes();
    renderInk();
    renderPalette();
    renderBreakdown();
    refreshOptNote();
    refreshRunButton();
    refreshEmptyHint();
  }

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
    openCtx(r.left, r.bottom + 6, [
      {
        label: 'Donate with PayPal',
        note: 'Opens PayPal in a new tab',
        run: function () { window.open(SUPPORT_URL, '_blank', 'noopener'); }
      }
    ]);
    // Right edge under the button's right edge.
    ctx.style.left = Math.max(8, r.right - ctx.offsetWidth) + 'px';
  });

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
  lastSnap = snapshot();
  refreshHistoryButtons();
})();
