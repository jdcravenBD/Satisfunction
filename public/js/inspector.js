/* Satisfunction — The Details page: the selected card's settings and the factory's problems. */

import { DATA, EPS, MINERS, SOLVER, canBuild, clamp, fmtNum, hasBuilding, isFluid, itemName,
  machineName, producersOf, rateText, recipeAllowed, shardsFor, state, titleCase } from './core.js';
import { MAX_NODES, MAX_RATE, MAX_SET, currentFactory } from './store.js';
import { changed } from './history.js';
import { openCtx, openItemPicker } from './menus.js';
import { group, row } from './panel.js';
import { factoryLabel } from './factories.js';
import { RULE_NAMES, extractorOf, flow, iconOf, isRuled, nodeById, nodeRecipe, partName,
  resourceCap, rulesOf, sloopsOf, slotItems, slotsOf } from './model.js';
import { factoryById, factoryOutputs, otherFactories, requestsOf } from './links.js';
import { selectedParts } from './palette.js';
import { focusPart } from './cards.js';

/* ---- panel: inspector, problems, outputs ---- */

var inspectorEl = document.getElementById('inspector');
var problemsEl = document.getElementById('problems');

function renderCustomPanel() {
  var outEl = document.getElementById('custom-outputs');
  outEl.innerHTML = '';
  Object.keys(flow.outputs).sort().forEach(function (id) {
    outEl.appendChild(row(itemName(id), '', rateText(id, flow.outputs[id])));
  });
  // Other factories importing from this one, and whether it keeps up.
  var asked = requestsOf(currentFactory().id);
  if (asked.length) {
    var sub = document.createElement('p');
    sub.className = 'custom-note sent-head';
    sub.textContent = 'Sent to other factories';
    outEl.appendChild(sub);
    var per = {};
    asked.forEach(function (r) { per[r.item] = (per[r.item] || 0) + r.rate; });
    asked.forEach(function (r) {
      var over = per[r.item] > (flow.outputs[r.item] || 0) * (1 + 1e-3) + 1e-6;
      outEl.appendChild(row(factoryLabel(r.factory), itemName(r.item), rateText(r.item, r.rate), null, over));
    });
  }
  problemsEl.innerHTML = '';
  // One orange box per card, its problems listed inside; pressing it
  // brings the card into view.
  var byPart = {};
  var order = [];
  flow.problems.forEach(function (pr) {
    if (!byPart[pr.part]) { byPart[pr.part] = []; order.push(pr.part); }
    byPart[pr.part].push(pr.text);
  });
  var rows = order.map(function (id) {
    var n = nodeById(id);
    var title = n ? cardTitle(n) : '';
    var box = document.createElement('button');
    box.type = 'button';
    box.className = 'problem-box';
    var head = document.createElement('span');
    head.className = 'problem-head';
    if (n) {
      var icon = document.createElement('img');
      icon.src = iconOf(n.item || (n.type === 'sink' ? 'storage' : n.type === 'awesome' ? 'sink' : n.type));
      icon.alt = '';
      head.appendChild(icon);
    }
    var name = document.createElement('span');
    name.textContent = title || 'Step';
    head.appendChild(name);
    box.appendChild(head);
    byPart[id].forEach(function (text) {
      var line = document.createElement('span');
      line.className = 'problem-line';
      // The box already says which card: drop it from the front.
      line.textContent = title && text.indexOf(title + ': ') === 0 ? titleCase(text.slice(title.length + 2)) : text;
      box.appendChild(line);
    });
    box.addEventListener('click', function () { focusPart(id); });
    return box;
  });
  if (!rows.length && state.custom.nodes.length) {
    var ok = row('No problems', '', '');
    ok.classList.add('quiet');
    rows.push(ok);
  }
  if (rows.length) problemsEl.appendChild(group('Problems', flow.problems.length ? String(flow.problems.length) : '', rows, 'problems'));
  renderInspector();
}

/** What a card is called: its item, or what kind of part it is. */
function cardTitle(n) {
  if (n.item) return itemName(n.item);
  var r = nodeRecipe(n);
  if (r) return itemName(r.out[0][0]);
  return partName(n);
}

/**
 * A clock speed, like the game's: the percentage to type on the left, and
 * a long rounded bar filled up to it, with a tall handle and marks at
 * 100%, 150%, 200% and 250%. Dragging updates the figure; letting go (or
 * typing) sets it.
 */
function clockSlider(k, onSet) {
  var MAX = SOLVER.MAX_CLOCK * 100;
  var wrap = document.createElement('div');
  wrap.className = 'clk';
  var field = document.createElement('label');
  field.className = 'clk-num';
  var num = document.createElement('input');
  num.type = 'number';
  num.min = 1;
  num.max = MAX;
  num.step = 1;
  num.value = Number((k * 100).toFixed(2));
  var pct = document.createElement('span');
  pct.textContent = '%';
  field.appendChild(num);
  field.appendChild(pct);
  wrap.appendChild(field);

  var bar = document.createElement('div');
  bar.className = 'clk-bar';
  var range = document.createElement('input');
  range.type = 'range';
  range.className = 'clk-range';
  range.min = 1;
  range.max = MAX;
  range.step = 1;
  range.value = Math.round(k * 100);
  bar.appendChild(range);
  // Where a value sits along the bar: the handle's centre travels between
  // half its width in from each end.
  function at(v) { return 'calc(5px + ' + ((v - 1) / (MAX - 1)) + ' * (100% - 10px))'; }
  var marks = [100, 150, 200, 250].filter(function (v) { return v <= MAX; });
  var labels = [];
  // The marks are drawn into the bar itself, so the handle covers them.
  var ticks = marks.filter(function (v) { return v < MAX; }).map(function (v) {
    var x = at(v);
    return 'linear-gradient(to right, transparent calc(' + x + ' - 1px), rgba(0, 0, 0, .5) calc(' + x + ' - 1px), ' +
      'rgba(0, 0, 0, .5) calc(' + x + ' + 1px), transparent calc(' + x + ' + 1px))';
  }).join(', ');
  var scale = document.createElement('div');
  scale.className = 'clk-scale';
  [1].concat(marks).forEach(function (v) {
    var l = document.createElement('button');
    l.type = 'button';
    l.textContent = (v === 1 ? 0 : v) + '%';
    l.style.left = at(v);
    // Pressing a mark snaps to it (0% is as low as the game goes: 1%).
    l.addEventListener('click', function () {
      range.value = v;
      num.value = v;
      paint(v);
      onSet(v / 100);
    });
    scale.appendChild(l);
    labels.push({ el: l, v: v });
  });
  bar.appendChild(scale);
  wrap.appendChild(bar);

  function paint(v) {
    bar.style.setProperty('--fill', at(v));
    bar.style.setProperty('--ticks', ticks);
    labels.forEach(function (l) { l.el.classList.toggle('on', l.v <= v); });
  }
  paint(Number(range.value));
  range.addEventListener('input', function () { num.value = range.value; paint(Number(range.value)); });
  range.addEventListener('change', function () { onSet(clamp(Number(range.value) / 100, 0.01, SOLVER.MAX_CLOCK)); });
  num.addEventListener('change', function () {
    var v = clamp(Number(num.value) || 100, 1, MAX);
    onSet(v / 100);
  });
  return wrap;
}

/** The selected card's settings and rates. */
function renderInspector() {
  inspectorEl.innerHTML = '';
  if (state.build !== 'custom' || !flow) return;
  var sel = selectedParts();
  if (sel.length !== 1) return;
  var n = sel[0];
  var st = flow.nodes[n.id] || { ins: [], outs: [] };
  var box = document.createElement('div');
  box.className = 'sum-group inspector';
  var head = document.createElement('div');
  head.className = 'sum-group-head insp-head';
  var img = document.createElement('img');
  img.className = 'insp-icon';
  img.alt = '';
  img.src = iconOf(n.item || (n.type === 'sink' ? 'storage' : n.type === 'awesome' ? 'sink' : n.type));
  var title = document.createElement('span');
  title.className = 'sum-group-name';
  title.textContent = n.item ? itemName(n.item) : partName(n);
  head.appendChild(img);
  head.appendChild(title);
  box.appendChild(head);

  function field(label, control) {
    var wrap = document.createElement('label');
    wrap.className = 'insp-field';
    var l = document.createElement('span');
    l.className = 'insp-label';
    l.textContent = label;
    wrap.appendChild(l);
    wrap.appendChild(control);
    box.appendChild(wrap);
  }
  // A button showing the current choice, opening the app's own menu of
  // the rest (with icons and a second line where they help).
  function select(options, value, onPick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'insp-drop';
    var cur = options.filter(function (o) { return o.value === value; })[0] || options[0];
    if (cur && cur.icon) {
      var ic = document.createElement('img');
      ic.src = cur.icon;
      ic.alt = '';
      b.appendChild(ic);
    }
    var t = document.createElement('span');
    t.className = 'insp-drop-text';
    t.textContent = cur ? (cur.short || cur.label) : '';
    b.appendChild(t);
    if (cur && cur.tag) {
      var tg = document.createElement('span');
      tg.className = 'insp-drop-tag';
      tg.textContent = cur.tag;
      b.appendChild(tg);
    }
    var chev = document.createElement('span');
    chev.className = 'insp-drop-chev';
    chev.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    b.appendChild(chev);
    b.addEventListener('click', function () {
      var r = b.getBoundingClientRect();
      openCtx(r.left, r.bottom + 4, options.map(function (o) {
        return { label: o.label, note: o.note, icon: o.icon, tag: o.tag, on: o.value === value, run: function () { onPick(o.value); } };
      }), false, r.width);
    });
    return b;
  }
  function number(value, min, step, onSet) {
    var i = document.createElement('input');
    i.type = 'number';
    i.className = 'insp-number';
    i.min = min;
    i.step = step;
    i.value = value;
    i.addEventListener('change', function () { onSet(Number(i.value)); });
    return i;
  }
  function note(text) {
    var p = document.createElement('p');
    p.className = 'insp-note';
    p.textContent = text;
    box.appendChild(p);
  }

  if (n.type === 'recipe') {
    var r = nodeRecipe(n);
    var rids = (producersOf[n.item] || []).filter(function (rid) {
      return (canBuild(rid) && recipeAllowed(rid)) || rid === n.recipe;
    });
    field('Recipe', select(rids.map(function (rid) {
      var q = DATA.recipes[rid];
      var per = SOLVER.perMinute(q);
      var side = function (list) {
        return list.map(function (x) { return fmtNum(Math.abs(per[x[0]])) + ' ' + itemName(x[0]); }).join(' + ');
      };
      return {
        value: rid, label: q.name, tag: q.alt ? 'ALT' : '', icon: iconOf(q.machine),
        note: machineName(rid) + ' · ' + side(q.in) + ' → ' + side(q.out)
      };
    }), n.recipe, function (v) {
      // Lines on slots the new recipe doesn't have come off.
      n.recipe = v;
      var s = slotsOf(n);
      state.custom.links = state.custom.links.filter(function (l) {
        if (l.to === n.id) {
          if (l.tk >= s.ins.length) return false;
          var brings = slotItems(nodeById(l.from), 'out', l.fk);
          if (!brings.length) return true;
          if (isFluid(s.ins[l.tk])) return brings.length === 1 && brings[0] === s.ins[l.tk];
          return brings.some(function (i) { return s.ins.indexOf(i) >= 0 && !isFluid(i); });
        }
        if (l.from === n.id) return l.fk < s.outs.length;
        return true;
      });
      changed();
    }));
    // Auto, or Set: a count, or a rate of the item it's for.
    var seg = document.createElement('div');
    seg.className = 'seg insp-seg';
    ['auto', 'set'].forEach(function (mode) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn' + ((mode === 'set') === !!n.set ? ' on' : '');
      b.textContent = mode === 'auto' ? 'Auto' : 'Set';
      b.addEventListener('click', function () {
        if (mode === 'set' && !n.set) { n.set = true; n.count = Number((st.count || 1).toFixed(4)) || 1; }
        else if (mode === 'auto') { n.set = false; delete n.count; }
        changed();
      });
      seg.appendChild(b);
    });
    field('Production', seg);
    if (n.set && r) {
      // One setting, shown two ways: typing either side updates the other
      // as you go, and the step takes it when you leave the field.
      var per = (SOLVER.perMinute(r)[n.item] || SOLVER.perMinute(r)[r.out[0][0]]) * (1 + sloopsOf(n).boost);
      var pair = document.createElement('div');
      pair.className = 'insp-pair';
      var cells = [
        { value: n.count || 0, step: 0.01, unit: 'machines', toCount: function (v) { return v; } },
        { value: (n.count || 0) * per, step: 0.1, unit: itemName(n.item) + '/min', icon: iconOf(n.item), toCount: function (v) { return v / per; } }
      ];
      var inputs = [];
      cells.forEach(function (c, i) {
        if (i) {
          var eq = document.createElement('span');
          eq.className = 'ip-eq';
          eq.textContent = '=';
          pair.appendChild(eq);
        }
        var cell = document.createElement('label');
        cell.className = 'ip-cell';
        var inp = document.createElement('input');
        inp.type = 'number';
        inp.min = 0;
        inp.max = Number((i ? MAX_SET * per : MAX_SET).toPrecision(6));
        inp.step = c.step;
        inp.value = Number(c.value.toFixed(4));
        cell.appendChild(inp);
        var unit = document.createElement('span');
        unit.className = 'ip-unit';
        if (c.icon) {
          var ui = document.createElement('img');
          ui.src = c.icon;
          ui.alt = '';
          unit.appendChild(ui);
        }
        unit.appendChild(document.createTextNode(c.unit));
        cell.appendChild(unit);
        pair.appendChild(cell);
        inputs.push(inp);
        inp.addEventListener('input', function () {
          var count = clamp(c.toCount(Number(inp.value) || 0), 0, MAX_SET);
          var other = inputs[1 - i];
          other.value = Number((i ? count : count * per).toFixed(4));
          pair.classList.add('live');
        });
        inp.addEventListener('change', function () {
          n.count = clamp(c.toCount(Number(inp.value) || 0), 0, MAX_SET);
          changed();
        });
      });
      box.appendChild(pair);
    }
    if (r) {
      // Its own clock speed (Custom), or the Speed setting's (Auto).
      var cseg = document.createElement('div');
      cseg.className = 'seg insp-seg';
      [['auto', 'Auto'], ['own', 'Custom']].forEach(function (o) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'seg-btn' + ((o[0] === 'own') === !!n.clock ? ' on' : '');
        b.textContent = o[1];
        b.addEventListener('click', function () {
          if (o[0] === 'own' && !n.clock) n.clock = 1;
          else if (o[0] === 'auto') delete n.clock;
          else return;
          changed();
        });
        cseg.appendChild(b);
      });
      field('Clock speed', cseg);
      if (n.clock) {
        box.appendChild(clockSlider(n.clock, function (k) { n.clock = k; changed(); }));
      }
      // Somersloops in each machine, as many as the building has slots for.
      var slots = DATA.machines[r.machine].sloops || 0;
      if (slots) {
        var sseg = document.createElement('div');
        sseg.className = 'seg insp-seg';
        for (var sv = 0; sv <= slots; sv++) {
          (function (v) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'seg-btn' + ((n.sloops || 0) === v ? ' on' : '');
            b.textContent = v ? String(v) : 'None';
            b.addEventListener('click', function () {
              if (v) n.sloops = v; else delete n.sloops;
              changed();
            });
            sseg.appendChild(b);
          })(sv);
        }
        field('Somersloops', sseg);
        var sl = sloopsOf(n);
        if (sl.used) {
          var hint = document.createElement('p');
          hint.className = 'insp-hint';
          hint.textContent = '+' + Math.round(sl.boost * 100) + '% output, ' + fmtNum(sl.power) + '× power, in each machine';
          box.appendChild(hint);
        }
      }
      r.in.forEach(function (q, k) {
        var wantIn = Math.abs(SOLVER.perMinute(r)[q[0]]) * (st.count || 0);
        box.appendChild(row(itemName(q[0]), 'in', fmtNum(st.ins[k] || 0) + ' of ' + rateText(q[0], wantIn), null, (st.ins[k] || 0) < wantIn - 1e-6));
      });
      r.out.forEach(function (q, k) {
        box.appendChild(row(itemName(q[0]), 'out', rateText(q[0], st.outs[k] || 0)));
      });
    }
  } else if (n.type === 'resource') {
    if (!isFluid(n.item)) {
      field('Miner', select(MINERS.filter(function (m) { return DATA.extractors[m] && (hasBuilding(m) || m === n.miner); }).map(function (m) {
        return { value: m, label: DATA.extractors[m].name, icon: iconOf(m) };
      }), extractorOf(n), function (v) { n.miner = v; state.defaultMiner = v; changed(); }));
    }
    if (n.item !== 'Desc_Water_C') {
      field('Purity', select(SOLVER.PURITIES.map(function (q) { return { value: q, label: titleCase(q) }; }),
        n.purity || 'normal', function (v) { n.purity = v; changed(); }));
    }
    field(n.item === 'Desc_Water_C' ? 'Extractors' : 'Nodes', number(n.count || 1, 1, 1, function (v) {
      n.count = clamp(Math.round(v || 1), 1, MAX_NODES);
      changed();
    }));
    field('Clock speed', document.createElement('span'));
    box.appendChild(clockSlider(n.clock || 1, function (k) { n.clock = k; changed(); }));
    note('Gives ' + fmtNum(st.run || 0) + ' of ' + rateText(n.item, resourceCap(n)) +
      (shardsFor(n.clock || 1) ? ' · ' + shardsFor(n.clock || 1) * (n.count || 1) + ' Power Shards' : ''));
  } else if (n.type === 'import') {
    var sources = [{ value: '', label: 'Elsewhere', note: 'A train, truck or drone from outside this save' }];
    otherFactories().forEach(function (f) {
      var makes = factoryOutputs(f)[n.item] || 0;
      if (makes > EPS || f.id === n.from) {
        sources.push({ value: f.id, label: factoryLabel(f), note: 'Makes ' + rateText(n.item, makes) });
      }
    });
    if (n.from && !factoryById(n.from)) sources.push({ value: n.from, label: 'A deleted factory', note: '' });
    field('From', select(sources, n.from || '', function (v) {
      if (v) n.from = v; else delete n.from;
      delete n.standIn;
      changed();
    }));
    field(itemName(n.item) + '/min', number(n.rate || 0, 0, 1, function (v) { n.rate = clamp(v || 0, 0, MAX_RATE); changed(); }));
  } else if (n.type === 'splitter') {
    // One card, three splitters: switching keeps the lines.
    var kind = n.programmable ? 'programmable' : n.priority ? 'smart' : 'splitter';
    field('Type', select([
      { value: 'splitter', label: 'Splitter', note: 'Shares evenly', icon: iconOf('splitter') },
      { value: 'smart', label: 'Smart Splitter', note: 'One rule per output', icon: iconOf('splitter') },
      { value: 'programmable', label: 'Programmable Splitter', note: 'Several rules per output', icon: iconOf('splitter') }
    ], kind, function (v) {
      if (v === kind) return;
      delete n.priority;
      delete n.programmable;
      // A Smart Splitter keeps one rule per output.
      if (n.rules && v === 'smart') n.rules = n.rules.map(function (list) { return list.slice(0, 1); });
      if (v === 'smart') n.priority = true;
      if (v === 'programmable') n.programmable = true;
      if (v === 'splitter') delete n.rules;
      changed();
    }));
    if (!isRuled(n)) {
      note('Shares what comes in evenly across its outputs; anything a branch can’t take goes to the others.');
    } else {
      note(n.programmable
        ? 'Each output takes what its rules name: items, Any, Any Undefined (anything no output names) or Overflow (what the others can’t take). An output with no rules takes nothing.'
        : 'Each output takes one thing: an item, Any, Any Undefined (anything no output names), Overflow (what the others can’t take) or None.');
      var onLine = slotItems(n, 'in', 0);
      var setRules = function (k, list) {
        n.rules = rulesOf(n).map(function (x) { return x.slice(); });
        n.rules[k] = list;
        changed();
      };
      // The choices for a rule: the special ones, then what's on the belt
      // in, then any item at all.
      var choices = function (skip) {
        var list = ['any', 'undefined', 'overflow'].map(function (r) { return { value: r, label: RULE_NAMES[r] }; });
        if (!n.programmable) list.splice(1, 0, { value: 'none', label: 'None' });
        onLine.forEach(function (i) { list.push({ value: i, label: itemName(i), icon: iconOf(i), note: 'On the belt in' }); });
        list.push({ value: '__pick', label: 'Another item…' });
        return list.filter(function (o) { return skip.indexOf(o.value) < 0; });
      };
      var ruleText = function (r) { return RULE_NAMES[r] || itemName(r); };
      ['Top', 'Middle', 'Bottom'].forEach(function (where, k) {
        var mine = rulesOf(n)[k];
        if (!n.programmable) {
          var cur = mine[0] || 'none';
          var opts = choices([]);
          if (opts.every(function (o) { return o.value !== cur; })) opts.splice(4, 0, { value: cur, label: ruleText(cur), icon: iconOf(cur) });
          var b = select(opts, cur, function (v) {
            if (v === '__pick') {
              openItemPicker(b, function (id) { setRules(k, [id]); });
              return;
            }
            setRules(k, v === 'none' ? [] : [v]);
          });
          field(where + ' output', b);
          return;
        }
        // Programmable: a chip per rule, and a + to add one.
        var row = document.createElement('div');
        row.className = 'rule-chips';
        if (!mine.length) {
          var none = document.createElement('span');
          none.className = 'rule-none';
          none.textContent = 'None';
          row.appendChild(none);
        }
        mine.forEach(function (r) {
          var chip = document.createElement('span');
          chip.className = 'rule-chip' + (RULE_NAMES[r] ? ' special' : '');
          if (!RULE_NAMES[r]) {
            var ci = document.createElement('img');
            ci.src = iconOf(r);
            ci.alt = '';
            chip.appendChild(ci);
          }
          chip.appendChild(document.createTextNode(ruleText(r)));
          var x = document.createElement('button');
          x.type = 'button';
          x.className = 'rule-x';
          x.setAttribute('aria-label', 'Remove ' + ruleText(r));
          x.textContent = '×';
          x.addEventListener('click', function () { setRules(k, mine.filter(function (q) { return q !== r; })); });
          chip.appendChild(x);
          row.appendChild(chip);
        });
        var add = document.createElement('button');
        add.type = 'button';
        add.className = 'rule-add';
        add.setAttribute('aria-label', 'Add a rule');
        add.textContent = '+';
        add.addEventListener('click', function () {
          var rr = add.getBoundingClientRect();
          openCtx(rr.left, rr.bottom + 4, choices(mine).map(function (o) {
            return {
              label: o.label, icon: o.icon, note: o.note,
              run: function () {
                if (o.value === '__pick') openItemPicker(add, function (id) { if (mine.indexOf(id) < 0) setRules(k, mine.concat([id])); });
                else setRules(k, mine.concat([o.value]));
              }
            };
          }));
        });
        row.appendChild(add);
        field(where + ' output', row);
      });
    }
  } else {
    note(n.type === 'merger' && n.priority ? 'Joins up to three lines into one, its top input first: when the line out is full, the others back up.'
      : n.type === 'merger' ? 'Joins up to three lines into one. Different items make a mixed belt.'
      : n.type === 'awesome' ? 'Sinks whatever solids reach it for FICSIT points: ' + fmtNum(st.points || 0) + ' points/min. From a splitter, it only takes what the other branches leave.'
      : 'Collects whatever reaches it. From a splitter, it only takes what the other branches leave.');
  }
  inspectorEl.appendChild(box);
}

export { renderCustomPanel, renderInspector };
