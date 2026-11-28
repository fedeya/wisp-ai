import { expect, it } from '@effect/vitest';
import { Exit, Schema } from 'effect';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
import { npcLocationsInput } from '../../src/contract/game-inspection.ts';

const decode = (input: unknown) =>
  Schema.decodeUnknownExit(npcLocationsInput)(input, rejectUnknownKeys);

it('NPC lookup inputs remain bounded and cannot select a different database version', () => {
  const services = decode({ mode: 'services', service: 'Transmogrifier', mapId: 1454 });
  expect(Exit.isSuccess(services)).toBe(true);
  const trainers = decode({ mode: 'class_trainers', class: 'MAGE', mapId: 1454 });
  expect(Exit.isSuccess(trainers)).toBe(true);
  for (const input of [
    {},
    { npcId: 0 },
    { mode: 'services' },
    { mode: 'services', service: 'invented' },
    { name: '' },
    { name: 'Deino', version: 'classic' },
    { mode: 'class_trainers', limit: 10000 },
  ]) {
    expect(Exit.isFailure(decode(input)), JSON.stringify(input)).toBe(true);
  }
});
