// Records today's Effect migration counts as the new baseline:
// `pnpm --filter @wisp/tests effect:baseline`.
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect } from 'effect';
import { Command } from 'effect/cli';
import { scoreboard, writeBaseline } from './effect-migration.ts';

const baseline = Command.make('effect:baseline', {}, () =>
  Effect.flatMap(scoreboard(), writeBaseline),
).pipe(Command.withDescription("Record today's Effect migration counts as the new baseline"));

baseline.pipe(
  Command.run({ version: '1.0.0' }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
