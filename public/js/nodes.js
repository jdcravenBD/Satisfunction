/* Satisfunction — Item view cards, and the hovered card's figures. */

import { DATA, EPS, NODE_W, SOLVER, blocked, buildingName, fmtCount, fmtNum, fmtPower, graph,
  isFluid, itemName, machineName, nameSpans, producersOf, rateText, recipeClocks, solved, state,
  stepPower, storedNodes, supplyInfo, titleCase, tpl, world } from './core.js';
import { changed } from './history.js';
import { dragging, focusNode } from './wires.js';
import { dragBehaviour, openSelectionMenu, selectOnly, selected, selectedNodes } from './canvas.js';
import { closeAll, openOutputMenu, openRecipeMenu, openSupplyMenu } from './menus.js';

/* --------------------------------------------------------------- nodes */

function mountNodes() {
  world.querySelectorAll('.node').forEach(function (el) { el.remove(); });
  graph.nodes.forEach(function (n) {
    n.el = buildNode(n);
    n.el.style.width = NODE_W + 'px';
    world.appendChild(n.el);
    n.w = NODE_W;
    n.h = n.el.offsetHeight;
  });
}

function buildNode(n) {
  var el = tpl.content.firstElementChild.cloneNode(true);
  var title = el.querySelector('.n-title');
  var rate = el.querySelector('.n-rate');
  var recipeBtn = el.querySelector('.n-recipe');
  var machine = el.querySelector('.n-machine');
  var alt = el.querySelector('.n-alt');
  var notes = el.querySelector('.n-notes');
  var badge = el.querySelector('.n-badge');

  el.dataset.key = n.key;
  title.textContent = itemName(n.item);
  title.title = itemName(n.item);

  var entry = solved.items[n.item];
  var menu = openRecipeMenu; // what the machine line and right-click open

  function note(text, cls) {
    var line = document.createElement('span');
    line.textContent = text;
    if (cls) line.className = cls;
    notes.appendChild(line);
    return line;
  }

  // The views are pictures of the model: nothing on them is edited.
  var readOnly = true;

  if (n.kind === 'recipe' || n.kind === 'bank') {
    var r = DATA.recipes[n.rid];
    var made = 0;
    r.out.forEach(function (p) {
      if (p[0] === n.item) made += p[1] * n.count * 60 / r.time;
    });
    setRate(rate, n.item, made);

    machine.innerHTML = '';
    nameSpans(machine, machineName(n.rid));
    machine.appendChild(document.createTextNode(' '));
    var count = document.createElement('b');
    count.textContent = '×' + fmtCount(n.count);
    machine.appendChild(count);
    recipeBtn.title = 'Change recipe';

    if (r.name !== itemName(n.item)) {
      alt.hidden = false;
      alt.textContent = r.name;
      alt.classList.toggle('is-alt', !!r.alt);
      alt.title = (r.alt ? 'Alternate recipe: ' : 'Recipe: ') + r.name;
    }

    // Anything else this step makes, and how much of it goes spare.
    r.out.forEach(function (p) {
      if (p[0] === n.item) return;
      var amount = p[1] * n.count * 60 / r.time;
      var e = solved.items[p[0]];
      var line = document.createElement('span');
      var text = '+ ' + fmtNum(amount) + (isFluid(p[0]) ? ' m³ ' : ' ') + itemName(p[0]);
      if (e && e.surplus > EPS && e.produced > EPS) {
        var spareHere = e.surplus * amount / e.produced;
        text += Math.abs(spareHere - amount) < 1e-6 ? ' · spare' : ' · ' + fmtNum(spareHere) + ' spare';
      }
      line.textContent = text;
      line.title = rateText(p[0], amount) + ' of ' + itemName(p[0]) + ' made on the side';
      notes.appendChild(line);
    });

    if (entry && entry.surplus > EPS) note(fmtNum(entry.surplus) + ' spare');
  } else if (n.kind === 'spare') {
    // Machine view only: somewhere for an unused byproduct's belt to go.
    el.classList.add('spare');
    setRate(rate, n.item, n.rate);
    machine.textContent = 'Spare · sink or store it';
  } else if (n.kind === 'output') {
    el.classList.add('output');
    setRate(rate, n.item, n.rate);
    var t = targetFor(n.item);
    badge.hidden = false;
    badge.textContent = t && t.max ? 'Output · max' : 'Output';
    recipeBtn.hidden = true;
    if (t && t.max && solved.limitedBy) {
      note('As much as ' + itemName(solved.limitedBy) + ' allows');
    }
    menu = openOutputMenu;
  } else {
    el.classList.add('raw');
    setRate(rate, n.item, n.rate);
    var it = DATA.items[n.item];
    var label;
    if (it.raw) {
      var info = supplyInfo(n.item);
      var nd = info && info.nodeList && n.slot != null ? info.nodeList[n.slot] : null;
      label = nd ? (n.nodes > 1 ? n.nodes + ' × ' : '') + nodeLabel(n.item, nd) : supplyLabel(n.item, info);
      menu = openSupplyMenu;
      recipeBtn.title = 'Purity and miner';
      if (!info || !info.purity) {
        // Water Extractors go anywhere; there's nothing to choose.
        recipeBtn.disabled = true;
        recipeBtn.title = '';
      }
      if (entry && entry.cap != null) {
        if (nd && info.nodeList.length > (n.nodes || 1)) note('Uses ' + fmtNum(n.rate) + ' of ' + rateText(n.item, n.cap || nd.rate));
        else note('Uses ' + fmtNum(entry.supplied) + ' of ' + rateText(n.item, entry.cap));
        // What's true of the resource as a whole goes on its first block.
        if (!n.slot && entry.short > EPS) {
          el.classList.add('short');
          note('Short by ' + rateText(n.item, entry.short), 'warn');
        }
        if (!n.slot && solved.limitedBy === n.item) note('Sets the max output');
      }
      if (nd && !readOnly) {
        // A thin + along the bottom of the resource's lowest block adds
        // another node (which block that is is settled after layout).
        var more = document.createElement('button');
        more.type = 'button';
        more.className = 'n-add';
        more.textContent = '+';
        more.title = 'Add another ' + itemName(n.item) + ' node';
        more.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        more.addEventListener('click', function (e) {
          e.stopPropagation();
          addResourceNode(n.item, nd);
        });
        el.appendChild(more);
      }
    } else if (state.imports[n.item]) {
      label = 'Imported';
      recipeBtn.title = 'Make it here instead';
    } else if (blocked[n.item]) {
      // Only a building the user doesn't have makes it.
      label = 'No ' + buildingName(blocked[n.item]);
      el.classList.add('short');
      recipeBtn.disabled = true;
      recipeBtn.title = '';
      note('Tick the ' + buildingName(blocked[n.item]) + ' under Machines to make it here', 'warn');
    } else if (!producersOf[n.item]) {
      label = 'Supplied';
      recipeBtn.disabled = true;
      recipeBtn.title = 'Nothing in the game makes this in a machine';
    } else {
      // Has a recipe, but still comes up short: a byproduct-only item that
      // doesn't make enough.
      label = 'Shortfall';
      el.classList.add('short');
      recipeBtn.title = 'Pick a recipe, or import it';
      var why = document.createElement('span');
      why.className = 'warn';
      why.textContent = 'Byproducts don’t cover this';
      notes.appendChild(why);
    }
    machine.textContent = label;
  }

  el.addEventListener('pointerenter', function () {
    focusNode(n.key, true);
    showHoverInfo(n);
  });
  el.addEventListener('pointerleave', function () {
    focusNode(n.key, false);
    if (!dragging) hideHoverInfo();
  });

  // Recipes and nodes are changed in Model.
  if (readOnly) {
    recipeBtn.disabled = true;
    recipeBtn.removeAttribute('title');
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    return el;
  }

  recipeBtn.addEventListener('click', function () {
    if (recipeBtn.disabled) return;
    var rect = recipeBtn.getBoundingClientRect();
    menu(n, rect.left, rect.bottom + 4, false);
  });

  el.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    e.stopPropagation();
    closeAll();
    if (selected[n.key] && selectedNodes().length > 1) {
      openSelectionMenu(e.clientX, e.clientY);
      return;
    }
    if (!selected[n.key]) selectOnly(n.key);
    menu(n, e.clientX, e.clientY, true);
  });

  dragBehaviour(el, n);
  return el;
}

/* ------------------------------------------------------------ hover info */

// The hovered node's figures, bottom left of the canvas: what it is, how
// fast, which machines, what they draw, and what goes in and out.
var hoverInfo = document.getElementById('hover-info');

function hideHoverInfo() { hoverInfo.hidden = true; }

function showHoverInfo(n) {
  if (!solved) return;
  var lines = [];
  function add(text, cls) { lines.push({ text: text, cls: cls || '' }); }
  function flows(net, sign) {
    return Object.keys(net).filter(function (id) { return net[id] * sign > EPS; })
      .map(function (id) { return rateText(id, Math.abs(net[id])) + ' ' + itemName(id); });
  }

  if (n.kind === 'recipe') {
    var r = DATA.recipes[n.rid];
    var per = SOLVER.perMinute(r);
    var net = {};
    Object.keys(per).forEach(function (id) { net[id] = per[id] * n.count; });
    var clocks = recipeClocks(n.rid, n.count);
    add(itemName(n.item), 'hi-title');
    add(rateText(n.item, net[n.item] || 0) + (r.name !== itemName(n.item) ? ' · ' + r.name : ''));
    add(clocks.length + ' × ' + machineName(n.rid) + ' · ' + fmtNum(n.count) + ' running');
    add(fmtPower(stepPower(n.rid, n.count, state.clockOf[n.rid]) * (state.boostOf[n.rid] ? state.boostOf[n.rid].power : 1)) + ' average');
    var ins = flows(net, -1);
    var outs = flows(net, 1);
    if (ins.length) add('In: ' + ins.join(', '));
    if (outs.length) add('Out: ' + outs.join(', '));
  } else if (n.kind === 'output') {
    var t = targetFor(n.item);
    add(itemName(n.item), 'hi-title');
    add(rateText(n.item, n.rate) + ' · ' + (t && t.max ? 'output, as much as possible' : 'output'));
    if (t && t.max && solved.limitedBy) add('Limited by ' + itemName(solved.limitedBy));
  } else if (n.kind === 'raw') {
    var e = solved.items[n.item];
    add(itemName(n.item), 'hi-title');
    add(rateText(n.item, n.rate));
    if (DATA.items[n.item].raw) {
      var info = supplyInfo(n.item);
      var nd = info && info.nodeList && n.slot != null ? info.nodeList[n.slot] : null;
      if (nd) {
        add((n.nodes > 1 ? n.nodes + ' × ' : '') + nodeLabel(n.item, nd) + ' · gives up to ' + rateText(n.item, n.cap || nd.rate));
      } else if (info) {
        add(supplyLabel(n.item, info));
      }
      if (e && e.cap != null) add('Resource in use: ' + fmtNum(e.supplied) + ' of ' + rateText(n.item, e.cap));
    } else {
      add(state.imports[n.item] ? 'Imported' : blocked[n.item] ? 'No ' + buildingName(blocked[n.item]) : 'Brought in');
    }
  } else {
    return;
  }

  hoverInfo.innerHTML = '';
  lines.forEach(function (l) {
    var div = document.createElement('div');
    div.className = 'hi-line ' + l.cls;
    div.textContent = l.text;
    hoverInfo.appendChild(div);
  });
  hoverInfo.hidden = false;
}

function setRate(el, id, n) {
  el.innerHTML = '';
  el.appendChild(document.createTextNode(fmtNum(n)));
  var unit = document.createElement('small');
  unit.textContent = (isFluid(id) ? ' m³' : '') + '/min';
  el.appendChild(unit);
}

function targetFor(id) {
  return state.targets.filter(function (t) { return t.item === id; })[0] || null;
}

/** One resource node's block: "Pure node · Mk.2". */
function nodeLabel(id, nd) {
  var text = titleCase(nd.purity) + ' node';
  if (!isFluid(id)) text += ' · ' + DATA.extractors[nd.extractor].name.replace(/^Miner\s*/, '');
  return text;
}

/** Another node for a resource: normal, with the same miner as the one beside it. */
function addResourceNode(id, like) {
  var s = state.supply[id] || {};
  var list = storedNodes(id);
  var next = { purity: 'normal' };
  if (!isFluid(id) && like && like.extractor) next.miner = like.extractor;
  list.push(next);
  state.supply[id] = { nodes: list, miner: s.miner };
  changed();
}

/** "Pure node · Mk.2", "Mined · any node", "3 nodes · Mk.1". */
function supplyLabel(id, info) {
  if (!info) return 'Supplied';
  if (!info.purity) return 'Water Extractors';
  var solid = !isFluid(id);
  if (!info.nodes.length) return (solid ? 'Mined' : 'Extracted') + ' · any node';
  var text = info.nodes.length === 1
    ? titleCase(info.nodes[0]) + ' node'
    : info.nodes.length + ' nodes';
  if (solid) text += ' · ' + DATA.extractors[info.extractor].name.replace(/^Miner\s*/, '');
  return text;
}

export { buildNode, hideHoverInfo, hoverInfo, mountNodes, targetFor };
