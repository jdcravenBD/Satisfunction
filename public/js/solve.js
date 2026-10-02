/* Satisfunction — Works the model out into the plan the Item and Machine views draw. */

import { DATA, EPS, SOLVER, blocked, buildablePlan, buildingName, currentCaps, errorEl, graph,
  itemName, setGraph, setSolved, solved, state, supplyInfo, world } from './core.js';
import { layout } from './layout.js';
import { hideHoverInfo, mountNodes } from './nodes.js';
import { buildMachineGraph, mountMachineNodes, place, renderMachineView } from './machines.js';
import { renderWires } from './wires.js';
import { keepSelection, lowestAdders } from './canvas.js';
import { renderBreakdown } from './panel.js';
import { refreshEmptyHint } from './factories.js';
import { refreshOptNote } from './recipes.js';
import { flow, nodeRecipe, setFlow, setLineCache } from './model.js';
import { inkEl } from './notes.js';
import { modelFlow } from './links.js';
import { renderCustomPanel } from './inspector.js';
import { buildModel, noteBuilt, refreshRunButton, renderCustomView, syncPlan } from './build.js';
import { hideTip, tipEl } from './tips.js';

/* --------------------------------------------------------------- solve */

/**
 * Re-solves the plan and rebuilds the canvas from it. Nodes are keyed by
 * what they are ("r:<recipe>", "raw:<item>" or "out:<item>"), so a pin
 * survives any change that doesn't remove that step outright.
 */
function recompute() {
  setLineCache(null);
  if (tipEl) hideTip();  // what it was pointing at is redrawn
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
  setFlow(modelFlow());
  syncPlan(flow);
  noteBuilt();
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
  setSolved(SOLVER.assemble(DATA, counts, owner, outs, currentCaps(), mult));

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
  // A resource drawn from several nodes shows one block for each kind of
  // node (purity and miner), saying how many there are, all running at the
  // same share of what they can give.
  var rawParts = {};
  Object.keys(solved.items).forEach(function (id) {
    var e = solved.items[id];
    if (!(e.supplied > EPS)) return;
    var info = DATA.items[id].raw ? supplyInfo(id) : null;
    if (!info || !info.purity || !info.nodeList.length) {
      add({ key: 'raw:' + id, kind: 'raw', item: id, rate: e.supplied });
      return;
    }
    var kinds = [];
    var byKind = {};
    info.nodeList.forEach(function (nd, i) {
      var k = nd.purity + '|' + nd.extractor;
      if (!byKind[k]) { byKind[k] = { slot: i, count: 0, cap: 0 }; kinds.push(byKind[k]); }
      byKind[k].count++;
      byKind[k].cap += nd.rate;
    });
    rawParts[id] = kinds.map(function (g, i) {
      var share = g.cap / info.capacity;
      var key = i ? 'raw:' + id + '#' + i : 'raw:' + id;
      add({ key: key, kind: 'raw', item: id, rate: e.supplied * share, slot: g.slot, nodes: g.count, cap: g.cap });
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

  setGraph({ nodes: nodes, edges: edges, byKey: byKey });
}

export { recompute };
