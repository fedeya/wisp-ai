import { randomUUID } from 'node:crypto';
import { expectedCharacter } from '@wisp/protocol/character-key';
import { selectionValues } from '@wisp/agent/contract/ui-schema';
import type { Connection, GameEvent } from '@wisp/wow-bridge';
import { Effect, Option, Schema } from 'effect';
import type { RunTurn } from '../chat/addon-conversations.ts';
import { characterIdentity } from '../chat/context.ts';
import { errorMessage } from '../errors.ts';
import type { SessionState } from '../session-state.ts';
type UiAction = Extract<GameEvent, { type: 'ui_action' }>;

const SettingsResult = Schema.Struct({
  status: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Struct({ verified: Schema.optionalKey(Schema.Boolean) })),
  error: Schema.optionalKey(Schema.String),
});
const decodeSettingsResult = Schema.decodeUnknownOption(SettingsResult);

export function make(deps: {
  state: SessionState;
  request: Connection['request'];
  enabled: (key: string) => boolean;
  run: RunTurn;
  saveChats: () => void;
  invalidateAddonView: () => void;
}) {
  const { state, request, enabled, run, saveChats, invalidateAddonView } = deps;
  const handle = Effect.fn('ReplyActions.handle')(function* (packet: UiAction) {
    const chat = state.chats.find((candidate) => candidate.id === packet.chat);
    if (!chat || chat.owner !== state.activeTransport || chat.status === 'working') return;
    const ui = chat.messages.find((message) => message.id === packet.messageId)?.ui;
    const node = ui?.find((item) => item.id === packet.nodeId);
    if (!ui || node?.kind !== 'button') return;
    const { action } = node;

    if (action.kind === 'ask') {
      const values = yield* Effect.try({
        try: () => selectionValues(ui, packet.values),
        catch: errorMessage,
      });
      return yield* Effect.tryPromise({
        try: () =>
          run(
            chat,
            action.prompt + '\n\nSelected panel values: ' + JSON.stringify(values),
            undefined,
            packet.context,
          ),
        catch: errorMessage,
      });
    }

    const undo = action.kind === 'undo_settings';
    const tool = undo ? 'undo_settings' : 'update_settings';
    if (!enabled('tool:' + tool)) return yield* Effect.fail('This tool is disabled in Settings');
    const identity = characterIdentity(packet.context);
    if (identity && chat.characterKey && identity !== chat.characterKey) {
      return yield* Effect.fail('Character identity changed; ask again for this character');
    }

    chat.status = 'working';
    invalidateAddonView();
    yield* Effect.gen(function* () {
      const result = yield* request({
        chat: chat.id,
        session: packet.session,
        operation: {
          kind: 'act',
          action: {
            kind: tool,
            args: undo
              ? { transactionId: action.transactionId }
              : { operation: 'apply', transactionId: action.transactionId },
            expectedCharacter: expectedCharacter(identity ?? chat.characterKey),
          },
        },
      }).pipe(Effect.mapError(errorMessage));
      if (packet.session !== state.activeTransport || !state.chats.includes(chat)) return;
      chat.lastUIResult = result;
      const value = Option.getOrUndefined(decodeSettingsResult(result));
      const verified = value?.status === 'completed' && value.data?.verified === true;
      chat.messages.push({
        id: 'settings-' + randomUUID(),
        role: 'system',
        text: verified
          ? undo
            ? 'Settings restored.'
            : 'Settings applied. You can undo these changes.'
          : 'Settings were not applied: ' + (value?.error || 'Verification failed.'),
      });
      const undoId = node.id.slice(0, 55) + '_undo';
      if (!undo && verified && !ui.some((item) => item.id === undoId)) {
        ui.push({
          id: undoId,
          parent: node.parent,
          kind: 'button',
          label: 'Undo changes',
          action: { kind: 'undo_settings', transactionId: action.transactionId },
        });
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (chat.status === 'working') chat.status = 'done';
          saveChats();
          invalidateAddonView();
        }),
      ),
    );
  });

  return Effect.fnUntraced(function* (packet: UiAction) {
    yield* handle(packet).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          const chat = state.chats.find((candidate) => candidate.id === packet.chat);
          if (!chat || state.activeTransport !== packet.session) return;
          chat.messages.push({ role: 'system', text: error });
          saveChats();
          invalidateAddonView();
        }),
      ),
    );
  });
}
