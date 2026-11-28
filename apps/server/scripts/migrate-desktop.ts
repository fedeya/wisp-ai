// @effect-migrated
// Imports a previous Wisp installation into this one, for Desktop's import
// command: `migrate-desktop.ts <previous installation folder>`, with this
// installation's data folder in WISP_DATA_DIR.
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Cause, Config, Console, Effect, Option } from 'effect';
import { Argument, Command } from 'effect/cli';
import * as HttpClient from '#/platform/http-client';
import { DesktopMigrationError, migrateDesktop } from '../src/migrations/desktop.ts';

/** A variable that is set and not empty. */
const nonEmpty = (name: string) =>
  Config.option(Config.String(name)).pipe(Config.map(Option.filter((value) => value !== '')));

const migrate = Command.make(
  'migrate-desktop',
  { source: Argument.String('source').pipe(Argument.optional) },
  Effect.fn(function* ({ source }) {
    const destination = yield* nonEmpty('WISP_DATA_DIR');
    const previous = Option.filter(source, (value) => value !== '');
    if (Option.isNone(previous) || Option.isNone(destination)) {
      return yield* new DesktopMigrationError({
        message: 'A previous installation folder and WISP_DATA_DIR are required.',
      });
    }
    yield* migrateDesktop({
      source: previous.value,
      destination: destination.value,
      localAppData: Option.getOrUndefined(yield* Config.option(Config.String('LOCALAPPDATA'))),
    });
    yield* Console.log('Imported Wisp chats, memory, configuration and protected credentials.');
  }),
);

migrate.pipe(
  Command.run({ version: '1.0.0' }),
  // Desktop shows what the import printed on stderr when it fails.
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) ? Effect.void : Console.error(Cause.pretty(cause)),
  ),
  Effect.provide([NodeServices.layer, NodeCrypto.layerDigest, HttpClient.layer]),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
