/* Satisfunction — Dragging, selecting and panning on the canvas. */

import { NEW_TARGET_RATE, emptyHint, graph, itemName, pins, stage, state, storedNodes, world } from './core.js';
import { save, writeNow } from './store.js';
import { changed } from './history.js';
import { applyView, fitView, toWorld, usableWidth, zoomAt } from './view.js';
import { targetFor } from './nodes.js';
import { place } from './machines.js';
import { renderWires, setDragging, wires } from './wires.js';
import { closeAll, openCtx } from './menus.js';
import { askForOutput, renderTargets } from './panel.js';
import { clearPlan } from './factories.js';
import { customHint, flow } from './model.js';
import { addNote, setTool } from './notes.js';
import { clip, copyParts, pasteParts, removeParts, selectedLinks, selectedParts } from './palette.js';
import { customBoxes } from './cards.js';
import { renderInspector } from './inspector.js';

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
    var mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
    // A selected node brings the rest of the selection with it.
    var group = selected[n.key] ? selectedNodes() : [n];
    var origins = group.map(function (g) { return { x: g.x, y: g.y }; });
    var moved = false;

    function onMove(ev) {
      var dx = (ev.clientX - startX) / state.view.s;
      var dy = (ev.clientY - startY) / state.view.s;
      // A few pixels of slop, so a click on a node doesn't pin it.
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3 / state.view.s) return;
      if (!moved) {
        moved = true;
        setDragging(true);
        el.classList.add('dragging');
      }
      group.forEach(function (g, i) {
        g.x = Math.round(origins[i].x + dx);
        g.y = Math.round(origins[i].y + dy);
        g.pinned = true;
        pins()[g.key] = { x: g.x, y: g.y };
        place(g);
      });
      renderWires(); // lines follow the nodes as they move
    }

    function onUp(ev) {
      try { el.releasePointerCapture(ev.pointerId); } catch (err) { /* never captured */ }
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      setDragging(false);
      if (moved) {
        lowestAdders();
        save();
      } else {
        pickNode(n, mods);
      }
    }

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
}

/** Shows each resource's + only under its lowest block. */
function lowestAdders() {
  if (state.mode !== 'items') return;
  var lowest = {};
  graph.nodes.forEach(function (n) {
    if (!n.el || !n.el.querySelector('.n-add')) return;
    if (!lowest[n.item] || n.y + n.h > lowest[n.item].y + lowest[n.item].h) lowest[n.item] = n;
  });
  graph.nodes.forEach(function (n) {
    var add = n.el && n.el.querySelector('.n-add');
    if (add) add.hidden = lowest[n.item] !== n;
  });
}

/* ------------------------------------------------------------ selection */

// Nodes picked in the Items view, by key, so a selection survives any
// re-solve that keeps them. selAnchor is where a Shift+click range starts.
var selected = {};
var selAnchor = null;

function selectedNodes() {
  return graph.nodes.filter(function (n) { return selected[n.key] && n.el; });
}
function applySelection() {
  graph.nodes.forEach(function (n) {
    if (n.el) n.el.classList.toggle('selected', !!selected[n.key]);
  });
  world.querySelectorAll('.cpart').forEach(function (el) {
    el.classList.toggle('selected', !!selected[el.dataset.id]);
  });
  wires.querySelectorAll('[data-link]').forEach(function (el) {
    el.classList.toggle('selected', !!selected[el.dataset.link]);
  });
  if (state.build === 'custom' && flow) renderInspector();
}
function selectOnly(key) {
  selected = {};
  if (key) selected[key] = true;
  selAnchor = key || null;
  applySelection();
}
function clearSelection() { selectOnly(null); }

/** After a redraw: drop what's gone, and in the Machines view, everything. */
function keepSelection() {
  if (state.mode !== 'items') {
    selected = {};
    selAnchor = null;
    return;
  }
  Object.keys(selected).forEach(function (k) { if (!graph.byKey[k]) delete selected[k]; });
  if (selAnchor && !graph.byKey[selAnchor]) selAnchor = null;
  applySelection();
}

/** A click on a node: select it; Ctrl adds or removes it; Shift takes the range. */
function pickNode(n, mods) {
  if (mods.shift && selAnchor && graph.byKey[selAnchor] && selAnchor !== n.key) {
    var range = between(graph.byKey[selAnchor], n);
    if (!mods.ctrl) selected = {};
    range.forEach(function (m) { selected[m.key] = true; });
    applySelection();
    return;
  }
  if (mods.ctrl) {
    if (selected[n.key]) delete selected[n.key];
    else selected[n.key] = true;
    selAnchor = n.key;
    applySelection();
    return;
  }
  selectOnly(n.key);
}

/**
 * Everything in a line between two nodes. Where belts join them, the one
 * chain of belts that keeps closest to the straight line between the two
 * (Iron Ingot to Reinforced Iron Plate takes the rods and screws in that
 * row, not the plates off to the side). Otherwise, whatever that straight
 * line passes through (the bottom of five stacked ore nodes to the second
 * from the top takes all but the top one).
 */
function between(a, b) {
  var ax = a.x + a.w / 2, ay = a.y + a.h / 2;
  var bx = b.x + b.w / 2, by = b.y + b.h / 2;
  var len = Math.hypot(bx - ax, by - ay) || 1;
  function offLine(n) {
    var cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    return Math.abs((bx - ax) * (ay - cy) - (ax - cx) * (by - ay)) / len;
  }
  function reach(from, dir) {
    var seen = {};
    var queue = [from];
    seen[from.key] = true;
    while (queue.length) {
      var n = queue.shift();
      n[dir].forEach(function (e) {
        var next = graph.byKey[dir === 'out' ? e.to : e.from];
        if (next && !seen[next.key]) {
          seen[next.key] = true;
          queue.push(next);
        }
      });
    }
    return seen;
  }
  // A chain's score: its furthest node from the line, then its average.
  function better(p, q) {
    if (!q) return true;
    if (Math.abs(p.worst - q.worst) > 0.5) return p.worst < q.worst;
    if (Math.abs(p.mean - q.mean) > 0.5) return p.mean < q.mean;
    return p.nodes.length < q.nodes.length;
  }
  function chain(x, y) {
    var down = reach(x, 'out');
    if (!down[y.key]) return null;
    var up = reach(y, 'inn');
    var best = null;
    var tried = 0;
    (function walk(n, trail) {
      if (tried > 2000) return;
      if (n === y) {
        tried++;
        var offs = trail.slice(1, -1).map(offLine);
        var cand = {
          nodes: trail.slice(),
          worst: offs.length ? Math.max.apply(null, offs) : 0,
          mean: offs.length ? offs.reduce(function (s, o) { return s + o; }, 0) / offs.length : 0
        };
        if (better(cand, best)) best = cand;
        return;
      }
      n.out.forEach(function (e) {
        var next = graph.byKey[e.to];
        if (!next || !down[next.key] || !up[next.key] || trail.indexOf(next) >= 0) return;
        trail.push(next);
        walk(next, trail);
        trail.pop();
      });
    })(x, [x]);
    return best && best.nodes;
  }
  var list = chain(a, b) || chain(b, a);
  if (list) return list;
  // Not joined by belts: what a band along the line, half a node high,
  // passes through.
  var band = Math.min(a.h, b.h) / 4;
  var steps = Math.max(2, Math.ceil(len / 4));
  return graph.nodes.filter(function (n) {
    if (!n.el) return false;
    for (var i = 0; i <= steps; i++) {
      var px = ax + (bx - ax) * i / steps;
      var py = ay + (by - ay) * i / steps;
      if (px >= n.x && px <= n.x + n.w && py >= n.y - band && py <= n.y + n.h + band) return true;
    }
    return false;
  });
}

/** Whether a node can be removed: a step, an output, or one of several resource nodes. */
function canRemove(n) {
  if (n.kind === 'recipe' || n.kind === 'output') return true;
  return n.kind === 'raw' && n.slot != null && storedNodes(n.item).length > 1;
}

/**
 * The nodes in a list that can go. A resource keeps at least one node, so
 * if all of one's nodes are listed, its first stays.
 */
function removableOf(list) {
  list = list.filter(canRemove);
  var perItem = {};
  list.forEach(function (n) { if (n.kind === 'raw') perItem[n.item] = (perItem[n.item] || 0) + 1; });
  return list.filter(function (n) {
    return n.kind !== 'raw' || perItem[n.item] < storedNodes(n.item).length || n.slot !== 0;
  });
}

/**
 * Removes nodes: an output stops being asked for; a step stops being made
 * here and is brought in instead; a resource node comes off its resource.
 */
function removeNodes(list) {
  list = removableOf(list);
  if (!list.length) return;
  var dropTargets = {};
  var slots = {};
  list.forEach(function (n) {
    if (n.kind === 'output') dropTargets[n.item] = true;
    else if (n.kind === 'recipe') {
      state.imports[n.item] = true;
      delete state.recipes[n.item];
    } else {
      (slots[n.item] = slots[n.item] || []).push(n.slot);
    }
  });
  state.targets = state.targets.filter(function (t) { return !dropTargets[t.item]; });
  Object.keys(slots).forEach(function (id) {
    var s = state.supply[id] || {};
    var nodes = storedNodes(id).filter(function (_, i) { return slots[id].indexOf(i) < 0; });
    if (!nodes.length) return;  // a resource keeps at least one node
    state.supply[id] = { nodes: nodes, miner: s.miner };
  });
  clearSelection();
  renderTargets();
  changed();
}

function makeOutputs(items) {
  items.forEach(function (id) {
    if (!targetFor(id)) state.targets.push({ item: id, rate: NEW_TARGET_RATE, max: true });
  });
  renderTargets();
  changed();
}

function removeOutputs(items) {
  state.targets = state.targets.filter(function (t) { return items.indexOf(t.item) < 0; });
  clearSelection();
  renderTargets();
  changed();
}

function uniq(list) { return list.filter(function (x, i) { return list.indexOf(x) === i; }); }

/** What can be done to the selection; anything that doesn't apply is shown dimmed. */
function openSelectionMenu(x, y) {
  var nodes = selectedNodes();
  var removable = removableOf(nodes);
  var toOutput = uniq(nodes.filter(function (n) { return n.kind === 'recipe' && !targetFor(n.item); })
    .map(function (n) { return n.item; }));
  var outputs = uniq(nodes.filter(function (n) { return targetFor(n.item); })
    .map(function (n) { return n.item; }));
  // Inputs and outputs on their own can only be removed. Once a step in
  // between is selected too, the other options show, dimmed where they
  // don't apply (an input can't be made an output).
  var inside = nodes.some(function (n) { return n.kind === 'recipe'; });
  var hasInput = nodes.some(function (n) { return n.kind === 'raw'; });
  var items = [
    { head: nodes.length + ' selected' },
    {
      label: removable.length === 1 ? 'Remove node' : 'Remove nodes',
      note: removable.length
        ? (inside ? removable.length + ' · steps are brought in instead' : String(removable.length))
        : 'A resource keeps at least one node',
      disabled: !removable.length,
      run: function () { removeNodes(removable); }
    }
  ];
  if (inside) {
    items.push({
      label: toOutput.length === 1 ? 'Make this an output' : 'Make these outputs',
      note: hasInput ? 'Not with an input selected' : toOutput.length ? toOutput.map(itemName).join(', ') : 'Already outputs',
      disabled: hasInput || !toOutput.length,
      run: function () { makeOutputs(toOutput); }
    });
    items.push({
      label: outputs.length === 1 ? 'Remove output' : 'Remove outputs',
      note: outputs.length ? outputs.map(itemName).join(', ') : 'No outputs selected',
      disabled: !outputs.length,
      run: function () { removeOutputs(outputs); }
    });
  }
  openCtx(x, y, items);
}

// Delete removes the selection; Escape lets it go; Ctrl+A takes every node.
// In Custom, Ctrl+C, X and V copy, cut and paste cards; V, P, E and T pick
// the select, pencil, eraser and text tools.
document.addEventListener('keydown', function (e) {
  var el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
  if (state.build === 'custom') {
    var keyTool = { v: 'select', p: 'pencil', e: 'eraser', t: 'note' }[e.key.toLowerCase()];
    if (keyTool && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setTool(keyTool);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && (selectedParts().length || selectedLinks().length)) {
      e.preventDefault();
      removeParts(selectedParts(), selectedLinks());
    } else if (e.key === 'Escape') {
      setTool('select');
      clearSelection();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      state.custom.nodes.forEach(function (n) { selected[n.id] = true; });
      applySelection();
    } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'x') && selectedParts().length) {
      e.preventDefault();
      copyParts(selectedParts());
      if (e.key.toLowerCase() === 'x') removeParts(selectedParts(), []);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && clip) {
      e.preventDefault();
      pasteParts();
    }
    return;
  }
  if (state.mode !== 'items') return;
  if (e.key === 'Escape' && selectedNodes().length) {
    clearSelection();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    graph.nodes.forEach(function (n) { if (n.el) selected[n.key] = true; });
    applySelection();
  }
});

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
  // A step split into several machine lines is found by its first.
  var n = graph.byKey[key] || graph.byKey[key + '#0'];
  if (!n) return;
  var v = state.view;
  v.x = usableWidth() / 2 - (n.x + n.w / 2) * v.s;
  v.y = stage.clientHeight / 2 - (n.y + n.h / 2) * v.s;
  applyView();
  writeNow();
  if (!n.el) return;
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
  if (customHint.contains(target)) return true;
  // In Model, and in both views (which can't be edited), a press anywhere
  // in the world counts: on a view's card it pans.
  return world.contains(target);
}

// Right-click on bare canvas.
stage.addEventListener('contextmenu', function (e) {
  if (!onCanvas(e.target)) return;
  e.preventDefault();
  closeAll();

  if (state.build === 'custom') {
    if (dragMenuSkip()) return;
    var at = { x: e.clientX, y: e.clientY };
    var menuItems = [
      { label: 'Paste', kbd: 'Ctrl+V', disabled: !clip, run: function () { pasteParts(at); } },
      '-',
      { label: '+ Add output…', run: function () { askForOutput(null, e.clientX, e.clientY); } },
      { label: 'Add a note', run: function () { var w = toWorld(at.x, at.y); addNote(w.x, w.y); } },
      { label: 'Fit to view', run: fitView }
    ];
    menuItems.push('-');
    menuItems.push({ label: 'Clear model', note: 'Removes every card', danger: true, confirm: true, run: clearPlan });
    openCtx(e.clientX, e.clientY, menuItems);
    return;
  }
  // The views only look.
  openCtx(e.clientX, e.clientY, [{ label: 'Fit to view', run: fitView }]);
});

var marquee = document.getElementById('marquee');

// After a right-button drag, the context menu that follows is skipped.
var skipMenuUntil = 0;
function dragMenuSkip() {
  if (Date.now() < skipMenuUntil) { skipMenuUntil = 0; return true; }
  return false;
}

/**
 * Draws the selection rectangle; on release, the nodes it touches become
 * the selection (Items view).
 */
function startMarquee(e, rightButton) {
  var box = stage.getBoundingClientRect();
  var x0 = e.clientX - box.left;
  var y0 = e.clientY - box.top;
  var x1 = x0;
  var y1 = y0;

  // With the right button, the box only shows once the pointer moves.
  if (!rightButton) marquee.classList.add('on');
  marquee.style.left = x0 + 'px';
  marquee.style.top = y0 + 'px';
  marquee.style.width = '0px';
  marquee.style.height = '0px';

  try { stage.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }

  function onMove(ev) {
    x1 = ev.clientX - box.left;
    y1 = ev.clientY - box.top;
    if (rightButton && !marquee.classList.contains('on') && Math.abs(x1 - x0) + Math.abs(y1 - y0) >= 4) {
      marquee.classList.add('on');
      closeAll();
    }
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
    if (Math.abs(x1 - x0) + Math.abs(y1 - y0) < 4) return;
    // The menu a right-button release would open isn't wanted after a box.
    if (rightButton) skipMenuUntil = Date.now() + 600;
    if (state.build === 'custom') {
      var cv = state.view;
      var cx0 = (Math.min(x0, x1) - cv.x) / cv.s, cx1 = (Math.max(x0, x1) - cv.x) / cv.s;
      var cy0 = (Math.min(y0, y1) - cv.y) / cv.s, cy1 = (Math.max(y0, y1) - cv.y) / cv.s;
      selected = {};
      customBoxes().forEach(function (b) {
        if (b.x < cx1 && b.x + b.w > cx0 && b.y < cy1 && b.y + b.h > cy0) selected[b.id] = true;
      });
      applySelection();
      return;
    }
    if (state.mode !== 'items') return;
    // The box in world coordinates.
    var v = state.view;
    var wx0 = (Math.min(x0, x1) - v.x) / v.s;
    var wx1 = (Math.max(x0, x1) - v.x) / v.s;
    var wy0 = (Math.min(y0, y1) - v.y) / v.s;
    var wy1 = (Math.max(y0, y1) - v.y) / v.s;
    selected = {};
    graph.nodes.forEach(function (n) {
      if (n.el && n.x < wx1 && n.x + n.w > wx0 && n.y < wy1 && n.y + n.h > wy0) selected[n.key] = true;
    });
    applySelection();
  }

  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
}

stage.addEventListener('pointerdown', function (e) {
  // In Model, holding the right button and dragging draws a selection box;
  // a right-click that doesn't move still opens the menu.
  if (e.button === 2 && state.build === 'custom' && onCanvas(e.target)) {
    startMarquee(e, true);
    return;
  }
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
  // Panning is applied incrementally from the previous pointer position, so
  // a wheel-zoom mid-drag doesn't make the view lurch. The hand shows once
  // it's really moving, not on a plain click.
  var lastX = e.clientX;
  var lastY = e.clientY;
  var panStartX = e.clientX;
  var panStartY = e.clientY;

  function onMove(ev) {
    if (!stage.classList.contains('panning') && Math.abs(ev.clientX - panStartX) + Math.abs(ev.clientY - panStartY) >= 3) {
      stage.classList.add('panning');
    }
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
    if (Math.abs(ev.clientX - panStartX) + Math.abs(ev.clientY - panStartY) < 4) clearSelection();
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

// Other files change these through here: an imported name can't be assigned to.
function setSelected(v) { selected = v; return v; }
function setSelAnchor(v) { selAnchor = v; return v; }

export { applySelection, clearSelection, dragBehaviour, dragMenuSkip, focusOn, keepSelection,
  lowestAdders, openSelectionMenu, selectOnly, selected, selectedNodes, setSelAnchor,
  setSelected, unpin };
