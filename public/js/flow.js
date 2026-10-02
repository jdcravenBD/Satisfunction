/* Satisfunction — How items flow through the model: belts, splitters, mergers, mixed belts and
   jams. */

import { DATA, SOLVER, fmtNum, isFluid, itemName, shardsFor, state, stepClocks, stepPower } from './core.js';
import { extractorOf, isEnd, isLogistic, isRuled, lineSets, mixable, nodeRecipe, partName,
  resourceCap, routeOf, sinkPoints, sloopsOf, slotItem, slotsOf, vscale, vsum, vtotal } from './model.js';

/**
 * The whole build's rates. First what each Set step asks for is passed up
 * through the Auto steps feeding it (their "wanted" counts). Then items are
 * pushed forward from the resources: every step takes what it needs, an
 * Auto step with nothing asked of it grows to use all it's given, splitters
 * share evenly (or as their rules say), and Storage takes what's left over.
 *
 * A line can carry a mix of items (a sushi belt). Each line's flow is kept
 * item by item, and a mixed belt moves as one: when the far end can't take
 * more of one of its items, the whole belt slows, as it jams in the game.
 */
function customFlow() {
  var nodes = state.custom.nodes;
  var links = state.custom.links;
  var byId = {}, linkById = {};
  nodes.forEach(function (n) { byId[n.id] = n; });
  links.forEach(function (l) { linkById[l.id] = l; });
  var outL = {}, inL = {};
  links.forEach(function (l) {
    (outL[l.from] = outL[l.from] || []).push(l);
    (inL[l.to] = inL[l.to] || []).push(l);
  });
  var sets = lineSets();
  function itemsOn(l) { return sets[l.id] || []; }
  function carries(l, item) { return itemsOn(l).indexOf(item) >= 0; }
  var perOf = {};
  nodes.forEach(function (n) {
    var r = nodeRecipe(n);
    var per = r ? SOLVER.perMinute(r) : {};
    // Somersloops multiply what comes out, not what goes in.
    var b = r ? sloopsOf(n).boost : 0;
    if (b) {
      per = Object.assign({}, per);
      Object.keys(per).forEach(function (id) { if (per[id] > 0) per[id] *= 1 + b; });
    }
    perOf[n.id] = per;
  });
  function need(n, item) { return Math.max(0, -(perOf[n.id][item] || 0)); }
  function make(n, item) { return Math.max(0, perOf[n.id][item] || 0); }
  function outLink(n, k) { return (outL[n.id] || []).filter(function (l) { return l.fk === k; })[0] || null; }
  function inLink(n, k) { return (inL[n.id] || []).filter(function (l) { return l.tk === k; })[0] || null; }
  function isSink(l) { return !!(byId[l.to] && byId[l.to].type === 'sink'); }

  // 1. Demand, item by item, passed upstream from Set steps. What a
  // splitter or merger passes on is worked out once; a line looping back
  // into one already being asked asks for nothing more.
  var wantMemo = {};
  var asking = {};
  var askedMemo = {}, askedBusy = {};
  function request(l, item, depth) {
    var n = byId[l.to];
    if (!n || !item) return 0;
    if (n.type === 'recipe') {
      if (!nodeRecipe(n)) return 0;
      var nd = need(n, item);
      if (!nd) return 0;
      var c = n.set ? (n.count || 0) : wanted(n, depth + 1);
      // Shared between the lines bringing it in.
      var k = (inL[n.id] || []).filter(function (x) { return carries(x, item); }).length || 1;
      return c * nd / k;
    }
    if (n.type === 'splitter') return askedOf(n, item, depth);
    if (n.type === 'merger') {
      var with_ = (inL[n.id] || []).filter(function (x) { return x === l || carries(x, item); });
      // A Priority Merger asks its top input for everything.
      var top = n.priority ? inLink(n, 0) : null;
      if (top && with_.indexOf(top) >= 0) return l === top ? askedOf(n, item, depth) : 0;
      return askedOf(n, item, depth) / (with_.length || 1);
    }
    return 0;
  }
  function askedOf(n, item, depth) {
    var key = n.id + '|' + item;
    if (askedMemo[key] != null) return askedMemo[key];
    if (askedBusy[key]) return 0;
    askedBusy[key] = true;
    var v = 0;
    var outs = outL[n.id] || [];
    if (n.type === 'splitter') {
      outs.forEach(function (o) { if (carries(o, item)) v += request(o, item, depth + 1); });
    } else if (outs[0]) {
      v = request(outs[0], item, depth + 1);
    }
    askedBusy[key] = false;
    askedMemo[key] = v;
    return v;
  }
  function wanted(n, depth) {
    if (wantMemo[n.id] != null) return wantMemo[n.id];
    if (asking[n.id]) return 0;
    asking[n.id] = true;
    var w = 0;
    slotsOf(n).outs.forEach(function (item, k) {
      var l = outLink(n, k);
      if (l && make(n, item) > 0) w = Math.max(w, request(l, item, depth) / make(n, item));
    });
    asking[n.id] = false;
    wantMemo[n.id] = w;
    return w;
  }
  // The count each step aims for (null: Auto with nothing asked of it,
  // settled by its inputs below).
  var aim = {};
  nodes.forEach(function (n) {
    if (!nodeRecipe(n)) return;
    if (n.set) aim[n.id] = n.count || 0;
    else { var w = wanted(n, 0); aim[n.id] = w > 1e-9 ? w : null; }
  });

  var flowOf = {};
  links.forEach(function (l) { flowOf[l.id] = {}; });
  function flowIn(l, item) { return (flowOf[l.id] && flowOf[l.id][item]) || 0; }

  // How much of an item a link's far end will take. Firm: leaving out
  // Storage, which only takes what's left over. The room past each
  // splitter or merger is worked out once per question, and a line looping
  // back into one already counted adds no room.
  var roomMemo = {}, roomBusy = {};
  function accept(l, item, firm) {
    roomMemo = {};
    roomBusy = {};
    return takes(l, item, !!firm);
  }
  function takes(l, item, firm) {
    var n = byId[l.to];
    if (!n) return 0;
    if (n.type === 'recipe') {
      if (!nodeRecipe(n)) return 0;
      var nd = need(n, item);
      if (!nd) return 0;
      if (aim[n.id] == null) return Infinity;
      var others = (inL[n.id] || []).reduce(function (sum, x) { return x === l ? sum : sum + flowIn(x, item); }, 0);
      // A mixed belt that's jammed stays jammed.
      return Math.max(0, nd * aim[n.id] - others) * (slow[l.id] == null ? 1 : slow[l.id]);
    }
    if (n.type === 'sink') return firm ? 0 : Infinity;
    if (n.type === 'awesome') return firm || isFluid(item) ? 0 : Infinity;
    if (n.type === 'splitter') return roomOf(n, item, firm);
    if (n.type === 'merger') {
      // Making a mixed belt, a merger takes whatever comes: if one item is
      // more than the far end uses, it's the whole belt that backs up.
      var o1m = (outL[n.id] || [])[0];
      if (o1m && itemsOn(o1m).length > 1) return Infinity;
      var room = roomOf(n, item, firm);
      // A Priority Merger's top input comes first; any other input gets
      // what the line out has left after the rest.
      if (n.priority && l.tk === 0) return room;
      var rest = (inL[n.id] || []).reduce(function (sum, x) { return x === l ? sum : sum + flowIn(x, item); }, 0);
      return Math.max(0, room - rest);
    }
    return 0;
  }
  function roomOf(n, item, firm) {
    var key = n.id + '|' + item;
    if (roomMemo[key] != null) return roomMemo[key];
    if (roomBusy[key]) return 0;
    roomBusy[key] = true;
    var v = 0;
    var outs = outL[n.id] || [];
    if (n.type === 'splitter') {
      var rt = isRuled(n) ? routeOf(n, item, outs.map(function (o) { return o.fk; })) : null;
      outs.forEach(function (o) {
        if (!rt || rt.take.indexOf(o.fk) >= 0 || rt.over.indexOf(o.fk) >= 0) v += takes(o, item, firm);
      });
    } else if (outs[0]) {
      v = takes(outs[0], item, firm);
    }
    roomBusy[key] = false;
    roomMemo[key] = v;
    return v;
  }

  // Whether a line ends in Storage, straight away or past more splitters.
  function spills(l, seen) {
    var n = byId[l.to];
    seen = seen || {};
    if (!n || seen[n.id]) return false;
    if (isEnd(n)) return true;
    if (n.type !== 'splitter') return false;
    seen[n.id] = true;
    return (outL[n.id] || []).some(function (o) { return spills(o, seen); });
  }

  // 2. Items pushed forward, sources first. The order is a depth-first
  // one from the sources, so a loop (a step feeding back into its own
  // supply) is cut at one line and everything after it still comes in
  // order; passes repeat until the flows stop changing.
  var order = [];
  var visited = {};
  function visit(n) {
    if (visited[n.id]) return;
    visited[n.id] = true;
    (outL[n.id] || []).forEach(function (l) { if (byId[l.to]) visit(byId[l.to]); });
    order.push(n);
  }
  nodes.filter(function (n) { return !(inL[n.id] || []).length; }).forEach(visit);
  nodes.forEach(visit);
  order.reverse();

  // How far a belt carrying v can run before one of its items meets cap.
  function fitTo(v, cap) {
    var f = 1;
    for (var i in v) if (v[i] > 1e-12) f = Math.min(f, (cap[i] != null ? cap[i] : Infinity) / v[i]);
    return Math.max(0, f);
  }

  var count = {}, run = {}, avail = {}, throttled = {}, stuck = {};
  var slow = {};   // a mixed belt's jam so far: how much of its flow still gets through
  for (var pass = 0; pass < 40; pass++) {
    var before = links.map(function (l) { return vtotal(flowOf[l.id]); });
    order.forEach(function (n) {
      var ins = inL[n.id] || [];
      var outs = [];   // what comes out of each output, item by item
      if (n.type === 'recipe') {
        var r = nodeRecipe(n);
        if (!r) { count[n.id] = 0; run[n.id] = 0; avail[n.id] = []; return; }
        var needs = {};
        r.in.forEach(function (q) { var nd = need(n, q[0]); if (nd > 0) needs[q[0]] = nd; });
        // What it can't use backs up on its belts. A mixed belt holds up
        // everything on it when one item backs up, so each line slows as a
        // whole, as far as its most-oversupplied item needs it to.
        var keep = ins.map(function () { return 1; });
        var limit, c, a;
        for (var it2 = 0; it2 < 30; it2++) {
          var got = {};
          ins.forEach(function (l, j) { var v = flowOf[l.id]; for (var i in v) if (needs[i]) got[i] = (got[i] || 0) + v[i] * keep[j]; });
          limit = Infinity;
          Object.keys(needs).forEach(function (i) { limit = Math.min(limit, (got[i] || 0) / needs[i]); });
          c = aim[n.id] != null ? aim[n.id] : (limit === Infinity ? 0 : limit);
          // The first pass runs every sized step at full, as if its loop
          // (if it's in one) were already primed; later passes settle from
          // there, and a loop that can't keep itself going runs down.
          a = pass === 0 && aim[n.id] != null ? c : Math.min(c, limit);
          var ratio = {}, over = false;
          Object.keys(needs).forEach(function (i) {
            var use = needs[i] * a;
            if ((got[i] || 0) > use + 1e-9) { ratio[i] = use / got[i]; over = true; }
          });
          if (!over) break;
          var moved = false;
          ins.forEach(function (l, j) {
            var v = flowOf[l.id], f = 1;
            for (var i in v) if (v[i] > 1e-12 && ratio[i] != null) f = Math.min(f, ratio[i]);
            // (A mixed belt only for a real excess, not a rounding speck.)
            if (itemsOn(l).length > 1 && f > 1 - 1e-6) f = 1;
            if (f < 1) moved = true;
            keep[j] *= f;
          });
          if (!moved) break;
        }
        ins.forEach(function (l, j) {
          if (keep[j] >= 1) return;
          // A mixed belt slowed by one of its items holds up the rest.
          if (itemsOn(l).length > 1 && keep[j] < 0.999) {
            var v = flowOf[l.id], worst = null, least = Infinity;
            for (var i in v) if (needs[i] && v[i] > 1e-9) { var share = needs[i] * a / v[i]; if (share < least) { least = share; worst = i; } }
            throttled[l.id] = worst;
          }
          if (itemsOn(l).length > 1) slow[l.id] = (slow[l.id] == null ? 1 : slow[l.id]) * keep[j];
          flowOf[l.id] = vscale(flowOf[l.id], keep[j]);
        });
        count[n.id] = c;
        run[n.id] = a;
        slotsOf(n).outs.forEach(function (item, k) { var o = {}; o[item] = make(n, item) * a; outs[k] = o; });
      } else if (n.type === 'resource') {
        outs[0] = {};
        outs[0][n.item] = resourceCap(n);
      } else if (n.type === 'import') {
        outs[0] = {};
        outs[0][n.item] = n.rate || 0;
      } else if (n.type === 'splitter') {
        var F = vsum(ins.map(function (l) { return flowOf[l.id]; }));
        var branches = (outL[n.id] || []).slice().sort(function (x, y) { return x.fk - y.fk; });
        var fks = branches.map(function (o) { return o.fk; });
        var ruled = isRuled(n);
        // Where each item may go: a plain splitter, every output; a ruled
        // one, the outputs its rules pick, then the Overflow ones.
        var routes = {};
        function routesFor(item) {
          if (routes[item]) return routes[item];
          if (!ruled) return (routes[item] = { take: branches, over: [] });
          var rt = routeOf(n, item, fks);
          return (routes[item] = {
            take: branches.filter(function (o) { return rt.take.indexOf(o.fk) >= 0; }),
            over: branches.filter(function (o) { return rt.over.indexOf(o.fk) >= 0; })
          });
        }
        var given = {};
        branches.forEach(function (o) { given[o.id] = {}; });
        var left = Object.assign({}, F);
        // Hands out what's left among the outputs `pick` allows for each
        // item, evenly; an output that can't take its share of every item
        // on its belt takes what it can, and the rest goes round again.
        var fill = function (pick, firm) {
          var full = {};
          for (var round = 0; round < 30; round++) {
            var offer = {}, any = false;
            Object.keys(left).forEach(function (i) {
              if (!(left[i] > 1e-12)) return;
              var open = pick(i).filter(function (o) { return !full[o.id]; });
              if (!open.length) return;
              var share = left[i] / open.length;
              open.forEach(function (o) { (offer[o.id] = offer[o.id] || {})[i] = share; });
              left[i] = 0;
              any = true;
            });
            if (!any) break;
            Object.keys(offer).forEach(function (oid) {
              var o = linkById[oid];
              var want = vsum([given[oid], offer[oid]]);
              var cap = {};
              Object.keys(want).forEach(function (i) { cap[i] = accept(o, i, firm); });
              var f = fitTo(want, cap);
              if (f < 1 - 1e-12) {
                full[oid] = true;
                var kept = vscale(want, f);
                Object.keys(want).forEach(function (i) { left[i] = (left[i] || 0) + want[i] - kept[i]; });
                given[oid] = kept;
              } else {
                given[oid] = want;
              }
            });
          }
        };
        fill(function (i) { return routesFor(i).take; }, true);
        fill(function (i) { return routesFor(i).over; }, true);
        // What's still left goes to Storage, here or further down the line.
        fill(function (i) {
          var rt = routesFor(i);
          return rt.take.concat(rt.over).filter(function (o) { return spills(o); });
        }, false);
        branches.forEach(function (o) { outs[o.fk] = given[o.id]; flowOf[o.id] = given[o.id]; });
        // Anything with nowhere to go stops the belt coming in.
        stuck[n.id] = ruled ? Object.keys(F).filter(function (i) {
          var rt = routesFor(i);
          return F[i] > 1e-9 && !rt.take.length && !rt.over.length;
        }) : [];
        var passed = {};
        Object.keys(F).forEach(function (i) { passed[i] = F[i] - (left[i] || 0); });
        var back = fitTo(F, passed);
        if (back < 1 - 1e-9) ins.forEach(function (l) { flowOf[l.id] = vscale(flowOf[l.id], back); });
      } else if (n.type === 'merger') {
        var o1 = (outL[n.id] || [])[0];
        if (o1) {
          var total = vsum(ins.map(function (l) { return flowOf[l.id]; }));
          var room = {};
          Object.keys(total).forEach(function (i) { room[i] = accept(o1, i); });
          // A merger that can't pass everything on backs up: evenly, or
          // a Priority Merger's other inputs before its top one.
          var top = n.priority ? inLink(n, 0) : null;
          if (top) {
            var ft = fitTo(flowOf[top.id], room);
            if (ft < 1) flowOf[top.id] = vscale(flowOf[top.id], ft);
            var rest = vsum(ins.filter(function (l) { return l !== top; }).map(function (l) { return flowOf[l.id]; }));
            var room2 = {};
            Object.keys(room).forEach(function (i) { room2[i] = Math.max(0, room[i] - (flowOf[top.id][i] || 0)); });
            var fo = fitTo(rest, room2);
            if (fo < 1) ins.forEach(function (l) { if (l !== top) flowOf[l.id] = vscale(flowOf[l.id], fo); });
          } else {
            var fa = fitTo(total, room);
            if (fa < 1) ins.forEach(function (l) { flowOf[l.id] = vscale(flowOf[l.id], fa); });
          }
          outs[0] = vsum(ins.map(function (l) { return flowOf[l.id]; }));
          flowOf[o1.id] = outs[0];
        } else {
          outs[0] = vsum(ins.map(function (l) { return flowOf[l.id]; }));
        }
      }
      avail[n.id] = outs.map(function (v) { return v ? vtotal(v) : 0; });
      if (!isLogistic(n)) {
        (outL[n.id] || []).forEach(function (l) {
          var v = outs[l.fk] || {};
          var f = {};
          Object.keys(v).forEach(function (i) { f[i] = Math.min(v[i], accept(l, i)); });
          flowOf[l.id] = f;
        });
      }
    });
    // Settled: another pass wouldn't change anything.
    if (pass >= 3 && links.every(function (l, i) { var t = vtotal(flowOf[l.id]); return Math.abs(t - before[i]) <= 1e-9 + before[i] * 1e-9; })) break;
  }

  // 3. What it comes to.
  var res = { nodes: {}, links: {}, items: {}, outputs: {}, sunk: {}, points: 0, recipes: {}, problems: [], bad: {}, steps: 0, tally: [] };
  links.forEach(function (l) {
    var list = itemsOn(l);
    var one = list.length === 1 ? list[0] : list.length ? null : (byId[l.from] ? slotItem(byId[l.from], 'out', l.fk) : null);
    var by = {};
    Object.keys(flowOf[l.id]).forEach(function (i) { if (flowOf[l.id][i] > 1e-9) by[i] = flowOf[l.id][i]; });
    res.links[l.id] = {
      total: vtotal(flowOf[l.id]), items: by, item: one, mixed: list.length > 1,
      fluid: one ? isFluid(one) : list.some(isFluid)
    };
  });
  function problem(n, text) {
    res.problems.push({ part: n.id, text: text });
    res.bad[n.id] = true;
  }
  function names(list) {
    var ns = list.map(itemName);
    return ns.length > 1 ? ns.slice(0, -1).join(', ') + ' and ' + ns[ns.length - 1] : ns[0];
  }
  nodes.forEach(function (n) {
    var s = slotsOf(n);
    var st = { count: 0, run: 0, ins: [], outs: [], got: {} };
    s.ins.forEach(function (item, k) { var l = inLink(n, k); st.ins[k] = l ? vtotal(flowOf[l.id]) : 0; });
    s.outs.forEach(function (item, k) { st.outs[k] = (avail[n.id] || [])[k] || 0; });
    (inL[n.id] || []).forEach(function (l) { var v = flowOf[l.id]; for (var i in v) st.got[i] = (st.got[i] || 0) + v[i]; });
    if (n.type === 'recipe') {
      var r = nodeRecipe(n);
      if (!r) {
        problem(n, 'A step has no recipe');
      } else {
        var c = count[n.id] || 0, a = run[n.id] || 0;
        st.count = c;
        st.run = a;
        var label = itemName(n.item || r.out[0][0]);
        var list = stepClocks(n.recipe, c, n.clock);
        var m = DATA.machines[r.machine];
        var sl = sloopsOf(n);
        res.tally.push({
          mid: r.machine, name: m.name, exact: a, built: list.length,
          power: stepPower(n.recipe, a, n.clock, list.length) * sl.power,
          sloops: sl.used * list.length,
          label: label, note: list.length + ' × ' + m.name, id: n.id,
          shards: list.reduce(function (t, x) { return t + shardsFor(x); }, 0)
        });
        var main = r.out[0][0];
        res.recipes[n.recipe] = res.recipes[n.recipe] || { item: main, count: 0 };
        res.recipes[n.recipe].count += a;
        res.steps++;
        var ins2 = inL[n.id] || [];
        r.in.forEach(function (q) {
          var wantIn = need(n, q[0]) * c;
          // Any line can bring it: its own input, or a mixed belt into another.
          var brings = ins2.some(function (l) { return carries(l, q[0]) || (!itemsOn(l).length && s.ins[l.tk] === q[0]); });
          if (!brings) {
            problem(n, label + ': nothing brings in ' + itemName(q[0]));
          } else if (c > 1e-9 && (st.got[q[0]] || 0) < wantIn * (1 - 1e-3) - 1e-6) {
            problem(n, label + ': gets ' + fmtNum(st.got[q[0]] || 0) + ' of the ' + fmtNum(wantIn) + '/min ' + itemName(q[0]) + ' it needs');
          }
        });
        ins2.forEach(function (l) {
          var extra = itemsOn(l).filter(function (i) { return !need(n, i); });
          if (extra.length) {
            problem(n, names(extra) + ' on a line into ' + label + (extra.length > 1 ? ' jam' : ' jams') +
              ' it: the ' + m.name + ' doesn’t use ' + (extra.length > 1 ? 'them' : 'it'));
          } else if (throttled[l.id] && slow[l.id] != null && slow[l.id] < 0.999) {
            problem(n, 'The mixed belt into ' + label + ' jams: it brings more ' + itemName(throttled[l.id]) +
              ' than the step uses, which holds up everything behind it. Sort the items onto their own belts with a Smart or Programmable Splitter first');
          }
        });
        s.outs.forEach(function (item, k) {
          var l = outLink(n, k);
          // A byproduct with nowhere to go fills the machine and stops it.
          if (!l && item !== (n.item || main) && st.outs[k] > 1e-6) {
            problem(n, fmtNum(st.outs[k]) + '/min ' + itemName(item) + ' has nowhere to go, so it would back up ' + label +
              (isFluid(item) ? ': fluids can’t be sunk, so use it up (Optimize finds a way) or package it'
                : ': send it to an AWESOME Sink'));
          }
          if (!l) {
            if (st.outs[k] > 1e-6) res.outputs[item] = (res.outputs[item] || 0) + st.outs[k];
          } else if (st.outs[k] - flowIn(l, item) > Math.max(0.01, st.outs[k] * 1e-3)) {
            problem(n, fmtNum(st.outs[k] - flowIn(l, item)) + '/min ' + itemName(item) + ' backs up');
          }
        });
      }
    } else if (n.type === 'resource') {
      var cap = resourceCap(n);
      var lo = outLink(n, 0);
      var used = lo ? flowIn(lo, n.item) : 0;
      st.count = n.count || 1;
      st.run = used;
      var exId = extractorOf(n);
      var ex = DATA.extractors[exId];
      if (ex) {
        var util = cap > 0 ? used / cap : 0;
        var each = SOLVER.clocks(n.count || 1, 'even').map(function () { return n.clock || 1; });
        res.tally.push({
          mid: exId, name: ex.name, exact: (n.count || 1) * util, built: n.count || 1,
          power: SOLVER.extractorPower(DATA, exId, each, state.clock) * util,
          label: itemName(n.item), note: (n.count || 1) + ' × ' + ex.name, id: n.id, extraction: true,
          shards: each.reduce(function (t, x) { return t + shardsFor(x); }, 0)
        });
      }
      if (used > 1e-6) {
        var it = res.items[n.item] || (res.items[n.item] = { supplied: 0, cap: 0, short: 0, surplus: 0, producers: [] });
        it.supplied += used;
        it.cap += cap;
      }
      if (state.noUse.indexOf(n.item) >= 0) {
        problem(n, itemName(n.item) + ' is switched off for this factory, under Resources' +
          (state.picker === 'optimise' ? ': nothing else can make what needs it' : ': Optimize can choose recipes that do without it'));
      }
      if (!lo) problem(n, itemName(n.item) + ' isn’t connected to anything');
      else if (!(byId[lo.to] && byId[lo.to].type === 'merger' && byId[lo.to].priority)) {
        // (Into a Priority Merger, the other inputs make up any shortfall;
        // a step left short says so itself.)
        var asked = request(lo, n.item, 0);
        if (asked > cap * (1 + 1e-3) + 1e-6) problem(n, itemName(n.item) + ': the steps ask for ' + fmtNum(asked) + '/min, but its nodes give ' + fmtNum(cap));
      }
    } else if (n.type === 'import') {
      var li = outLink(n, 0);
      var brought = li ? flowIn(li, n.item) : 0;
      st.run = brought;
      if (brought > 1e-6) {
        var bi = res.items[n.item] || (res.items[n.item] = { supplied: 0, short: 0, surplus: 0, producers: [], imported: true });
        bi.supplied += brought;
        bi.imported = true;
      }
      if (!li) problem(n, itemName(n.item) + ' (brought in) isn’t connected to anything');
    } else if (n.type === 'sink') {
      var ls = inLink(n, 0);
      if (ls) {
        var sv = flowOf[ls.id];
        Object.keys(sv).forEach(function (i) { if (sv[i] > 1e-6) res.outputs[i] = (res.outputs[i] || 0) + sv[i]; });
      }
    } else if (n.type === 'awesome') {
      var la = inLink(n, 0);
      if (la) {
        var av = flowOf[la.id];
        Object.keys(av).forEach(function (i) {
          if (!(av[i] > 1e-6)) return;
          res.sunk[i] = (res.sunk[i] || 0) + av[i];
          st.points = (st.points || 0) + sinkPoints(i, av[i]);
        });
        res.points += st.points || 0;
        var wet = itemsOn(la).filter(isFluid);
        if (wet.length) problem(n, 'An AWESOME Sink only takes solids: ' + names(wet) + ' backs up');
      }
    } else if (isLogistic(n)) {
      // Belts can carry a mix of items; pipes carry one fluid, never with
      // anything else.
      var kinds = {};
      (inL[n.id] || []).concat(outL[n.id] || []).forEach(function (l) { itemsOn(l).forEach(function (i) { kinds[i] = true; }); });
      var ks = Object.keys(kinds);
      if (!mixable(ks)) {
        problem(n, (ks.every(isFluid) ? 'Pipes can’t mix ' : 'Belts and pipes can’t mix: ') + names(ks));
      }
      if (stuck[n.id] && stuck[n.id].length) {
        problem(n, names(stuck[n.id]) + (stuck[n.id].length > 1 ? ' have' : ' has') + ' nowhere to go at this ' + partName(n) +
          ': no output takes ' + (stuck[n.id].length > 1 ? 'them' : 'it') + ', so the belt in stops');
      }
    }
    res.nodes[n.id] = st;
  });
  return res;
}

export { customFlow };
