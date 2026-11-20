import type { ClassAdapter } from './types.ts';
export const mage: ClassAdapter = {
  token: 'MAGE',
  engineClass: 'ClassMage',
  spec: 'mage',
  resource: 'mana',
  areaRanges: { FrostNova: 10, ArcaneExplosion: 10 },
  dots: ['Fireball'],
  families: [
    'Frostbolt',
    'Fireball',
    'FireBlast',
    'ArcaneMissiles',
    'FrostNova',
    'ArcaneExplosion',
  ],
  channels: ['ArcaneMissiles'],
  wand: true,
  assumptions: ['The engine applies level-scaled Arcane Intellect automatically.'],
};
