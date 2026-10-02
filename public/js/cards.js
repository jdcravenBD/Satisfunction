/* Satisfunction — Drawing model cards and lines, and connecting them. */

import { DATA, EPS, SOLVER, canBuild, fmtCount, fmtNum, isFluid, itemName, labelsEl,
  machineName, rateText, recipeAllowed, stage, state, titleCase, world } from './core.js';
import { save, uid, writeNow } from './store.js';
import { changed } from './history.js';
import { applyView, toWorld, usableWidth } from './view.js';
import { hideHoverInfo, hoverInfo } from './nodes.js';
import { svg, wirePath, wires } from './wires.js';
import { applySelection, clearSelection, dragMenuSkip, selectOnly, selected } from './canvas.js';
import { closeAll, openCtx } from './menus.js';
import { factoryLabel } from './factories.js';
import { MAX_FLOOR, PROBLEM_ICON, STRIP, STRIP_LOGI, buildingOf, extractorOf, floorOf, floorsUsed,
  flow, hasFloor, iconOf, isLogistic,
  linkOn, mixable, nodeById, nodeRecipe, nodeSize, partName, sloopsOf, slotAt, slotItem,
  slotItems, slotsOf } from './model.js';
import { factoryById, factoryOutputs, otherFactories, requestsOf } from './links.js';
import { canSplice, copyParts, linkAt, markSplice, newNode, removeParts, selectedLinks,
  selectedParts, splice } from './palette.js';
import { bringIn, buildModel, planKey } from './build.js';

/** Every card's box on the canvas. */
function customBoxes() {
  return state.custom.nodes.map(function (n) {
    var size = nodeSize(n);
    return { id: n.id, x: n.x, y: n.y, w: size.w, h: size.h };
  });
}

/** Centres the view on a node and selects it. */
function focusPart(id) {
  var n = nodeById(id);
  if (!n) return;
  var size = nodeSize(n);
  var v = state.view;
  v.x = usableWidth() / 2 - (n.x + size.w / 2) * v.s;
  v.y = stage.clientHeight / 2 - (n.y + size.h / 2) * v.s;
  applyView();
  selectOnly(id);
  writeNow();
}

/* ---- cards ---- */

function cardEl(n) {
  var size = nodeSize(n);
  var st = (flow && flow.nodes[n.id]) || { ins: [], outs: [] };
  var s = slotsOf(n);
  var strip = isLogistic(n) ? STRIP_LOGI : STRIP;
  var el = document.createElement('div');
  el.className = 'cpart cnode cnode-' + n.type;
  el.dataset.id = n.id;
  el.style.left = n.x + 'px';
  el.style.top = n.y + 'px';
  el.style.width = size.w + 'px';
  el.style.height = size.h + 'px';

  // The middle: the building's picture with the count over it, between
  // the inputs' strip and the outputs'.
  var body = document.createElement('div');
  body.className = 'cn-body';
  body.style.left = (s.ins.length ? strip : 0) + 'px';
  body.style.right = (s.outs.length ? strip : 0) + 'px';
  el.appendChild(body);
  if (isLogistic(n)) {
    var letter = document.createElement('span');
    letter.className = 'cn-letter' + (n.priority || n.programmable ? ' small' : '');
    letter.textContent = n.type === 'splitter' ? (n.programmable ? 'PS' : n.priority ? 'SS' : 'S') : (n.priority ? 'PM' : 'M');
    body.appendChild(letter);
  } else {
    var badge = document.createElement('span');
    badge.className = 'cn-count';
    if (n.type === 'recipe') {
      badge.textContent = nodeRecipe(n) ? '×' + fmtCount(st.count || 0) : '?';
      if (n.set) badge.classList.add('set');
      if (st.run < (st.count || 0) - 1e-6) badge.classList.add('short');
    } else if (n.type === 'resource') {
      badge.textContent = '×' + (n.count || 1);
    } else if (n.type === 'import') {
      badge.textContent = fmtNum(n.rate || 0) + '/min';
    } else if (n.type === 'awesome') {
      badge.textContent = 'AWESOME Sink';
    } else {
      badge.textContent = 'Storage';
    }
    body.appendChild(badge);
    var b = buildingOf(n);
    var pic = document.createElement('img');
    pic.className = 'cn-icon';
    pic.src = iconOf(b || (n.type === 'import' && isFluid(n.item) ? 'buffer' : n.type === 'awesome' ? 'sink' : 'storage'));
    pic.alt = '';
    pic.draggable = false;
    var r0 = nodeRecipe(n);
    pic.dataset.tip = r0 ? DATA.machines[r0.machine].name + ' · ' + r0.name + (r0.alt ? ' (alternate)' : '')
      : n.type === 'resource' ? (DATA.extractors[extractorOf(n)] ? DATA.extractors[extractorOf(n)].name + ' on ' : '') + itemName(n.item)
      : n.type === 'import' ? itemName(n.item) + ', brought in'
      : partName(n);
    body.appendChild(pic);
    if (n.type === 'import') {
      var from = n.from && factoryById(n.from);
      var fromCap = document.createElement('span');
      fromCap.className = 'cn-caption cn-from';
      fromCap.textContent = n.from ? 'from ' + (from ? factoryLabel(from) : 'a deleted factory') : 'from elsewhere';
      body.appendChild(fromCap);
    } else if (n.type === 'awesome') {
      var pts = document.createElement('span');
      pts.className = 'cn-caption';
      pts.textContent = fmtNum(st.points || 0) + ' points/min';
      body.appendChild(pts);
    } else if (n.type === 'resource' && n.item !== 'Desc_Water_C') {
      var cap = document.createElement('span');
      cap.className = 'cn-caption';
      cap.textContent = titleCase(n.purity || 'normal') + (isFluid(n.item) ? '' : ' · ' + DATA.extractors[extractorOf(n)].name.replace(/^Miner\s*/, ''));
      body.appendChild(cap);
    } else if (n.type === 'recipe' && nodeRecipe(n) && (nodeRecipe(n).alt || n.clock || sloopsOf(n).used)) {
      var alt = document.createElement('span');
      alt.className = 'cn-caption alt';
      var used = sloopsOf(n).used;
      alt.textContent = [nodeRecipe(n).alt ? 'ALT' : '', n.clock ? Math.round(n.clock * 100) + '%' : '',
        used ? used + (used === 1 ? ' sloop' : ' sloops') : ''].filter(Boolean).join(' · ');
      body.appendChild(alt);
    }
  }

  // Inputs in a strip down the left, outputs down the right: a cell each,
  // showing its item. The line joins the card's edge level with it.
  [['in', s.ins], ['out', s.outs]].forEach(function (side) {
    if (!side[1].length) return;
    var col = document.createElement('div');
    col.className = 'cn-side ' + side[0];
    col.style.width = strip + 'px';
    side[1].forEach(function (item, k) {
      var shown = item || slotItem(n, side[0], k);
      var mix = !shown ? slotItems(n, side[0], k) : [];
      // A step's input is fed too when its item comes on a mixed belt
      // into another of its inputs.
      var fed = linkOn(n, side[0], k) || (item && side[0] === 'in' && state.custom.links.some(function (l) {
        return l.to === n.id && slotItems(nodeById(l.from), 'out', l.fk).indexOf(item) >= 0;
      }));
      var slot = document.createElement('div');
      slot.className = 'cn-slot ' + side[0] + (shown && isFluid(shown) ? ' fluid' : '') + (fed ? ' linked' : '') +
        (mix.length > 1 ? ' mixed' : '') +
        (n.priority && !n.rules && k === 0 && side[0] === (n.type === 'splitter' ? 'out' : 'in') ? ' prio' : '');
      slot.dataset.node = n.id;
      slot.dataset.side = side[0];
      slot.dataset.k = k;
      if (shown) {
        var img = document.createElement('img');
        img.src = iconOf(shown);
        img.alt = '';
        img.draggable = false;
        slot.appendChild(img);
      } else if (mix.length > 1) {
        // A mixed belt: its first few items, small.
        mix.slice(0, 4).forEach(function (i) {
          var mi = document.createElement('img');
          mi.src = iconOf(i);
          mi.alt = '';
          mi.draggable = false;
          slot.appendChild(mi);
        });
      }
      slot.setAttribute('aria-label', (shown ? itemName(shown) : mix.length > 1 ? 'Mixed: ' + mix.map(itemName).join(', ') : 'Any item') +
        (side[0] === 'in' ? ' in' : ' out'));
      slot.dataset.tip = slotTip(n, st, side[0], k, shown, mix);
      slot.addEventListener('pointerdown', function (e) { dragFromSlot(n, side[0], k, e); });
      col.appendChild(slot);
      // Where the chain ends, what comes out, just past the card's edge
      // (lines carry their own figure).
      if (side[0] === 'out' && !isLogistic(n) && !linkOn(n, 'out', k)) {
        var end = document.createElement('div');
        end.className = 'flow-label cflow cn-end';
        end.style.top = (slotAt(n, 'out', k).y - n.y) + 'px';
        var bold = document.createElement('b');
        bold.textContent = fmtNum(st.outs[k] || 0);
        end.appendChild(bold);
        end.appendChild(document.createTextNode((shown && isFluid(shown) ? ' m³' : '') + '/min'));
        el.appendChild(end);
      }
    });
    el.appendChild(col);
  });

  // Once the model has more than one floor, each card says which it's on.
  if (hasFloor(n) && floorsUsed().length > 1) {
    var fl = document.createElement('span');
    fl.className = 'cn-floor';
    fl.textContent = 'Floor ' + floorOf(n);
    el.appendChild(fl);
  }

  // Something wrong: a flag off the top right corner. Hovering it says what.
  var mine = flow ? flow.problems.filter(function (pr) { return pr.part === n.id; }) : [];
  if (mine.length) {
    el.classList.add('has-problem');
    var flag = document.createElement('span');
    flag.className = 'cn-flag';
    flag.innerHTML = PROBLEM_ICON;
    flag.addEventListener('pointerenter', function () {
      hoverInfo.innerHTML = '';
      var head = document.createElement('div');
      head.className = 'hi-line hi-title';
      head.textContent = n.item ? itemName(n.item) : titleCase(n.type);
      hoverInfo.appendChild(head);
      mine.forEach(function (pr) {
        var div = document.createElement('div');
        div.className = 'hi-line';
        div.textContent = pr.text;
        hoverInfo.appendChild(div);
      });
      hoverInfo.hidden = false;
    });
    flag.addEventListener('pointerleave', hideHoverInfo);
    el.appendChild(flag);
  }
  el.setAttribute('aria-label', n.item ? itemName(n.item) : partName(n));
  el.addEventListener('pointerdown', function (e) { dragCard(el, n, e); });
  el.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (dragMenuSkip()) return;
    closeAll();
    if (!selected[n.id]) selectOnly(n.id);
    var list = selectedParts();
    var floored = list.filter(hasFloor);
    openCtx(e.clientX, e.clientY, [
      { head: list.length > 1 ? list.length + ' selected' : (n.item ? itemName(n.item) : partName(n)) },
      { label: 'Cut', kbd: 'Ctrl+X', run: function () { copyParts(list); removeParts(list, []); } },
      { label: 'Copy', kbd: 'Ctrl+C', run: function () { copyParts(list); } },
      // Pasting goes where you right-click empty canvas.
      { label: 'Paste', kbd: 'Ctrl+V', disabled: true, run: function () {} },
      '-'
    ].concat([
      { label: list.length > 1 ? 'Remove these' : 'Remove', kbd: 'Del', run: function () { removeParts(list, selectedLinks()); } }
    ].concat(floored.length ? [
      '-',
      { label: 'Floor', note: floorNote(floored), run: function () { openFloorMenu(e.clientX, e.clientY, floored); } }
    ] : []).concat(list.length === 1 && nodeRecipe(n) ? [
      '-',
      { label: 'Bring in instead', note: 'An Import in its place, and what fed it goes', run: function () {
        var fresh = !!state.optKey && state.optKey === planKey();
        var im = bringIn(n);
        if (im && fresh && buildModel()) { clearSelection(); changed(); return; }
        if (im) selectOnly(im.id);
        changed();
      } }
    ] : [])));
  });
  return el;
}

/** Which floor some cards are on, for a menu's second line. */
function floorNote(list) {
  var at = list.map(floorOf).filter(function (f, i, all) { return all.indexOf(f) === i; });
  return at.length === 1 ? 'On Floor ' + at[0] : 'On Floors ' + at.sort(function (a, b) { return a - b; }).join(', ');
}

/** Moves cards to a floor: any in use, or the one above the highest. */
function openFloorMenu(x, y, list) {
  var used = floorsUsed();
  var top = Math.min(MAX_FLOOR, Math.max(used[used.length - 1] || 1, 1) + 1);
  var same = list.every(function (n) { return floorOf(n) === floorOf(list[0]); }) ? floorOf(list[0]) : 0;
  var items = [{ head: 'Move to floor' }];
  for (var f = 1; f <= top; f++) {
    (function (f) {
      items.push({
        label: 'Floor ' + f, on: f === same,
        note: used.indexOf(f) < 0 ? 'New' : '',
        run: function () {
          list.forEach(function (n) { if (f > 1) n.floor = f; else delete n.floor; });
          changed();
        }
      });
    })(f);
  }
  openCtx(x, y, items);
}

/** What a card's input or output is, and how much goes through it. */
function slotTip(n, st, side, k, shown, mix) {
  var r = nodeRecipe(n);
  if (shown && r && side === 'in') {
    var want = Math.abs(SOLVER.perMinute(r)[shown] || 0) * (st.count || 0);
    return itemName(shown) + ' · gets ' + rateText(shown, (st.got && st.got[shown]) || 0).replace('/min', '') + ' of ' + rateText(shown, want);
  }
  if (shown && side === 'out' && !isLogistic(n)) return itemName(shown) + ' · ' + rateText(shown, st.outs[k] || 0);
  var l = linkOn(n, side, k);
  var f = l && flow && flow.links[l.id];
  if (mix.length > 1) {
    return mix.map(function (i) { return itemName(i) + (f && f.items[i] ? ' ' + rateText(i, f.items[i]) : ''); }).join(' · ');
  }
  if (shown) return itemName(shown) + (f ? ' · ' + rateText(shown, f.total) : '');
  return side === 'in' ? 'Any item in' : 'Any item out';
}

/** Moves a card (and the rest of the selection, if it's in it). */
function dragCard(el, n, e) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  closeAll();
  var mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
  var group = selected[n.id] ? selectedParts() : [n];
  var origins = group.map(function (g) { return { x: g.x, y: g.y }; });
  var startX = e.clientX, startY = e.clientY;
  var moved = false;
  // A splitter or merger with nothing joined, dragged on its own, can go
  // into a line: the card lets the pointer through to find it.
  var splicing = group.length === 1 && canSplice(n);
  var target = null;
  function move(ev) {
    var dx = (ev.clientX - startX) / state.view.s;
    var dy = (ev.clientY - startY) / state.view.s;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 3 / state.view.s) return;
    if (!moved) {
      moved = true;
      el.classList.add('dragging');
      if (splicing) el.style.pointerEvents = 'none';
    }
    group.forEach(function (g, i) {
      g.x = Math.round(origins[i].x + dx);
      g.y = Math.round(origins[i].y + dy);
      var ge = world.querySelector('.cnode[data-id="' + g.id + '"]');
      if (ge) { ge.style.left = g.x + 'px'; ge.style.top = g.y + 'px'; }
    });
    renderLinks();
    if (splicing) {
      target = linkAt(ev.clientX, ev.clientY);
      markSplice(target);
    }
  }
  function up() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    el.classList.remove('dragging');
    el.style.pointerEvents = '';
    markSplice(null);
    if (moved && target) {
      splice(target, n);
      selectOnly(n.id);
      changed();
      return;
    }
    if (moved) { save(); return; }
    if (mods.ctrl || mods.shift) {
      if (selected[n.id]) delete selected[n.id];
      else selected[n.id] = true;
      applySelection();
    } else {
      selectOnly(n.id);
    }
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/* ---- lines ---- */

/** Every line between cards: a curve from an output to an input, with its rate. */
function renderLinks() {
  while (wires.firstChild) wires.removeChild(wires.firstChild);
  labelsEl.innerHTML = '';
  state.custom.links.forEach(function (l) {
    var a = nodeById(l.from), b = nodeById(l.to);
    if (!a || !b) return;
    var p1 = slotAt(a, 'out', l.fk), p2 = slotAt(b, 'in', l.tk);
    var path = wirePath(p1, { x: 1, y: 0 }, p2, { x: -1, y: 0 });
    var f = flow && flow.links[l.id];
    var fluid = f ? f.fluid : false;
    svg('path', { d: path.d, 'class': 'wire cwire' + (fluid ? ' pipe' : ''), 'data-link': l.id });
    if (fluid) svg('path', { d: path.d, 'class': 'wire pipe-core' });
    if (f) {
      var label = document.createElement('div');
      label.className = 'flow-label cflow';
      label.style.left = path.mid.x + 'px';
      label.style.top = path.mid.y + 'px';
      var on = Object.keys(f.items).sort(function (x, y) { return f.items[y] - f.items[x]; });
      if (f.mixed && on.length > 1) {
        // A mixed belt: each item and its rate.
        label.classList.add('mixed');
        on.slice(0, 5).forEach(function (i, j) {
          var mi = document.createElement('img');
          mi.className = 'fl-icon';
          mi.src = iconOf(i);
          mi.alt = itemName(i);
          mi.dataset.tip = itemName(i) + ' · ' + rateText(i, f.items[i]);
          if (j) label.appendChild(document.createTextNode('  '));
          label.appendChild(mi);
          var mb = document.createElement('b');
          mb.textContent = fmtNum(f.items[i]);
          label.appendChild(mb);
        });
        if (on.length > 5) label.appendChild(document.createTextNode('  +' + (on.length - 5)));
        label.appendChild(document.createTextNode('/min'));
      } else {
        var one = f.item || on[0];
        if (one) {
          var icon = document.createElement('img');
          icon.className = 'fl-icon';
          icon.src = iconOf(one);
          icon.alt = '';
          icon.dataset.tip = itemName(one);
          label.appendChild(icon);
        }
        var bold = document.createElement('b');
        bold.textContent = fmtNum(f.total);
        label.appendChild(bold);
        label.appendChild(document.createTextNode((fluid ? ' m³' : '') + '/min'));
      }
      labelsEl.appendChild(label);
    }
    var hit = svg('path', { d: path.d, 'class': 'belt-hit', 'data-hit': l.id });
    hit.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      closeAll();
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        if (selected[l.id]) delete selected[l.id];
        else selected[l.id] = true;
        applySelection();
      } else {
        selectOnly(l.id);
      }
    });
    hit.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeAll();
      if (!selected[l.id]) selectOnly(l.id);
      openCtx(e.clientX, e.clientY, [
        { head: 'Line' },
        { label: 'Remove', run: function () { removeParts([], selectedLinks()); } }
      ]);
    });
  });
  applySelection();
}

/**
 * Whether two slots can be joined: one in and one out, the far one free.
 * Belts can mix items (a sushi belt), and a machine takes any of its solid
 * ingredients through any input, as in the game; a pipe carries one fluid.
 */
function fits(f, t) {
  if (!f || !t || f.node === t.node || f.side === t.side) return false;
  if (linkOn(t.node, t.side, t.k)) return false;
  var out = f.side === 'out' ? f : t, inn = f.side === 'out' ? t : f;
  var a = slotItems(out.node, 'out', out.k);
  if (!a.length) { var a1 = slotItem(out.node, 'out', out.k); if (a1) a = [a1]; }
  var fixed = slotsOf(inn.node).ins[inn.k];
  if (fixed) {
    if (!a.length) return true;
    if (isFluid(fixed)) return a.length === 1 && a[0] === fixed;
    var r = nodeRecipe(inn.node);
    var uses = r ? r.in.map(function (q) { return q[0]; }) : [fixed];
    return a.every(function (i) { return !isFluid(i); }) && a.some(function (i) { return uses.indexOf(i) >= 0; });
  }
  if (inn.node.type === 'awesome' && a.some(isFluid)) return false;
  // Into a splitter, merger or Storage: anything that can share its line.
  var b = slotItems(inn.node, 'in', inn.k);
  if (!b.length) { var b1 = slotItem(inn.node, 'in', inn.k); if (b1) b = [b1]; }
  return mixable(a.concat(b));
}

function join(f, t) {
  var out = f.side === 'out' ? f : t, inn = f.side === 'out' ? t : f;
  state.custom.links.push({ id: 'l' + uid(), from: out.node.id, fk: out.k, to: inn.node.id, tk: inn.k });
}

/**
 * Drag from an input or output to connect it: onto a matching slot, onto a
 * card (its first free matching slot), or onto empty canvas for a menu of
 * steps that use (or make) the item, placed there and joined up. Pressing
 * a slot that's already joined picks that line's end up.
 */
function dragFromSlot(n, side, k, e) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  closeAll();
  var from = { node: n, side: side, k: k };
  var existing = linkOn(n, side, k);
  if (existing) {
    state.custom.links = state.custom.links.filter(function (l) { return l !== existing; });
    from = side === 'out'
      ? { node: nodeById(existing.to), side: 'in', k: existing.tk }
      : { node: nodeById(existing.from), side: 'out', k: existing.fk };
    renderLinks();
  }
  var A = slotAt(from.node, from.side, from.k);
  var preview = svg('path', { d: '', 'class': 'belt-preview' });
  function target(ev) {
    var el = document.elementFromPoint(ev.clientX, ev.clientY);
    var slotEl = el && el.closest && el.closest('.cn-slot');
    if (slotEl) return { node: nodeById(slotEl.dataset.node), side: slotEl.dataset.side, k: Number(slotEl.dataset.k) };
    var card = el && el.closest && el.closest('.cnode');
    if (card) {
      var m = nodeById(card.dataset.id);
      var s = slotsOf(m);
      var list = from.side === 'out' ? s.ins : s.outs;
      var mine = slotItems(from.node, from.side, from.k);
      for (var pass = 0; pass < 2; pass++) {
        for (var j = 0; j < list.length; j++) {
          if (!pass && list[j] && mine.indexOf(list[j]) < 0) continue;
          var t = { node: m, side: from.side === 'out' ? 'in' : 'out', k: j };
          if (fits(from, t)) return t;
        }
      }
    }
    return null;
  }
  function move(ev) {
    var w = toWorld(ev.clientX, ev.clientY);
    var t = target(ev);
    var ok = t && fits(from, t);
    var B = ok ? slotAt(t.node, t.side, t.k) : w;
    var path = from.side === 'out'
      ? wirePath(A, { x: 1, y: 0 }, B, { x: -1, y: 0 })
      : wirePath(B, { x: 1, y: 0 }, A, { x: -1, y: 0 });
    preview.setAttribute('d', path.d);
    preview.classList.toggle('ok', !!ok);
  }
  function up(ev) {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    preview.remove();
    var t = target(ev);
    if (t && fits(from, t)) {
      join(from, t);
      changed();
      return;
    }
    var over = document.elementFromPoint(ev.clientX, ev.clientY);
    if (over && stage.contains(over) && !over.closest('.cnode, .view-opts')) {
      quickAdd(from, toWorld(ev.clientX, ev.clientY), ev.clientX, ev.clientY, !!existing);
      return;
    }
    if (existing) changed();
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/** The menu for a line dropped on empty canvas: what could take (or give) its item. */
function quickAdd(from, w, cx, cy, dropped) {
  var item = slotItem(from.node, from.side, from.k);
  var mixed = !item ? slotItems(from.node, from.side, from.k) : [];
  if (mixed.length < 2) mixed = [];
  var items = [{ head: item ? itemName(item) : mixed.length ? 'Mixed belt' : 'Connect' }];
  function make(kind, recipe, extra) {
    return function () {
      var n = newNode(kind, w.x, w.y);
      if (recipe) { n.type = 'recipe'; n.recipe = recipe; n.item = kind; }
      Object.assign(n, extra || {});
      var size = nodeSize(n);
      // Line the new card's slot up with the drop point.
      if (from.side === 'out') n.x = Math.round(w.x); else n.x = Math.round(w.x - size.w);
      var s = slotsOf(n);
      var list = from.side === 'out' ? s.ins : s.outs;
      var k = Math.max(0, item ? list.indexOf(item) : 0);
      if (k < 0 || k >= list.length) k = 0;
      var at = slotAt(n, from.side === 'out' ? 'in' : 'out', k);
      n.y = Math.round(n.y + (w.y - at.y));
      var t = { node: n, side: from.side === 'out' ? 'in' : 'out', k: k };
      if (fits(from, t)) join(from, t);
      selectOnly(n.id);
      changed();
    };
  }
  // A mixed belt can feed any step that uses something on it.
  var takesFrom = item ? [item] : from.side === 'out' ? mixed : [];
  if (takesFrom.length) {
    var rids = Object.keys(DATA.recipes).filter(function (rid) {
      var r = DATA.recipes[rid];
      if (!canBuild(rid) || !recipeAllowed(rid)) return false;
      var list = from.side === 'out' ? r.in : r.out;
      return list.some(function (q) { return takesFrom.indexOf(q[0]) >= 0; });
    }).sort(function (a, b) {
      var ra = DATA.recipes[a], rb = DATA.recipes[b];
      return (ra.alt ? 1 : 0) - (rb.alt ? 1 : 0) || ra.name.localeCompare(rb.name);
    });
    if (from.side === 'in') {
      if (DATA.items[item].raw) items.push({ label: 'Resource node', note: 'Mine or extract it', icon: iconOf(item), run: make(item) });
    }
    rids.forEach(function (rid) {
      var r = DATA.recipes[rid];
      var product = itemName(r.out[0][0]);
      items.push({
        label: from.side === 'out' ? product : r.name,
        note: (from.side === 'out' && r.name !== product ? r.name + ' · ' : '') + machineName(rid) + (r.alt ? ' · alternate' : ''),
        icon: iconOf(r.out[0][0]),
        run: make(from.side === 'out' ? r.out[0][0] : item, rid)
      });
    });
  }
  items.push('-');
  if (item && from.side === 'in') {
    items.push({ label: 'Import', note: 'From outside this save', icon: iconOf(item), run: make(item, null, { type: 'import', rate: 60 }) });
    otherFactories().forEach(function (f) {
      var makes = factoryOutputs(f)[item] || 0;
      if (!(makes > EPS)) return;
      var taken = requestsOf(f.id).filter(function (r) { return r.item === item; }).reduce(function (sum, r) { return sum + r.rate; }, 0);
      var left = Math.max(0, makes - taken);
      items.push({
        label: 'Import from \u201c' + factoryLabel(f) + '\u201d', note: fmtNum(left) + ' of ' + rateText(item, makes) + ' free', icon: iconOf(item),
        run: make(item, null, { type: 'import', rate: Number((left || makes).toFixed(4)), from: f.id })
      });
    });
  }
  if (from.side === 'out') {
    items.push({ label: 'Splitter', note: 'Shares evenly', icon: iconOf('splitter'), run: make('splitter') });
    items.push({ label: 'Smart Splitter', note: 'One item, or Any or Overflow, per output', icon: iconOf('splitter'), run: make('smart') });
    items.push({ label: 'Programmable Splitter', note: 'Several items per output', icon: iconOf('splitter'), run: make('programmable') });
    if (!(item ? isFluid(item) : mixed.some(isFluid))) {
      items.push({ label: 'AWESOME Sink', note: 'Sinks it for points', icon: iconOf('sink'), run: make('awesome') });
    }
  } else {
    items.push({ label: 'Merger', note: 'Joins evenly', icon: iconOf('merger'), run: make('merger') });
    items.push({ label: 'Priority Merger', note: 'Top input first', icon: iconOf('merger'), run: make('priority') });
  }
  openCtx(cx, cy, items);
  if (dropped) changed();
}

export { cardEl, customBoxes, focusPart, renderLinks };
