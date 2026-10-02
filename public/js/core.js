/* Satisfunction — Shared foundations: the page's main elements, the plan's state, and game-data
   helpers (lookups, buildings, clocks, numbers). */

var DATA = window.SF_DATA;
var SOLVER = window.SF_SOLVER;
var OPTIMISE = window.SF_OPTIMISE;

var KEY = 'satisfunction.plan.v1';
var EPS = 1e-9;

var NODE_W = 224;
var COL_GAP = 150;   // room between columns for the rate labels
var ROW_GAP = 34;
var MIN_ZOOM = 0.015;  // far enough out to see the biggest factory whole
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
  floorShown: 0, // machine view: the one floor shown, or 0 for every floor
  build: 'custom', // 'custom': the Model canvas; 'auto': one of its views (Item or Machine)
  optKey: null,  // planKey() when the model was last optimized or built
  noUse: [],     // resources this factory doesn't use (Optimize does without them)
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
    // Water Extractors go anywhere: as many as the model's cards have,
    // sharing the work, or else just enough.
    var have = state.custom.nodes.reduce(function (sum, n) {
      return sum + (n.type === 'resource' && n.item === id ? n.count || 1 : 0);
    }, 0);
    var clocks = [];
    for (var w = 0; w < have; w++) clocks.push(used / info.baseRate / have);
    if (!have) clocks = SOLVER.clocks(used / info.baseRate, state.clock, DATA.logistics.pipes[state.pipe - 1] / info.baseRate);
    return {
      info: info,
      list: clocks.map(function (c) {
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

// Other files change these through here: an imported name can't be assigned to.
function setSolved(v) { solved = v; return v; }
function setGraph(v) { graph = v; return v; }

export { BUILDINGS, COL_GAP, DATA, DEFAULTS, EPS, KEY, MAX_ZOOM, MINERS, MIN_ZOOM,
  NEW_TARGET_RATE, NODE_W, OPTIMISE, PICKABLE, RAW_ITEMS, ROW_GAP, SOLVER, availableMiner,
  blocked, buildablePlan, buildingName, canBuild, clamp, clockLabel, clockSetting, currentCaps,
  currentRecipe, emptyHint, errorEl, extractorsFor, fallbackRecipe, fmtCount, fmtNum, fmtPower,
  graph, hasBuilding, importFile, isFluid, itemName, labelsEl, machineName, nameSpans, pins,
  producersOf, rateText, recipeAllowed, recipeClocks, redoBtn, setGraph, setSolved, shardsFor,
  solved, stage, state, stepClocks, stepPower, storedNodes, supplyInfo, titleCase, tpl, undoBtn,
  unlockable, world };
