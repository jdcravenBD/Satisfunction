/* Satisfunction — production planner.
   Built on the GCL board shell: same pan/zoom canvas, curved wires, menus and
   history. Instead of cards the user places, the canvas shows a plan the
   solver generates from the outputs asked for. The user steers it by picking
   recipes, importing items, and dragging nodes where they want them. */

(function () {
  'use strict';

  var DATA = window.SF_DATA;
  var SOLVER = window.SF_SOLVER;

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
    supply: {},    // raw item -> { nodes: ['pure', ...], miner }
    clock: 'even', // how part-machines are split: 'even' or 'fill'
    pins: {},      // node key -> { x, y }, for nodes moved in the item view
    defaultMiner: 'Build_MinerMk1_C',
    view: { x: 60, y: 40, s: 1 },
    mode: 'items', // 'items' or 'machines'
    panel: true
  };

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
  function currentRecipe(id) {
    if (state.imports[id]) return null;
    var rid = state.recipes[id];
    return rid && DATA.recipes[rid] ? rid : DATA.defaults[id] || null;
  }

  /** The user's supply setting for a raw input, with plan defaults filled in. */
  function supplyOf(id) {
    var s = state.supply[id] || {};
    return { nodes: s.nodes || [], miner: s.miner || state.defaultMiner };
  }

  function supplyInfo(id) {
    return SOLVER.supplyInfo(DATA, id, supplyOf(id));
  }

  /** Most each raw input can supply, for the ones with resource nodes set. */
  function currentCaps() {
    var caps = {};
    Object.keys(state.supply).forEach(function (id) {
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
        list: SOLVER.clocks(used / info.baseRate, state.clock).map(function (c) {
          return { purity: null, clock: c };
        })
      };
    }
    if (!info.nodes.length) return null;
    var ratio = info.capacity > EPS ? Math.min(1, used / info.capacity) : 0;
    return {
      info: info,
      list: info.nodes.map(function (p) { return { purity: p, clock: ratio }; })
    };
  }

  function titleCase(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

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

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return;
      adopt(JSON.parse(raw));
    } catch (e) {
      console.warn('Could not read saved plan:', e);
    }
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
      if (DATA.recipes[data.recipes[id]]) state.recipes[id] = data.recipes[id];
    });
    state.imports = {};
    Object.keys(data.imports || {}).forEach(function (id) {
      if (data.imports[id] && DATA.items[id]) state.imports[id] = true;
    });
    state.supply = {};
    Object.keys(data.supply || {}).forEach(function (id) {
      var s = data.supply[id];
      if (!s || !DATA.items[id] || !DATA.items[id].raw) return;
      state.supply[id] = {
        nodes: (Array.isArray(s.nodes) ? s.nodes : []).filter(function (p) {
          return SOLVER.PURITIES.indexOf(p) >= 0;
        }),
        miner: DATA.extractors[s.miner] ? s.miner : undefined
      };
    });
    state.clock = data.clock === 'fill' ? 'fill' : 'even';
    state.pins = data.pins && typeof data.pins === 'object' ? data.pins : {};
    if (DATA.extractors[data.defaultMiner]) state.defaultMiner = data.defaultMiner;
    if (data.view && isFinite(data.view.s)) state.view = data.view;
    if (data.mode === 'machines' || data.mode === 'items') state.mode = data.mode;
    if (typeof data.panel === 'boolean') state.panel = data.panel;
    return true;
  }

  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeNow, 250);
    scheduleCommit();
  }

  function writeNow() {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Could not save plan:', e);
    }
  }

  /* --------------------------------------------------------------- history */

  // Snapshot-based undo. The camera, the panel and which view is showing are
  // deliberately left out — looking around isn't an edit.
  var undoStack = [];
  var redoStack = [];
  var lastSnap = null;
  var commitTimer = null;
  var MAX_HISTORY = 80;

  var UNDOABLE = ['name', 'targets', 'recipes', 'imports', 'supply', 'clock', 'pins'];

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
    UNDOABLE.forEach(function (k) { state[k] = d[k]; });
    boardNameInput.value = state.name || '';
    refreshClockSeg();
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

  var CELL = 44; // must match --cell in styles.css

  function applyView() {
    var v = state.view;
    world.style.transform =
      'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.s + ')';

    // Drag the plus field along with the nodes, and scale it with the zoom,
    // so the canvas reads as one surface rather than a fixed backdrop.
    var cell = CELL * v.s;
    stage.style.backgroundSize = cell + 'px ' + cell + 'px';
    stage.style.backgroundPosition = v.x + 'px ' + v.y + 'px';

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
    return stage.clientWidth - (state.panel ? panelEl.offsetWidth + 20 : 0);
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
    solved = SOLVER.solve(DATA, {
      targets: state.targets,
      recipes: state.recipes,
      imports: state.imports,
      caps: currentCaps()
    });

    errorEl.hidden = !solved.error;
    errorEl.textContent = solved.error || '';

    world.classList.toggle('machines', state.mode === 'machines');
    if (state.mode === 'machines') {
      buildMachineGraph();
      mountMachineNodes();
    } else {
      buildGraph();
      mountNodes();
    }
    layout();
    if (state.mode === 'machines') assignPorts();
    graph.nodes.forEach(place);
    renderWires();
    renderBreakdown();
    refreshMaxRates();
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
    Object.keys(solved.items).forEach(function (id) {
      var e = solved.items[id];
      if (e.supplied > EPS) add({ key: 'raw:' + id, kind: 'raw', item: id, rate: e.supplied });
    });
    // Each output is a node of its own, fed like any other consumer.
    Object.keys(solved.targets).forEach(function (id) {
      var rate = solved.targets[id];
      if (rate > EPS) add({ key: 'out:' + id, kind: 'output', item: id, rate: rate });
    });

    // One edge per source, destination and item.
    var edgeMap = {};
    var edges = [];
    solved.flows.forEach(function (f) {
      var k = f.from + '>' + f.to + '>' + f.item;
      if (!edgeMap[k]) {
        edgeMap[k] = { from: f.from, to: f.to, item: f.item, rate: 0 };
        edges.push(edgeMap[k]);
      }
      edgeMap[k].rate += f.rate;
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
    var colGap = machines ? 110 : COL_GAP;
    var rowGap = machines ? 44 : ROW_GAP;

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

    var fwd = graph.edges.filter(function (e) { return !back.has(e); });
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
    // offset from the node's middle: machine blocks take belts in at the top
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
        var d = { key: 'via' + seq++, dummy: true, col: c2, w: 0, h: DUMMY_H, lo: [], li: [] };
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

    // Columns are as wide as their widest node: machine blocks vary a lot.
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
      machine.appendChild(document.createTextNode(machineName(n.rid) + ' '));
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
        label = supplyLabel(n.item, info);
        menu = openSupplyMenu;
        recipeBtn.title = 'Choose resource nodes';
        if (!info || !info.purity) {
          // Water Extractors go anywhere; there's nothing to choose.
          recipeBtn.disabled = true;
          recipeBtn.title = '';
        }
        if (entry && entry.cap != null) {
          note('Uses ' + fmtNum(entry.supplied) + ' of ' + rateText(n.item, entry.cap));
          if (entry.short > EPS) {
            el.classList.add('short');
            note('Short by ' + rateText(n.item, entry.short), 'warn');
          }
          if (solved.limitedBy === n.item) note('Sets the max output');
        }
        if (readOnly && n.kind === 'raw') {
          note('Pick a node purity in the Items view to place its ' +
            (isFluid(n.item) ? 'extractors' : 'miners'));
        }
      } else if (state.imports[n.item]) {
        label = 'Imported';
        recipeBtn.title = 'Make it here instead';
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

    el.addEventListener('pointerenter', function () { focusNode(n.key, true); });
    el.addEventListener('pointerleave', function () { focusNode(n.key, false); });

    // The machine view is a picture of the build: nothing on it is edited or
    // moved. Recipes and nodes are changed in the Items view.
    if (readOnly) {
      recipeBtn.disabled = true;
      recipeBtn.removeAttribute('title');
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

  /* ------------------------------------------------------------- machines */

  var PX_PER_M = 8;                // machine view scale: pixels per metre in game
  var LANE = 14;                   // spacing between side-by-side manifold belts
  var BRANCH = 26;                 // belt run between a manifold and a machine port
  var BLOCK_PAD = 14;
  var MACHINE_GAP = 2 * PX_PER_M;  // 2 m between neighbouring machines
  var LOGI = 32;                   // splitters and mergers: 4 m square

  // Throughput of each belt and pipe tier, per minute.
  var BELTS = [60, 120, 270, 480, 780, 1200];
  var PIPES = [300, 600];

  /** "Mk.2": the slowest belt or pipe that carries this rate, or null if none does. */
  function beltTier(id, rate) {
    var tiers = isFluid(id) ? PIPES : BELTS;
    for (var i = 0; i < tiers.length; i++) {
      if (rate <= tiers[i] + 1e-6) return 'Mk.' + (i + 1);
    }
    return null;
  }

  /** On-screen size of a building: its length across, its width down. */
  function machineSize(size) {
    return {
      w: Math.max(46, Math.round((size ? size.l : 10) * PX_PER_M)),
      h: Math.max(34, Math.round((size ? size.w : 8) * PX_PER_M))
    };
  }

  /**
   * One building, drawn top-down at its real footprint with belts running
   * left to right through it. Input ports sit on the left edge and outputs on
   * the right, hollow for pipes.
   */
  function machineShape(size, name, sub, clock, ins, outs) {
    var m = document.createElement('div');
    m.className = 'machine';
    if (clock < 1 - 1e-6) m.classList.add('under');
    var px = machineSize(size);
    m.style.width = px.w + 'px';
    m.style.height = px.h + 'px';
    m.title = name + ' · ' + Number((clock * 100).toFixed(4)) + '% clock' +
      (size ? ' · ' + size.l + ' × ' + size.w + ' m' : '');

    var label = document.createElement('span');
    label.className = 'm-name';
    label.textContent = name;
    var clockEl = document.createElement('span');
    clockEl.className = 'm-sub';
    clockEl.textContent = sub;
    m.appendChild(label);
    m.appendChild(clockEl);

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
   * The machine view's graph. Each production step becomes a block of its
   * buildings, and each resource with known nodes a block of its miners or
   * extractors. Between blocks every item runs on one belt or pipe: where
   * several blocks make it, mergers join them; where several use it,
   * splitters share it out. Unused byproducts run to a "spare" end.
   */
  function buildMachineGraph() {
    var nodes = [];
    var byKey = {};
    var edges = [];

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

    Object.keys(solved.recipes).forEach(function (rid) {
      var r = DATA.recipes[rid];
      var s = solved.recipes[rid];
      var spec = DATA.machines[r.machine];
      add({
        key: 'r:' + rid, kind: 'bank', rid: rid, item: s.item, count: s.count,
        ins: r.in.map(function (p) { return p[0]; }),
        outs: r.out.map(function (p) { return p[0]; }),
        size: spec.size,
        machines: SOLVER.clocks(s.count, state.clock).map(function (c) {
          return { name: spec.name, clock: c, sub: fmtClock(c) };
        })
      });
    });

    Object.keys(solved.items).forEach(function (id) {
      var e = solved.items[id];
      if (e.supplied > EPS) {
        var ex = DATA.items[id].raw ? extractorsFor(id, e.supplied) : null;
        if (ex) {
          var spec = DATA.extractors[ex.info.extractor];
          add({
            key: 'raw:' + id, kind: 'extract', item: id, rate: e.supplied,
            ins: [], outs: [id], size: spec.size,
            machines: ex.list.map(function (m) {
              return {
                name: spec.name,
                clock: m.clock,
                sub: (m.purity ? titleCase(m.purity) + ' · ' : '') + fmtClock(m.clock)
              };
            })
          });
        } else {
          add({ key: 'raw:' + id, kind: 'raw', item: id, rate: e.supplied });
        }
      }
      if (e.surplus > EPS) add({ key: 'spare:' + id, kind: 'spare', item: id, rate: e.surplus });
    });

    Object.keys(solved.targets).forEach(function (id) {
      var rate = solved.targets[id];
      if (rate > EPS) add({ key: 'out:' + id, kind: 'output', item: id, rate: rate });
    });

    // One belt per item: merge every source, then split to every user.
    var seq = 0;
    Object.keys(solved.items).forEach(function (id) {
      var e = solved.items[id];
      function tally(list) {
        var sums = {};
        list.forEach(function (p) {
          if (byKey[p.node] && p.rate > EPS) sums[p.node] = (sums[p.node] || 0) + p.rate;
        });
        return Object.keys(sums).map(function (k) { return { key: k, rate: sums[k] }; });
      }
      var src = tally(e.producers);
      var dst = tally(e.consumers.concat(e.surplus > EPS ? [{ node: 'spare:' + id, rate: e.surplus }] : []))
        .filter(function (d) {
          // A step that feeds on its own output keeps that loop internal.
          return !src.some(function (s) { return s.key === d.key; });
        });
      if (!src.length || !dst.length) return;
      var fluid = isFluid(id);
      var total = dst.reduce(function (sum, d) { return sum + d.rate; }, 0);

      var head = src[0].key;
      if (src.length > 1) {
        // Mergers take three belts in; a chain of them takes any number.
        var carry = null;
        var carried = 0;
        var waiting = src.slice();
        while (waiting.length) {
          var m = add({ key: 'mrg:' + id + ':' + seq++, kind: 'merger', item: id, fluid: fluid });
          if (carry) link(carry, m.key, id, carried);
          waiting.splice(0, carry ? 2 : 3).forEach(function (s) {
            link(s.key, m.key, id, s.rate);
            carried += s.rate;
          });
          carry = m.key;
        }
        head = carry;
      }

      if (dst.length === 1) {
        link(head, dst[0].key, id, total);
        return;
      }
      // Splitters send three ways; past three users they chain.
      var from = head;
      var left = total;
      var rest = dst.slice();
      while (rest.length) {
        var sp = add({ key: 'spl:' + id + ':' + seq++, kind: 'splitter', item: id, fluid: fluid });
        link(from, sp.key, id, left);
        rest.splice(0, rest.length <= 3 ? rest.length : 2).forEach(function (d) {
          link(sp.key, d.key, id, d.rate);
          left -= d.rate;
        });
        from = sp.key;
      }
    });

    graph = { nodes: nodes, edges: edges, byKey: byKey };
  }

  function mountMachineNodes() {
    world.querySelectorAll('.node').forEach(function (el) { el.remove(); });
    graph.nodes.forEach(function (n) {
      if (n.kind === 'bank' || n.kind === 'extract') {
        buildBlock(n);
      } else if (n.kind === 'splitter' || n.kind === 'merger') {
        buildLogistic(n);
      } else {
        n.el = buildNode(n);
        n.el.style.width = NODE_W + 'px';
        world.appendChild(n.el);
        n.w = NODE_W;
        n.h = n.el.offsetHeight;
      }
    });
  }

  /**
   * A block of identical buildings on a manifold. Machines stand in one
   * column. Each input comes in at the top left and runs down its own belt
   * beside the column, with a splitter feeding each machine and the last one
   * fed by the belt's end. Outputs run the same way on the right, merged in
   * machine by machine, and leave at the bottom right.
   */
  function buildBlock(n) {
    var el = buildNode(n);
    el.classList.add('block');
    var nIn = n.ins.length;
    var nOut = n.outs.length;
    var px = machineSize(n.size);
    var mx = BLOCK_PAD + (nIn ? nIn * LANE + BRANCH : 0);
    var laneOut0 = mx + px.w + BRANCH;
    var inner = nOut ? laneOut0 + (nOut - 1) * LANE + BLOCK_PAD + 6 : mx + px.w + BLOCK_PAD;
    var W = Math.max(NODE_W, inner);
    el.style.width = W + 'px';
    world.appendChild(el);

    // The header decides where the first machine can start.
    var head = el.offsetHeight + 6;
    var rows = n.machines.map(function (_, k) { return head + k * (px.h + MACHINE_GAP); });
    var H = rows[rows.length - 1] + px.h + BLOCK_PAD;
    el.style.height = H + 'px';

    n.machines.forEach(function (m, k) {
      var shape = machineShape(n.size, m.name, m.sub, m.clock, n.ins, n.outs);
      shape.style.left = mx + 'px';
      shape.style.top = rows[k] + 'px';
      el.appendChild(shape);
    });

    function inY(k, i) { return rows[k] + px.h * (i + 1) / (nIn + 1); }
    function outY(k, j) { return rows[k] + px.h * (j + 1) / (nOut + 1); }
    var last = rows.length - 1;

    n.el = el;
    n.w = W;
    n.h = H;
    // Any input port takes any input, so the order items meet the ports in
    // is free. It starts as the recipe's, and assignPorts can reorder it to
    // match where the belts arrive from.
    n.setPorts = function () {
      n.ports = { in: {}, out: {} };
      n.ins.forEach(function (id, i) { n.ports.in[id] = { x: 0, y: inY(0, i) }; });
      n.outs.forEach(function (id, j) { n.ports.out[id] = { x: W, y: outY(last, j) }; });
      el.querySelectorAll('.machine').forEach(function (shape) {
        shape.querySelectorAll('.m-port.in').forEach(function (dot, i) {
          dot.classList.toggle('fluid', isFluid(n.ins[i]));
        });
        shape.querySelectorAll('.m-port.out').forEach(function (dot, j) {
          dot.classList.toggle('fluid', isFluid(n.outs[j]));
        });
      });
    };
    n.setPorts();
    n.geo = {
      W: W, mx: mx, mw: px.w, rows: rows, inY: inY, outY: outY,
      // The top port's belt runs nearest the machines, so a belt entering
      // lower down never has to cross one that's already running.
      laneIn: function (i) { return BLOCK_PAD + (nIn - 1 - i) * LANE; },
      laneOut: function (j) { return laneOut0 + j * LANE; }
    };
  }

  /**
   * Once blocks are placed, give each item the port that faces where its belt
   * goes: outputs in the order of what they feed, top to bottom, then inputs
   * in the order of where they come from. Belts then fan in and out without
   * crossing at the block.
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
    var blocks = graph.nodes.filter(function (n) { return n.setPorts; });
    blocks.forEach(function (n) {
      n.outs = rank(n.outs, function (id) {
        var e = n.out.filter(function (o) { return o.item === id; })[0];
        if (!e) return Infinity;
        return e.via.length ? e.via[0].y : portY(byKey[e.to], 'in', id);
      });
      n.setPorts();
    });
    blocks.forEach(function (n) {
      n.ins = rank(n.ins, function (id) {
        var e = n.inn.filter(function (o) { return o.item === id; })[0];
        if (!e) return Infinity;
        return e.via.length ? e.via[e.via.length - 1].y : portY(byKey[e.from], 'out', id);
      });
      n.setPorts();
    });
  }

  var LOGI_ICONS = {
    splitter: 'M5 16 H14 M14 16 L27 7 M14 16 H27 M14 16 L27 25',
    merger: 'M5 7 L18 16 M5 16 H18 M5 25 L18 16 M18 16 H27',
    junction: 'M5 16 H27 M16 5 V27'
  };

  /** A splitter, merger, or for pipes a junction: a 4 m square with its glyph. */
  function buildLogistic(n) {
    var kind = n.fluid ? 'junction' : n.kind;
    var el = document.createElement('div');
    el.className = 'node logi' + (n.fluid ? ' fluid' : '');
    el.dataset.key = n.key;
    el.style.width = LOGI + 'px';
    el.style.height = LOGI + 'px';
    el.title = (n.fluid ? 'Pipeline Junction' : titleCase(n.kind)) + ' · ' + itemName(n.item);
    el.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="' + LOGI_ICONS[kind] + '"/></svg>';
    el.addEventListener('pointerenter', function () { focusNode(n.key, true); });
    el.addEventListener('pointerleave', function () { focusNode(n.key, false); });
    world.appendChild(el);
    n.el = el;
    n.w = LOGI;
    n.h = LOGI;
  }

  function place(n) {
    n.el.style.left = n.x + 'px';
    n.el.style.top = n.y + 'px';
    n.el.classList.toggle('pinned', !!n.pinned);
  }

  /* ---------------------------------------------------------------- wires */

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var wires = document.getElementById('wires');
  var belts = document.getElementById('belts');  // manifolds, drawn over their blocks
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
    while (belts.firstChild) belts.removeChild(belts.firstChild);
    labelsEl.innerHTML = '';
    related = {};

    var byKey = graph.byKey;
    var machines = state.mode === 'machines';

    // A moved node breaks the route layout planned, so its lines go direct.
    function viaOf(e) {
      if (byKey[e.from].pinned || byKey[e.to].pinned) return [];
      return e.via || [];
    }
    function centerY(key) { var n = byKey[key]; return n.y + n.h / 2; }
    function nextY(e) { var v = viaOf(e); return v.length ? v[0].y : centerY(e.to); }
    function prevY(e) { var v = viaOf(e); return v.length ? v[v.length - 1].y : centerY(e.from); }

    // Machine blocks have a fixed port for each item. Everything else spreads
    // its lines along its edge, in the order of whatever is at the other end,
    // so they leave and arrive without crossing each other.
    var outPos = {};
    var inPos = {};
    graph.nodes.forEach(function (n) {
      var outs = n.out.slice().sort(function (a, b) { return nextY(a) - nextY(b); });
      outs.forEach(function (e, i) {
        var p = n.ports && n.ports.out[e.item];
        outPos[edgeId(e)] = p
          ? { x: n.x + p.x, y: n.y + p.y }
          : { x: n.x + n.w, y: n.y + n.h * (i + 1) / (outs.length + 1) };
      });
      var ins = n.inn.slice().sort(function (a, b) { return prevY(a) - prevY(b); });
      ins.forEach(function (e, i) {
        var p = n.ports && n.ports.in[e.item];
        inPos[edgeId(e)] = p
          ? { x: n.x + p.x, y: n.y + p.y }
          : { x: n.x, y: n.y + n.h * (i + 1) / (ins.length + 1) };
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
      // In the machine view, the slowest belt or pipe that will carry it.
      if (machines) {
        var tier = beltTier(e.item, e.rate);
        var t = document.createElement('span');
        t.className = 'fl-tier' + (tier ? '' : ' warn');
        t.textContent = tier || (fluid ? 'over one pipe' : 'over one belt');
        t.title = tier
          ? (fluid ? 'Pipeline ' : 'Conveyor Belt ') + tier + ' or faster'
          : 'More than the fastest ' + (fluid ? 'pipe' : 'belt') + ' carries; it needs a second line';
        label.appendChild(t);
      }
      labelsEl.appendChild(label);
      relate(keys, label);
    });

    if (machines) {
      graph.nodes.forEach(function (n) { if (n.geo) drawManifold(n); });
    }

    if (hovered) focusNode(hovered, true);
  }

  /**
   * A block's manifolds, over its machines. Inputs: in at the top left, down a
   * belt beside the machines, a splitter at each machine and the belt's end
   * turning into the last one. Outputs: each machine merged onto a belt on the
   * right, which leaves at the bottom right.
   */
  function drawManifold(n) {
    var g = n.geo;
    var bx = n.x;
    var by = n.y;
    var last = g.rows.length - 1;

    function marker(x, y, fluid, what, id) {
      var el = fluid
        ? svg('circle', { cx: x, cy: y, r: 4.5, 'class': 'belt-node fluid' }, belts)
        : svg('rect', { x: x - 5, y: y - 5, width: 10, height: 10, rx: 1.5, 'class': 'belt-node' }, belts);
      var title = document.createElementNS(SVG_NS, 'title');
      title.textContent = (fluid ? 'Pipeline Junction' : what) + ' · ' + itemName(id);
      el.appendChild(title);
    }

    n.ins.forEach(function (id, i) {
      var fluid = isFluid(id);
      var lx = bx + g.laneIn(i);
      var ys = g.rows.map(function (_, k) { return by + g.inY(k, i); });
      var d = 'M ' + bx + ' ' + ys[0] + ' H ' + lx + ' V ' + ys[last];
      ys.forEach(function (y) { d += ' M ' + lx + ' ' + y + ' H ' + (bx + g.mx); });
      line(d, fluid, [], belts);
      for (var k = 0; k < last; k++) marker(lx, ys[k], fluid, 'Splitter', id);
    });

    n.outs.forEach(function (id, j) {
      var fluid = isFluid(id);
      var lx = bx + g.laneOut(j);
      var ys = g.rows.map(function (_, k) { return by + g.outY(k, j); });
      var d = '';
      ys.forEach(function (y) { d += 'M ' + (bx + g.mx + g.mw) + ' ' + y + ' H ' + lx + ' '; });
      d += 'M ' + lx + ' ' + ys[0] + ' V ' + ys[last] + ' H ' + (bx + g.W);
      line(d, fluid, [], belts);
      for (var k = 1; k <= last; k++) marker(lx, ys[k], fluid, 'Merger', id);
    });
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
      var origin = { x: n.x, y: n.y };
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
        n.x = Math.round(origin.x + dx);
        n.y = Math.round(origin.y + dy);
        n.pinned = true;
        pins()[n.key] = { x: n.x, y: n.y };
        place(n);
        renderWires(); // lines follow the node as it moves
      }

      function onUp(ev) {
        try { el.releasePointerCapture(ev.pointerId); } catch (err) { /* never captured */ }
        el.classList.remove('dragging');
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        dragging = false;
        if (moved) save();
      }

      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });
  }

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
    var n = graph.byKey[key];
    if (!n) return;
    var v = state.view;
    v.x = usableWidth() / 2 - (n.x + n.w / 2) * v.s;
    v.y = stage.clientHeight / 2 - (n.y + n.h / 2) * v.s;
    applyView();
    writeNow();
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

  /** Draws the selection rectangle. Purely visual at this stage. */
  function startMarquee(e) {
    var box = stage.getBoundingClientRect();
    var x0 = e.clientX - box.left;
    var y0 = e.clientY - box.top;

    marquee.classList.add('on');
    marquee.style.left = x0 + 'px';
    marquee.style.top = y0 + 'px';
    marquee.style.width = '0px';
    marquee.style.height = '0px';

    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }

    function onMove(ev) {
      var x1 = ev.clientX - box.left;
      var y1 = ev.clientY - box.top;
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

  document.getElementById('add').addEventListener('click', function () {
    askForOutput(this);
  });

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
  document.addEventListener('pointerdown', function (e) {
    if (confirmEl.contains(e.target) || itemPop.contains(e.target)) return;
    if (!ctx.contains(e.target)) closeCtx();
    closeConfirm();
    closeItemPicker();
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

      items.push({ head: 'Recipe for ' + itemName(id) });
      list.forEach(function (rid) {
        var r = DATA.recipes[rid];
        items.push({
          label: r.name,
          tag: r.alt ? 'ALT' : (r.out[0][0] !== id ? 'SIDE' : null),
          note: recipeSummary(rid),
          on: rid === current,
          run: function () {
            if (rid === def) delete state.recipes[id];
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
      var nodes = info.nodes;
      var set = function (list, miner) {
        var s = supplyOf(id);
        state.supply[id] = { nodes: list, miner: miner || s.miner };
        changed();
      };
      var perNode = function (p) { return rateText(id, info.perNode(p)) + ' per node'; };
      var exName = DATA.extractors[info.extractor].name;

      items.push({ head: 'Resource node · ' + exName });
      items.push({
        label: 'Any node',
        note: 'As much as the plan needs',
        on: !nodes.length,
        run: function () { set([]); }
      });
      SOLVER.PURITIES.forEach(function (p) {
        items.push({
          label: titleCase(p),
          note: perNode(p),
          on: nodes.length === 1 && nodes[0] === p,
          run: function () { set([p]); }
        });
      });

      if (nodes.length) {
        items.push('-');
        items.push({ head: 'Add another node' });
        SOLVER.PURITIES.forEach(function (p) {
          items.push({ label: '+ ' + titleCase(p), note: perNode(p), run: function () { set(nodes.concat([p])); } });
        });
        if (nodes.length > 1) {
          items.push({ head: nodes.length + ' nodes · ' + rateText(id, info.capacity) + ' total' });
          nodes.forEach(function (p, i) {
            items.push({
              label: titleCase(p) + ' node',
              note: 'Click to remove',
              run: function () { set(nodes.filter(function (_, j) { return j !== i; })); }
            });
          });
        }
      }

      if (!isFluid(id)) {
        items.push('-');
        items.push({ head: 'Miner' });
        ['Build_MinerMk1_C', 'Build_MinerMk2_C', 'Build_MinerMk3_C'].forEach(function (mid) {
          var ex = DATA.extractors[mid];
          if (!ex) return;
          items.push({
            label: ex.name,
            note: rateText(id, ex.rate) + ' on a normal node',
            on: info.extractor === mid,
            run: function () {
              // New resources start on whichever miner was picked last.
              state.defaultMiner = mid;
              set(nodes, mid);
            }
          });
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

  /** Adds an output (or finds the existing one) and puts the caret in its rate. */
  function addTarget(id) {
    var wasEmpty = !state.targets.length;
    var index = -1;
    state.targets.forEach(function (t, i) { if (t.item === id) index = i; });
    if (index < 0) {
      state.targets.push({ item: id, rate: NEW_TARGET_RATE });
      index = state.targets.length - 1;
      renderTargets();
      changed();
      if (wasEmpty) fitView();
    }
    setPanelOpen(true);
    var input = targetsEl.querySelectorAll('.t-rate')[index];
    if (input) {
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

  var panelEl = document.getElementById('panel');
  var breakdownEl = document.getElementById('breakdown');

  function setPanelOpen(open) {
    state.panel = open;
    panelEl.classList.toggle('show', open);
    document.getElementById('panel-toggle').classList.toggle('primary', open);
    centreEmptyHint();
    writeNow();
  }

  document.getElementById('panel-toggle').addEventListener('click', function () {
    setPanelOpen(!state.panel);
  });
  document.getElementById('panel-close').addEventListener('click', function () {
    setPanelOpen(false);
  });

  function group(title, sub, rows) {
    var wrap = document.createElement('div');
    wrap.className = 'sum-group';
    var head = document.createElement('div');
    head.className = 'sum-group-head';
    var name = document.createElement('span');
    name.className = 'sum-group-name';
    name.textContent = title;
    var count = document.createElement('span');
    count.className = 'sum-group-count';
    count.textContent = sub || '';
    head.appendChild(name);
    head.appendChild(count);
    wrap.appendChild(head);
    rows.forEach(function (r) { wrap.appendChild(r); });
    return wrap;
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

    var power = 0;
    var buildings = 0;
    var byMachine = {};
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
      tally(mid, DATA.machines[mid].name, count,
        SOLVER.clocks(count, state.clock).length,
        SOLVER.recipePower(DATA, rid, count, state.clock));
    });
    // Extractors count too, wherever the plan knows what they are.
    Object.keys(solved.items).forEach(function (id) {
      var e = solved.items[id];
      if (!(e.supplied > EPS) || !DATA.items[id].raw) return;
      var ex = extractorsFor(id, e.supplied);
      if (!ex) return;
      var clocksList = ex.list.map(function (m) { return m.clock; });
      tally(ex.info.extractor, DATA.extractors[ex.info.extractor].name,
        clocksList.reduce(function (s, c) { return s + c; }, 0),
        clocksList.length,
        SOLVER.extractorPower(DATA, ex.info.extractor, clocksList));
    });

    var steps = Object.keys(solved.recipes).length;
    document.getElementById('stat-machines').textContent = buildings;
    document.getElementById('stat-power').textContent = fmtPower(power);
    document.getElementById('stat-steps').textContent = steps;
    document.getElementById('total').textContent = fmtPower(power);
    document.getElementById('total-machines').textContent =
      buildings ? buildings + (buildings === 1 ? ' machine' : ' machines') : '';

    // Raw inputs: what has to arrive from outside this factory.
    var raws = Object.keys(solved.items)
      .filter(function (id) { return solved.items[id].supplied > EPS; })
      .sort(function (a, b) { return solved.items[b].supplied - solved.items[a].supplied; });
    if (raws.length) {
      breakdownEl.appendChild(group('Inputs', 'from outside', raws.map(function (id) {
        var it = DATA.items[id];
        var e = solved.items[id];
        var short = (!it.raw && !state.imports[id] && !!producersOf[id]) || e.short > EPS;
        var note = it.raw
          ? (e.cap != null ? 'of ' + fmtNum(e.cap) : '')
          : state.imports[id] ? 'imported' : short ? 'shortfall' : 'supplied';
        return row(itemName(id), note, rateText(id, e.supplied),
          function () { focusOn('raw:' + id); }, short);
      })));
    }

    var mids = Object.keys(byMachine).sort(function (a, b) {
      return byMachine[b].built - byMachine[a].built;
    });
    if (mids.length) {
      breakdownEl.appendChild(group('Machines', 'running · built', mids.map(function (mid) {
        var m = byMachine[mid];
        return row(m.name, fmtNum(m.exact) + ' · ' + fmtPower(m.power), String(m.built));
      })));
    }

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

  // Centred in the part of the canvas the panel leaves visible, so the
  // examples are never hidden behind it.
  function centreEmptyHint() {
    emptyHint.style.left = state.panel ? usableWidth() / 2 + 'px' : '';
    emptyHint.style.width = state.panel ? Math.min(560, usableWidth() - 48) + 'px' : '';
  }
  window.addEventListener('resize', centreEmptyHint);

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
        state.targets = ex.targets.map(function (t) { return { item: t.item, rate: t.rate }; });
        if (!state.name) {
          state.name = ex.name;
          boardNameInput.value = state.name;
        }
        renderTargets();
        changed();
        setPanelOpen(true);
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

  // The header wraps onto extra rows on a narrow window. Publishing its real
  // height as --bar-h keeps the canvas tucked underneath instead of covered.
  var barEl = document.querySelector('.bar');

  function syncBarHeight() {
    document.documentElement.style.setProperty(
      '--bar-h', barEl.offsetHeight + 'px'
    );
  }

  if (window.ResizeObserver) new ResizeObserver(syncBarHeight).observe(barEl);
  window.addEventListener('resize', syncBarHeight);
  syncBarHeight();

  /* ------------------------------------------------------------ plan name */

  var boardNameInput = document.getElementById('board-name');

  boardNameInput.addEventListener('input', function () {
    state.name = boardNameInput.value;
    save();
  });
  boardNameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      boardNameInput.blur();
    }
  });

  /** Plan name reduced to something safe to use as a filename. */
  function exportFilename(extension) {
    var base = (state.name || '').trim()
      .replace(/[\\/:*?"<>|]+/g, '')  // characters filesystems reject
      .replace(/\s+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 60);
    return (base || 'satisfunction-plan') + '.' + (extension || 'json');
  }

  document.getElementById('export').addEventListener('click', function () {
    var out = {
      app: 'satisfunction',
      version: 2,
      name: state.name,
      targets: state.targets,
      recipes: state.recipes,
      imports: state.imports,
      supply: state.supply,
      clock: state.clock,
      defaultMiner: state.defaultMiner,
      pins: state.pins,
      mode: state.mode,
      view: state.view
    };
    var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = exportFilename('json');
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });

  document.getElementById('import').addEventListener('click', function () {
    importFile.click();
  });

  importFile.addEventListener('change', async function () {
    var file = importFile.files && importFile.files[0];
    if (!file) return;
    try {
      var data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.targets)) throw new Error('bad file');
      adopt(data);
      boardNameInput.value = state.name;
      refreshModeSeg();
      refreshClockSeg();
      renderTargets();
      changed();
      fitView();
    } catch (e) {
      alert('That file is not a Satisfunction plan export.');
    }
    importFile.value = '';
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
  }

  modeSeg.addEventListener('click', function (e) {
    var btn = e.target.closest('.seg-btn');
    if (!btn || btn.dataset.mode === state.mode) return;
    state.mode = btn.dataset.mode;
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

  /* ------------------------------------------------------------ typeface */

  var FONT_KEY = 'satisfunction.font';
  var fontButtons = [].slice.call(document.querySelectorAll('.font-btn'));

  function setFont(id, persist) {
    document.documentElement.setAttribute('data-font', id);
    fontButtons.forEach(function (b) {
      b.classList.toggle('on', b.dataset.font === id);
    });
    if (persist) {
      try {
        localStorage.setItem(FONT_KEY, id);
      } catch (e) {
        console.warn('Could not save font choice:', e);
      }
    }
    // Node heights depend on the face, so lay the plan out again.
    if (solved) recompute();
  }

  fontButtons.forEach(function (b) {
    b.addEventListener('click', function () { setFont(b.dataset.font, true); });
  });

  /* ----------------------------------------------------------------- boot */

  var savedFont = 'ui';
  try {
    savedFont = localStorage.getItem(FONT_KEY) || 'ui';
  } catch (e) {
    // storage unavailable; stay on the default
  }
  setFont(savedFont, false);

  load();
  boardNameInput.value = state.name || '';
  panelEl.classList.toggle('show', state.panel);
  document.getElementById('panel-toggle').classList.toggle('primary', state.panel);
  refreshModeSeg();
  refreshClockSeg();
  renderTargets();
  applyView();
  recompute();

  // Web fonts can land after the first layout and change node heights.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { recompute(); });
  }

  // Baseline for the history stack: the plan as it was loaded.
  lastSnap = snapshot();
  refreshHistoryButtons();
})();
