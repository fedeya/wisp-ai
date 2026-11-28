import { expect, it } from '@effect/vitest';
import { Exit, Schema } from 'effect';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
import { databaseEntity, databaseRequest, databaseSearch } from '../../src/contract/database.ts';
import { rpcRequests, rpcResponses } from '../../src/contract/agent-rpc.ts';

const strict = <S extends Schema.Codec<unknown, unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownExit(schema);
  return (input: unknown) => decode(input, rejectUnknownKeys);
};
const search = strict(databaseSearch);
const entity = strict(databaseEntity);
const request = strict(databaseRequest);

it('database searches trim the query and fill the page and limit', () => {
  expect(search({ kind: 'spell', query: '  Frost Nova ' })).toEqual(
    Exit.succeed({ kind: 'spell', query: 'Frost Nova', page: 1, limit: 10 }),
  );
  expect(search({ kind: 'item', query: 'x', page: 200, limit: 20 })).toEqual(
    Exit.succeed({ kind: 'item', query: 'x', page: 200, limit: 20 }),
  );
});

it('database requests are strict and bound their fields', () => {
  for (const input of [
    { kind: 'spell', query: '   ' },
    { kind: 'spell', query: 'x'.repeat(65) },
    { kind: 'spell', query: 'x', page: 0 },
    { kind: 'spell', query: 'x', page: 201 },
    { kind: 'spell', query: 'x', limit: 21 },
    { kind: 'spell', query: 'x', limit: 1.5 },
    { kind: 'retail', query: 'x' },
    { kind: 'spell', query: 'x', version: 'retail' },
  ]) {
    expect(Exit.isFailure(search(input)), JSON.stringify(input)).toBe(true);
  }
  // The query's bounds hold after trimming.
  expect(Exit.isSuccess(search({ kind: 'spell', query: ' ' + 'x'.repeat(64) + ' ' }))).toBe(true);
  expect(entity({ kind: 'npc', id: Number.MAX_SAFE_INTEGER })).toEqual(
    Exit.succeed({ kind: 'npc', id: Number.MAX_SAFE_INTEGER }),
  );
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    expect(Exit.isFailure(entity({ kind: 'npc', id })), String(id)).toBe(true);
  }
});

it('a database request is a search or a get, told apart by its operation', () => {
  expect(request({ operation: 'get', kind: 'quest', id: 7 })).toEqual(
    Exit.succeed({ kind: 'quest', id: 7, operation: 'get' }),
  );
  expect(request({ operation: 'search', kind: 'quest', query: 'Kobold' })).toEqual(
    Exit.succeed({ kind: 'quest', query: 'Kobold', page: 1, limit: 10, operation: 'search' }),
  );
  for (const input of [
    { kind: 'quest', id: 7 },
    { operation: 'get', kind: 'quest', query: 'Kobold' },
    { operation: 'search', kind: 'quest', id: 7 },
    { operation: 'list', kind: 'quest' },
  ]) {
    expect(Exit.isFailure(request(input)), JSON.stringify(input)).toBe(true);
  }
});

it('the database RPC request adds the agent session after the request', () => {
  const decoded = rpcRequests.database.parse({
    agentSession: 'session',
    operation: 'search',
    kind: 'spell',
    query: ' Frost Nova ',
  });
  expect(JSON.stringify(decoded)).toBe(
    '{"kind":"spell","query":"Frost Nova","page":1,"limit":10,"operation":"search","agentSession":"session"}',
  );
  expect(() =>
    rpcRequests.database.parse({ agentSession: '', operation: 'get', kind: 'spell', id: 1 }),
  ).toThrow('Expected a value with a length of at least 1');
});

it('the RPC readings accept any object and drop an own __proto__ key, as zod did', () => {
  const reading = rpcResponses.database.parse(JSON.parse('{"__proto__":{"x":1},"results":[]}'));
  expect(Object.keys(reading)).toEqual(['results']);
  expect(Object.getPrototypeOf(reading)).toBe(Object.prototype);
  for (const value of [null, [], 'text', 1]) {
    expect(() => rpcResponses.routines.parse(value), JSON.stringify(value)).toThrow();
  }
});
