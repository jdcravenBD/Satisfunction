/* Satisfunction — Model tools: pencil, eraser and text notes. */

import { clamp, stage, state, world } from './core.js';
import { save, uid } from './store.js';
import { changed } from './history.js';
import { toWorld } from './view.js';
import { closeAll, openCtx } from './menus.js';

/* ---- notes, and the pencil ---- */

// In Model, a strip of tools at the canvas's top left says what a press
// does: select (the usual), draw with the pencil, rub drawings out, or
// drop a note. Notes and drawings are saved with the model and only show
// there.
var inkEl = document.getElementById('ink');

// The canvas clips rather than scrolls, but focusing something near its
// edge (a note) can still scroll it; that would shift everything, so any
// scroll is put straight back.
stage.addEventListener('scroll', function () {
  if (stage.scrollLeft || stage.scrollTop) { stage.scrollLeft = 0; stage.scrollTop = 0; }
});
var toolsEl = document.getElementById('model-tools');
var tool = 'select';
var PEN = 5;     // pencil width on the canvas (so on screen, times the zoom)
var RUB = 4;     // eraser reach from the pointer, px (its cursor is a square twice this)

/** The pencil's cursor: a circle as wide as its line looks at this zoom. */
function penCursor() {
  var d = clamp(PEN * state.view.s, 2, 100);
  var size = Math.ceil(d + 4);
  var c = size / 2;
  var light = document.documentElement.dataset.theme === 'light';
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '">' +
    '<circle cx="' + c + '" cy="' + c + '" r="' + (d / 2 + 1) + '" fill="none" stroke="' + (light ? '#fff' : '#000') + '" stroke-opacity="' + (light ? '.8' : '.55') + '" stroke-width="1"/>' +
    '<circle cx="' + c + '" cy="' + c + '" r="' + (d / 2) + '" fill="none" stroke="' + (light ? '#000' : '#fff') + '" stroke-width="1"/></svg>';
  stage.style.setProperty('--pen-cursor', 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '") ' + Math.round(c) + ' ' + Math.round(c));
}

function setTool(t) {
  tool = t;
  if (t === 'pencil') penCursor();
  toolsEl.querySelectorAll('.mt-btn').forEach(function (b) { b.classList.toggle('on', b.dataset.tool === t); });
  stage.classList.toggle('tool-pencil', t === 'pencil');
  stage.classList.toggle('tool-eraser', t === 'eraser');
  stage.classList.toggle('tool-note', t === 'note');
}
toolsEl.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
toolsEl.addEventListener('click', function (e) {
  var b = e.target.closest('.mt-btn');
  if (b) setTool(b.dataset.tool === tool && tool !== 'select' ? 'select' : b.dataset.tool);
});

/** A stroke's points as a smooth path: straight to each midpoint, curving through the points. */
function inkPath(pts) {
  if (pts.length < 4) return '';
  var d = 'M' + pts[0] + ' ' + pts[1];
  if (pts.length === 4) return d + ' L' + pts[2] + ' ' + pts[3];
  for (var i = 2; i < pts.length - 2; i += 2) {
    var mx = (pts[i] + pts[i + 2]) / 2, my = (pts[i + 1] + pts[i + 3]) / 2;
    d += ' Q' + pts[i] + ' ' + pts[i + 1] + ' ' + mx + ' ' + my;
  }
  return d + ' L' + pts[pts.length - 2] + ' ' + pts[pts.length - 1];
}

function renderInk() {
  inkEl.innerHTML = '';
  (state.custom.strokes || []).forEach(function (k) {
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', inkPath(k.pts));
    p.setAttribute('class', 'ink-stroke');
    p.dataset.id = k.id;
    inkEl.appendChild(p);
  });
}

function renderNotes() {
  world.querySelectorAll('.cnote').forEach(function (el) { el.remove(); });
  (state.custom.notes || []).forEach(function (n) { world.appendChild(noteEl(n)); });
}

/**
 * A note: white text in a thin outline, the box growing with what's typed.
 * Click the text to type; drag by the outline around it. A note left empty
 * goes away.
 */
function noteEl(n) {
  var el = document.createElement('div');
  el.className = 'cnote';
  el.dataset.id = n.id;
  el.style.left = n.x + 'px';
  el.style.top = n.y + 'px';
  var text = document.createElement('textarea');
  text.className = 'cnote-text';
  text.value = n.text || '';
  text.placeholder = 'Text';
  text.spellcheck = false;
  text.rows = 1;
  el.appendChild(text);
  function fit() {
    // Browsers without field-sizing grow it by hand.
    if (CSS.supports && CSS.supports('field-sizing', 'content')) return;
    text.style.height = 'auto';
    text.style.height = text.scrollHeight + 'px';
  }
  requestAnimationFrame(fit);
  // The note as it is in the model now (a redraw or undo may have swapped the object).
  function live() { return (state.custom.notes || []).filter(function (m) { return m.id === n.id; })[0]; }
  function remove() {
    state.custom.notes = (state.custom.notes || []).filter(function (m) { return m.id !== n.id; });
    changed();
  }
  text.addEventListener('input', function () { var m = live(); if (m) m.text = text.value; fit(); save(); });
  // While typing, presses in the text are the text's own (caret, selection).
  text.addEventListener('pointerdown', function (e) {
    if (document.activeElement === text) e.stopPropagation();
  });
  text.addEventListener('blur', function () {
    if (!text.value.trim() && live()) remove();
  });
  text.addEventListener('keydown', function (e) {
    // Enter finishes; Shift+Enter starts a new line.
    if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      text.blur();
    }
  });
  // Otherwise a press anywhere on it drags it, or, if it doesn't move,
  // starts typing at the end.
  el.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || document.activeElement === text) return;
    e.preventDefault();
    e.stopPropagation();
    closeAll();
    var m = live() || n;
    var sx = e.clientX, sy = e.clientY, ox = m.x, oy = m.y, moved = false;
    function move(ev) {
      var dx = (ev.clientX - sx) / state.view.s, dy = (ev.clientY - sy) / state.view.s;
      if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 3) return;
      if (!moved) { stage.classList.add('moving-note'); el.classList.add('moving'); }
      moved = true;
      m.x = Math.round(ox + dx);
      m.y = Math.round(oy + dy);
      el.style.left = m.x + 'px';
      el.style.top = m.y + 'px';
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      stage.classList.remove('moving-note');
      el.classList.remove('moving');
      if (moved) { save(); return; }
      var at = caretAt(text, sx, sy);
      text.focus({ preventScroll: true });
      text.setSelectionRange(at, at);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  el.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (document.activeElement === text) return;
    closeAll();
    openCtx(e.clientX, e.clientY, [
      { head: 'Text' },
      { label: 'Remove', run: remove }
    ]);
  });
  return el;
}

/**
 * Where in a text box's text a screen point falls: its line from the
 * height, then the nearest gap between letters along it, measured in the
 * box's own font (the canvas zoom taken out).
 */
var measureCtx = null;
function caretAt(ta, x, y) {
  var cs = getComputedStyle(ta);
  var r = ta.getBoundingClientRect();
  var z = state.view.s;
  var lx = (x - r.left) / z - parseFloat(cs.paddingLeft);
  var ly = (y - r.top) / z - parseFloat(cs.paddingTop);
  var lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25;
  var lines = ta.value.split('\n');
  var row = clamp(Math.floor(ly / lh), 0, lines.length - 1);
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  measureCtx.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
  var line = lines[row], col = line.length;
  for (var i = 0; i < line.length; i++) {
    var mid = (measureCtx.measureText(line.slice(0, i)).width + measureCtx.measureText(line.slice(0, i + 1)).width) / 2;
    if (lx < mid) { col = i; break; }
  }
  var at = col;
  for (var j = 0; j < row; j++) at += lines[j].length + 1;
  return at;
}

/** A new note at a point on the canvas, ready to type in. */
function addNote(wx, wy) {
  var n = { id: 'm' + uid(), x: Math.round(wx), y: Math.round(wy), text: '' };
  state.custom.notes = (state.custom.notes || []).concat([n]);
  changed();
  var el = world.querySelector('.cnote[data-id="' + n.id + '"] .cnote-text');
  if (el) el.focus({ preventScroll: true });
}

// With the pencil, eraser or note tool, a press on the canvas (cards
// included) is theirs, caught before anything else sees it.
stage.addEventListener('pointerdown', function (e) {
  if (state.build !== 'custom' || tool === 'select' || e.button !== 0) return;
  if (e.target.closest('.view-opts, .model-tools, .cnote, .empty-hint')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  closeAll();
  var w = toWorld(e.clientX, e.clientY);
  if (tool === 'note') {
    addNote(w.x, w.y);
    setTool('select');
    return;
  }
  try { stage.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }
  if (tool === 'pencil') {
    var pts = [Math.round(w.x), Math.round(w.y)];
    var live = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    live.setAttribute('class', 'ink-stroke live');
    inkEl.appendChild(live);
    var draw = function (ev) {
      var p = toWorld(ev.clientX, ev.clientY);
      var lx = pts[pts.length - 2], ly = pts[pts.length - 1];
      // Points closer than a couple of pixels on screen add nothing.
      if (Math.hypot(p.x - lx, p.y - ly) * state.view.s < 2.5) return;
      pts.push(Math.round(p.x), Math.round(p.y));
      live.setAttribute('d', inkPath(pts));
    };
    var done = function () {
      stage.removeEventListener('pointermove', draw);
      stage.removeEventListener('pointerup', done);
      stage.removeEventListener('pointercancel', done);
      if (pts.length < 4) pts.push(pts[0] + 1, pts[1]);  // a dot
      state.custom.strokes = (state.custom.strokes || []).concat([{ id: 'k' + uid(), pts: pts }]);
      changed();
    };
    stage.addEventListener('pointermove', draw);
    stage.addEventListener('pointerup', done);
    stage.addEventListener('pointercancel', done);
    return;
  }
  // Eraser: any stroke passing near the pointer goes.
  var gone = {};
  var rub = function (ev) {
    var p = toWorld(ev.clientX, ev.clientY);
    var r = RUB / state.view.s;
    (state.custom.strokes || []).forEach(function (k) {
      if (gone[k.id]) return;
      for (var i = 0; i < k.pts.length; i += 2) {
        if (Math.abs(k.pts[i] - p.x) <= r && Math.abs(k.pts[i + 1] - p.y) <= r) {
          gone[k.id] = true;
          var el = inkEl.querySelector('[data-id="' + k.id + '"]');
          if (el) el.remove();
          return;
        }
      }
    });
  };
  rub(e);
  var stop = function () {
    stage.removeEventListener('pointermove', rub);
    stage.removeEventListener('pointerup', stop);
    stage.removeEventListener('pointercancel', stop);
    if (Object.keys(gone).length) {
      state.custom.strokes = state.custom.strokes.filter(function (k) { return !gone[k.id]; });
      changed();
    }
  };
  stage.addEventListener('pointermove', rub);
  stage.addEventListener('pointerup', stop);
  stage.addEventListener('pointercancel', stop);
}, true);

export { addNote, inkEl, penCursor, renderInk, renderNotes, setTool, tool, toolsEl };
