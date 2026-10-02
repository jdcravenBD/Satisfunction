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
    size: footprint(c),
    // Somersloop slots (the game calls them production shards): each one
    // adds `sloopBoost` to the output; power grows with the boost squared.
    // A machine that can be boosted but lists no slots (the Smelter) has one.
    sloops: c.mCanChangeProductionBoost === 'False' ? 0 : num(c.mProductionShardSlotSize) || 1,
    sloopBoost: num(c.mProductionShardBoostMultiplier) || 0,
    sloopPowerExp: num(c.mProductionBoostPowerConsumptionExponent) || 2
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

/* ---------------------------------------------------------- progression */

// How far into the game each item turns up, as `order` (0 first). A made item
// counts from the earliest standard recipe for it: the starting recipes, then
// the tutorial, then each milestone tier in the HUB's own order. MAM research
// sits just after tier 3, where it's usually done, deeper steps later.
// Resources are ordered by hand: the game unlocks them through buildings and scanners, not recipes.
const RESOURCE_ORDER = [
  'Desc_OreIron_C', 'Desc_OreCopper_C', 'Desc_Stone_C', 'Desc_Coal_C', 'Desc_Water_C',
  'Desc_OreGold_C', 'Desc_RawQuartz_C', 'Desc_Sulfur_C', 'Desc_LiquidOil_C',
  'Desc_OreBauxite_C', 'Desc_NitrogenGas_C', 'Desc_OreUranium_C', 'Desc_SAM_C'
];
const stageOf = {};
for (const c of classesOf(/FGSchematic'/)) {
  let key;
  if (c.ClassName === 'Schematic_StartingRecipes_C') key = 0;
  else if (c.mType === 'EST_Tutorial') key = num(c.mMenuPriority) / 10;
  else if (c.mType === 'EST_Milestone') key = num(c.mTechTier) + num(c.mMenuPriority) / 1000;
  else if (c.mType === 'EST_MAM') {
    // Research_Caterium_4_2_C: four steps into the Caterium tree. Alien
    // research (SAM, Somersloops) has tech tier 0 and comes near the end.
    const depth = Number((/^Research_[A-Za-z]+_(\d+)/.exec(c.ClassName) || [])[1] ?? 5);
    key = num(c.mTechTier) ? 3.5 + depth / 20 : 8.5 + depth / 20;
  }
  else continue;
  const unlocked = [...JSON.stringify(c.mUnlocks || []).matchAll(/\.(Recipe_[A-Za-z0-9_]+)/g)].map((m) => m[1]);
  unlocked.forEach((rid, i) => {
    const k = key + i * 1e-6;
    if (!(rid in stageOf) || k < stageOf[rid]) stageOf[rid] = k;
  });
}
const itemStage = {};
for (const [rid, r] of Object.entries(recipes)) {
  if (r.alt || !(rid in stageOf)) continue;
  for (const [id] of r.out) {
    if (!(id in itemStage) || stageOf[rid] < itemStage[id]) itemStage[id] = stageOf[rid];
  }
}
RESOURCE_ORDER.forEach((id, i) => { itemStage[id] = -100 + i; });
Object.keys(items)
  .sort((a, b) => (itemStage[a] ?? 1e9) - (itemStage[b] ?? 1e9) || items[a].name.localeCompare(items[b].name))
  .forEach((id, i) => { items[id].order = i; });

// The build's .version file: its branch and changelist, and the version
// players know it by ("1.2.4.0").
const versionFile = (() => {
  // Steam and Epic name the file differently (FactoryGameSteam / FactoryGameEGS).
  try {
    const dir = path.join(src, '..', '..', '..', 'Engine', 'Binaries', 'Win64');
    const file = fs.readdirSync(dir).find((f) => /-Win64-Shipping\.version$/.test(f));
    return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  } catch (e) {
    return null;
  }
})();
const gameVersion = versionFile && versionFile.GameVersion ? versionFile.GameVersion : null;

const version = (() => {
  if (!versionFile) return null;
  return versionFile.BranchName.replace(/^\+\+FactoryGame\+/, '') + ' CL ' + versionFile.Changelist;
})();

/* ------------------------------------------------------------ logistics */

// Belt and pipe throughput per tier, and the sizes of the pieces that join
// them. A belt's mSpeed is twice its items per minute; a pipe's mFlowLimit is
// m³ per second.
const tierOf = (c) => Number((/Mk\.?(\d)/i.exec(c.mDisplayName) || [])[1] || 1);
const belts = classesOf(/FGBuildableConveyorBelt'/)
  .map((c) => ({ tier: tierOf(c), rate: num(c.mSpeed) / 2 }))
  .sort((a, b) => a.tier - b.tier)
  .map((b) => b.rate);
const pipes = classesOf(/FGBuildablePipeline'/)
  .filter((c) => !/NoIndicator/.test(c.ClassName))
  .map((c) => ({ tier: tierOf(c), rate: num(c.mFlowLimit) * 60 }))
  .sort((a, b) => a.tier - b.tier)
  .map((p) => p.rate);

/** Width of a soft clearance box, in metres: splitters and junctions only have those. */
function squareSize(className) {
  const c = docs.flatMap((g) => g.Classes).find((k) => k.ClassName === className);
  const m = c && /Min=\(X=([-\d.]+).*?Max=\(X=([-\d.]+)/.exec(c.mClearanceData || '');
  return m ? Math.round(Number(m[2]) - Number(m[1])) / 100 : null;
}

// Where finished goods and spare byproducts end up: a Storage Container for
// items, a Fluid Buffer for fluids, and the AWESOME Sink for anything spare.
function building(className) {
  const c = docs.flatMap((g) => g.Classes).find((k) => k.ClassName === className);
  return c ? { name: c.mDisplayName, size: footprint(c) } : null;
}

const logistics = {
  belts,
  pipes,
  splitter: squareSize('Build_ConveyorAttachmentSplitter_C') || 4,
  merger: squareSize('Build_ConveyorAttachmentMerger_C') || 4,
  junction: squareSize('Build_PipelineJunction_Cross_C') || 2.4,
  storage: {
    items: building('Build_StorageContainerMk1_C'),
    fluids: building('Build_PipeStorageTank_C'),
    sink: building('Build_ResourceSink_C')
  }
};

/* ----------------------------------------------------------- build costs */

// What each building costs to place: the build gun recipe whose product is
// the building's descriptor (Build_X_C is placed from Desc_X_C).
const buildCosts = {};
const costed = new Set(Object.keys(machines).concat(Object.keys(extractors), [
  'Build_ConveyorAttachmentSplitter_C', 'Build_ConveyorAttachmentSplitterSmart_C', 'Build_ConveyorAttachmentSplitterProgrammable_C',
  'Build_ConveyorAttachmentMerger_C', 'Build_ConveyorAttachmentMergerPriority_C',
  'Build_StorageContainerMk1_C', 'Build_PipeStorageTank_C', 'Build_PipelineJunction_Cross_C',
  'Build_FrackingSmasher_C', 'Build_ResourceSink_C'
]));
for (const c of classesOf(/FGRecipe'/)) {
  if (!/BuildGun/.test(c.mProducedIn || '')) continue;
  const out = parseAmounts(c.mProduct);
  if (out.length !== 1) continue;
  const build = out[0][0].replace(/^Desc_/, 'Build_');
  if (!costed.has(build) || buildCosts[build]) continue;
  const cost = parseAmounts(c.mIngredients);
  cost.forEach(([id]) => {
    if (!items[id] && allItems.get(id)) {
      const it = allItems.get(id);
      items[id] = { name: it.name, form: it.form };
    }
  });
  buildCosts[build] = cost;
}

const data = {
  source: path.basename(src),
  build: version,
  gameVersion: gameVersion,
  generated: new Date().toISOString().slice(0, 10),
  items,
  recipes,
  defaults,
  machines,
  extractors,
  logistics,
  buildCosts
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
