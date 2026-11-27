import { and, eq, max } from 'drizzle-orm';
import { Clock, Context, Effect, Layer, Schema } from 'effect';
import { panelContent } from '@wisp/agent/contract/panels';
import type { Panel, PanelInput } from '@wisp/agent/contract/panels';
import { panels } from '@wisp/db/schema';
import { SqlDatabase } from '@wisp/db/sql-database';
import type { SqlOrm } from '@wisp/db/sql-database';

type PanelRow = typeof panels.$inferSelect;
type PanelEdit = Extract<PanelInput, { operation: 'save' | 'remove' }>;

class PanelStorageError extends Schema.TaggedError<PanelStorageError>()('PanelStorageError', {
  operation: Schema.Literals(['read', 'write']),
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Could not ${this.operation} saved panels`;
  }
}

class PanelQuotaExceeded extends Schema.TaggedError<PanelQuotaExceeded>()(
  'PanelQuotaExceeded',
  {},
) {
  override get message() {
    return 'Keep at most 12 panels per character';
  }
}

const StoredPanelContent = Schema.fromJsonString(
  Schema.StructWithRest(Schema.Struct({ formerKey: Schema.optionalKey(Schema.String) }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
);
const decodeStoredContent = Schema.decodeUnknownEffect(StoredPanelContent);
const storageError = (operation: PanelStorageError['operation']) => (cause: unknown) =>
  new PanelStorageError({ operation, cause });

const decodePanel = Effect.fnUntraced(function* ({
  content,
  sortIndex: _sortIndex,
  ...row
}: PanelRow) {
  const stored = yield* decodeStoredContent(content).pipe(Effect.mapError(storageError('read')));
  const parsed = panelContent.safeParse({ ...stored, ...row });
  if (!parsed.success) return yield* storageError('read')(parsed.error);
  return { ...stored, ...row, ...parsed.data } satisfies Panel;
});

export function encodePanel(
  { characterKey, id, title, updatedAt, ...content }: Panel,
  sortIndex: number,
): PanelRow {
  return { characterKey, id, title, updatedAt, sortIndex, content: JSON.stringify(content) };
}

const byId = (characterKey: string, id: string) =>
  and(eq(panels.characterKey, characterKey), eq(panels.id, id));

function make(db: SqlOrm) {
  const select = (characterKey?: string) =>
    db
      .select()
      .from(panels)
      .where(characterKey === undefined ? undefined : eq(panels.characterKey, characterKey))
      .orderBy(panels.sortIndex);

  const list = Effect.fn('PanelRepository.list')(function* (characterKey?: string) {
    const rows = yield* select(characterKey).pipe(Effect.mapError(storageError('read')));
    const readable: Panel[] = [];
    for (const row of rows) {
      const panel = yield* decodePanel(row).pipe(
        Effect.catch((error) =>
          Effect.logWarning(error.message).pipe(
            Effect.annotateLogs({ event: 'panels.invalid_row', panelId: row.id }),
            Effect.as(undefined),
          ),
        ),
      );
      if (panel) readable.push(panel);
    }
    return readable;
  });

  const get = Effect.fn('PanelRepository.get')(function* (characterKey: string, id: string) {
    const row = yield* db
      .select()
      .from(panels)
      .where(byId(characterKey, id))
      .get()
      .pipe(Effect.mapError(storageError('read')));
    if (row) {
      return yield* decodePanel(row);
    }
  });

  const remove = Effect.fn('PanelRepository.remove')(function* (characterKey: string, id: string) {
    const deleted = yield* db
      .delete(panels)
      .where(byId(characterKey, id))
      .returning({ id: panels.id })
      .pipe(Effect.mapError(storageError('write')));
    return deleted.length > 0;
  });

  const update = Effect.fn('PanelRepository.update')((characterKey: string, edit: PanelEdit) =>
    db.$client
      .withTransaction(
        Effect.gen(function* () {
          if (edit.operation === 'remove') {
            yield* remove(characterKey, edit.id);
            return yield* list(characterKey);
          }

          // Unreadable rows still take up space and can be replaced by ID.
          const previous = yield* select(characterKey);
          const existing = previous.find((panel) => panel.id === edit.panel.id);
          if (!existing && previous.length >= 12) {
            return yield* new PanelQuotaExceeded();
          }
          const content = yield* Effect.try({
            try: () => panelContent.parse(edit.panel),
            catch: storageError('write'),
          });
          // Edits move to the end of the list, as they did in the old store.
          const last = yield* db
            .select({ position: max(panels.sortIndex) })
            .from(panels)
            .get();
          const panel: Panel = {
            ...content,
            characterKey,
            updatedAt: yield* Clock.currentTimeMillis,
          };
          const stored = existing
            ? yield* decodeStoredContent(existing.content).pipe(
                Effect.orElseSucceed(() => undefined),
              )
            : undefined;
          if (stored?.formerKey) panel.formerKey = stored.formerKey;
          const row = encodePanel(panel, (last?.position ?? -1) + 1);
          yield* db
            .insert(panels)
            .values(row)
            .onConflictDoUpdate({
              target: [panels.characterKey, panels.id],
              set: row,
            });
          return yield* list(characterKey);
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: storageError('write'),
          EffectDrizzleQueryError: storageError('write'),
        }),
      ),
  );

  return { list, get, remove, update };
}

export class PanelRepository extends Context.Service<PanelRepository, ReturnType<typeof make>>()(
  '@wisp/server/panels/PanelRepository',
) {}

export const layer = Layer.effect(
  PanelRepository,
  Effect.map(SqlDatabase, ({ db }) => make(db)),
);
