import { expect, it } from '@effect/vitest';
import { Exit, Schema } from 'effect';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
import {
  chatHistoryInput,
  inspectionParseOptions,
  inspectionSchema,
} from '../../src/contract/game-inspection.ts';

const decodeChat = (input: unknown) =>
  Schema.decodeUnknownExit(chatHistoryInput)(input, rejectUnknownKeys);

it('chat schema validates bounded reads', () => {
  expect(Schema.decodeUnknownSync(chatHistoryInput)({})).toEqual({
    channels: [],
    limit: 30,
    lastSeconds: 1800,
  });
  const request = { kind: 'chat', args: { channels: ['raid'] } };
  const inspection = Schema.decodeUnknownExit(inspectionSchema)(
    request,
    inspectionParseOptions('chat'),
  );
  expect(Exit.isSuccess(inspection)).toBe(true);
  for (const input of [{ limit: 51 }, { lastSeconds: 1801 }, { channels: ['addon'] }]) {
    expect(Exit.isFailure(decodeChat(input)), JSON.stringify(input)).toBe(true);
  }
});
