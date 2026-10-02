/* Satisfunction — The camera: panning and zooming the canvas. */

import { MAX_ZOOM, MIN_ZOOM, clamp, graph, stage, state, world } from './core.js';
import { writeNow } from './store.js';
import { penCursor, tool } from './notes.js';
import { customBoxes } from './cards.js';

/* ----------------------------------------------------------------- view */

var CELL = 44;           // must match --cell in styles.css
var FOUNDATION_PX = 64;  // machine view: one 8 m foundation at 8 px/m

function applyView() {
  var v = state.view;
  world.style.transform =
    'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.s + ')';
  // Text outlines stay one pixel on screen at any zoom; the pencil's
  // cursor follows how wide its line looks now.
  world.style.setProperty('--zoom', v.s);
  if (typeof tool !== 'undefined' && tool === 'pencil') penCursor();

  // Drag the plus field along with the nodes, and scale it with the zoom,
  // so the canvas reads as one surface rather than a fixed backdrop. In the
  // machine view the pluses mark the corners of 8 m foundations.
  var machines = state.mode === 'machines' && state.build !== 'custom';
  var cell = (machines ? FOUNDATION_PX : CELL) * v.s;
  var shift = machines ? cell / 2 : 0;
  stage.style.backgroundSize = cell + 'px ' + cell + 'px';
  stage.style.backgroundPosition = (v.x - shift) + 'px ' + (v.y - shift) + 'px';

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
  return stage.clientWidth;
}

/** Frames the whole plan in whatever part of the canvas is visible. */
function fitView() {
  var nodes = state.build === 'custom' ? customBoxes() : graph.nodes.concat((graph.bands || []).map(function (b) {
    // The Machine view's floors, names and all.
    return { x: b.left, y: b.top, w: b.right - b.left, h: b.bottom - b.top };
  }));
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

export { applyView, fitView, toWorld, usableWidth, zoomAt };
