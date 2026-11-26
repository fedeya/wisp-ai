import type { ClassAdapter } from './types.ts';
export const shaman: ClassAdapter = {
  token: 'SHAMAN',
  engineClass: 'ClassShaman',
  spec: 'elementalShaman',
  resource: 'mana',
  dots: ['FlameShock'],
  families: ['LightningBolt', 'ChainLightning', 'EarthShock', 'FlameShock'],
  assumptions: ['Caster damage adapter; no totems or weapon imbues.'],
};
