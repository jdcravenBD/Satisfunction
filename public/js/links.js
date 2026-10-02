/* Satisfunction — Links between factories: what one sends and another brings in. */

import { DATA, buildingName, canBuild, itemName, producersOf, rateText, state } from './core.js';
import { currentFactory, currentSave, readCustom } from './store.js';
import { factoryLabel } from './factories.js';
import { customFlow } from './flow.js';

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
  standInProblems(f);
  return f;
}

/**
 * Imports Build put in for things no ticked building can make: why, or,
 * once that building is ticked, that a rebuild would make it here.
 */
function standInProblems(f) {
  state.custom.nodes.forEach(function (n) {
    if (n.type !== 'import' || !n.standIn || n.from) return;
    var rids = producersOf[n.item] || [];
    if (!rids.length) return;
    var def = DATA.defaults[n.item] || rids[0];
    var building = buildingName(DATA.recipes[def].machine);
    var text = rids.some(canBuild)
      ? itemName(n.item) + ' is brought in, but the ' + building + ' is ticked now: ' +
        (state.picker === 'optimise' ? 'Reoptimize' : 'Rebuild') + ' to make it here'
      : itemName(n.item) + ' can’t be made here: it needs the ' + building +
        ', which is unticked under Machines, so it’s brought in instead';
    f.problems.push({ part: n.id, text: text });
    f.bad[n.id] = true;
  });
}



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

export { factoryById, factoryOutputs, modelFlow, otherFactories, requestsOf };
