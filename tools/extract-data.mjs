/* Builds public/data.js from the game's own data dump.
 *
 * Satisfactory ships every recipe, item and building as JSON in
 * CommunityResources/Docs/<locale>.json. It's UTF-16 with a BOM, and most
 * values are Unreal property strings rather than real JSON, so this script
 * parses those and keeps only what the planner needs.
 *
 *   node tools/extract-data.mjs ["path/to/en-US.json"]
 *
 * With no argument it tries the default Steam and Epic install paths. Re-run it
 * after a game update to pick up recipe changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'public', 'data.js');

const CANDIDATES = [
  'C:/Program Files (x86)/Steam/steamapps/common/Satisfactory/CommunityResources/Docs/en-US.json',
  'C:/Program Files/Epic Games/Satisfactory/CommunityResources/Docs/en-US.json'
];

const src = process.argv[2] || CANDIDATES.find((p) => fs.existsSync(p));
if (!src || !fs.existsSync(src)) {
  console.error('Could not find en-US.json. Pass its path as the first argument.');
  process.exit(1);
}

let text = fs.readFileSync(src).toString('utf16le');
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
const docs = JSON.parse(text);

/** All classes under native classes whose name matches `re`. */
function classesOf(re) {
  return docs
    .filter((g) => re.test(g.NativeClass))
    .flatMap((g) => g.Classes);
}

/** `.../Desc_IronIngot.Desc_IronIngot_C'` -> `Desc_IronIngot_C` */
function className(ref) {
  const m = /\.([A-Za-z0-9_]+)'?"?$/.exec(ref.trim());
  return m ? m[1] : ref;
}

/** `((ItemClass="...",Amount=1),(...))` -> [[classId, amount], ...] */
function parseAmounts(s) {
  const out = [];
  const re = /ItemClass="?([^",)]+)"?,Amount=([\d.]+)/g;
  let m;
  while ((m = re.exec(s || ''))) out.push([className(m[1]), Number(m[2])]);
  return out;
}

const num = (v) => Number(v) || 0;

/* ---------------------------------------------------------------- items */

const FORM = { RF_SOLID: 'solid', RF_LIQUID: 'liquid', RF_GAS: 'gas' };

const resourceClasses = classesOf(/FGResourceDescriptor'/);
const rawIds = new Set(resourceClasses.map((c) => c.ClassName));

const itemClasses = classesOf(
  /FG(ResourceDescriptor|ItemDescriptor|ItemDescriptorBiomass|ItemDescriptorNuclearFuel|ItemDescriptorPowerBoosterFuel|ConsumableDescriptor|EquipmentDescriptor|AmmoType\w*|PowerShardDescriptor)'/
);

const allItems = new Map();
for (const c of itemClasses) {
  allItems.set(c.ClassName, {
    name: c.mDisplayName,
    form: FORM[c.mForm] || 'solid',
    sink: num(c.mResourceSinkPoints) || undefined
  });
}

/* ------------------------------------------------------------- machines */

// A building's clearance is several boxes. The ones used for snapping — not
// soft, not ExcludeForSnapping — make up its footprint, so the footprint is
// their union. Units are centimetres around the building origin; w runs
// across the building (X), l along it (Y), the way belts go through it.
function footprint(c) {
  const src = c.mClearanceData || '';
  // Split into one entry per box: each starts at "(ClearanceBox=" or "(Type=".
  const entries = src.split(/,(?=\((?:Type=|ClearanceBox=))/);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = 0;
  for (const e of entries) {
    if (/Type=CT_Soft|ExcludeForSnapping=True/.test(e)) continue;
    const b = /ClearanceBox=\(Min=\(X=([-\d.]+),Y=([-\d.]+),Z=[-\d.]+\),Max=\(X=([-\d.]+),Y=([-\d.]+),Z=([-\d.]+)\)/.exec(e);
    if (!b) continue;
    const t = /Translation=\(X=([-\d.]+),Y=([-\d.]+)/.exec(e);
    const tx = t ? Number(t[1]) : 0;
    const ty = t ? Number(t[2]) : 0;
    const [ax, ay, bx, by, bz] = b.slice(1).map(Number);
    x0 = Math.min(x0, ax + tx, bx + tx); x1 = Math.max(x1, ax + tx, bx + tx);
    y0 = Math.min(y0, ay + ty, by + ty); y1 = Math.max(y1, ay + ty, by + ty);
    z1 = Math.max(z1, bz);
  }
  if (!isFinite(x0)) return null;
  // Rounded to 10cm; the game's own values are already whole.
  const r = (v) => Math.round(v / 10) / 10;
  return { w: r(x1 - x0), l: r(y1 - y0), h: r(z1) };
}

const machineClasses = classesOf(/FGBuildableManufacturer(VariablePower)?'/);
const machines = {};
for (const c of machineClasses) {
  machines[c.ClassName] = {
    name: c.mDisplayName,
    power: num(c.mPowerConsumption),
    powerExp: num(c.mPowerConsumptionExponent) || 1.321929,
    variable: /VariablePower/.test(c.ClassName) || num(c.mPowerConsumption) === 0,
    size: footprint(c)
  };
}

const extractorClasses = classesOf(
  /FGBuildable(ResourceExtractor|WaterPump|FrackingExtractor)'/
);
const extractors = {};
for (const c of extractorClasses) {
  const liquid = /RF_LIQUID|RF_GAS/.test(c.mAllowedResourceForms || '');
  const perCycle = num(c.mItemsPerCycle) / (liquid ? 1000 : 1);
  const cycle = num(c.mExtractCycleTime) || 1;
  const allowed = [];
  const re = /'([^']+)'/g;
  let m;
  while ((m = re.exec(c.mAllowedResources || ''))) allowed.push(className(m[1]));
  extractors[c.ClassName] = {
    name: c.mDisplayName,
    power: num(c.mPowerConsumption),
    // Items per minute on a normal-purity node at 100% clock.
    rate: (perCycle * 60) / cycle,
    forms: liquid ? ['liquid', 'gas'] : ['solid'],
    resources: allowed.length ? allowed : null,
    size: footprint(c)
  };
}

/* -------------------------------------------------------------- recipes */

const recipes = {};
const usedItems = new Set();

for (const c of classesOf(/FGRecipe'/)) {
  const producers = [...(c.mProducedIn || '').matchAll(/\.(Build_[A-Za-z0-9_]+)/g)]
    .map((m) => m[1])
    .filter((id) => machines[id]);
  if (!producers.length) continue;         // hand-craft or build-gun only
  if (c.mRelevantEvents) continue;         // seasonal (FICSMAS) recipes

  const scale = ([id, amt]) => {
    const it = allItems.get(id);
    return [id, it && it.form !== 'solid' ? amt / 1000 : amt];
  };
  const ins = parseAmounts(c.mIngredients).map(scale);
  const outs = parseAmounts(c.mProduct).map(scale);
  if (!outs.length) continue;

  ins.forEach(([id]) => usedItems.add(id));
  outs.forEach(([id]) => usedItems.add(id));

  const recipe = {
    name: c.mDisplayName.replace(/^Alternate:\s*/, ''),
    machine: producers[0],
    time: num(c.mManufactoringDuration),
    in: ins,
    out: outs
  };
  if (/^Alternate:/.test(c.mDisplayName)) recipe.alt = true;
  // Particle Accelerator, Converter and Quantum Encoder draw a varying amount
  // of power per recipe; average draw is constant + factor / 2.
  const vc = num(c.mVariablePowerConsumptionConstant);
  const vf = num(c.mVariablePowerConsumptionFactor);
  if (machines[recipe.machine].variable) recipe.power = vc + vf / 2;
  recipes[c.ClassName] = recipe;
}

/* ---------------------------------------------------- default recipes */

// For each item, the recipe the planner uses unless told otherwise. A recipe
// that only makes the item as a byproduct is never the default when anything
// else will do: asking for Heavy Oil Residue shouldn't build a plastic plant.
// After that, standard beats alternate, and the recipe named after the item
// wins. Converter and unpackaging recipes come last, since
// they exist to turn one thing into another rather than to make the item.
function score(rid, itemId) {
  const r = recipes[rid];
  const item = allItems.get(itemId);
  let s = 0;
  if (r.out[0][0] !== itemId) s -= 200;
  if (r.alt) s -= 100;
  if (r.machine === 'Build_Converter_C') s -= 50;
  // Unpackaging needs the packaged item, which is made from this one: a loop.
  if (/^Unpackage/i.test(r.name)) s -= 150;
  // Synthetic shards and the like: late-game machines as a last resort.
  if (machines[r.machine].variable) s -= 10;
  if (item && r.name === item.name) s += 20;
  // Fewer distinct inputs breaks the remaining ties (Power Shard (1) before (5)).
  s -= r.in.length;
  return s;
}

const producersOf = {};
for (const [rid, r] of Object.entries(recipes)) {
  for (const [id] of r.out) (producersOf[id] ||= []).push(rid);
}

const defaults = {};
for (const [id, list] of Object.entries(producersOf)) {
  if (rawIds.has(id)) continue; // mined, not made
  const best = list
    .map((rid) => ({ rid, s: score(rid, id) }))
    .sort((a, b) => b.s - a.s)[0];
  // An item whose only recipes are alternates still gets one, so it can be
  // planned at all.
  defaults[id] = best.rid;
}

/* -------------------------------------------------------------- output */

const items = {};
for (const id of [...usedItems].sort()) {
  const it = allItems.get(id) || { name: id.replace(/^Desc_|_C$/g, ''), form: 'solid' };
  items[id] = { name: it.name, form: it.form };
  if (rawIds.has(id)) items[id].raw = true;
  if (it.sink) items[id].sink = it.sink;
}

// Resources nothing currently uses are still worth listing (for imports).
for (const c of resourceClasses) {
  if (!items[c.ClassName]) {
    items[c.ClassName] = { name: c.mDisplayName, form: FORM[c.mForm] || 'solid', raw: true };
  }
}

const version = (() => {
  // Steam and Epic name the file differently (FactoryGameSteam / FactoryGameEGS).
  try {
    const dir = path.join(src, '..', '..', '..', 'Engine', 'Binaries', 'Win64');
    const file = fs.readdirSync(dir).find((f) => /-Win64-Shipping\.version$/.test(f));
    const v = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    return v.BranchName.replace(/^\+\+FactoryGame\+/, '') + ' CL ' + v.Changelist;
  } catch (e) {
    return null;
  }
})();

const data = {
  source: path.basename(src),
  build: version,
  generated: new Date().toISOString().slice(0, 10),
  items,
  recipes,
  defaults,
  machines,
  extractors
};

const banner =
  '/* Generated by tools/extract-data.mjs from the game\'s ' + data.source +
  (version ? ' (' + version + ')' : '') + '.\n   Do not edit by hand; re-run the script. */\n';

fs.writeFileSync(OUT, banner + 'window.SF_DATA = ' + JSON.stringify(data) + ';\n');

console.log(
  'Wrote', path.relative(process.cwd(), OUT), '—',
  Object.keys(items).length, 'items,',
  Object.keys(recipes).length, 'recipes,',
  Object.keys(machines).length, 'machines,',
  Object.keys(extractors).length, 'extractors',
  version ? '(' + version + ')' : ''
);
