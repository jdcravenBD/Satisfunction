/* Satisfunction — recipe optimiser.
 *
 * The alternative to picking recipes by hand: every allowed recipe (the
 * standard ones, plus whichever alternates the user has) becomes a variable,
 * how many machines' worth of it runs, and a linear program picks the rates.
 * Every item gets one row: what's made of it, plus what comes in from
 * outside, must cover what's used and what's asked for. Then three passes,
 * each holding on to the last one's result:
 *
 *   1. Least shortfall: fixed outputs the resource nodes can't cover.
 *   2. Most output: the rate every "max" output shares, as high as it goes.
 *   3. The goal: fewest resources (weighted by the game's sink points, which
 *      track how rare each is; water is free), least power, or fewest
 *      machines.
 *
 * The answer is used as it is. It can mix recipes for one item (some screws
 * from iron, some from steel), or run a recipe just for what it gives off on
 * the side, which picking one recipe per item can't express.
 */

(function (root) {
  'use strict';

  var EPS = 1e-7;

  function perMinute(recipe) {
    var k = 60 / recipe.time;
    var net = {};
    recipe.in.forEach(function (p) { net[p[0]] = (net[p[0]] || 0) - p[1] * k; });
    recipe.out.forEach(function (p) { net[p[0]] = (net[p[0]] || 0) + p[1] * k; });
    return net;
  }

  /**
   * plan: { targets, imports, caps, pins } — pins are recipes the user fixed
   * for an item: { item: recipeId or { recipeId: share } }.
   * opts: { goal: 'resources' | 'power' | 'machines', allowed(recipeId) }.
   * Returns { status, counts: { recipeId: machines }, maxRate, unbounded }.
   */
  function optimise(data, plan, opts) {
    var res = attempt(data, plan, opts, true);
    // Things gathered by hand (power slugs, leaves, creature parts) or given
    // off by generators (Nuclear Waste) are held back first. If a chain can't
    // do without them, or makes at least a quarter more with them, they're
    // allowed: the optimiser shouldn't do worse than picking by hand.
    if (!res.usesGathered) return res;
    var retry = attempt(data, plan, opts, false);
    if (retry.status !== 'optimal') return res;
    if (res.status !== 'optimal' || res.gatheredShort) return retry;
    var maxing = res.maxItems && res.maxItems.length && !res.unbounded;
    if (maxing && retry.maxRate > 1.25 * res.maxRate + 1e-9) return retry;
    return res;
  }

  function attempt(data, plan, opts, holdGathered) {
    var LP = root.SF_LP;
    var defaultRecipes = {};
    Object.keys(data.defaults).forEach(function (id) { defaultRecipes[data.defaults[id]] = true; });
    var imports = plan.imports || {};
    var caps = plan.caps || {};
    var pins = plan.pins || {};
    var fixed = {};
    var maxItems = [];
    (plan.targets || []).forEach(function (t) {
      if (!data.items[t.item]) return;
      if (t.max) {
        if (maxItems.indexOf(t.item) < 0) maxItems.push(t.item);
      } else if (Number(t.rate) > 0) {
        fixed[t.item] = (fixed[t.item] || 0) + Number(t.rate);
      }
    });
    var wanted = Object.keys(fixed).concat(maxItems);
    if (!wanted.length) return { status: 'optimal', counts: {}, maxRate: null, maxItems: [], fixed: {}, usesGathered: false };

    // A pinned item is made only by its pinned recipes; an imported one isn't
    // made here at all. Anything else: whatever the user's recipes allow.
    function pinnedTo(item) {
      var p = pins[item];
      if (!p) return null;
      return typeof p === 'string' ? [p] : Object.keys(p);
    }
    function usable(rid) {
      var main = data.recipes[rid].out[0][0];
      if (imports[main]) return false;
      var pin = pinnedTo(main);
      if (pin) return pin.indexOf(rid) >= 0;
      // An item with no standard recipe keeps its default (an alternate or
      // a Converter recipe), or it couldn't be made at all.
      if (defaultRecipes[rid]) return true;
      return opts.allowed(rid);
    }
    var producers = {};
    Object.keys(data.recipes).forEach(function (rid) {
      if (!usable(rid)) return;
      data.recipes[rid].out.forEach(function (p) {
        (producers[p[0]] = producers[p[0]] || []).push(rid);
      });
    });

    // Everything reachable from the outputs through usable recipes. Side
    // products get a row but aren't made for their own sake.
    var items = {};
    var recipes = {};
    var queue = wanted.slice();
    while (queue.length) {
      var id = queue.shift();
      if (items[id] === true) continue;
      items[id] = true;
      if (data.items[id].raw || imports[id]) continue;
      (producers[id] || []).forEach(function (rid) {
        if (recipes[rid]) return;
        recipes[rid] = true;
        var r = data.recipes[rid];
        r.in.forEach(function (p) { queue.push(p[0]); });
        r.out.forEach(function (p) { items[p[0]] = items[p[0]] || 'side'; });
      });
    }

    // Variables: recipes, supply for whatever comes from outside (raw
    // resources, imports, anything nothing here makes), shortfall past a
    // resource's nodes, and the shared max rate.
    var rids = Object.keys(recipes);
    var ids = Object.keys(items);
    var nets = rids.map(function (rid) { return perMinute(data.recipes[rid]); });
    var supplied = ids.filter(function (id) {
      return data.items[id].raw || imports[id] ||
        !(producers[id] || []).some(function (rid) { return recipes[rid]; });
    });
    // Things neither mined nor imported (power slugs, leaves, creature parts)
    // are gathered by hand, so they're treated as a resource with nothing to
    // spare: used only where there's no other way.
    function gathered(id) { return !data.items[id].raw && !imports[id]; }
    var capOf = function (id) { return gathered(id) && holdGathered ? 0 : caps[id]; };
    var capped = supplied.filter(function (id) { return capOf(id) != null; });
    var usesGathered = supplied.some(gathered);

    var n = 0;
    var xOf = rids.map(function () { return n++; });
    var uOf = {};
    supplied.forEach(function (id) { uOf[id] = n++; });
    var sOf = {};
    capped.forEach(function (id) { sOf[id] = n++; });
    var tVar = maxItems.length ? n++ : -1;

    var rows = [];
    ids.forEach(function (id) {
      var a = {};
      rids.forEach(function (rid, j) {
        var v = nets[j][id];
        if (v) a[xOf[j]] = v;
      });
      if (uOf[id] != null) a[uOf[id]] = 1;
      if (sOf[id] != null) a[sOf[id]] = 1;
      if (tVar >= 0 && maxItems.indexOf(id) >= 0) a[tVar] = -1;
      rows.push({ a: a, op: '>=', b: fixed[id] || 0 });
    });
    capped.forEach(function (id) {
      var a = {};
      a[uOf[id]] = 1;
      rows.push({ a: a, op: '<=', b: capOf(id) });
    });

    function weight(id) {
      if (id === 'Desc_Water_C') return 0;  // pumped anywhere, never short
      if (gathered(id)) return 1000;
      return data.items[id].sink || 1;
    }
    function power(rid) {
      var r = data.recipes[rid];
      return r.power != null ? r.power : data.machines[r.machine].power;
    }

    // 1. Least shortfall.
    if (capped.length) {
      var c1 = new Array(n).fill(0);
      capped.forEach(function (id) { c1[sOf[id]] = -1; });
      var r1 = LP.maximize(n, c1, rows);
      if (r1.status !== 'optimal') return { status: r1.status };
      // Fixed outputs that can only be met with held-back gathered things.
      var gatheredShort = holdGathered && supplied.some(function (id) {
        return gathered(id) && sOf[id] != null && r1.x[sOf[id]] > 1e-6;
      });
      if (gatheredShort) return { status: 'optimal', gatheredShort: true, usesGathered: true, counts: {}, maxItems: maxItems, fixed: fixed, maxRate: 0 };
      var hold = {};
      capped.forEach(function (id) { hold[sOf[id]] = 1; });
      rows.push({ a: hold, op: '<=', b: -r1.value * (1 + 1e-6) + EPS });
    }

    // 2. Most output. If nothing caps it, the plan says so and makes none.
    var maxRate = null;
    var unbounded = false;
    if (tVar >= 0) {
      var c2 = new Array(n).fill(0);
      c2[tVar] = 1;
      var r2 = LP.maximize(n, c2, rows);
      var t = {};
      t[tVar] = 1;
      if (r2.status === 'unbounded') {
        unbounded = true;
        maxRate = 0;
        rows.push({ a: t, op: '=', b: 0 });
      } else if (r2.status === 'optimal') {
        maxRate = r2.value;
        rows.push({ a: t, op: '>=', b: maxRate * (1 - 1e-6) });
      } else {
        return { status: r2.status };
      }
    }

    // 3. The goal, with a whisper of the others to settle ties.
    var c3 = new Array(n).fill(0);
    var goal = opts.goal || 'resources';
    rids.forEach(function (rid, j) {
      var cost = goal === 'power' ? power(rid) : goal === 'machines' ? 1 : 0;
      c3[xOf[j]] = -(cost + 1e-4);
    });
    supplied.forEach(function (id) {
      var w = weight(id) * (goal === 'resources' ? 1 : 1e-3);
      c3[uOf[id]] = -w;
      if (sOf[id] != null) c3[sOf[id]] = -w;
    });
    var r3 = LP.maximize(n, c3, rows);
    if (r3.status !== 'optimal') return { status: r3.status };

    var counts = {};
    var biggest = 0;
    rids.forEach(function (rid, j) { biggest = Math.max(biggest, r3.x[xOf[j]]); });
    rids.forEach(function (rid, j) {
      // Slivers are rounding, not recipes.
      if (r3.x[xOf[j]] > Math.max(1e-6, biggest * 1e-6)) counts[rid] = r3.x[xOf[j]];
    });
    // The rate actually reached, which the plan then asks for exactly.
    if (tVar >= 0 && !unbounded) maxRate = r3.x[tVar];
    return {
      status: 'optimal',
      usesGathered: usesGathered,
      counts: counts,
      maxRate: maxRate,
      unbounded: unbounded,
      maxItems: maxItems,
      fixed: fixed
    };
  }

  /**
   * The optimiser as a drop-in for the solver: same plan in, same shape out,
   * so the canvas can't tell the difference. Returns null if it couldn't
   * settle the plan, so the caller can fall back to the user's own picks.
   */
  function solveOptimised(data, plan, opts) {
    var S = root.SF_SOLVER;
    var res = optimise(data, plan, opts);
    if (res.status !== 'optimal') return null;
    var targets = {};
    Object.keys(res.fixed).forEach(function (id) { targets[id] = res.fixed[id]; });
    res.maxItems.forEach(function (id) { targets[id] = (targets[id] || 0) + res.maxRate; });
    var caps = plan.caps || {};
    var result = S.assemble(data, res.counts, {}, targets, caps);
    result.maxRate = res.maxItems.length ? res.maxRate : null;
    if (res.unbounded) result.error = S.unboundedMessage(res.maxItems.length);
    // The limit is whichever capped resource runs right up to its cap.
    if (result.maxRate) {
      var tightest = null;
      Object.keys(caps).forEach(function (id) {
        var e = result.items[id];
        if (!e || !(e.supplied > 0)) return;
        var room = caps[id] - e.supplied;
        if (room < caps[id] * 1e-4 + 1e-6 && (!tightest || room < tightest.room)) {
          tightest = { id: id, room: room };
        }
      });
      result.limitedBy = tightest ? tightest.id : null;
    }
    result.optimised = true;
    return result;
  }

  var api = { optimise: optimise, solveOptimised: solveOptimised };
  root.SF_OPTIMISE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
