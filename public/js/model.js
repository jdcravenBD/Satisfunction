/* Satisfunction — Model cards: sizes, slots, splitter rules, and which items each line carries. */

import { DATA, SOLVER, clamp, isFluid, state, titleCase } from './core.js';

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

var CNODE_W = { recipe: 170, resource: 156, import: 132, sink: 120, awesome: 120, splitter: 64, merger: 64 };
var SLOT = 38;       // room for each input or output
var CARD_TOP = 28;   // room above the slots for the count
var STRIP = 36;      // the inputs' and outputs' strips down the card's sides
var STRIP_LOGI = 20; // the same on a splitter or merger

function iconOf(id) { return 'icons/' + id + '.png'; }

// A rounded diamond with "!" in it, as on the Machines view's note.
var PROBLEM_ICON = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">' +
  '<rect x="4.1" y="4.1" width="11.8" height="11.8" rx="2.6" transform="rotate(45 10 10)" style="fill: var(--flag-bg)" stroke="currentColor" stroke-width="1.6"/>' +
  '<path d="M10 6.7v4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
  '<circle cx="10" cy="13.5" r="1.05" fill="currentColor"/></svg>';
function isLogistic(n) { return n.type === 'splitter' || n.type === 'merger'; }
/** Where a line can end: Storage, or an AWESOME Sink. */
function isEnd(n) { return n.type === 'sink' || n.type === 'awesome'; }
/** AWESOME Sink points for an item a minute: what it's worth, solids only. */
function sinkPoints(id, rate) { return isFluid(id) ? 0 : (DATA.items[id].sink || 0) * rate; }

/** A card's building by its in-game name. */
function partName(n) {
  if (n.type === 'splitter') return n.programmable ? 'Programmable Splitter' : n.priority ? 'Smart Splitter' : 'Splitter';
  if (n.type === 'merger') return n.priority ? 'Priority Merger' : 'Merger';
  if (n.type === 'sink') return 'Storage Container';
  if (n.type === 'awesome') return 'AWESOME Sink';
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
  if (n.type === 'sink' || n.type === 'awesome') return { ins: [null], outs: [] };
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

// Smart and Programmable Splitters send items where their outputs' rules
// say. Each output has a list of rules: item ids, or these.
var RULE_NAMES = { any: 'Any', none: 'None', undefined: 'Any Undefined', overflow: 'Overflow' };

function isRuled(n) { return n.type === 'splitter' && !!(n.priority || n.programmable); }

/** A Smart or Programmable Splitter's rules: a list for each of its three outputs. */
function rulesOf(n) {
  if (Array.isArray(n.rules) && n.rules.length === 3) return n.rules;
  // A Smart Splitter's top output fills first and the others overflow;
  // a new Programmable Splitter sends anything anywhere.
  return n.programmable ? [['any'], ['any'], ['any']] : [['any'], ['overflow'], ['overflow']];
}

/**
 * Where a ruled splitter sends an item, among the outputs joined up (fks):
 * the ones set to take it (by name, Any, or Any Undefined when no output
 * names it), and failing those, the Overflow ones.
 */
function routeOf(n, item, fks) {
  var rules = rulesOf(n);
  var named = fks.some(function (k) { return rules[k].indexOf(item) >= 0; });
  var take = fks.filter(function (k) {
    var r = rules[k];
    return r.indexOf(item) >= 0 || r.indexOf('any') >= 0 || (!named && r.indexOf('undefined') >= 0);
  });
  var over = fks.filter(function (k) { return take.indexOf(k) < 0 && rules[k].indexOf('overflow') >= 0; });
  return { take: take, over: over };
}

/**
 * The items each line can carry: what its maker makes, passed on through
 * mergers (all their inputs' items, so belts can mix) and splitters (what
 * each output's rules let through). Worked out again whenever the cards or
 * lines change.
 */
var lineCache = null;
function lineSets() {
  var nodes = state.custom.nodes, links = state.custom.links;
  var c = lineCache;
  if (c && c.nodes === nodes && c.links === links && c.nn === nodes.length && c.nl === links.length) return c.sets;
  var byId = {};
  nodes.forEach(function (n) { byId[n.id] = n; });
  var inL = {}, outL = {};
  links.forEach(function (l) {
    (inL[l.to] = inL[l.to] || []).push(l);
    (outL[l.from] = outL[l.from] || []).push(l);
  });
  var has = {};
  links.forEach(function (l) {
    has[l.id] = {};
    var a = byId[l.from];
    var it = a && !isLogistic(a) ? slotsOf(a).outs[l.fk] : null;
    if (it) has[l.id][it] = true;
  });
  var logi = nodes.filter(isLogistic);
  for (var round = 0; round < 200; round++) {
    var grew = false;
    logi.forEach(function (n) {
      var mine = {};
      (inL[n.id] || []).forEach(function (l) { Object.keys(has[l.id]).forEach(function (i) { mine[i] = true; }); });
      var outs = outL[n.id] || [];
      var fks = outs.map(function (o) { return o.fk; });
      outs.forEach(function (o) {
        Object.keys(mine).forEach(function (i) {
          if (has[o.id][i]) return;
          if (isRuled(n)) {
            var rt = routeOf(n, i, fks);
            if (rt.take.indexOf(o.fk) < 0 && rt.over.indexOf(o.fk) < 0) return;
          }
          has[o.id][i] = true;
          grew = true;
        });
      });
    });
    if (!grew) break;
  }
  var sets = {};
  links.forEach(function (l) { sets[l.id] = Object.keys(has[l.id]).sort(); });
  lineCache = { nodes: nodes, links: links, nn: nodes.length, nl: links.length, sets: sets };
  return sets;
}

/** The items a slot carries: its own, or for splitters, mergers and Storage, their lines'. */
function slotItems(n, side, k) {
  var s = slotsOf(n);
  var it = (side === 'in' ? s.ins : s.outs)[k];
  if (it) return [it];
  if (!isLogistic(n) && !isEnd(n)) return [];
  var sets = lineSets();
  var l = linkOn(n, side, k);
  if (l) return sets[l.id] || [];
  // A free slot: whatever the part's other lines carry.
  var mine = {};
  state.custom.links.forEach(function (x) {
    if (x.to === n.id || x.from === n.id) (sets[x.id] || []).forEach(function (i) { mine[i] = true; });
  });
  return Object.keys(mine).sort();
}

/** The one item a slot carries, or null when it carries a mix (or nothing known yet). */
function slotItem(n, side, k, guard) {
  var list = slotItems(n, side, k);
  if (list.length === 1) return list[0];
  if (list.length > 1) return null;
  return isLogistic(n) || isEnd(n) ? lineItem(n, guard) : null;
}

/** Items that can share one line: any number of solids, or a single fluid. */
function mixable(list) {
  var u = {};
  list.forEach(function (i) { if (i) u[i] = true; });
  var ks = Object.keys(u);
  return !ks.some(isFluid) || ks.length <= 1;
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

function vsum(list) {
  var o = {};
  list.forEach(function (v) { for (var i in v) o[i] = (o[i] || 0) + v[i]; });
  return o;
}
function vtotal(v) { var t = 0; for (var i in v) t += v[i]; return t; }
function vscale(v, f) { var o = {}; for (var i in v) o[i] = v[i] * f; return o; }

// Other files change these through here: an imported name can't be assigned to.
function setLineCache(v) { lineCache = v; return v; }
function setFlow(v) { flow = v; return v; }

export { PROBLEM_ICON, RULE_NAMES, STRIP, STRIP_LOGI, buildingOf, customHint, extractorOf, flow,
  iconOf, isEnd, isLogistic, isRuled, lineSets, linkOn, mixable, nodeById, nodeRecipe, nodeSize,
  palette, partName, resourceCap, routeOf, rulesOf, setFlow, setLineCache, sinkPoints, sloopsOf,
  slotAt, slotItem, slotItems, slotsOf, vscale, vsum, vtotal };
