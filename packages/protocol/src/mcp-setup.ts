// @effect-migrated
import { Effect, Schema } from 'effect';
import { RecordOf } from './checks.js';
// Shared by the agent's MCP manager and the desktop routes contract.
const reservedNames = [
  'external',
  'wow',
  'questie',
  'thewowdb',
  'wowhead',
  'web',
  'wowsims',
  'wisp',
  'constructor',
  'prototype',
  '__proto__',
];
export const mcpName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9_]{0,47}$/u),
  Schema.makeFilter((name) => !reservedNames.includes(name), { expected: 'an unreserved name' }),
);
const maxLength = (length: number) => Schema.String.check(Schema.isMaxLength(length));
function httpUrlWithoutCredentials(input: string) {
  const url = URL.parse(input);
  return (
    url !== null && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
  );
}
export const mcpDefinition = Schema.Struct({
  name: mcpName,
  description: maxLength(500).pipe(Schema.withDecodingDefault(Effect.succeed(''))),
  transport: Schema.Literals(['http', 'sse', 'stdio']).pipe(
    Schema.withDecodingDefault(Effect.succeed('http' as const)),
  ),
  url: Schema.optional(maxLength(2000)),
  command: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000))),
  args: Schema.Array(maxLength(2000))
    .check(Schema.isMaxLength(50))
    .pipe(Schema.withDecodingDefault(Effect.sync(() => []))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  tokenEnv: Schema.optional(maxLength(100)),
}).check(
  Schema.makeFilter((server) => {
    if (server.transport === 'stdio') {
      return server.command ? undefined : 'Command is required';
    }
    return httpUrlWithoutCredentials(server.url || '')
      ? undefined
      : 'Use an HTTP(S) URL without embedded credentials';
  }),
);
export const mcpSetup = Schema.Struct({
  server: mcpDefinition,
  token: Schema.optional(maxLength(10_000)),
  env: Schema.optional(
    RecordOf(Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u)), maxLength(10_000)),
  ),
});
