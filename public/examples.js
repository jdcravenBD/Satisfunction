/* Starter plans, shown on the empty canvas.
 *
 * Each one is just a set of outputs; the solver works out the rest. Item ids
 * are the game's class names, as listed in data.js.
 *
 *   {
 *     name:    'Motor',                                  // tile heading
 *     note:    '5 / min',                                // one short line under it
 *     targets: [{ item: 'Desc_Motor_C', rate: 5 }]       // per minute
 *   }
 */

window.SF_EXAMPLES = [
  {
    name: 'Reinforced Iron Plate',
    note: '5 / min, all iron',
    targets: [{ item: 'Desc_IronPlateReinforced_C', rate: 5 }]
  },
  {
    name: 'Modular Frame',
    note: '5 / min',
    targets: [{ item: 'Desc_ModularFrame_C', rate: 5 }]
  },
  {
    name: 'Motor',
    note: '5 / min, iron and copper',
    targets: [{ item: 'Desc_Motor_C', rate: 5 }]
  },
  {
    name: 'Encased Industrial Beam',
    note: '6 / min, steel and concrete',
    targets: [{ item: 'Desc_SteelPlateReinforced_C', rate: 6 }]
  },
  {
    name: 'Computer',
    note: '2.5 / min, first oil',
    targets: [{ item: 'Desc_Computer_C', rate: 2.5 }]
  },
  {
    name: 'Plastic + Rubber',
    note: '30 / min each, with byproducts',
    targets: [
      { item: 'Desc_Plastic_C', rate: 30 },
      { item: 'Desc_Rubber_C', rate: 30 }
    ]
  }
];
