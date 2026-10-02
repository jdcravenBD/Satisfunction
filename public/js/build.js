/* Satisfunction — Optimize and Build: remaking the model from the plan, and drawing it. */

import { DATA, EPS, NEW_TARGET_RATE, OPTIMISE, SOLVER, blocked, buildablePlan, canBuild,
  errorEl, isFluid, recipeAllowed, setGraph, setSolved, solved, state, supplyInfo, world } from './core.js';
import { uid } from './store.js';
import { changed } from './history.js';
import { fitView } from './view.js';
import { clearSelection, selectOnly, selected } from './canvas.js';
import { askConfirm } from './menus.js';
import { renderBreakdown } from './panel.js';
import { refreshEmptyHint } from './factories.js';
import { refreshOptNote } from './recipes.js';
import { extractorOf, floorOf, flow, hasFloor, isEnd, isLogistic, nodeById, nodeRecipe, nodeSize, resourceCap,
  setFlow, sloopsOf, slotAt, slotsOf } from './model.js';
import { customFlow } from './flow.js';
import { renderInk, renderNotes } from './notes.js';
import { modelFlow } from './links.js';
import { newNode, renderPalette } from './palette.js';
import { cardEl, customBoxes, renderLinks } from './cards.js';

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
    // (What goes into an AWESOME Sink is a spare, not an output.)
    var left = net[id] - ((f.sunk && f.sunk[id]) || 0);
    if (mainOf[id] && left > 1e-4) byItem[id] = left;
  });
  // An output Build couldn't make here, brought in instead, is still one.
  state.custom.nodes.forEach(function (n) {
    if (n.type !== 'import' || !n.standIn || !(n.rate > 0)) return;
    var l = state.custom.links.filter(function (x) { return x.from === n.id; })[0];
    var to = l && nodeById(l.to);
    if (to && to.type === 'sink') byItem[n.item] = (byItem[n.item] || 0) + n.rate;
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
    if (n.type === 'import' && !n.standIn) imports[n.item] = true;
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
    u: state.unavailable.slice().sort(),
    n: state.noUse.slice().sort()
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
  // So do floors, and those of resources and inputs with their items.
  var floorKey = function (n) { return n.type === 'recipe' ? 'r:' + n.recipe : n.type + ':' + n.item; };
  var floorWas = {};
  state.custom.nodes.forEach(function (n) {
    if (hasFloor(n) && floorOf(n) > 1 && !floorWas[floorKey(n)]) floorWas[floorKey(n)] = floorOf(n);
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
  // Somersloops stay with their recipes, and the plan counts on them.
  var outMult = {};
  Object.keys(sloopsWas).forEach(function (rid) {
    outMult[rid] = 1 + sloopsOf({ type: 'recipe', recipe: rid, sloops: sloopsWas[rid] }).boost;
  });
  var off = {};
  state.noUse.forEach(function (id) { off[id] = 0; });
  var plan = { targets: targets, recipes: built.recipes, imports: built.imports, caps: off, outMult: outMult };
  setSolved(null);
  if (state.picker === 'optimise') {
    plan.pins = {};
    setSolved(OPTIMISE.solveOptimised(DATA, plan, { goal: state.goal, allowed: recipeAllowed, built: canBuild, useFluids: true }));
  }
  if (!solved) {
    plan.recipes = buildablePlan(true).recipes;
    setSolved(SOLVER.solve(DATA, plan));
    // Fluids left over can't be sunk, and would back the steps up. Keeping
    // every recipe picked, standard recipes are added to use them up
    // (Heavy Oil Residue into Petroleum Coke for the AWESOME Sink, say).
    var wet = Object.keys(solved.items || {}).some(function (id) { return solved.items[id].surplus > 1e-6 && isFluid(id); });
    if (wet && !solved.error) {
      var pins = {};
      Object.keys(solved.recipes).forEach(function (rid) {
        var it = solved.recipes[rid].item;
        (pins[it] = pins[it] || {})[rid] = 1;
      });
      var tidy = OPTIMISE.solveOptimised(DATA, { targets: targets, imports: plan.imports, caps: off, pins: pins, outMult: outMult },
        { goal: 'resources', allowed: function () { return false; }, built: canBuild, useFluids: true });
      if (tidy && !tidy.error && !Object.keys(tidy.items).some(function (id) { return tidy.items[id].surplus > 1e-6 && isFluid(id); })) setSolved(tidy);
    }
  }
  layoutSloops = sloopsWas;
  autoToCustom();
  layoutSloops = {};
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
    if (hasFloor(n) && floorWas[floorKey(n)]) n.floor = floorWas[floorKey(n)];
  });
  state.pins = {};
  keyAfterRender = true;
  return true;
}

// Set by buildModel: the next redraw (Model or a view) records the new planKey.
var keyAfterRender = false;
// Somersloops for the cards autoToCustom lays out: recipe -> how many.
var layoutSloops = {};

function noteBuilt() {
  if (!keyAfterRender) return;
  keyAfterRender = false;
  state.optKey = state.targets.length ? planKey() : null;
}

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
/**
 * A step's main item brought in instead: an Import card at the rate it
 * makes, taking over its lines out, and the step goes, with anything
 * upstream that only fed what's going.
 */
function bringIn(n) {
  var r = nodeRecipe(n);
  if (!r) return null;
  var item = n.item || r.out[0][0];
  var k = Math.max(0, slotsOf(n).outs.indexOf(item));
  var st = flow && flow.nodes[n.id];
  var per = (SOLVER.perMinute(r)[item] || 0) * (1 + sloopsOf(n).boost);
  var rate = ((st && st.count) || n.count || 1) * per;
  var size = nodeSize({ type: 'import' });
  var im = {
    id: 'n' + uid(), type: 'import', item: item, rate: Number(rate.toFixed(4)) || 60,
    x: Math.round(n.x + nodeSize(n).w - size.w), y: Math.round(slotAt(n, 'out', k).y - size.h / 2)
  };
  var links = state.custom.links;
  var gone = {};
  gone[n.id] = true;
  for (var grew = true; grew;) {
    grew = false;
    state.custom.nodes.forEach(function (m) {
      if (gone[m.id]) return;
      var outs = links.filter(function (l) { return l.from === m.id; });
      if (outs.length && outs.every(function (l) { return gone[l.to]; })) { gone[m.id] = true; grew = true; }
    });
  }
  state.custom.links = links.filter(function (l) {
    if (l.from === n.id && l.fk === k && !gone[l.to]) { l.from = im.id; l.fk = 0; return true; }
    return !gone[l.from] && !gone[l.to];
  });
  state.custom.nodes = state.custom.nodes.filter(function (m) { return !gone[m.id]; }).concat([im]);
  return im;
}

/** "+ Add input": steps making it are swapped for an Import; else a new Import card. */
function addModelInput(id) {
  var fresh = !!state.optKey && state.optKey === planKey();
  var makers = state.custom.nodes.filter(function (n) { return nodeRecipe(n) && (n.item || nodeRecipe(n).out[0][0]) === id; });
  var made = makers.map(bringIn).filter(Boolean);
  if (!made.length) {
    var left = Infinity, top = Infinity;
    customBoxes().forEach(function (b) { left = Math.min(left, b.x); top = Math.min(top, b.y); });
    var im = { id: 'n' + uid(), type: 'import', item: id, rate: 60, x: isFinite(left) ? left - 280 : 0, y: isFinite(top) ? top : 0 };
    state.custom.nodes.push(im);
    made = [im];
  }
  clearSelection();
  // A model as Optimize or Build left it is rebuilt around the import
  // (nothing done by hand to lose); otherwise Reoptimize offers to.
  if (fresh && made[0].type === 'import' && buildModel()) { changed(); return; }
  made.forEach(function (m) { selected[m.id] = true; });
  changed();
}

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
      // Brought in only because no ticked building can make it: marked, so
      // it says why and a later rebuild tries to make it again.
      if (blocked[id]) im.standIn = true;
      give(id, im, 0, e.supplied);
      place(0, im);
    }
  });
  // Steps, by how far they are from the raw resources.
  var used = Object.keys(solved.recipes).filter(function (rid) { return solved.recipes[rid].count > 1e-9; });
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
    if (layoutSloops[rid]) n.sloops = layoutSloops[rid];
    planned[n.id] = count;
    var col = stepDepth(rid, {});
    last = Math.max(last, col);
    place(col, n);
    var per = SOLVER.perMinute(r);
    var boost = 1 + sloopsOf(n).boost;
    r.in.forEach(function (q, k) { take(q[0], n, k, -per[q[0]] * count); });
    r.out.forEach(function (q, k) { if (per[q[0]] > 0) give(q[0], n, k, per[q[0]] * count * boost); });
  });
  // Outputs and spares into Storage.
  var end = last + 1;
  function collect(id, rate, type) {
    var s = node({ type: type || 'sink' });
    take(id, s, 0, rate);
    place(end, s);
  }
  Object.keys(solved.targets).forEach(function (id) { if (solved.targets[id] > EPS) collect(id, solved.targets[id]); });
  // Spare byproducts: solids into an AWESOME Sink, as you'd build it. A
  // fluid can't be sunk: one sharing a line with a user goes to Storage
  // for the rest; one nothing uses stays at its output, which says so.
  Object.keys(solved.items).forEach(function (id) {
    var e = solved.items[id];
    if (!(e.surplus > EPS)) return;
    if (!isFluid(id)) collect(id, e.surplus, 'awesome');
    else if (cons[id] && cons[id].length) collect(id, e.surplus);
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

  // Where an item's makers and users cross (one maker feeding several
  // steps, one of which also takes from another maker), separate lines
  // would be split evenly and leave a step short. Those items get one line
  // instead: everything making it merges in (made ones first, mined or
  // brought-in ones topping up), then it's split out to every step.
  plans.forEach(function (pl) {
    var np = new Map(), nc = new Map();
    pl.pairs.forEach(function (pr) {
      np.set(pr.p, (np.get(pr.p) || 0) + 1);
      nc.set(pr.c, (nc.get(pr.c) || 0) + 1);
    });
    var split = false, merge = false;
    np.forEach(function (k) { if (k > 1) split = true; });
    nc.forEach(function (k) { if (k > 1) merge = true; });
    if (!split || !merge) return;
    var bus = { made: [], src: [], to: [] };
    np.forEach(function (k, e) { (e.n.type === 'resource' || e.n.type === 'import' ? bus.src : bus.made).push(e); });
    nc.forEach(function (k, e) { bus.to.push(e); });
    pl.bus = bus;
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
      if (isEnd(n)) return;
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
  function busLength(b) {
    var n = chainLength(b.made.length) + chainLength(b.to.length);
    if (b.made.length && b.src.length) n += 1 + (b.src.length > 2 ? chainLength(b.src.length) : 0);
    else n += chainLength(b.src.length);
    return n;
  }
  var busAfter = new Map();  // column -> lanes its shared lines take
  plans.forEach(function (pl) {
    if (!pl.bus) return;
    var c = Math.max.apply(null, pl.bus.made.concat(pl.bus.src).map(function (e) { return colOf.get(e.n); }));
    busAfter.set(c, Math.max(busAfter.get(c) || 0, busLength(pl.bus)));
  });
  plans.forEach(function (pl) {
    if (pl.bus) return;
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
  busAfter.forEach(function (k, c) { lanesAfter[c] = Math.max(lanesAfter[c], k); });
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
  function busLines(b) {
    function outY(e) { return slotAt(e.n, 'out', e.k).y; }
    function inY(e) { return slotAt(e.n, 'in', e.k).y; }
    // In a row just past the rightmost maker, starting level with it, each
    // part placed so the line runs level into it from the one before.
    var all = b.made.concat(b.src);
    var anchor = all.reduce(function (a, e) { return slotAt(e.n, 'out', e.k).x > slotAt(a.n, 'out', a.k).x ? e : a; });
    var x0 = slotAt(anchor.n, 'out', anchor.k).x + 48;
    var lineY = outY(anchor);
    var lane = 0;
    function part(obj, inK) {
      var p = node(obj);
      p.x = Math.round(x0 + lane * LANE);
      p.y = 0;
      p.y = Math.round(lineY - slotAt(p, 'in', inK).y);
      lane++;
      return p;
    }
    function join(a, p, k) { links.push({ id: 'l' + uid(), from: a.n.id, fk: a.k, to: p.id, tk: k }); }
    function mergeAll(list) {
      list = list.slice().sort(function (a, c) { return outY(a) - outY(c); });
      if (list.length === 1) { lineY = outY(list[0]); return list[0]; }
      var stream = null;
      while (list.length) {
        var mg = part({ type: 'merger' }, stream ? 0 : 1);
        var k = 0;
        if (stream) join(stream, mg, k++);
        while (k < 3 && list.length) join(list.shift(), mg, k++);
        stream = { n: mg, k: 0 };
        lineY = slotAt(mg, 'out', 0).y;
      }
      return stream;
    }
    var stream;
    var made = b.made.length ? mergeAll(b.made) : null;
    if (made && b.src.length) {
      var madeY = lineY;
      var src = b.src.length > 2 ? [mergeAll(b.src)] : b.src;
      lineY = madeY;
      var pm = part({ type: 'merger', priority: true }, 0);
      join(made, pm, 0);
      src.forEach(function (e, i) { join(e, pm, i + 1); });
      stream = { n: pm, k: 0 };
      lineY = slotAt(pm, 'out', 0).y;
    } else {
      stream = made || mergeAll(b.src);
    }
    var to = b.to.slice().sort(function (a, c) { return inY(a) - inY(c); });
    while (to.length) {
      var sp = part({ type: 'splitter' }, 0);
      lineY = slotAt(sp, 'out', 2).y;
      join(stream, sp, 0);
      var room = to.length <= 3 ? to.length : 2;
      for (var t = 0; t < room; t++) {
        var e = to.shift();
        links.push({ id: 'l' + uid(), from: sp.id, fk: t, to: e.n.id, tk: e.k });
      }
      stream = { n: sp, k: 2 };
    }
  }
  plans.forEach(function (pl) {
    if (pl.bus) { busLines(pl.bus); return; }
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
      return Math.abs(got - planned[n.id]) > Math.max(1e-9, planned[n.id] * 1e-4);
    });
    if (!off.length) break;
    off.forEach(function (n) { n.set = true; n.count = planned[n.id]; });
  }
}

/* ---- the view ---- */

/** Custom's canvas: the cards and lines, and the panel worked out from them. */
function renderCustomView() {
  setFlow(modelFlow());
  syncPlan(flow);
  noteBuilt();
  setSolved({ recipes: {}, items: flow.items, targets: flow.outputs, flows: [], custom: true });
  setGraph({ nodes: [], edges: [], byKey: {} });
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

export { addModelInput, addModelOutput, bringIn, buildModel, noteBuilt, planKey,
  refreshRunButton, renderCustomView, syncPlan };
