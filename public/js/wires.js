/* Satisfunction — Item view lines between cards, and what lights up together on hover. */

import { fmtNum, graph, isFluid, itemName, labelsEl, state, world } from './core.js';

/* ---------------------------------------------------------------- wires */

var SVG_NS = 'http://www.w3.org/2000/svg';
var wires = document.getElementById('wires');
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
function line(d, fluid, keys, layer, extra) {
  var more = extra ? ' ' + extra : '';
  if (fluid) {
    relate(keys, svg('path', { d: d, 'class': 'wire pipe' + more }, layer));
    relate(keys, svg('path', { d: d, 'class': 'wire pipe-core' + more }, layer));
  } else {
    relate(keys, svg('path', { d: d, 'class': 'wire' + more }, layer));
  }
}

function renderWires() {
  while (wires.firstChild) wires.removeChild(wires.firstChild);
  labelsEl.innerHTML = '';
  related = {};

  var byKey = graph.byKey;

  // A moved node breaks the route layout planned, so its lines go direct.
  function viaOf(e) {
    if (byKey[e.from].pinned || byKey[e.to].pinned) return [];
    return e.via || [];
  }
  function centerY(key) { var n = byKey[key]; return n.y + n.h / 2; }
  function nextY(e) { var v = viaOf(e); return v.length ? v[0].y : centerY(e.to); }
  function prevY(e) { var v = viaOf(e); return v.length ? v[v.length - 1].y : centerY(e.from); }

  // Each node spreads its lines along its edge, in the order of whatever is
  // at the other end, so they leave and arrive without crossing each other.
  var outPos = {};
  var inPos = {};
  graph.nodes.forEach(function (n) {
    var outs = n.out.slice().sort(function (a, b) { return nextY(a) - nextY(b); });
    outs.forEach(function (e, i) {
      outPos[edgeId(e)] = { x: n.x + n.w, y: n.y + n.h * (i + 1) / (outs.length + 1) };
    });
    var ins = n.inn.slice().sort(function (a, b) { return prevY(a) - prevY(b); });
    ins.forEach(function (e, i) {
      inPos[edgeId(e)] = { x: n.x, y: n.y + n.h * (i + 1) / (ins.length + 1) };
    });
  });

  var straight = state.show.lines === 'straight';

  graph.edges.forEach(function (e) {
    if (straight) {
      straightWire(e);
      return;
    }
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
    labelsEl.appendChild(label);
    relate(keys, label);
  });

  /**
   * Straight: from the middle of the node it leaves (hidden under that
   * node) to the edge of the node it feeds, where a long, narrow arrow
   * points in.
   */
  function straightWire(e) {
    var a = byKey[e.from];
    var b = byKey[e.to];
    var ax = a.x + a.w / 2, ay = a.y + a.h / 2;
    var bx = b.x + b.w / 2, by = b.y + b.h / 2;
    var dx = bx - ax, dy = by - ay;
    var len = Math.hypot(dx, dy);
    if (len < 1) return;
    var ux = dx / len, uy = dy / len;
    // How far along the line each box's edge is.
    function exitAt(n, fromEnd) {
      var tx = ux ? (n.w / 2) / Math.abs(ux) : Infinity;
      var ty = uy ? (n.h / 2) / Math.abs(uy) : Infinity;
      return Math.min(tx, ty) + (fromEnd ? 3 : 0);
    }
    var tipD = len - exitAt(b, true);
    var startD = exitAt(a, false);
    if (tipD <= startD + 4) return;
    var ARROW = 20, HALF = 5;
    var tip = { x: ax + ux * tipD, y: ay + uy * tipD };
    var base = { x: tip.x - ux * ARROW, y: tip.y - uy * ARROW };
    var keys = [e.from, e.to];
    var fluid = isFluid(e.item);
    line('M ' + ax + ' ' + ay + ' L ' + base.x + ' ' + base.y, fluid, keys, null, 'thin');
    var px = -uy * HALF, py = ux * HALF;
    relate(keys, svg('path', {
      d: 'M ' + tip.x + ' ' + tip.y + ' L ' + (base.x + px) + ' ' + (base.y + py) +
        ' L ' + (base.x - px) + ' ' + (base.y - py) + ' Z',
      'class': 'wire-arrow' + (fluid ? ' pipe' : '')
    }));

    // The rate, halfway along the part that shows.
    var mid = (startD + tipD) / 2;
    var label = document.createElement('div');
    label.className = 'flow-label';
    label.style.left = ax + ux * mid + 'px';
    label.style.top = ay + uy * mid + 'px';
    var bold = document.createElement('b');
    bold.textContent = fmtNum(e.rate);
    label.appendChild(bold);
    label.appendChild(document.createTextNode((fluid ? ' m³' : '') + '/min'));
    if (a.item !== e.item) {
      var nm = document.createElement('span');
      nm.className = 'fl-item';
      nm.textContent = itemName(e.item);
      label.appendChild(nm);
    }
    labelsEl.appendChild(label);
    relate(keys, label);
  }

  if (hovered) focusNode(hovered, true);
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

// Other files change these through here: an imported name can't be assigned to.
function setRelated(v) { related = v; return v; }
function setDragging(v) { dragging = v; return v; }

export { dragging, edgeId, focusNode, relate, renderWires, setDragging, setRelated, svg,
  wirePath, wires };
