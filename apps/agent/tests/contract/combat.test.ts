import { expect, it } from '@effect/vitest';
import { Exit, Schema } from 'effect';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
import {
  combatInput,
  inspectionParseOptions,
  inspectionSchema,
} from '../../src/contract/game-inspection.ts';

it('combat schema defaults to the latest death and bounds reads', () => {
  expect(Schema.decodeUnknownSync(combatInput)({})).toEqual({
    view: 'deaths',
    deaths: 1,
    includeGroup: false,
    eventLimit: 20,
  });
  const request = { kind: 'combat', args: { view: 'fight' } };
  const inspection = Schema.decodeUnknownExit(inspectionSchema)(
    request,
    inspectionParseOptions('combat'),
  );
  expect(Exit.isSuccess(inspection)).toBe(true);
  for (const input of [
    { deaths: 6 },
    { eventLimit: 31 },
    { view: 'recent' },
    { includeGroup: 'yes' },
    { unit: 'target' },
  ]) {
    const decoded = Schema.decodeUnknownExit(combatInput)(input, rejectUnknownKeys);
    expect(Exit.isFailure(decoded), JSON.stringify(input)).toBe(true);
  }
});
