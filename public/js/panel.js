/* Satisfunction — The plan panel on the right: outputs, Overview and Power. */

import { BUILDINGS, DATA, EPS, NEW_TARGET_RATE, blocked, buildingName, fmtNum, fmtPower,
  hasBuilding, isFluid, itemName, machineName, producersOf, rateText, recipeClocks, shardsFor,
  solved, state, stepPower, unlockable } from './core.js';
import { writeNow } from './store.js';
import { changed } from './history.js';
import { fitView } from './view.js';
import { focusOn } from './canvas.js';
import { openItemPicker, removeTarget, toggleMax } from './menus.js';
import { extractorOf, flow, iconOf, nodeById, slotItem } from './model.js';
import { focusPart } from './cards.js';
import { renderCustomPanel } from './inspector.js';
import { addModelInput, addModelOutput } from './build.js';

/* ------------------------------------------------------------- targets */

function askForOutput(anchor, x, y) {
  openItemPicker(anchor, addModelOutput, x, y);
}

/** Adds an output (or finds the existing one) and shows it in the panel. */
function addTarget(id) {
  var wasEmpty = !state.targets.length;
  var index = -1;
  state.targets.forEach(function (t, i) { if (t.item === id) index = i; });
  if (index < 0) {
    // New outputs make as much as the resource nodes allow; the rate is
    // what switching to a fixed rate starts from.
    state.targets.push({ item: id, rate: NEW_TARGET_RATE, max: true });
    index = state.targets.length - 1;
    renderTargets();
    changed();
    if (wasEmpty) fitView();
  }
  // A max output's figure isn't typed, so only a fixed rate gets the caret.
  var input = targetsEl.querySelectorAll('.t-rate')[index];
  if (input && !input.disabled) {
    input.focus();
    input.select();
  }
}

var targetsEl = document.getElementById('targets');

/** Max outputs show what the solver reached, updated after every solve. */
function refreshMaxRates() {
  targetsEl.querySelectorAll('.t-rate').forEach(function (input) {
    if (!input.dataset.max) return;
    input.value = solved.maxRate != null ? fmtNum(solved.maxRate) : '—';
  });
}

/**
 * The output rows. Rebuilt only when the list itself changes — typing a
 * rate re-solves the plan but leaves these fields alone, so the caret stays.
 */
function renderTargets() {
  targetsEl.innerHTML = '';
  state.targets.forEach(function (t) {
    var row = document.createElement('div');
    row.className = 'target-row';

    var pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 't-item';
    pick.title = 'Change item';
    var name = document.createElement('span');
    name.textContent = itemName(t.item);
    pick.appendChild(name);
    pick.addEventListener('click', function () {
      openItemPicker(pick, function (id) {
        if (id === t.item) return;
        // Picking an item that's already an output merges the two rows.
        var existing = state.targets.filter(function (o) { return o.item === id; })[0];
        if (existing) {
          existing.rate = (Number(existing.rate) || 0) + (Number(t.rate) || 0);
          state.targets = state.targets.filter(function (o) { return o !== t; });
        } else {
          t.item = id;
        }
        renderTargets();
        changed();
      });
    });

    // In max mode the field shows the rate the solver reached, read-only.
    var rate = document.createElement('input');
    rate.type = 'text';
    rate.inputMode = 'decimal';
    rate.className = 't-rate';
    rate.value = String(t.rate);
    rate.disabled = !!t.max;
    rate.dataset.max = t.max ? '1' : '';
    rate.setAttribute('aria-label', itemName(t.item) + ' per minute');
    rate.addEventListener('input', function () {
      var v = parseFloat(rate.value);
      // 0 is allowed: the output stays listed but asks for nothing, so
      // everything made of it goes on to whatever uses it.
      var ok = isFinite(v) && v >= 0;
      rate.classList.toggle('bad', !ok && rate.value.trim() !== '');
      if (!ok) return;
      t.rate = v;
      changed();
    });
    rate.addEventListener('blur', function () {
      rate.classList.remove('bad');
      if (!t.max) rate.value = String(t.rate);
    });
    rate.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); rate.blur(); }
    });

    var unit = document.createElement('button');
    unit.type = 'button';
    unit.className = 't-unit' + (t.max ? ' on' : '');
    unit.textContent = t.max ? 'max' : (isFluid(t.item) ? 'm³/min' : '/min');
    unit.title = t.max
      ? 'Making as much as the resource nodes allow. Click to set a rate.'
      : 'Click to make as much as possible instead';
    unit.addEventListener('click', function () { toggleMax(t); });

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 't-del';
    del.title = 'Remove output';
    del.innerHTML = '&times;';
    del.addEventListener('click', function () { removeTarget(t); });

    row.appendChild(pick);
    row.appendChild(rate);
    row.appendChild(unit);
    row.appendChild(del);
    targetsEl.appendChild(row);
  });
}

document.getElementById('add-target').addEventListener('click', function () {
  askForOutput(this);
});

/* ---------------------------------------------------------------- panel */

var breakdownEl = document.getElementById('breakdown');
var inputsBox = document.getElementById('inputs-box');
var machinesBox = document.getElementById('machines-box');

function toggleBuilding(mid) {
  var i = state.unavailable.indexOf(mid);
  if (i >= 0) state.unavailable.splice(i, 1);
  else state.unavailable.push(mid);
  changed();
}


/* ---------------------------------------------------------- panel icons */

// Small line icons for the panel's section headings (16 × 16, drawn in the
// heading's own colour).
var ICONS = {
  recipe: '<rect x="3.5" y="2.5" width="9" height="11.5" rx="1.5"/><path d="M6 2.5h4v2H6zM6 7.5h4M6 10.5h4"/>',
  target: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2.2"/>',
  shuffle: '<path d="M2.5 5h2.8l5.2 6h3M2.5 11h2.8l5.2-6h3M11.8 3.2l1.7 1.8-1.7 1.8M11.8 9.2l1.7 1.8-1.7 1.8"/>',
  gauge: '<path d="M2.5 11.5a5.5 5.5 0 1 1 11 0"/><path d="M8 11.5l2.8-3.3"/>',
  belt: '<rect x="1.5" y="5" width="13" height="6" rx="3"/><circle cx="4.5" cy="8" r="1"/><circle cx="11.5" cy="8" r="1"/><path d="M7 8h2"/>',
  pipe: '<path d="M8 2.5c2.2 2.8 3.8 4.9 3.8 6.8a3.8 3.8 0 0 1-7.6 0c0-1.9 1.6-4 3.8-6.8z"/>',
  box: '<path d="M2.5 5.2L8 2.8l5.5 2.4v5.6L8 13.2l-5.5-2.4z"/><path d="M2.5 5.2L8 7.6l5.5-2.4M8 7.6v5.6"/>',
  ore: '<path d="M4.5 3h7l2.5 3.5L8 13.5 2 6.5z"/><path d="M2 6.5h12M6.2 3L8 13.5 9.8 3"/>',
  factory: '<path d="M2 13.5V7l4 2.5V7l4 2.5V3.5h4v10z"/>',
  gear: '<circle cx="8" cy="8" r="2"/><circle cx="8" cy="8" r="4.4"/><path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3"/>',
  bolt: '<path d="M9 1.8L3.8 9h3.8l-.8 5.2L12.2 7H8.4z"/>',
  list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.8" cy="4" r=".6"/><circle cx="2.8" cy="8" r=".6"/><circle cx="2.8" cy="12" r=".6"/>'
};
// Headings built in code, by title. Inputs, Outputs and Machines on the
// Details page go without.
var ICON_FOR = {
  'Spare': 'box', 'Resources': 'ore', 'Production': 'factory', 'Machines': 'gear',
  'Power': 'bolt', 'Alternate recipes used': 'shuffle', 'Itemised': 'list'
};

function iconEl(name) {
  var span = document.createElement('span');
  span.className = 'sg-icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" ' +
    'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
  return span;
}

// The headings written in the page.
document.querySelectorAll('#panel .sum-group-name[data-icon]').forEach(function (el) {
  el.parentNode.insertBefore(iconEl(el.dataset.icon), el);
});

/**
 * A panel section. With a fold key its heading is a button that collapses
 * the rows under it, remembered between visits.
 */
function group(title, sub, rows, fold) {
  var wrap = document.createElement('div');
  wrap.className = 'sum-group';
  var head = document.createElement(fold ? 'button' : 'div');
  head.className = 'sum-group-head';
  if (fold) {
    head.type = 'button';
    head.classList.add('fold-head');
    wrap.dataset.fold = fold;
    wrap.classList.toggle('folded', isFolded(fold));
  }
  var name = document.createElement('span');
  name.className = 'sum-group-name';
  name.textContent = title;
  var count = document.createElement('span');
  count.className = 'sum-group-count';
  count.textContent = sub || '';
  var fixed = fold === 'inputs' || fold === 'outputs' || fold === 'machines';
  if (!fixed && ICON_FOR[title]) head.appendChild(iconEl(ICON_FOR[title]));
  head.appendChild(name);
  head.appendChild(count);
  wrap.appendChild(head);
  var body = wrap;
  if (fold) {
    body = document.createElement('div');
    body.className = 'fold-body';
    wrap.appendChild(body);
  }
  rows.forEach(function (r) { body.appendChild(r); });
  return wrap;
}

// Any section heading that folds, whether built here or in the page.
document.getElementById('panel-list').addEventListener('click', function (e) {
  var head = e.target.closest('.fold-head');
  if (!head) return;
  var wrap = head.closest('[data-fold]');
  var key = wrap.dataset.fold;
  state.folds[key] = !isFolded(key);
  if (state.folds[key] === !!FOLDED_AT_FIRST[key]) delete state.folds[key];
  wrap.classList.toggle('folded', isFolded(key));
  writeNow();
});

// Sections that start folded: the long alternates list.
var FOLDED_AT_FIRST = { alternates: true };

function isFolded(key) {
  return key in state.folds ? state.folds[key] : !!FOLDED_AT_FIRST[key];
}

function applyFolds() {
  document.querySelectorAll('#panel-list [data-fold]').forEach(function (wrap) {
    wrap.classList.toggle('folded', isFolded(wrap.dataset.fold));
  });
}

function row(label, note, value, onClick, warn) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'sum-row';
  var l = document.createElement('span');
  l.className = 'sum-row-name';
  l.textContent = label;
  b.appendChild(l);
  if (note) {
    var n = document.createElement('span');
    n.className = 'sum-row-note';
    n.textContent = note;
    b.appendChild(n);
  }
  var v = document.createElement('span');
  v.className = 'sum-row-price' + (warn ? ' warn' : '');
  v.textContent = value;
  b.appendChild(v);
  if (onClick) b.addEventListener('click', onClick);
  else b.style.cursor = 'default';
  return b;
}

/** Totals, raw inputs, machine counts and spare output. */
function renderBreakdown() {
  breakdownEl.innerHTML = '';
  inputsBox.innerHTML = '';
  machinesBox.innerHTML = '';

  var power = 0;
  var buildings = 0;
  var shards = 0;
  var byMachine = {};
  var draws = [];   // [{ label, note, power, extraction }]
  function tally(mid, name, exact, built, p) {
    var m = byMachine[mid] || (byMachine[mid] = { name: name, exact: 0, built: 0, power: 0 });
    m.exact += exact;
    m.built += built;
    m.power += p;
    power += p;
    buildings += built;
  }
  Object.keys(solved.recipes).forEach(function (rid) {
    var count = solved.recipes[rid].count;
    var mid = DATA.recipes[rid].machine;
    var list = recipeClocks(rid, count);
    list.forEach(function (c) { shards += shardsFor(c); });
    var p = stepPower(rid, count, state.clockOf[rid], list.length) * (state.boostOf[rid] ? state.boostOf[rid].power : 1);
    tally(mid, DATA.machines[mid].name, count, list.length, p);
    var r = DATA.recipes[rid];
    draws.push({
      label: itemName(solved.recipes[rid].item) + (r.alt ? ' (' + r.name + ')' : ''),
      note: list.length + ' × ' + DATA.machines[mid].name,
      power: p,
      node: 'r:' + rid
    });
  });
  // Extractors in the views: the model's resource cards, as they run there.
  if (!solved.custom && flow) {
    flow.tally.forEach(function (t) {
      if (!t.extraction) return;
      var card = nodeById(t.id);
      shards += t.shards;
      tally(t.mid, t.name, t.exact, t.built, t.power);
      draws.push({ label: t.label, note: t.note, power: t.power, extraction: true, node: 'raw:' + (card ? card.item : '') });
    });
  }

  // In Custom, every placed building counts, running as the flow found.
  if (solved.custom) {
    flow.tally.forEach(function (t) {
      shards += t.shards;
      tally(t.mid, t.name, t.exact, t.built, t.power);
      if (t.power > EPS) draws.push({ label: t.label, note: t.note, power: t.power, extraction: !!t.extraction, part: t.id });
    });
    renderCustomPanel();
  }
  var steps = solved.custom ? flow.steps : Object.keys(solved.recipes).length;
  var sloops = flow ? flow.tally.reduce(function (sum, t) { return sum + (t.sloops || 0); }, 0) : 0;
  renderOverview({ power: power, buildings: buildings, shards: shards, sloops: sloops, byMachine: byMachine, draws: draws });
  renderPower(draws, power);
  document.getElementById('stat-machines').textContent = buildings;
  document.getElementById('stat-power').textContent = fmtPower(power);
  document.getElementById('stat-steps').textContent = steps;

  // Raw inputs: what has to arrive from outside this factory.
  var raws = Object.keys(solved.items)
    .filter(function (id) { return solved.items[id].supplied > EPS; })
    .sort(function (a, b) { return solved.items[b].supplied - solved.items[a].supplied; });
  if (raws.length || solved.custom) {
    inputsBox.appendChild(group('Inputs', 'from outside', raws.map(function (id) {
      var it = DATA.items[id];
      var e = solved.items[id];
      var short = !e.imported && ((!it.raw && !state.imports[id] && !!producersOf[id]) || e.short > EPS);
      var note = e.imported ? 'brought in' : it.raw
        ? (e.cap != null ? 'of ' + fmtNum(e.cap) : '')
        : state.imports[id] ? 'imported'
        : blocked[id] ? 'no ' + buildingName(blocked[id])
        : short ? 'shortfall' : 'supplied';
      return row(itemName(id), note, rateText(id, e.supplied),
        function () { focusOn('raw:' + id); }, short);
    }), 'inputs'));
    // Something made elsewhere, brought in here instead.
    if (solved.custom) {
      var addIn = document.createElement('button');
      addIn.type = 'button';
      addIn.className = 'add-target add-input';
      addIn.textContent = '+ Add input';
      addIn.addEventListener('click', function () { openItemPicker(addIn, addModelInput); });
      inputsBox.lastChild.appendChild(addIn);
    }
  }

  // Every building, ticked if the user has it: what the plan uses shows
  // how many, and unticking one re-plans without it.
  var rows = BUILDINGS.map(function (mid) {
    var m = byMachine[mid];
    var has = hasBuilding(mid);
    var b = row(buildingName(mid), m ? fmtNum(m.exact) + ' · ' + fmtPower(m.power) : '',
      m ? String(m.built) : '', function () { toggleBuilding(mid); });
    b.classList.add('check-row');
    b.classList.toggle('on', has);
    b.classList.toggle('idle', !m);
    b.title = has ? 'Untick if you don’t have it yet' : 'Tick once you have it';
    return b;
  });
  if (shards) {
    var sh = row('Power Shards', 'for overclocking', String(shards));
    sh.classList.add('extra-row');
    rows.push(sh);
  }
  if (sloops) {
    var sls = row('Somersloops', 'for more output', String(sloops));
    sls.classList.add('extra-row');
    rows.push(sls);
  }
  machinesBox.appendChild(group('Machines', 'running · built', rows, 'machines'));

  var spare = Object.keys(solved.items)
    .filter(function (id) { return solved.items[id].surplus > EPS; });
  if (spare.length) {
    breakdownEl.appendChild(group('Spare', 'made but unused', spare.map(function (id) {
      var e = solved.items[id];
      var from = e.producers.filter(function (p) { return p.node.indexOf('r:') === 0; })[0];
      return row(itemName(id), '', rateText(id, e.surplus),
        from ? function () { focusOn(from.node); } : null);
    })));
  }
}

/** A section in its own box, for the Overview and Power pages. */
function boxed(title, sub, rows) {
  var box = document.createElement('div');
  box.className = 'panel-box';
  box.appendChild(group(title, sub, rows));
  return box;
}

function quietRow(text) {
  var r = row(text, '', '');
  r.classList.add('quiet');
  return r;
}

/** The factory at a glance: resources, production, machines, power, alternates. */
/**
 * Every building the model needs, from its cards: machines and extractors
 * as built (a Resource Well also needs its Pressurizer), splitters and
 * mergers (Pipeline Junctions on fluids), and Storage Containers (Fluid
 * Buffers). Returns their total and the items they cost.
 */
function buildCost() {
  var buildings = {};
  function add(id, k) { if (k > 0) buildings[id] = (buildings[id] || 0) + k; }
  if (flow) flow.tally.forEach(function (t) { add(t.mid, t.built); });
  state.custom.nodes.forEach(function (n) {
    if (n.type === 'resource' && extractorOf(n) === 'Build_FrackingExtractor_C') add('Build_FrackingSmasher_C', 1);
    if (n.type === 'awesome') { add('Build_ResourceSink_C', 1); return; }
    if (n.type !== 'splitter' && n.type !== 'merger' && n.type !== 'sink') return;
    var item = slotItem(n, 'in', 0) || slotItem(n, 'out', 0);
    var fluid = item && isFluid(item);
    if (n.type === 'sink') add(fluid ? 'Build_PipeStorageTank_C' : 'Build_StorageContainerMk1_C', 1);
    else if (fluid) add('Build_PipelineJunction_Cross_C', 1);
    else if (n.type === 'splitter') add(n.programmable ? 'Build_ConveyorAttachmentSplitterProgrammable_C' : n.priority ? 'Build_ConveyorAttachmentSplitterSmart_C' : 'Build_ConveyorAttachmentSplitter_C', 1);
    else add(n.priority ? 'Build_ConveyorAttachmentMergerPriority_C' : 'Build_ConveyorAttachmentMerger_C', 1);
  });
  var items = {}, count = 0;
  Object.keys(buildings).forEach(function (id) {
    count += buildings[id];
    (DATA.buildCosts[id] || []).forEach(function (q) { items[q[0]] = (items[q[0]] || 0) + q[1] * buildings[id]; });
  });
  return { buildings: buildings, items: items, count: count };
}

function renderOverview(t) {
  var el = document.getElementById('overview-list');
  el.innerHTML = '';

  // Resources: what the factory draws from the map, and what it imports.
  var ids = Object.keys(solved.items).filter(function (id) { return solved.items[id].supplied > EPS; })
    .sort(function (a, b) { return solved.items[b].supplied - solved.items[a].supplied; });
  var raw = ids.filter(function (id) { return DATA.items[id].raw; });
  var brought = ids.filter(function (id) { return !DATA.items[id].raw; });
  var rows = raw.map(function (id) {
    var e = solved.items[id];
    return row(itemName(id), e.cap != null ? 'of ' + fmtNum(e.cap) : 'no cap', rateText(id, e.supplied),
      function () { focusOn('raw:' + id); }, e.short > EPS);
  }).concat(brought.map(function (id) {
    return row(itemName(id), state.imports[id] ? 'imported' : blocked[id] ? 'no ' + buildingName(blocked[id]) : 'brought in',
      rateText(id, solved.items[id].supplied), function () { focusOn('raw:' + id); });
  }));
  el.appendChild(boxed('Resources', raw.length + ' from the map' + (brought.length ? ', ' + brought.length + ' brought in' : ''),
    rows.length ? rows : [quietRow('Nothing yet')]));

  // Production: what it's for, and what it makes on the side.
  var outs = Object.keys(solved.targets).filter(function (id) { return solved.targets[id] > EPS; });
  var spare = Object.keys(solved.items).filter(function (id) { return solved.items[id].surplus > EPS; });
  rows = outs.map(function (id) {
    return row(itemName(id), 'output', rateText(id, solved.targets[id]), function () { focusOn('out:' + id); });
  }).concat(spare.map(function (id) {
    var r = row(itemName(id), 'spare', rateText(id, solved.items[id].surplus));
    r.classList.add('quiet');
    return r;
  }));
  el.appendChild(boxed('Production', 'per minute', rows.length ? rows : [quietRow('No outputs yet')]));

  // Machines: how many of each building.
  var mids = Object.keys(t.byMachine).sort(function (a, b) { return t.byMachine[b].built - t.byMachine[a].built; });
  rows = mids.map(function (mid) {
    var m = t.byMachine[mid];
    return row(m.name, fmtNum(m.exact) + ' running', String(m.built));
  });
  if (t.shards) rows.push(row('Power Shards', 'for overclocking', String(t.shards)));
  if (t.sloops) rows.push(row('Somersloops', 'for more output', String(t.sloops)));
  el.appendChild(boxed('Machines', t.buildings + (t.buildings === 1 ? ' building' : ' buildings'),
    rows.length ? rows : [quietRow('None yet')]));

  // Build cost: what it takes to place every building, from the game's
  // build recipes. Belts, pipes and foundations aren't counted.
  var cost = buildCost();
  var costIds = Object.keys(cost.items).sort(function (a, b) { return cost.items[b] - cost.items[a]; });
  rows = costIds.map(function (id) {
    var r = row(itemName(id), '', fmtNum(cost.items[id]));
    var ic = document.createElement('img');
    ic.className = 'row-icon';
    ic.src = iconOf(id);
    ic.alt = '';
    r.insertBefore(ic, r.firstChild);
    return r;
  });
  if (costIds.length) {
    var q = quietRow('Not counting belts, pipes or foundations');
    rows.push(q);
  }
  el.appendChild(boxed('Build cost', cost.count ? cost.count + (cost.count === 1 ? ' building' : ' buildings') : '',
    rows.length ? rows : [quietRow('Nothing to build yet')]));

  // Power: the total, split between making and extracting.
  var made = t.draws.filter(function (d) { return !d.extraction; }).reduce(function (s, d) { return s + d.power; }, 0);
  rows = [
    row('Production buildings', '', fmtPower(made)),
    row('Miners and extractors', '', fmtPower(t.power - made))
  ];
  var total = row('Total', 'average draw', fmtPower(t.power));
  total.classList.add('total-row');
  rows.push(total);
  el.appendChild(boxed('Power', 'itemised under Power', rows));

  // Alternates in use.
  var used = solved.custom ? flow.recipes : solved.recipes;
  var alts = Object.keys(used).filter(unlockable).sort(function (a, b) {
    return DATA.recipes[a].name.localeCompare(DATA.recipes[b].name);
  });
  rows = alts.map(function (rid) {
    return row(DATA.recipes[rid].name, itemName(used[rid].item) + ' · ' + machineName(rid),
      '', function () { focusOn('r:' + rid); });
  });
  el.appendChild(boxed('Alternate recipes used', alts.length ? String(alts.length) : '',
    rows.length ? rows : [quietRow('Standard recipes only')]));
}

/** Everything that draws power, biggest first, each with its share. */
function renderPower(draws, total) {
  var el = document.getElementById('power-list');
  el.innerHTML = '';
  var head = row('Total', 'average draw', fmtPower(total));
  head.classList.add('total-row');
  el.appendChild(boxed('Power', draws.length + (draws.length === 1 ? ' step' : ' steps'), [head]));
  if (!draws.length) return;
  var rows = draws.slice().sort(function (a, b) { return b.power - a.power; }).map(function (d) {
    var r = row(d.label, d.note, fmtPower(d.power), function () { if (d.part) focusPart(d.part); else focusOn(d.node); });
    var share = total > EPS ? d.power / total : 0;
    r.classList.add('draw-row');
    var bar = document.createElement('span');
    bar.className = 'draw-bar';
    bar.style.width = Math.max(1, share * 100) + '%';
    r.appendChild(bar);
    r.title = d.label + ' · ' + d.note + ' · ' + fmtPower(d.power) + ' (' + Math.round(share * 100) + '% of the total)';
    return r;
  });
  el.appendChild(boxed('Itemised', 'biggest first', rows));
}

document.getElementById('data-build').textContent =
  DATA.build ? DATA.build : DATA.generated;

export { addTarget, applyFolds, askForOutput, group, renderBreakdown, renderTargets, row };
