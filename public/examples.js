/* Starter plans, shown on the empty canvas.
 *
 * Each one is just a set of outputs; the solver works out the rest. Item ids
 * are the game's class names, as listed in data.js. Outputs marked max make
 * as much as the resource nodes allow (one normal node each, unless changed).
 *
 *   {
 *     name:    'Motor',                                  // tile heading
 *     note:    'Iron and copper',                        // one short line under it
 *     targets: [{ item: 'Desc_Motor_C', max: true }]     // or { item, rate } per minute
 *   }
 */

window.SF_EXAMPLES = [
  {
    name: 'Reinforced Iron Plate',
    note: 'All iron',
    targets: [{ item: 'Desc_IronPlateReinforced_C', max: true }]
  },
  {
    name: 'Modular Frame',
    note: 'Iron, with screws',
    targets: [{ item: 'Desc_ModularFrame_C', max: true }]
  },
  {
    name: 'Motor',
    note: 'Iron and copper',
    targets: [{ item: 'Desc_Motor_C', max: true }]
  },
  {
    name: 'Encased Industrial Beam',
    note: 'Steel and concrete',
    targets: [{ item: 'Desc_SteelPlateReinforced_C', max: true }]
  },
  {
    name: 'Computer',
    note: 'First oil',
    targets: [{ item: 'Desc_Computer_C', max: true }]
  },
  {
    name: 'Plastic + Rubber',
    note: 'Equal amounts, with byproducts',
    targets: [
      { item: 'Desc_Plastic_C', max: true },
      { item: 'Desc_Rubber_C', max: true }
    ]
  }
];
