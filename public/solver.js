/* Satisfunction — production solver.
 *
 * Turns "I want these items at these rates" into how hard each recipe has to
 * run, and what flows between them. No DOM here, so it runs under Node too.
 *
 * Each item that's made in the factory gets exactly one recipe — the one the
 * user picked, or the game-data default. That gives one balance equation per
 * made item and one unknown per recipe (how many machines' worth it runs), so
 * the system is square and solved directly. Byproducts fall out of that for
 * free: whatever a recipe makes on the side is credited against demand for it,
 * so e.g. water from Aluminum Scrap cuts the water you have to pump.
 *
 * A byproduct can overshoot: more Heavy Oil Residue from plastic than anything
 * wants. The system then asks the residue's own recipe to run backwards. That
 * recipe is dropped, the item becomes byproduct-only, and the solve repeats.
 *
 * Outputs set to "max" share one unknown rate, t. Because the system is
 * linear, every recipe's rate is (fixed part) + t × (max part), and so is the
 * draw on every raw input. The largest t that keeps every capped input within
 * its resource nodes is the answer; all max outputs get that same rate.
 */

(function (root) {
  'use strict';

  var EPS = 1e-9;

  /* ------------------------------------------------------------ extraction */

  var PURITY = { impure: 0.5, normal: 1, pure: 2 };
  var PURITIES = ['impure', 'normal', 'pure'];
  var DEFAULT_MINER = 'Build_MinerMk1_C';
  var WATER_PUMP = 'Build_WaterPump_C';
  var WELL = 'Build_FrackingExtractor_C';

  /**
   * The building that extracts a raw resource: the chosen miner for solids,
   * otherwise the dedicated extractor (Oil or Water Extractor), falling back to
   * a resource well (the only source of Nitrogen Gas).
   */
  function extractorFor(data, item, supply) {
    var it = data.items[item];
    if (!it || !it.raw) return null;
    if (it.form === 'solid') {
      var m = supply && supply.miner;
      return data.extractors[m] ? m : DEFAULT_MINER;
    }
    var ids = Object.keys(data.extractors);
    var fits = function (id) {
      var r = data.extractors[id].resources;
      return r && r.indexOf(item) >= 0;
    };
    return ids.filter(function (id) { return id !== WELL && fits(id); })[0] ||
      (fits(WELL) ? WELL : null);
  }

  /**
   * How a raw input is supplied. `supply` is the user's setting for it:
   * { nodes: [{ purity, miner }], miner } — no nodes means "as needed". A
   * node is a purity ('pure') or { purity, miner }: each solid node can have
   * its own miner, falling back to the resource's. Water Extractors go
   * anywhere, so water has no purity and no cap.
   */
  function supplyInfo(data, item, supply) {
    var ex = extractorFor(data, item, supply);
    if (!ex) return null;
    var rate = data.extractors[ex].rate;
    var purity = ex !== WATER_PUMP;
    var solid = data.items[item].form === 'solid';
    var list = purity && supply && Array.isArray(supply.nodes)
      ? supply.nodes.map(function (n) {
        var p = typeof n === 'string' ? n : n && n.purity;
        if (!PURITY[p]) return null;
        var m = solid && n && typeof n === 'object' && data.extractors[n.miner] ? n.miner : ex;
        return { purity: p, extractor: m, rate: data.extractors[m].rate * PURITY[p] };
      }).filter(Boolean)
      : [];
    return {
      extractor: ex,
      purity: purity,
      nodes: list.map(function (n) { return n.purity; }),
      nodeList: list,
      perNode: function (p) { return rate * (purity ? PURITY[p] : 1); },
      baseRate: rate,
      capacity: list.length
        ? list.reduce(function (s, n) { return s + n.rate; }, 0)
        : null
    };
  }

  /** Caps for every raw input the plan has resource nodes set for. */
  function capsFrom(data, supplies) {
    var caps = {};
    Object.keys(supplies || {}).forEach(function (item) {
      var info = supplyInfo(data, item, supplies[item]);
      if (info && info.capacity != null) caps[item] = info.capacity;
    });
    return caps;
  }

  /* ---------------------------------------------------------------- clocks */

  var MAX_CLOCK = 2.5;

  /**
   * Clock speeds (as fractions) for `count` machines' worth of work. "even"
   * spreads it over the fewest whole machines; "fill" runs all but the last at
   * 100% and underclocks that one; "max" overclocks, up to `top` (250% unless
   * a belt couldn't keep up), over the fewest machines that can take it.
   * "none" leaves every machine at 100%: the list is then each one's share
   * of the work, the last one idling part of the time.
   */
  function clocks(count, mode, top) {
    if (!(count > EPS)) return [];
    if (mode === 'max') {
      top = Math.max(1, Math.min(MAX_CLOCK, top || MAX_CLOCK));
      var m = Math.max(1, Math.ceil(count / top - 1e-6));
      var list = [];
      for (var k = 0; k < m; k++) list.push(count / m);
      return list;
    }
    var n = Math.max(1, Math.ceil(count - 1e-6));
    var out = [];
    if (mode === 'fill' || mode === 'none') {
      var whole = Math.floor(count + 1e-6);
      for (var i = 0; i < whole; i++) out.push(1);
      if (count - whole > 1e-6) out.push(count - whole);
    } else {
      for (var j = 0; j < n; j++) out.push(count / n);
    }
    return out;
  }

  /**
   * Average draw in MW of `count` machines' worth of a recipe. Power scales
   * with clock speed to the power of ~1.32, so how the work is split matters.
   * An unclocked machine draws full power while it works and none while it
   * waits, so there it's simply in proportion.
   */
  function recipePower(data, rid, count, mode, top) {
    var r = data.recipes[rid];
    var m = data.machines[r.machine];
    var base = r.power != null ? r.power : m.power;
    var exp = mode === 'none' ? 1 : m.powerExp;
    return clocks(count, mode, top).reduce(function (s, c) {
      return s + base * Math.pow(c, exp);
    }, 0);
  }

  function extractorPower(data, exId, clockList, mode) {
    var ex = data.extractors[exId];
    var exp = mode === 'none' ? 1 : 1.321929;
    return clockList.reduce(function (s, c) { return s + ex.power * Math.pow(c, exp); }, 0);
  }

  /* ----------------------------------------------------------------- maths */

  /** Items per minute of each input and output, for one machine at 100%. */
  function perMinute(recipe) {
    var k = 60 / recipe.time;
    var net = {};
    recipe.in.forEach(function (p) { net[p[0]] = (net[p[0]] || 0) - p[1] * k; });
    recipe.out.forEach(function (p) { net[p[0]] = (net[p[0]] || 0) + p[1] * k; });
    return net;
  }

  /** Gaussian elimination with partial pivoting. Returns null if singular. */
  function solveLinear(A, b) {
    var n = b.length;
    var M = A.map(function (row, i) { return row.concat([b[i]]); });
    for (var c = 0; c < n; c++) {
      var p = c;
      for (var r = c + 1; r < n; r++) {
        if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      }
      if (Math.abs(M[p][c]) < 1e-12) return null;
      var tmp = M[c]; M[c] = M[p]; M[p] = tmp;
      for (var r2 = 0; r2 < n; r2++) {
        if (r2 === c) continue;
        var f = M[r2][c] / M[c][c];
        if (!f) continue;
        for (var k = c; k <= n; k++) M[r2][k] -= f * M[c][k];
      }
    }
    return M.map(function (row, i) { return row[n] / row[i]; });
  }

  /* ----------------------------------------------------------------- solve */

  /**
   * plan: {
   *   targets: [{ item, rate, max }], // rate per minute; max ignores rate
   *   recipes: { itemId: recipeId or { recipeId: share } },  // overrides; a
   *                                   // mix splits the item across recipes
   *   imports: { itemId: true },      // supplied from outside this factory
   *   caps:    { itemId: perMinute }  // most a raw input can supply
   * }
   */
  function solve(data, plan) {
    var fixed = {};
    var maxItems = [];
    (plan.targets || []).forEach(function (t) {
      if (!t.item || !data.items[t.item]) return;
      if (t.max) {
        if (maxItems.indexOf(t.item) < 0) maxItems.push(t.item);
        return;
      }
      var rate = Number(t.rate);
      if (!(rate > 0)) return;  // 0/min: listed, but asks for nothing
      fixed[t.item] = (fixed[t.item] || 0) + rate;
    });

    var overrides = plan.recipes || {};
    var imports = plan.imports || {};
    var caps = plan.caps || {};
    var suppressed = {};  // items left to byproducts after an overshoot

    /** How an item is made: [{ rid, share }], shares summing to 1, or null. */
    function mixFor(item) {
      if (imports[item] || suppressed[item]) return null;
      var it = data.items[item];
      if (!it || it.raw) return null;
      return readMix(data, item, overrides[item]) || readMix(data, item, data.defaults[item]);
    }

    var result, attempts = 0;
    while (attempts++ < 40) {
      result = attempt();
      if (!result.retry) break;
    }
    delete result.retry;
    return result;

    function attempt() {
      // Walk from the targets down through recipe inputs. Every item made
      // here gets one unknown, y: how much of it its recipes make per minute.
      // Its mix turns y into machines of each recipe, so the system stays
      // square whether an item uses one recipe or several.
      var chosen = {};  // item -> mix
      var seen = {};
      var queue = Object.keys(fixed).concat(maxItems);
      while (queue.length) {
        var item = queue.shift();
        if (seen[item]) continue;
        seen[item] = true;
        var mix = mixFor(item);
        if (!mix) continue;
        chosen[item] = mix;
        mix.forEach(function (m) {
          data.recipes[m.rid].in.forEach(function (p) { queue.push(p[0]); });
        });
      }

      // A recipe picked for an item it only makes on the side (Plastic for
      // Heavy Oil Residue), and also picked for its main product, is run for
      // the main product; the side item takes what comes off it.
      Object.keys(chosen).forEach(function (it) {
        var mix = chosen[it];
        if (mix.length !== 1) return;
        var main = data.recipes[mix[0].rid].out[0][0];
        var mainMix = chosen[main];
        if (main !== it && mainMix && mainMix.length === 1 && mainMix[0].rid === mix[0].rid) {
          delete chosen[it];
        }
      });

      var eqItems = Object.keys(chosen);
      var ridIndex = {};
      var rids = [];
      var owner = {};   // recipeId -> the item it's run for
      // Machines of each recipe per 1/min of the item it's run for.
      var use = eqItems.map(function (it) {
        return chosen[it].map(function (m) {
          var r = data.recipes[m.rid];
          var out = r.out.filter(function (p) { return p[0] === it; })[0];
          if (ridIndex[m.rid] == null) {
            ridIndex[m.rid] = rids.length;
            rids.push(m.rid);
          }
          if (!owner[m.rid] || r.out[0][0] === it) owner[m.rid] = it;
          return { j: ridIndex[m.rid], per: m.share / (out[1] * 60 / r.time) };
        });
      });
      var nets = rids.map(function (rid) { return perMinute(data.recipes[rid]); });
      var cols = use.map(function (list) {
        var col = {};
        list.forEach(function (u) {
          var net = nets[u.j];
          Object.keys(net).forEach(function (id) { col[id] = (col[id] || 0) + net[id] * u.per; });
        });
        return col;
      });
      var A = eqItems.map(function (rowItem) {
        return cols.map(function (col) { return col[rowItem] || 0; });
      });

      var unit = {};
      maxItems.forEach(function (id) { unit[id] = 1; });
      var b0 = eqItems.map(function (id) { return fixed[id] || 0; });
      var b1 = eqItems.map(function (id) { return unit[id] || 0; });

      var y0 = eqItems.length ? solveLinear(A, b0) : [];
      var y1 = !eqItems.length ? [] : maxItems.length ? solveLinear(A, b1) : b1.map(function () { return 0; });
      if (!y0 || !y1) {
        return {
          error: 'These recipes feed each other in a loop that never balances. ' +
                 'Try a different recipe for one of them.',
          recipes: {}, items: {}, flows: [], targets: {}, maxRate: null
        };
      }
      function machinesFor(y) {
        var x = rids.map(function () { return 0; });
        use.forEach(function (list, i) {
          list.forEach(function (u) { x[u.j] += u.per * y[i]; });
        });
        return x;
      }
      var x0 = machinesFor(y0);
      var x1 = machinesFor(y1);

      /** What each item still needs from outside, for recipe rates x. */
      function gaps(x, wanted) {
        var g = {};
        Object.keys(wanted).forEach(function (id) { g[id] = wanted[id]; });
        rids.forEach(function (rid, i) {
          var r = data.recipes[rid];
          var k = x[i] * 60 / r.time;
          r.in.forEach(function (p) { g[p[0]] = (g[p[0]] || 0) + p[1] * k; });
          r.out.forEach(function (p) { g[p[0]] = (g[p[0]] || 0) - p[1] * k; });
        });
        return g;
      }

      // How far the max outputs can go before some capped input runs dry.
      var t = 0;
      var unbounded = false;
      var limitedBy = null;
      if (maxItems.length) {
        var g0 = gaps(x0, fixed);
        var g1 = gaps(x1, unit);
        t = Infinity;
        Object.keys(caps).forEach(function (id) {
          var slope = g1[id] || 0;
          if (slope <= EPS) return;
          var room = (caps[id] - (g0[id] || 0)) / slope;
          if (room < t) { t = room; limitedBy = id; }
        });
        if (!isFinite(t)) {
          unbounded = true;
          t = 0;
        }
        t = Math.max(0, t);
      }

      var x = x0.map(function (v, i) { return v + t * x1[i]; });

      // An overshooting byproduct shows up as an item asked to be made in
      // reverse. Hand that item over to byproducts and go again.
      for (var i = 0; i < eqItems.length; i++) {
        if (y0[i] + t * y1[i] < -EPS) {
          suppressed[eqItems[i]] = true;
          return { retry: true };
        }
      }

      var targets = {};
      Object.keys(fixed).forEach(function (id) { targets[id] = fixed[id]; });
      maxItems.forEach(function (id) { targets[id] = (targets[id] || 0) + t; });

      var counts = {};
      rids.forEach(function (rid, j) { counts[rid] = x[j]; });
      var result = assemble(data, counts, owner, targets, caps);
      result.maxRate = maxItems.length ? t : null;
      result.limitedBy = limitedBy;
      if (unbounded) result.error = unboundedMessage(maxItems.length);
      result.byproductOnly = Object.keys(suppressed);
      return result;
    }
  }

  function unboundedMessage(count) {
    return 'Nothing limits the max output' + (count > 1 ? 's' : '') +
      '. Set a resource node purity on one of the raw inputs to give it a ceiling.';
  }

  /**
   * From recipe rates to everything the canvas draws: per-item balances,
   * what's supplied from outside and what's spare, and the flows between
   * steps. counts: { recipeId: machines at 100% }; owner: { recipeId: the
   * item it's run for }, defaulting to its main product.
   */
  function assemble(data, counts, owner, targets, caps) {
    var recipes = {};
    Object.keys(counts).forEach(function (rid) {
      if (counts[rid] > EPS) {
        recipes[rid] = { count: counts[rid], item: owner[rid] || data.recipes[rid].out[0][0] };
      }
    });

    // Per-item balance.
    var items = {};
    function entry(id) {
      return items[id] || (items[id] = {
        produced: 0, consumed: 0, target: targets[id] || 0,
        supplied: 0, surplus: 0, short: 0, producers: [], consumers: []
      });
    }
    Object.keys(targets).forEach(entry);
    Object.keys(recipes).forEach(function (rid) {
      var r = data.recipes[rid];
      var k = recipes[rid].count * 60 / r.time;
      r.out.forEach(function (p) {
        var e = entry(p[0]);
        e.produced += p[1] * k;
        e.producers.push({ node: 'r:' + rid, rate: p[1] * k });
      });
      r.in.forEach(function (p) {
        var e = entry(p[0]);
        e.consumed += p[1] * k;
        e.consumers.push({ node: 'r:' + rid, rate: p[1] * k });
      });
    });

    // The output itself is a consumer like any other, so it gets its own
    // line: making rods for screws never swallows the rods you asked for.
    Object.keys(targets).forEach(function (id) {
      if (targets[id] > EPS) entry(id).consumers.push({ node: 'out:' + id, rate: targets[id] });
    });

    // Whatever the factory doesn't make enough of comes in from outside:
    // mined, pumped, or imported. Whatever it makes too much of is surplus.
    Object.keys(items).forEach(function (id) {
      var e = items[id];
      var gap = e.consumed + e.target - e.produced;
      // Rounding (a few thousandths a minute, or a few parts per million of
      // what moves) isn't real supply or surplus.
      var tol = Math.max(5e-3, 1e-6 * (e.consumed + e.target + e.produced));
      if (gap > tol) {
        e.supplied = gap;
        e.producers.push({ node: 'raw:' + id, rate: gap });
      } else if (gap < -tol) {
        e.surplus = -gap;
      }
      if (caps[id] != null) {
        e.cap = caps[id];
        if (e.supplied > caps[id] * (1 + 1e-5) + 1e-6) e.short = e.supplied - caps[id];
      }
    });

    // Flows. When several sources feed one item, every consumer draws from
    // them in proportion, the way a merged belt would deliver.
    var flows = [];
    Object.keys(items).forEach(function (id) {
      var e = items[id];
      var supply = e.produced + e.supplied;
      if (supply < EPS) return;
      e.producers.forEach(function (p) {
        var share = p.rate / supply;
        e.consumers.forEach(function (c) {
          if (p.node === c.node) return; // a recipe feeding itself
          var rate = c.rate * share;
          if (rate > EPS) flows.push({ from: p.node, to: c.node, item: id, rate: rate });
        });
      });
    });

    return {
      recipes: recipes,
      items: items,
      flows: flows,
      targets: targets,
      maxRate: null,
      limitedBy: null,
      error: null,
      byproductOnly: []
    };
  }

  /**
   * A recipe choice as a mix: a recipe id, or { recipeId: share }. Only
   * recipes that actually make the item count; shares are scaled to sum to 1.
   */
  function readMix(data, item, choice) {
    if (!choice) return null;
    var raw = typeof choice === 'string' ? {} : choice;
    if (typeof choice === 'string') raw[choice] = 1;
    var list = Object.keys(raw).filter(function (rid) {
      var r = data.recipes[rid];
      return r && raw[rid] > 0 && r.out.some(function (p) { return p[0] === item; });
    }).map(function (rid) { return { rid: rid, share: Number(raw[rid]) }; });
    var total = list.reduce(function (s, m) { return s + m.share; }, 0);
    if (!list.length || !(total > 0)) return null;
    list.forEach(function (m) { m.share /= total; });
    return list;
  }

  var api = {
    solve: solve,
    assemble: assemble,
    unboundedMessage: unboundedMessage,
    readMix: readMix,
    perMinute: perMinute,
    clocks: clocks,
    MAX_CLOCK: MAX_CLOCK,
    recipePower: recipePower,
    extractorPower: extractorPower,
    supplyInfo: supplyInfo,
    capsFrom: capsFrom,
    PURITIES: PURITIES,
    PURITY: PURITY
  };
  root.SF_SOLVER = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
