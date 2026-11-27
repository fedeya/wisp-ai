import { Clock, Context, Effect, FileSystem, Layer, Option, Path, Schema } from 'effect';
import type { GameEvent } from '@wisp/wow-bridge';
import { errorMessage } from '../errors.ts';

type InlineStatus = Extract<GameEvent, { type: 'inline_status' }>;

const milliseconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const FirstText = Schema.Struct({
  event: Schema.Literal('first_text'),
  messageId: Schema.String.check(Schema.isBetweenLength(1, 200)),
  totalMs: milliseconds,
  afterSendingMs: Schema.optionalKey(milliseconds),
});
const decodeFirstText = Schema.decodeUnknownOption(FirstText);

export class Service extends Context.Service<
  Service,
  { record: (packet: InlineStatus) => Effect.Effect<void> }
>()('@wisp/server/game/InlineDiagnostics') {}

export const layer = (runtime: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(runtime, 'inline-status.json');
      const record = Effect.fn('InlineDiagnostics.record')(function* ({
        data,
        chat,
      }: InlineStatus) {
        if (data?.event === 'first_text') {
          const timing = decodeFirstText(data);
          if (Option.isSome(timing)) {
            yield* Effect.logInfo('First text in WoW').pipe(
              Effect.annotateLogs({ ...timing.value, event: 'chat.first_text_in_wow', chat }),
            );
          }
          return;
        }
        const status = {
          at: yield* Clock.currentTimeMillis,
          event: typeof data?.event === 'string' ? data.event.slice(0, 40) : '',
          key: typeof data?.key === 'string' ? data.key.slice(0, 80) : undefined,
          action: typeof data?.action === 'string' ? data.action.slice(0, 120) : undefined,
          panelShown: data?.panelShown === true,
          hasReference: data?.hasReference === true,
          error: typeof data?.error === 'string' ? data.error.slice(0, 300) : undefined,
        };
        yield* fs.writeFileString(file, JSON.stringify(status, null, 2)).pipe(
          Effect.catch((error) =>
            Effect.logWarning('Inline diagnostic save failed').pipe(
              Effect.annotateLogs({
                event: 'addon.inline_status_save_failed',
                error: errorMessage(error),
              }),
            ),
          ),
        );
      });
      return Service.of({ record });
    }),
  );
