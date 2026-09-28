# Satisfunction — Satisfactory Production Planner

A visual production planner for Satisfactory. Say what you want to make and how
fast, and it works out every step behind it and lays the chain out on a canvas,
left to right from raw resources to finished parts.

Built on the GCL board shell: same dark canvas, pan and zoom, curved wires,
menus and undo history. Static site, no build step, no dependencies at runtime.

## Running it locally

Any static file server pointed at `public/` works. With Python:

```bash
python -m http.server 8790 --directory public
```

Then open http://localhost:8790. Or, matching GCL, through Wrangler:

```bash
npm install
```

```bash
npm run dev
```

## Deploying it for free

Same as GCL. Cloudflare Pages serves `public/` as-is:

```bash
npx wrangler pages deploy
```

## Game data

`public/data.js` is generated from the game's own data dump, which ships with
every install at `CommunityResources/Docs/en-US.json`. The current file was
built from **rel-main-anniversary-2026, CL 502094**.

After a game update, regenerate it:

```bash
npm run data
```

That runs `tools/extract-data.mjs`, which finds the Steam or Epic install on
its own. Pass a path to use a different `en-US.json`.

The extractor keeps every recipe made in a production building (seasonal
FICSMAS recipes are left out), all items they touch, and each building's power
draw and footprint. Fluid amounts are converted from litres to m³. Footprints
are the union of each building's solid clearance boxes: a Constructor is
8 × 10 m, a Smelter 5 × 10 m, a Manufacturer 18 × 20 m. The machine view draws
buildings at those sizes.

### Default recipes

Every item gets one default recipe, chosen by these rules:

1. A recipe that only makes the item as a byproduct is never the default when
   anything else will do. Asking for Heavy Oil Residue doesn't build a plastic
   plant.
2. Standard recipes beat alternates.
3. Converters come near last, and unpackaging comes after alternates, since
   unpackaging needs the packaged item, which is made from the fluid in the
   first place.
4. The recipe named after the item wins ties.

Five items have no standard recipe, so their default is an alternate:
Heavy Oil Residue, Polymer Resin, Compacted Coal, Dissolved Silica and
Portable Miner.

## How the solver works

`public/solver.js`. It has no DOM code, so it also runs under Node.

Each item made in the factory uses exactly one recipe: yours or the default.
That gives one balance equation per item and one unknown per recipe (how many
machines' worth it runs). The system is square, so the solver solves it
directly with Gaussian elimination. This handles cases that a simple walk
down the recipe tree gets wrong:

- **Byproducts are credited.** Water from Aluminum Scrap cuts the water you
  have to pump. Heavy Oil Residue from plastic feeds Residual Fuel without a
  separate residue recipe.
- **Loops balance.** Recycled Plastic and Recycled Rubber feeding each other
  settle at the right rates.
- **Overshoot is handled.** A byproduct can come off faster than anything uses
  it. The item's own recipe would then have to run backwards, so the solver
  drops that recipe, marks the extra as spare, and solves again.

Inputs the factory doesn't make are supplied from outside: mined, pumped, or
imported. When several sources feed one item, each consumer draws from them in
proportion, the way a merged belt delivers. Each output is a consumer in its
own right, with its own line. Asking for 10 rods and some screws keeps 10 rods
and only sends the rest to the screw line.

### Max outputs and resource nodes

A raw input starts on **one normal node**, which caps it. It can be tied to
other resource nodes instead (impure, normal or pure, as many as you like), or
set to **any node**, which supplies whatever the plan needs. Miners give 30/60/120 per minute on
impure/normal/pure nodes for Mk.1, twice that for Mk.2, and four times for
Mk.3. Oil Extractors and resource wells work the same way. Water Extractors go
anywhere, so water is never capped.

New outputs start on **max**; click the unit to set a fixed rate instead.
Outputs set to max share one unknown rate. The system is linear, so every
recipe's rate is a fixed part plus that rate times a max part, and so is the
draw on every raw input. The solver takes the largest rate that keeps every
capped input within its nodes. Several max outputs all get the same rate. If
nothing capped is involved, the plan says so rather than going to infinity.

### Clocks and power

When a step needs part of a machine, the Plan panel chooses how to split it:
**100% (Default)**, which new factories start on (nothing clocked: 2.5 machines' worth → 3 at 100%, the last
idling half the time, drawing power only while it works),
**Spread evenly** (2.5 machines' worth → 3 at 83.33%, least power),
**Underclock last** (2 at 100% and 1 at 50%) or **Overclock** (fewest
machines: 1 at 250%, spread evenly over as few as can take it). Overclocking
stops short of 250% where one machine's belt or pipe couldn't keep up at the
fastest tier allowed, and the Machines list counts the Power Shards it takes
(one per 50% over 100%). Miners on resource nodes stay at 100% or below.
Power is the average draw per building, at
clock^1.32 of full power, so the choice changes the total. Particle
Accelerators, Converters and Quantum Encoders use each recipe's average draw.
Miners and extractors are counted once their nodes are known.

## Picking recipes

The Plan panel's **Recipes** switch decides who picks.

**I pick.** Every item uses its standard recipe unless you pick another on its
node. The solver above does the rest.

**Optimise.** A linear program (`public/lp.js`, a two-phase simplex) picks
recipe rates for you, and redoes it on every change, in tens of milliseconds.
Every allowed recipe becomes a variable. Every item gets a row requiring that
what's made of it, plus what comes in from outside, covers what's used and
asked for. It then solves three times, each holding on to the last result:

1. Least shortfall, for fixed outputs the resource nodes can't cover.
2. Most output: every max output as high as it goes.
3. The goal you pick: **Fewest machines**, **Fewest resources** (weighted
   by the game's sink points, which track rarity; water is free), or **Least
   power**.

Its answer is used as it is, so it can do what one recipe per item can't: make
screws partly from iron and partly from steel, or run a recipe purely for its
byproduct. With every alternate it takes a Motor from 1.9/min to 61/min on the
default nodes.

- **Alternates.** A searchable, ticked list in the panel that folds away
  from its heading, with **All** and **None** to tick or clear the lot. Only
  ticked alternates are used, and Converter recipes count as unlockable too. Items with no standard recipe (Heavy Oil Residue, Polymer
  Resin, Compacted Coal…) always keep their game default.
- **Pins.** Picking a recipe on a node pins it: the optimiser has to make that
  item that way. **Let the optimiser choose** unpins it.
- **Hand-gathered things.** Power slugs, leaves and creature parts, and waste
  from power generators, are held back and only used when a chain can't do
  without them, or makes at least a quarter more with them. So optimising
  never does worse than picking by hand.
- **Robustness.** The solver rebuilds its tableau from the original rows every
  50 pivots, nudges right-hand sides to break degeneracy, and checks its
  answer against the original rows before trusting it. If it ever can't
  settle a plan, the plan falls back to your own picks and says so. It's
  tested on every craftable item as a max output, with each goal and
  alternate setting (780 runs): none fail, none do worse than picking by hand,
  and the slowest takes about 0.1 s.

The solver also accepts a recipe mix for an item (`{ recipeId: share }`),
which saved and imported plans keep.

## Using it

| Action | How |
| --- | --- |
| Add an output | **+ Add output**, then type to search |
| Set its rate | Type in the Plan panel; the plan re-solves as you type. 0 keeps it listed but makes none |
| Make as much as possible | Outputs start on **max**; click **max** / **/min** to switch |
| Choose a node's purity and miner | Click "Normal node · Mk.1" on an ore, oil or gas block |
| Add another resource node | The tall **+** down the left of the block, in the Items view. Each node is its own block with its own purity and miner; **Remove this node** is in its menu |
| Save now | **Ctrl+S** (or the ring beside the save's name) |
| Manifold or balancer | **Manifold** / **Balancer** in the header, in the Machines view |
| Buildings you don't have yet | Untick them under **Machines** in the Plan panel |
| Labels on the canvas | The sliders button, top right: resource names, rates, two-letter building names |
| See every building | **Machines** in the header; **Items** goes back to one card per step |
| Change a recipe | Click the machine line on a node (e.g. "Smelter ×2") |
| Import an item instead of making it | Same menu, **Import from elsewhere** |
| Move a node | Drag it (Items view). It stays put through re-solves; a dot marks it pinned |
| Unpin one | Right-click it, **Unpin** |
| Unpin everything | Right-click the canvas, **Tidy layout** |
| Fit the plan to the window | Click the zoom percentage |
| Pan / zoom | Drag the background / scroll |

The plan panel is a rounded panel of its own, running the full height to the
right of the canvas; the tabs and toolbar stop where the canvas does. It has
three pages: **Details** (everything below); **Overview** (resources from the
map and brought in, production and spare, machines and Power Shards, power split
between making and extracting, and alternate recipes in use); and **Power**
(every step and extractor drawing power, biggest first with a bar for its
share, and the total). Items / Machines and Manifold / Balancer each act as one
toggle: pressing the side that's already on flips to the other. Factory names in
a save are kept distinct: a clash gets the next number ("New factory 2",
"Motor 3"). It boxes Inputs, Outputs, Machines, recipe settings and layout
settings; the first three fold away from their heading. Machines lists every
building with a tick for the ones you have. Unticking one re-plans without it:
another recipe stands in where one exists (standard first, then unlocked
alternates, then any), miners drop to the next mark down, and anything only
that building makes is brought in and flagged "no <building>". The whole app is
set in Space Grotesk.

Hovering a node lights up its own lines and fades the rest. Outputs are tinted
green.

### Layout

Columns run left to right. Each node goes as far left as its inputs allow, then
anything that feeds something slides right to sit just before its first user.
So an output stops right after the step that makes it: kept rods sit level with
the screw constructors, not at the far edge. Lines that skip columns get a
waypoint in each column they pass through, so they route between nodes rather
than over them. Rows are ordered to cut crossings (barycentre sweeps, then
swapping neighbours while that removes crossings), and each node is placed level
with what it connects to.

### Machine view

The build itself: every building, splitter, merger and belt at its real size,
where it would go, fed by manifolds or balancers. It can't be edited or
rearranged. Recipes, nodes and positions are all set in the Items view, and
dragging anywhere pans.

- **Scale.** Everything is measured in metres and drawn at 8 px to the metre,
  on whole metres. The canvas grid marks the corners of 8 m foundations, and
  columns start on foundation lines.
- **Buildings.** Each is drawn on its own at its in-game footprint, tinted
  orange, with what it makes and its clock speed. There are no containers
  around a step's machines.
- **Manifolds.** A step's machines stand in a line with belts running through
  them left to right. Each input belt arrives above the first machine and runs
  down beside the line: a splitter feeds each machine, and the belt's end turns
  into the last one. Outputs merge in machine by machine and leave below the
  last one. A single machine is fed straight, with no manifold.
- **Balancers.** Switch to **Balancer** and each line's inputs arrive on a tree
  of splitters instead, so every machine gets exactly the same share. Splitters
  go two or three ways, so a tree reaches 2^a·3^b outputs (2, 3, 4, 6, 8, 9,
  12…). For any other count it's built for the next such number up, and the
  spare outputs loop back underneath to a merger at the tree's start: five
  machines on a 1→6 with one looped back. Hovering the first splitter says
  which. Each splitter sits level with the middle of what it feeds, nudged
  clear of belts running past from other inputs' trees. Outputs still merge on
  a manifold, since merging needs no balancing. The looped-back share rides
  the input belt twice, which counts toward the belt limit.
- **Real parts.** Splitters (**S**) and mergers (**M**) are 4 m square. On
  pipes the same jobs are done by Pipeline Junctions, round and 2.4 m, as in
  the game.
- **Belts.** Drawn light grey, about a metre wide, with rounded corners.
- **Between lines.** Belts run on real routes: out of a port, along a vertical
  track in the gap between columns, and into the next port. Each belt in a gap
  gets its own track, ordered to cut crossings, and each gap is as wide as its
  tracks need. A splitter sends belts out its front and both sides and a merger
  takes them in at its back and both sides, each side facing where its belt
  goes. Where one belt crosses another, it's drawn passing over.
- **Straight belts.** Before routing, kinks are taken out: a building moves up
  or down a little (up to 4 m, never into anything) where that lets more of
  its belts run level, and a belt passing through several columns keeps one
  height as long as it can, so it changes height once where possible. A belt
  off a splitter's or merger's side can run further out before it turns
  rather than turning twice.
- **Belt limits.** The Plan panel sets the fastest belt (Mk.1–6) and pipe
  (Mk.1–2) the build may use. A step whose manifold would need more is split
  into parallel lines. An item that needs more than one belt between steps
  runs on several, with sources paired to users so no belt goes over the
  limit. Every belt is labelled with its rate and the slowest tier that
  carries it. A single machine that puts out more than the limit (an Aluminum
  Scrap refinery, say) is flagged.
- **Storage.** Each output ends in real storage at its real size: a Storage
  Container (11 × 5 m) for items, a Fluid Buffer (6 × 6 m) for fluids, tinted
  green. A container takes one belt, so an output arriving on several belts
  gets one container per belt. Unused byproducts go to an AWESOME Sink
  (14 × 16 m), or a Fluid Buffer for fluids.
- **Starts.** Raw resources without nodes set, and imports, are compact
  markers. Miners and extractors appear as buildings once a resource has nodes
  set, and water always shows its extractors.

Belts are drawn as solid lines and pipes as hollow double lines. Each line is
labelled with its rate, plus the item name when the source makes more than one
thing.

### Saves and factories

Work is kept as **main saves**, each holding **factories**. A save is one game:
what you've unlocked (ticked alternates, the buildings you have, the fastest
belt and pipe, the miner new resources start on) is shared by all its
factories. A factory is one production line with its own outputs, recipes,
resource nodes, clocks and view.

- The dark orange header holds the save's name (type to rename) and four
  buttons: **save** (a dim ring while changes wait, a green tick once
  written; changes also save themselves a moment after each edit),
  **browse** (every save in a scrolling list to open or delete, and **New
  save**), **import** and **export**.
- Factories are tabs over the top left of the canvas: **+** adds one,
  double-click renames, drag sideways to reorder, right-click for more,
  **×** deletes.
- The toolbar under the tabs runs the width of the app: undo and redo,
  Rename, Duplicate, Export, Import, Clear and Delete for the open factory on
  the left; under **View** on the right, Items / Machines, Manifold / Balancer
  (greyed out in the Items view) and zoom.
- Every dropdown closes again when its own button is clicked.
- **Import** takes either kind of file: a save file comes in as a new save, a
  factory file (or an export from before saves existed) as a new tab.
- Undo history belongs to the open factory and starts fresh on switching.

Everything saves automatically to `localStorage` under
`satisfunction.saves.v1`. A plan kept under the older `satisfunction.plan.v1`
becomes the first factory of "My save".

## Layout

```
public/            static site (no build step)
  index.html
  styles.css
  app.js           canvas, nodes, menus, panel
  solver.js        rates and flows; no DOM, runs under Node
  lp.js            linear-programming solver (two-phase simplex)
  optimise.js      recipe optimiser, built on lp.js; same output as solver.js
  data.js          generated from the game — don't edit by hand
  examples.js      starter plans on the empty canvas
tools/
  extract-data.mjs game Docs JSON -> public/data.js
wrangler.toml
```

## Roadmap

1. ~~Recipe data and solver, item-flow view~~
2. ~~Machine view: each step expanded into its real buildings at real
   footprints, with clock speeds; max outputs; resource node purity~~
3. ~~Manifold logistics: every machine, splitter, merger and belt at real
   size and position; belt limits with parallel lines; foundation grid~~
4. ~~Load-balancer logistics as an alternative, with loop-backs for machine
   counts that don't balance cleanly (5, 7, …)~~
5. ~~Choosing recipes by optimisation; outputs into real storage~~
   (Collapsible machine banks were dropped: the Items / Machines switch
   already shows every step either collapsed or expanded, all at once.)
