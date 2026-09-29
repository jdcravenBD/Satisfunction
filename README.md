# Satisfunction

A visual production planner for Satisfactory. Pick what you want to make, and
it works out every step behind it and lays the whole chain out on a canvas,
from raw resources on the left to finished parts on the right.

Most planners stop at "Iron Ore → Iron Ingot → Iron Rod". Satisfunction also
shows the machines: how many Constructors, at what clock speed, and in the
Machines view, every building, splitter, merger and belt at its real in-game
size.

## Features

- **Items view:** one card per step, with rates on every line. Drag cards
  around; they stay where you put them.
- **Machines view:** the build itself, laid out on an 8 m foundation grid, fed
  by manifolds or load balancers, with belts and pipes split to fit the fastest
  tier you've unlocked.
- **Recipes:** use the standard ones, pick your own per step, or let the
  optimiser choose (fewest machines, fewest resources or least power) from the
  alternates you've unlocked.
- **Resource nodes:** each node has its own purity and miner, and caps what the
  plan can make. Outputs can be a fixed rate or "as much as possible".
- **Clock speeds:** everything at 100%, spread evenly, underclock the last
  machine, or overclock with Power Shards.
- **Auto and Custom:** Auto generates the whole build from your outputs.
  Custom lets you place every building and part yourself from a parts panel,
  at real size on the foundation grid, turn them with **R**, and join their
  ports with belts and pipes by dragging from one port to another. Select a
  part to set its recipe, resource, node purity and clock speed; every belt
  shows its rate and tier, and a problems list flags anything unconnected,
  starved, jammed with the wrong item, or over a belt's limit.
- **Saves and factories:** each save is one game, holding any number of
  factories as tabs. Export and import either.
- **Overview and Power pages:** resources, production, machine counts,
  alternates in use, and an itemised power breakdown.

## Running it

It's a static site with no build step. Serve the `public/` folder:

```bash
python -m http.server 8790 --directory public
```

and open http://localhost:8790. Or with Wrangler:

```bash
npm install
```

```bash
npm run dev
```

## Game data

`public/data.js` is generated from the data dump that ships with the game, at
`CommunityResources/Docs/en-US.json`. The current file is from game version
1.2. After an update, regenerate it:

```bash
npm run data
```

This finds a Steam or Epic install on its own; pass a path to use a different
`en-US.json`.

## Controls

| | |
| --- | --- |
| Pan / zoom | Drag the background / scroll |
| Add an output | **+ Add output** in the Outputs box, or right-click the canvas |
| Change a recipe | Click the machine line on a card |
| Add a resource node | The **+** under a resource's lowest card |
| Select | Click, **Ctrl+click** to add, **Shift+click** for a range, **Ctrl/Shift+drag** for a box |
| Act on a selection | Right-click it, or **Delete** to remove |
| Undo / redo | **Ctrl+Z** / **Ctrl+Y** |
| Save | **Ctrl+S** (it also saves on its own) |

## How it works

- `solver.js` gives every item one recipe and solves the balance of all of
  them at once, so byproducts are credited and loops settle. Max outputs are
  found from the resource node caps.
- `optimise.js` sets the recipe choice up as a linear program and solves it
  with its own simplex solver in `lp.js`.
- In Custom, the build's rates come from one linear program over the placed
  parts: machines held to their recipe and clock, splitters and mergers
  balanced, belts within the fastest tier allowed.
- `app.js` lays out the graph in columns, cutting line crossings, and builds
  the Machines view from it: machine lines, manifolds or balancer trees, and
  belt routing between columns.

None of the solving code touches the DOM, so it also runs under Node.

## Project layout

```
public/
  index.html
  styles.css
  app.js           canvas, views, panels, saves
  solver.js        rates and flows
  lp.js            linear program solver
  optimise.js      recipe optimiser
  data.js          generated game data (don't edit by hand)
  icons/           item and building icons (128 px), named by game ID
  examples.js      starter plans
tools/
  extract-data.mjs builds data.js from the game's Docs JSON
```

## Deploying

Cloudflare Pages serves `public/` as it is:

```bash
npx wrangler pages deploy
```

## Credits

Satisfactory and its game icons © Coffee Stain Studios. Icons via the
[Satisfactory Wiki](https://satisfactory.wiki.gg). Satisfunction is a fan
project and isn't affiliated with Coffee Stain.
