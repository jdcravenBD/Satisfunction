# Satisfunction

A visual production planner for Satisfactory. Pick what you want to make, and
it works out every step behind it and lays the whole chain out on a canvas,
from raw resources on the left to finished parts on the right.

Most planners stop at "Iron Ore → Iron Ingot → Iron Rod". Satisfunction also
shows the machines: how many Constructors, at what clock speed, and in the
Machine view, every building, splitter, merger and belt at its real in-game
size.

## Features

- **Model:** where a factory is made, much like Satisfactory Modeler. Drag
  items onto the canvas (a resource, or a part to make); each becomes a card
  showing its building and its items' icons at the inputs and outputs. Join an
  output to an input by dragging, or drop a line on empty space to pick what
  could use (or make) its item. Each step's machine count is worked out for
  you, from what flows in or from what a step you've Set asks for. Splitters
  share evenly and Priority Mergers take from their top input first.
- **Sushi belts and filters:** merge different items onto one belt and it
  carries the mix, item by item. A machine takes any of its ingredients from
  a mixed belt through any input, and a mixed belt jams, as in the game, when
  it brings more of one item than the machine uses. Smart and Programmable
  Splitters sort items with the game's rules per output: an item, Any, Any
  Undefined, Overflow or None (a Programmable Splitter takes several).
- **Hover hints:** point at any item's icon for its name and rate.
- **Build and Optimize:** add an output and the model's chain is built for it.
  Optimize rebuilds the machines between your outputs and inputs with the
  optimiser's pick of recipes (fewest machines, fewest resources or least
  power, from the alternates you've unlocked); Build does the same with the
  standard recipes and the ones you've picked. The button reads Reoptimize (or
  Rebuild) once something it depends on has changed. Anything no ticked building can
  make is brought in instead, with a warning saying which building it needs.
- **Item view:** the model as one card per recipe, with rates on every line.
- **Machine view:** the model as it would be built, laid out on an 8 m
  foundation grid, fed by manifolds or load balancers, with belts and pipes
  split to fit the fastest tier you've unlocked. Long manifolds fold into
  compact blocks, and belts that skip several steps run on a bus above or
  below the factory.
- **Floors:** give machines, resources and inputs a floor (in Details, or
  right-click) and the Machine view stacks the floors like the building,
  with a lift wherever a belt goes up or down. Show every floor, or one.
- **Inputs from elsewhere:** "+ Add input" under Inputs, or right-click a
  machine and "Bring in instead", swaps what made an item for an Import.
- **Resources per factory:** switch off any resource under Recipes and
  Optimize does without it.
- **Byproducts:** spare solids go to an AWESOME Sink (with its points), and
  Optimize and Build use up fluid byproducts, which the game can't sink.
- **Resource nodes:** each has its own purity and miner.
- **Clock speeds:** everything at 100%, spread evenly, underclock the last
  machine, or overclock with Power Shards.
- **Copy and paste:** Ctrl+C, X and V, across factories too.
- **Clock speeds and Somersloops per machine:** give any step its own clock
  (1–250%, with the Power Shards it takes) or Somersloops in each machine
  (more output, at the game's squared power cost).
- **Factories feeding each other:** an Import can come from another factory
  in the same save. It shares what that factory makes, and the source
  factory lists what it sends where.
- **Build cost:** everything the buildings take to place, on the Overview.
- **Notes and a pencil:** sticky notes and freehand drawing on the model.
- **Saves and factories:** each save is one game, holding any number of
  factories as tabs. Export and import either.
- **Overview and Power pages:** resources, production, machine counts,
  alternates in use, and an itemised power breakdown.
- **Settings:** the gear at the top right. Light mode, kept in your browser.

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
| Connect | Drag from an output to an input, or onto empty space for a menu |
| Change a card | Select it; its settings show in the panel |
| Select | Click, **Ctrl+click** to add, **Shift/Ctrl+drag** for a box |
| Copy / cut / paste | **Ctrl+C** / **Ctrl+X** / **Ctrl+V** |
| Remove | **Delete**, or right-click |
| Undo / redo | **Ctrl+Z** / **Ctrl+Y** |
| Save | **Ctrl+S** (it also saves on its own) |

## How it works

- `solver.js` gives every item one recipe and solves the balance of all of
  them at once, so byproducts are credited and loops settle. Max outputs are
  found from the resource node caps.
- `optimise.js` sets the recipe choice up as a linear program and solves it
  with its own simplex solver in `lp.js`.
- In the model, demand from Set steps is passed upstream first, then items
  are pushed forward from the resources: each step takes what it needs (or,
  left on Auto, grows to use what it's given).
- The Item and Machine views solve the model's own plan (its outputs, inputs
  and recipes) and lay it out: `js/layout.js` places the graph in columns,
  cutting line crossings, and `js/machines.js` builds the Machine view from
  it: machine lines, manifolds or balancer trees, and belt routing between
  columns.

None of the solving code touches the DOM, so it also runs under Node.

## Project layout

```
public/
  index.html
  styles.css
  js/              the app, as ES modules (no build step); main.js starts it
    core.js        the plan's state, game-data helpers, numbers
    store.js       saves and factories in localStorage
    history.js     undo and redo
    model.js       model cards: slots, splitter rules, line items
    flow.js        how items flow through the model
    cards.js       drawing model cards and lines
    inspector.js   the Details page
    build.js       Optimize and Build
    solve.js       the model worked out into a plan for the views
    layout.js      Item view layout
    machines.js    Machine view
    …              canvas, menus, panel, palette, notes, options, tips
  solver.js        rates and flows
  lp.js            linear program solver
  optimise.js      recipe optimiser
  data.js          generated game data (don't edit by hand)
  icons/           item and building icons (128 px), named by game ID
  examples.js      starter plans
tools/
  extract-data.mjs builds data.js from the game's Docs JSON
  build-offline.mjs builds the one-file offline version into dist/
```

## Offline and self-hosting

- **One file, no install:** download `satisfunction-offline.html` from the
  [Offline version release](https://github.com/jdcravenBD/Satisfunction/releases/tag/offline)
  and open it in your browser. Everything is inside it (icons, game data),
  so it needs no server and no internet. Its saves live in that browser,
  separate from the website's; Export and Import move them across. The
  release is rebuilt on every update.
- **Build that file yourself:** `npm run offline` (Node only, no packages
  needed) writes it to `dist/`.
- **Host your own copy:** `public/` is the whole site, static files with no
  build step. Serve it with anything, for example `npx serve public` or
  `python -m http.server -d public`. Opening `public/index.html` straight
  from disk won't work: browsers only load the app's modules from a server.

## Deploying

Cloudflare Pages serves `public/` as it is:

```bash
npx wrangler pages deploy
```

## Credits

Satisfactory and its game icons © Coffee Stain Studios. Icons via the
[Satisfactory Wiki](https://satisfactory.wiki.gg). Satisfunction is a fan
project and isn't affiliated with Coffee Stain.
