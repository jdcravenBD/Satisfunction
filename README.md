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

A raw input can be left as **any node**, supplying whatever the plan needs. It
can also be tied to specific resource nodes (impure, normal or pure, as many as
you like), which caps it. Miners give 30/60/120 per minute on
impure/normal/pure nodes for Mk.1, twice that for Mk.2, and four times for
Mk.3. Oil Extractors and resource wells work the same way. Water Extractors go
anywhere, so water is never capped.

Outputs set to **max** share one unknown rate. The system is linear, so every
recipe's rate is a fixed part plus that rate times a max part, and so is the
draw on every raw input. The solver takes the largest rate that keeps every
capped input within its nodes. Several max outputs all get the same rate. If
nothing capped is involved, the plan says so rather than going to infinity.

### Clocks and power

When a step needs part of a machine, the Plan panel chooses how to split it:
**Spread evenly** (2.5 machines' worth → 3 at 83.33%) or **Underclock last**
(2 at 100% and 1 at 50%). Power is the average draw per building, at
clock^1.32 of full power, so the choice changes the total. Particle
Accelerators, Converters and Quantum Encoders use each recipe's average draw.
Miners and extractors are counted once their nodes are known.

## Using it

| Action | How |
| --- | --- |
| Add an output | **+ Add output**, then type to search |
| Set its rate | Type in the Plan panel; the plan re-solves as you type. 0 keeps it listed but makes none |
| Make as much as possible | Click an output's **/min** to switch it to **max** |
| Choose resource nodes | Click "Mined · any node" on an ore, oil or gas node |
| See every building | **Machines** in the header; **Items** goes back to one card per step |
| Change a recipe | Click the machine line on a node (e.g. "Smelter ×2") |
| Import an item instead of making it | Same menu, **Import from elsewhere** |
| Move a node | Drag it (Items view). It stays put through re-solves; a dot marks it pinned |
| Unpin one | Right-click it, **Unpin** |
| Unpin everything | Right-click the canvas, **Tidy layout** |
| Fit the plan to the window | Click the zoom percentage |
| Pan / zoom | Drag the background / scroll |

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

A picture of the build, following a manifold layout. It can't be edited or
rearranged: recipes, nodes and positions are all set in the Items view, and
dragging anywhere pans.

- **Blocks.** Each step is a block of its buildings, tinted orange and drawn
  top-down at their in-game footprints (8 px to the metre) with their clock
  speeds.
- **Manifolds.** Each input comes in at the block's top left and runs down a
  belt beside the machines. A splitter feeds each machine, and the belt's end
  feeds the last one. Outputs merge onto a belt on the right, which leaves at
  the bottom right. Pipes use junctions (circles) instead of splitters and
  mergers.
- **Ports.** Any input port takes any input, so items are matched to ports in
  the order their belts arrive from. That keeps belts from crossing at the
  block.
- **Between blocks.** Every item runs on one belt. Mergers join several sources
  and splitters share it between several users, chaining past three. Unused
  byproducts run to a **Spare** end.
- **Belt tiers.** Each belt is labelled with the slowest belt or pipe that
  carries it (belts Mk.1–6: 60, 120, 270, 480, 780 and 1,200/min; pipes Mk.1–2:
  300 and 600 m³/min). Anything faster is flagged.
- **Extractors.** Miners and extractors appear as blocks once a resource has
  nodes set. Water always shows its extractors.

Belts are drawn as solid lines and pipes as hollow double lines. Each line is
labelled with its rate, plus the item name when the source makes more than one
thing.

Plans save automatically to `localStorage` under `satisfunction.plan.v1`.
**Export** writes a JSON file and **Import** reads one back.

## Layout

```
public/            static site (no build step)
  index.html
  styles.css
  app.js           canvas, nodes, menus, panel
  solver.js        rates and flows; no DOM, runs under Node
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
3. ~~Manifold logistics: splitters and mergers wired to every machine, with
   belt tiers~~
   Still to do: splitting a manifold that's over one belt's capacity into
   parallel lines, and snapping blocks to the 8 m foundation grid
4. Load-balancer logistics as an alternative, including advice for machine
   counts that don't balance cleanly (5, 7, …)
5. Collapsible machine banks, and choosing recipes by optimisation
