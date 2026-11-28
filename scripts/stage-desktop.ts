// @effect-migrated
// Stages the desktop app's payload with the deployed server, for development.
//   node scripts/stage-desktop.ts
import { Effect } from 'effect';
import { Command } from 'effect/cli';
import { runScript } from './run-script.ts';
import { stageTauri, stagingHttpClient } from './stage-tauri.ts';

if (import.meta.main) {
  Command.make('stage-desktop', {}, () => stageTauri()).pipe(
    Command.withDescription("Stage the desktop app's payload for development"),
    Command.run({ version: '1.0.0' }),
    Effect.provide(stagingHttpClient),
    runScript,
  );
}
