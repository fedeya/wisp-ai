import type { ClassAdapter } from './types.ts';
export const druid: ClassAdapter = {
  token: 'DRUID',
  engineClass: 'ClassDruid',
  spec: 'balanceDruid',
  resource: 'mana',
  dots: ['Moonfire'],
  families: ['Wrath', 'Starfire', 'Moonfire'],
  assumptions: [
    'Caster damage adapter; the engine activates Moonkin Form when the applied talents unlock it. No feral attacks.',
  ],
};
