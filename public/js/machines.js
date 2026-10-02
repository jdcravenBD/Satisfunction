/* Satisfunction — Machine view: every building at its real footprint, with belts, pipes,
   splitters and mergers. */

import { DATA, EPS, clockLabel, clockSetting, extractorsFor, fmtNum, graph, isFluid, itemName,
  labelsEl, nameSpans, rateText, recipeClocks, setGraph, shardsFor, solved, state, titleCase,
  world } from './core.js';
import { buildNode } from './nodes.js';
import { edgeId, relate, setRelated, svg, wires } from './wires.js';
import { inkEl } from './notes.js';

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

  setGraph({ nodes: nodes, edges: edges, byKey: byKey });
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
  // A long manifold folds into rows side by side, so a step makes a block
  // about as wide as it's tall instead of one very long line.
  if (state.balance !== 'balancer' || !nIn) {
    var colW = (nIn ? half + (nIn - 1) * LANE_M + half + BRANCH_M : 0) + l + (nOut ? BRANCH_M + half + (nOut - 1) * LANE_M + half : 0);
    var perCol = Math.max(3, Math.ceil(Math.sqrt(N * (colW + SUB_GAP_M) / pitch)));
    if (perCol < N) return wrappedGeometry(n, perCol, colW);
  }
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

/**
 * A manifold folded into columns of `perCol` machines, side by side. Each
 * input arrives on a belt along the top, which splits off down each
 * column's manifold; each output's column manifolds come down and merge
 * into a belt along the bottom, leaving at the right.
 */
var SUB_GAP_M = 4;   // between the columns of a folded line
function wrappedGeometry(n, perCol, colW) {
  var N = n.machines.length;
  var nIn = n.ins.length;
  var nOut = n.outs.length;
  var l = n.size ? n.size.l : 10;
  var w = n.size ? n.size.w : 8;
  var half = SPLIT_M / 2;
  var pitch = Math.ceil(w + GAP_M);
  var g = { machines: [], belts: [], parts: [], ports: { in: {}, out: {} }, l: l, w: w };
  var cols = Math.ceil(N / perCol);
  function inAt(top, i) { return top + w * (i + 1) / (nIn + 1); }
  function outAt(top, j) { return top + w * (j + 1) / (nOut + 1); }
  function entry(i) { return 1 + i * 2; }
  var entryFloor = nIn ? entry(nIn - 1) + 1 : 0;
  var y1 = 0;
  n.ins.forEach(function (_, i) { y1 = Math.max(y1, entry(i) + 1 + half - w * (i + 1) / (nIn + 1)); });
  y1 = Math.max(Math.ceil(y1), nIn ? Math.ceil(entryFloor + half) : 0);
  var tops = [];
  for (var r = 0; r < perCol; r++) tops.push(y1 + r * pitch);
  var span = colW + SUB_GAP_M;
  var mxOf = function (c) { return c * span + (nIn ? half + (nIn - 1) * LANE_M + half + BRANCH_M : 0); };
  var inX = function (c, i) { return c * span + half + (nIn - 1 - i) * LANE_M; };
  var outX = function (c, j) { return mxOf(c) + l + BRANCH_M + half + j * LANE_M; };
  var rowsIn = function (c) { return Math.min(perCol, N - c * perCol); };
  var width = (cols - 1) * span + colW;

  for (var c = 0; c < cols; c++) {
    for (var r2 = 0; r2 < rowsIn(c); r2++) g.machines.push({ x: mxOf(c), y: tops[r2], m: n.machines[c * perCol + r2] });
  }

  // Inputs: along the top, then down each column.
  n.ins.forEach(function (id, i) {
    var fluid = isFluid(id);
    var lastC = cols - 1;
    g.belts.push({ item: id, pts: [[0, entry(i)], [inX(lastC, i), entry(i)]] });
    for (var c2 = 0; c2 < cols; c2++) {
      var x = inX(c2, i);
      var rows = rowsIn(c2);
      var ys = tops.slice(0, rows).map(function (t) { return inAt(t, i); });
      if (c2 < lastC) g.parts.push({ role: 'splitter', fluid: fluid, item: id, x: x, y: entry(i) });
      g.belts.push({ item: id, pts: [[x, entry(i)], [x, ys[rows - 1]], [mxOf(c2), ys[rows - 1]]], branch: c2 < lastC });
      for (var k = 0; k < rows - 1; k++) {
        g.belts.push({ item: id, pts: [[x, ys[k]], [mxOf(c2), ys[k]]], branch: true });
        g.parts.push({ role: 'splitter', fluid: fluid, item: id, x: x, y: ys[k] });
      }
    }
    g.ports.in[id] = { x: 0, y: entry(i) };
  });

  // Outputs: down each column, then along the bottom.
  var outBottom = tops[perCol - 1] + w;
  n.outs.forEach(function (_, j) { outBottom = Math.max(outBottom, outAt(tops[perCol - 1], j) + half); });
  function exit(j) { return Math.ceil(outBottom) + 1 + half + (nOut - 1 - j) * (SPLIT_M + 1); }
  n.outs.forEach(function (id, j) {
    var fluid = isFluid(id);
    for (var c3 = 0; c3 < cols; c3++) {
      var x = outX(c3, j);
      var rows = rowsIn(c3);
      var ys = tops.slice(0, rows).map(function (t) { return outAt(t, j); });
      g.belts.push({ item: id, pts: [[mxOf(c3) + l, ys[0]], [x, ys[0]], [x, exit(j)]].concat(c3 === 0 ? [[width, exit(j)]] : []), branch: c3 > 0 });
      for (var k2 = 1; k2 < rows; k2++) {
        g.belts.push({ item: id, pts: [[mxOf(c3) + l, ys[k2]], [x, ys[k2]]], branch: true });
        g.parts.push({ role: 'merger', fluid: fluid, item: id, x: x, y: ys[k2] });
      }
      if (c3 > 0) g.parts.push({ role: 'merger', fluid: fluid, item: id, x: x, y: exit(j) });
    }
    g.ports.out[id] = { x: width, y: exit(j) };
  });

  g.w = width;
  g.h = nOut ? exit(0) + half + 1 : outBottom;
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
  // Every column starts at the same height, under the bus, rather than
  // each sitting a little lower than the last.
  // Packed down from there in their order, a little room between, so
  // no column is mostly empty space.
  layers.forEach(function (layer) {
    var list = layer.slice().sort(function (p, q) { return p.y - q.y; });
    var at = 0;
    list.forEach(function (n) {
      if (n.dummy) { n.y = snap(at + px(2)); n.cy = n.y; at = n.y + px(2); return; }
      n.y = snap(at);
      n.cy = n.y + n.h / 2;
      at = n.y + n.h + px(6);
    });
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
  // The bus: lanes above everything for belts skipping several columns,
  // each lane shared by belts whose stretches don't overlap; the longest
  // belts take the outermost lanes.
  // A belt whose ends sit low in the factory takes a lane underneath
  // instead, below any loops back.
  var top = graph.nodes.reduce(function (m, n) { return Math.min(m, n.y); }, Infinity);
  var bottom = graph.nodes.reduce(function (m, n) { return Math.max(m, n.y + n.h); }, -Infinity);
  var backs = graph.edges.filter(function (e) { return e.back; }).length;
  var lanes = { high: [], low: [] };
  graph.edges.filter(function (e) { return e.bus && !e.back; })
    .sort(function (x, y) { return byKey[x.from].col - byKey[y.from].col || byKey[y.to].col - byKey[x.to].col; })
    .forEach(function (e) {
      var from = byKey[e.from].col, to = byKey[e.to].col;
      e.side = (startY(e) + endY(e)) / 2 > (top + bottom) / 2 ? 'low' : 'high';
      var list = lanes[e.side];
      var k = 0;
      while (list[k] != null && list[k] > from) k++;
      list[k] = to;
      e.lane = k;
    });
  graph.edges.forEach(function (e) {
    if (e.back) return;
    var a = byKey[e.from];
    if (e.bus) {
      var busY = e.side === 'low'
        ? snap(bottom + px(6 + backs * 2 + e.lane * TRACK_M * 1.5))
        : snap(top - px(6 + e.lane * TRACK_M * 1.5));
      e.ys = [startY(e), busY, endY(e)];
      e.tracks = [{ e: e, k: 0, ya: e.ys[0], yb: busY }, { e: e, k: 1, ya: busY, yb: e.ys[2] }];
      gaps[a.col].push(e.tracks[0]);
      gaps[byKey[e.to].col - 1].push(e.tracks[1]);
      return;
    }
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
      // Under just the columns it spans, not the whole factory.
      var under = nodes.reduce(function (m, n) {
        return n.col >= b.col && n.col <= a.col ? Math.max(m, n.y + n.h) : m;
      }, Math.max(y0, y1));
      var low = under + px(4 + 2 * k);
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
  setRelated({});
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

export { buildMachineGraph, mountMachineNodes, place, renderMachineView, routeMachineView };
