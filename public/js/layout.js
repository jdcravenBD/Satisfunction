/* Satisfunction — Item view layout: the plan's steps in columns, ordered to cross as little as
   possible. */

import { COL_GAP, ROW_GAP, graph, itemName, pins, setGraph, state } from './core.js';
import { routeMachineView } from './machines.js';

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
    // In the machine view a belt skipping several columns runs on a bus
    // above the factory instead of through every column in between.
    e.bus = machines && b.col - a.col >= 3;
    if (e.bus) return;
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

  /**
   * Crossings between a column and the next one: the lines in order of
   * where they leave, counting each pair whose ends come the other way
   * round (a merge sort, so a big factory doesn't take forever).
   */
  function crossingsAfter(c3) {
    if (c3 < 0 || c3 >= maxC) return 0;
    var pairs = [];
    layers[c3].forEach(function (u) {
      u.lo.forEach(function (l) { pairs.push([u.idx, l.b.idx]); });
    });
    pairs.sort(function (p, q) { return p[0] - q[0] || p[1] - q[1]; });
    var ends = pairs.map(function (p) { return p[1]; });
    var count = 0;
    (function sortCount(list) {
      if (list.length < 2) return list;
      var half = list.length >> 1;
      var a = sortCount(list.slice(0, half)), b = sortCount(list.slice(half));
      var out = [], i = 0, j = 0;
      while (i < a.length || j < b.length) {
        if (j >= b.length || (i < a.length && a[i] <= b[j])) out.push(a[i++]);
        else { count += a.length - i; out.push(b[j++]); }
      }
      return out;
    })(ends);
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

  // Crossings among two neighbours' own lines, u above v. Swapping them
  // changes nothing else, so that's all a swap needs to compare.
  function pairCrossings(u, v) {
    var c = 0;
    u.lo.forEach(function (x) { v.lo.forEach(function (y) { if (x.b.idx > y.b.idx) c++; }); });
    u.li.forEach(function (x) { v.li.forEach(function (y) { if (x.a.idx > y.a.idx) c++; }); });
    return c;
  }

  function transpose() {
    var improved = true;
    var rounds = 0;
    while (improved && rounds++ < 6) {
      improved = false;
      for (var c5 = 0; c5 <= maxC; c5++) {
        var layer = layers[c5];
        for (var j = 0; j + 1 < layer.length; j++) {
          var u = layer[j], v = layer[j + 1];
          if (pairCrossings(v, u) < pairCrossings(u, v)) {
            layer[j] = v;
            layer[j + 1] = u;
            v.idx = j;
            u.idx = j + 1;
            improved = true;
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

/**
 * The Machine view, a floor at a time: each floor is laid out on its own,
 * then they're stacked like the building, the top floor highest, each in a
 * band with its name. With one floor picked, only that one shows.
 */
var FLOOR_GAP = 96;     // between one floor's band and the next
var FLOOR_HEAD = 40;    // room at the top of a band for its name
var FLOOR_PAD = 24;     // round the edge of a band
function layoutFloors() {
  var full = graph;
  var floors = full.floors || [];
  if (floors.length < 2) {
    layout();
    return;
  }
  var shown = floors.indexOf(state.floorShown) >= 0 ? [state.floorShown] : floors.slice().reverse();
  var bands = [];
  var keep = { nodes: [], edges: [], byKey: {} };
  var y = 0;
  shown.forEach(function (f) {
    var nodes = full.nodes.filter(function (n) { return n.floor === f; });
    if (!nodes.length) return;
    var byKey = {};
    nodes.forEach(function (n) { byKey[n.key] = n; });
    // Belts never cross floors here: those that did now end at lifts.
    var edges = full.edges.filter(function (e) { return byKey[e.from]; });
    setGraph({ nodes: nodes, edges: edges, byKey: byKey });
    layout();
    var box = { top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity };
    function grow(x0, y0, x1, y1) {
      box.left = Math.min(box.left, x0);
      box.right = Math.max(box.right, x1);
      box.top = Math.min(box.top, y0);
      box.bottom = Math.max(box.bottom, y1);
    }
    nodes.forEach(function (n) { grow(n.x, n.y, n.x + n.w, n.y + n.h); });
    edges.forEach(function (e) { (e.route || []).forEach(function (p) { grow(p[0], p[1], p[0], p[1]); }); });
    var dy = y + FLOOR_PAD + FLOOR_HEAD - box.top;
    nodes.forEach(function (n) { n.y += dy; n.cy += dy; });
    edges.forEach(function (e) {
      if (e.route) e.route = e.route.map(function (p) { return [p[0], p[1] + dy]; });
    });
    bands.push({ floor: f, top: y, bottom: box.bottom + dy + FLOOR_PAD, left: box.left - FLOOR_PAD, right: box.right + FLOOR_PAD });
    y = box.bottom + dy + FLOOR_PAD + FLOOR_GAP;
    keep.nodes = keep.nodes.concat(nodes);
    keep.edges = keep.edges.concat(edges);
    Object.assign(keep.byKey, byKey);
  });
  // Every band as wide as the widest, so the floors line up.
  var left = Math.min.apply(null, bands.map(function (b) { return b.left; }));
  var right = Math.max.apply(null, bands.map(function (b) { return b.right; }));
  bands.forEach(function (b) { b.left = left; b.right = right; });
  // Cards for floors not shown were made anyway; they go.
  full.nodes.forEach(function (n) { if (!keep.byKey[n.key] && n.el) n.el.remove(); });
  keep.floors = floors;
  keep.bands = bands;
  setGraph(keep);
}

export { layout, layoutFloors };
