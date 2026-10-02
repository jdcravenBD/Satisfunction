/* Satisfunction — Toolbar, confirm popups, context menus, and the recipe and item pickers. */

import { DATA, EPS, MINERS, PICKABLE, SOLVER, canBuild, clamp, currentRecipe, fmtNum,
  hasBuilding, isFluid, itemName, machineName, pins, producersOf, rateText, recipeAllowed,
  redoBtn, solved, stage, state, storedNodes, supplyInfo, titleCase, undoBtn, unlockable } from './core.js';
import { writeNow } from './store.js';
import { changed, redo, undo } from './history.js';
import { fitView, usableWidth, zoomAt } from './view.js';
import { targetFor } from './nodes.js';
import { unpin } from './canvas.js';
import { addTarget, renderTargets } from './panel.js';

/* -------------------------------------------------------------- toolbar */

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
  if (e.key.toLowerCase() === 's') {
    e.preventDefault();  // not the browser's "save page"
    writeNow();
    return;
  }
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

/** The confirmation's wording: its question and buttons, or the usual. */
function confirmWords(w) {
  w = w || {};
  confirmEl.querySelector('.confirm-q').textContent = w.q || 'Are you sure?';
  confirmEl.querySelector('.confirm-yes').textContent = w.yes || 'Yes';
  confirmEl.querySelector('.confirm-no').textContent = w.no || 'No';
  confirmEl.classList.toggle('wordy', !!w.q);
}

/**
 * Drop the shared "Are you sure?" just under the pointer, with the pointer
 * centred between Yes and No, running `onYes` if taken. From the keyboard
 * (no pointer), it drops against `anchor`.
 */
function askConfirm(anchor, onYes, overlap, words) {
  popOpener = clickFrom;
  confirmAction = onYes;
  confirmWords(words);
  if (lastPress && Date.now() - lastPress.t < 1500) {
    var yes = confirmEl.querySelector('.confirm-yes');
    var no = confirmEl.querySelector('.confirm-no');
    var mid = (yes.offsetLeft + yes.offsetWidth + no.offsetLeft) / 2;
    var w = confirmEl.offsetWidth;
    var h = confirmEl.offsetHeight;
    var left = Math.max(8, Math.min(lastPress.x - mid, window.innerWidth - w - 8));
    var top = lastPress.y + 12;
    if (top + h > window.innerHeight - 8) top = lastPress.y - h - 12;
    confirmEl.style.left = left + 'px';
    confirmEl.style.top = top + 'px';
  } else {
    placePopup(confirmEl, anchor, overlap);
  }
  confirmEl.classList.add('show');
}

// Where the pointer last pressed, for popups that open under it.
var lastPress = null;
document.addEventListener('pointerdown', function (e) {
  lastPress = { x: e.clientX, y: e.clientY, t: Date.now() };
}, true);
document.addEventListener('keydown', function () { lastPress = null; }, true);

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
 * section heading, { toggle, label, note, on, run(on) } for a switch that
 * flips in place (the menu stays open), or { label, run, note, tag, on,
 * danger, confirm }.
 * Placed at the point given, nudged back inside the window if it overflows.
 */
function openCtx(clientX, clientY, items, asPicker, minWidth) {
  popOpener = clickFrom;
  ctx.innerHTML = '';
  ctx.classList.toggle('picker', !!asPicker);
  ctx.style.minWidth = minWidth ? minWidth + 'px' : '';
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
    if (item.toggle) {
      b.className = 'ctx-toggle';
      b.setAttribute('role', 'switch');
      var text = document.createElement('span');
      text.className = 'ctx-toggle-text';
      var tl = document.createElement('span');
      tl.className = 'ctx-main';
      tl.textContent = item.label;
      text.appendChild(tl);
      if (item.note) {
        var tn = document.createElement('span');
        tn.className = 'ctx-note';
        tn.textContent = item.note;
        text.appendChild(tn);
      }
      var sw = document.createElement('span');
      sw.className = 'ctx-switch';
      b.appendChild(text);
      b.appendChild(sw);
      var on = !!item.on;
      var paint = function () {
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      };
      paint();
      b.addEventListener('click', function () {
        on = !on;
        paint();
        item.run(on);
      });
      ctx.appendChild(b);
      return;
    }
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
    if (item.icon) {
      var ic = document.createElement('img');
      ic.className = 'ctx-icon';
      ic.src = item.icon;
      ic.alt = '';
      b.classList.add('with-icon');
      b.insertBefore(ic, b.firstChild);
    }
    if (item.kbd) {
      var kbd = document.createElement('span');
      kbd.className = 'ctx-kbd';
      kbd.textContent = item.kbd;
      b.appendChild(kbd);
    }
    if (item.danger) b.classList.add('danger');
    if (item.on) b.classList.add('on');
    if (item.disabled) b.disabled = true;
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
// A press on the button that opened the popup closes it too, and the click
// that follows is swallowed so it doesn't open it straight back up.
document.addEventListener('pointerdown', function (e) {
  if (confirmEl.contains(e.target) || itemPop.contains(e.target)) return;
  var open = ctx.classList.contains('show') || confirmEl.classList.contains('show') ||
    itemPop.classList.contains('show');
  swallow = open && popOpener && popOpener.contains(e.target) ? popOpener : null;
  if (!ctx.contains(e.target)) closeCtx();
  closeConfirm();
  closeItemPicker();
}, true);

var popOpener = null;  // the button that opened the popup showing
var clickFrom = null;  // the button being clicked right now
var swallow = null;
document.addEventListener('click', function (e) {
  if (swallow && swallow.contains(e.target)) {
    e.stopPropagation();
    e.preventDefault();
    swallow = null;
    return;
  }
  swallow = null;
  clickFrom = e.target.closest ? e.target.closest('button') : null;
  setTimeout(function () { clickFrom = null; }, 0);
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

    var optimising = state.picker === 'optimise';
    items.push({ head: 'Recipe for ' + itemName(id) });
    if (optimising) {
      // In optimise mode a pick is a pin: the optimiser has to use it.
      items.push({
        label: 'Let the optimiser choose',
        note: 'Picking a recipe below pins it',
        on: !current && !state.imports[id],
        run: function () {
          delete state.recipes[id];
          delete state.imports[id];
          changed();
        }
      });
    } else if (current && typeof current !== 'string') {
      items.push({
        label: 'Mixed',
        note: Object.keys(current).map(function (rid) {
          return Math.round(current[rid] * 100) + '% ' + DATA.recipes[rid].name;
        }).join(', '),
        on: true,
        run: function () {}
      });
    }
    list.forEach(function (rid) {
      var r = DATA.recipes[rid];
      var locked = optimising && unlockable(rid) && !recipeAllowed(rid);
      items.push({
        label: r.name,
        tag: r.alt ? 'ALT' : (r.out[0][0] !== id ? 'SIDE' : null),
        note: recipeSummary(rid) + (locked ? ' · not unlocked' : '') +
          (canBuild(rid) ? '' : ' · no ' + machineName(rid)),
        on: typeof current === 'string' ? current === rid : false,
        run: function () {
          if (rid === def && !optimising) delete state.recipes[id];
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
    var s = state.supply[id] || {};
    var nodes = storedNodes(id);
    var slot = Math.min(n.slot || 0, Math.max(0, nodes.length - 1));
    var here = nodes[slot];
    var nd = info.nodeList[slot];
    var set = function (list, miner) {
      state.supply[id] = { nodes: list, miner: miner || s.miner };
      changed();
    };
    // This node, changed; the others left alone.
    // Every node keeps the miner it has now, so picking one here doesn't
    // move the others (which may be following the last miner picked).
    var withHere = function (change) {
      var list = nodes.map(function (o, j) {
        var copy = Object.assign({}, o);
        if (!isFluid(id) && info.nodeList[j]) copy.miner = info.nodeList[j].extractor;
        return copy;
      });
      if (!list.length) list = [{ purity: 'normal' }];
      Object.assign(list[slot], change);
      return list;
    };
    var minerHere = nd ? nd.extractor : info.extractor;
    var rateFor = function (mid, p) {
      return rateText(id, DATA.extractors[mid].rate * SOLVER.PURITY[p]) + ' per node';
    };

    items.push({ head: nodes.length > 1
      ? 'Node ' + (slot + 1) + ' of ' + nodes.length + ' · ' + rateText(id, info.capacity) + ' in all'
      : 'Resource node · ' + DATA.extractors[minerHere].name });
    items.push({
      label: 'Any node',
      note: nodes.length > 1 ? 'As much as the plan needs, in place of all ' + nodes.length + ' nodes' : 'As much as the plan needs',
      on: !nodes.length,
      run: function () { set([]); }
    });
    SOLVER.PURITIES.forEach(function (p) {
      items.push({
        label: titleCase(p),
        note: rateFor(minerHere, p),
        on: !!here && here.purity === p,
        run: function () { set(withHere({ purity: p })); }
      });
    });

    if (!isFluid(id)) {
      items.push('-');
      items.push({ head: nodes.length > 1 ? 'Miner on this node' : 'Miner' });
      MINERS.forEach(function (mid) {
        var ex = DATA.extractors[mid];
        if (!ex) return;
        items.push({
          label: ex.name,
          note: rateText(id, ex.rate) + ' on a normal node' + (hasBuilding(mid) ? '' : ' · not available'),
          on: minerHere === mid,
          run: function () {
            // New resources start on whichever miner was picked last.
            state.defaultMiner = mid;
            if (nodes.length) set(withHere({ miner: mid }));
            else set([], mid);
          }
        });
      });
    }

    if (nodes.length > 1) {
      items.push('-');
      items.push({
        label: 'Remove this node',
        run: function () { set(nodes.filter(function (_, j) { return j !== slot; })); }
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
  popOpener = clickFrom;
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

export { askConfirm, closeAll, confirmEl, ctx, openCtx, openItemPicker, openOutputMenu,
  openRecipeMenu, openSupplyMenu, removeTarget, toggleMax };
