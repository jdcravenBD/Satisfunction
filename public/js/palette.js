/* Satisfunction — The Items panel, placing parts, splicing them into lines, copy and paste. */

import { DATA, PICKABLE, RAW_ITEMS, availableMiner, canBuild, fallbackRecipe, isFluid, itemName,
  producersOf, recipeAllowed, stage, state } from './core.js';
import { clone, uid } from './store.js';
import { changed } from './history.js';
import { toWorld } from './view.js';
import { wires } from './wires.js';
import { clearSelection, selectOnly, selected } from './canvas.js';
import { closeAll } from './menus.js';
import { iconOf, isLogistic, nodeSize, palette } from './model.js';

/* ---- palette ---- */

var palQuery = '';

/** The items panel: resources, parts, and the logistics nodes, with a search. */
function renderPalette() {
  if (palette.dataset.built) { filterPalette(); return; }
  palette.dataset.built = '1';
  palette.innerHTML = '';
  // The title and search stay at the top while the items scroll under them.
  var top = document.createElement('div');
  top.className = 'pal-top';
  var title = document.createElement('div');
  title.className = 'pal-title';
  title.textContent = 'Items';
  top.appendChild(title);
  var field = document.createElement('div');
  field.className = 'pal-field';
  var search = document.createElement('input');
  search.type = 'text';
  search.className = 'pal-search';
  search.placeholder = 'Search items';
  search.spellcheck = false;
  var clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'pal-clear';
  clear.setAttribute('aria-label', 'Clear the search');
  clear.textContent = '×';
  clear.hidden = true;
  function query() {
    palQuery = search.value.trim().toLowerCase();
    clear.hidden = !search.value;
    filterPalette();
  }
  search.addEventListener('input', query);
  clear.addEventListener('click', function () { search.value = ''; query(); search.focus(); });
  field.appendChild(search);
  field.appendChild(clear);
  top.appendChild(field);
  palette.appendChild(top);
  // In the order the game brings them in (see order in tools/extract-data.mjs).
  function progression(a, b) { return (DATA.items[a].order || 0) - (DATA.items[b].order || 0); }
  var sections = [
    { head: 'Logistics', kinds: ['splitter', 'smart', 'programmable', 'merger', 'priority', 'sink', 'awesome'] },
    { head: 'Resources', kinds: RAW_ITEMS.slice().sort(progression) },
    { head: 'Parts', kinds: PICKABLE.slice().sort(progression) }
  ];
  var NAMES = { splitter: 'Splitter', smart: 'Smart Splitter', programmable: 'Programmable Splitter', merger: 'Merger',
    priority: 'Priority Merger', sink: 'Storage Container', awesome: 'AWESOME Sink' };
  var ICONS = { splitter: 'splitter', smart: 'splitter', programmable: 'splitter', merger: 'merger', priority: 'merger', sink: 'storage', awesome: 'sink' };
  sections.forEach(function (sec) {
    var wrap = document.createElement('div');
    wrap.className = 'pal-section';
    var head = document.createElement('div');
    head.className = 'pal-head';
    head.textContent = sec.head;
    wrap.appendChild(head);
    var grid = document.createElement('div');
    grid.className = 'pal-grid';
    sec.kinds.forEach(function (kind) {
      var name = NAMES[kind] || itemName(kind);
      var tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'pal-tile';
      tile.dataset.kind = kind;
      tile.dataset.name = name.toLowerCase();
      var img = document.createElement('img');
      img.src = iconOf(ICONS[kind] || kind);
      img.alt = '';
      img.draggable = false;
      var label = document.createElement('span');
      label.className = 'pal-name';
      label.textContent = name;
      tile.appendChild(img);
      tile.appendChild(label);
      tile.setAttribute('aria-label', name);
      tile.addEventListener('pointerdown', function (e) { dragFromPalette(kind, e); });
      grid.appendChild(tile);
    });
    wrap.appendChild(grid);
    palette.appendChild(wrap);
  });
  filterPalette();
}

function filterPalette() {
  palette.querySelectorAll('.pal-section').forEach(function (sec) {
    var any = false;
    sec.querySelectorAll('.pal-tile').forEach(function (t) {
      var show = !palQuery || t.dataset.name.indexOf(palQuery) >= 0;
      t.hidden = !show;
      if (show) any = true;
    });
    sec.hidden = !any;
  });
}

/** Drag an item off the panel onto the canvas; a plain click drops it mid-view. */
function dragFromPalette(kind, e) {
  if (e.button !== 0) return;
  e.preventDefault();
  closeAll();
  var startX = e.clientX, startY = e.clientY;
  var moved = false;
  var ghost = document.createElement('img');
  ghost.className = 'pal-ghost';
  ghost.src = e.currentTarget.querySelector('img').src;
  ghost.alt = '';
  function move(ev) {
    if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 4) return;
    if (!moved) { moved = true; document.body.appendChild(ghost); }
    ghost.style.left = ev.clientX + 'px';
    ghost.style.top = ev.clientY + 'px';
    // A splitter or merger held over a line goes into it when dropped.
    if (SPLICERS[kind]) markSplice(linkAt(ev.clientX, ev.clientY));
  }
  function up(ev) {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    ghost.remove();
    markSplice(null);
    if (!moved) {
      var r = stage.getBoundingClientRect();
      var mid = toWorld(r.left + r.width / 2, r.top + r.height / 2);
      placeItem(kind, mid.x, mid.y);
      return;
    }
    var over = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!over || !stage.contains(over) || over.closest('.view-opts, .hover-info')) return;
    var at = toWorld(ev.clientX, ev.clientY);
    placeItem(kind, at.x, at.y, SPLICERS[kind] ? linkAt(ev.clientX, ev.clientY) : null);
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/** The recipe a new step for an item starts on: its usual one if you can build it. */
function startRecipe(item) {
  var def = DATA.defaults[item];
  if (def && canBuild(def) && recipeAllowed(def)) return def;
  var list = (producersOf[item] || []).filter(function (rid) {
    return canBuild(rid) && recipeAllowed(rid) && DATA.recipes[rid].out[0][0] === item;
  });
  return list[0] || fallbackRecipe(item);
}

/** A new node for an item (a step, a resource, or something brought in), centred on a point. */
function newNode(kind, wx, wy) {
  var n;
  if (kind === 'splitter' || kind === 'merger' || kind === 'sink' || kind === 'awesome') {
    n = { type: kind };
  } else if (kind === 'smart') {
    n = { type: 'splitter', priority: true };
  } else if (kind === 'programmable') {
    n = { type: 'splitter', programmable: true };
  } else if (kind === 'priority') {
    n = { type: 'merger', priority: true };
  } else if (DATA.items[kind].raw) {
    n = { type: 'resource', item: kind, purity: 'normal', count: 1, clock: 1 };
    if (!isFluid(kind)) n.miner = availableMiner(state.defaultMiner);
  } else {
    var rid = startRecipe(kind);
    n = rid ? { type: 'recipe', recipe: rid, item: kind } : { type: 'import', item: kind, rate: 60 };
  }
  n.id = 'n' + uid();
  var size = nodeSize(n);
  n.x = Math.round(wx - size.w / 2);
  n.y = Math.round(wy - size.h / 2);
  state.custom.nodes.push(n);
  return n;
}

function placeItem(kind, wx, wy, onLink) {
  var n = newNode(kind, wx, wy);
  if (onLink) splice(onLink, n);
  selectOnly(n.id);
  changed();
}

/* ---- splitters and mergers dropped onto a line ---- */

var SPLICERS = { splitter: true, smart: true, programmable: true, merger: true, priority: true };

/** The line under a screen point, if any. */
function linkAt(x, y) {
  var el = document.elementFromPoint(x, y);
  var hit = el && el.closest && el.closest('.belt-hit');
  return hit ? state.custom.links.filter(function (l) { return l.id === hit.dataset.hit; })[0] || null : null;
}

/** Marks the line a drop would go into (or none). */
function markSplice(l) {
  wires.querySelectorAll('.cwire.splice').forEach(function (p) { p.classList.remove('splice'); });
  if (!l) return;
  var p = wires.querySelector('.cwire[data-link="' + l.id + '"]');
  if (p) p.classList.add('splice');
}

/** Puts a splitter or merger into a line: the line's start feeds it, and it feeds the line's end. */
function splice(l, n) {
  state.custom.links = state.custom.links.filter(function (x) { return x !== l; });
  state.custom.links.push({ id: 'l' + uid(), from: l.from, fk: l.fk, to: n.id, tk: 0 });
  state.custom.links.push({ id: 'l' + uid(), from: n.id, fk: 0, to: l.to, tk: l.tk });
}

/** Whether a card could go into a line: a splitter or merger with nothing joined yet. */
function canSplice(n) {
  return isLogistic(n) && !state.custom.links.some(function (l) { return l.from === n.id || l.to === n.id; });
}

/* ---- selection helpers ---- */

function selectedParts() {
  return state.custom.nodes.filter(function (n) { return selected[n.id]; });
}
function selectedLinks() {
  return state.custom.links.filter(function (l) { return selected[l.id]; });
}

/** Removes nodes, with every line on them, and any lines listed. */
function removeParts(list, links) {
  var gone = {};
  list.forEach(function (n) { gone[n.id] = true; });
  var cut = {};
  (links || []).forEach(function (l) { cut[l.id] = true; });
  state.custom.nodes = state.custom.nodes.filter(function (n) { return !gone[n.id]; });
  state.custom.links = state.custom.links.filter(function (l) {
    return !cut[l.id] && !gone[l.from] && !gone[l.to];
  });
  clearSelection();
  changed();
}

/* ---- copy and paste ---- */

// Copied cards, with the lines between them. Kept for the session, so they
// paste into another factory too.
var clip = null;
var pastes = 0;
var pointerOnStage = null;   // where the pointer last was over the canvas
stage.addEventListener('pointermove', function (e) { pointerOnStage = { x: e.clientX, y: e.clientY }; });
stage.addEventListener('pointerleave', function () { pointerOnStage = null; });

function copyParts(list) {
  if (!list.length) return;
  var ids = {};
  list.forEach(function (n) { ids[n.id] = true; });
  clip = {
    nodes: clone(list),
    links: clone(state.custom.links.filter(function (l) { return ids[l.from] && ids[l.to]; }))
  };
  pastes = 0;
}

/** New copies of the copied cards: under the pointer, or a step along from the last. */
function pasteParts(atScreen) {
  if (!clip || !clip.nodes.length) return;
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  clip.nodes.forEach(function (n) {
    var size = nodeSize(n);
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + size.w); y1 = Math.max(y1, n.y + size.h);
  });
  var dx, dy;
  var point = atScreen || pointerOnStage;
  if (point) {
    var w = toWorld(point.x, point.y);
    dx = Math.round(w.x - (x0 + x1) / 2);
    dy = Math.round(w.y - (y0 + y1) / 2);
  } else {
    pastes++;
    dx = dy = 40 * pastes;
  }
  var newId = {};
  clearSelection();
  clip.nodes.forEach(function (n) {
    var m = clone(n);
    m.id = 'n' + uid();
    m.x = n.x + dx;
    m.y = n.y + dy;
    newId[n.id] = m.id;
    state.custom.nodes.push(m);
    selected[m.id] = true;
  });
  clip.links.forEach(function (l) {
    state.custom.links.push({ id: 'l' + uid(), from: newId[l.from], fk: l.fk, to: newId[l.to], tk: l.tk });
  });
  changed();
}

export { canSplice, clip, copyParts, linkAt, markSplice, newNode, pasteParts, removeParts,
  renderPalette, selectedLinks, selectedParts, splice };
