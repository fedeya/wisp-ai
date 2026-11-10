// Offline migration only. The live renderer accepts structured references exclusively.
import { linkedReferences } from '@wisp/protocol/references';
import { referenceSchema, type RichReference } from '@wisp/protocol/rich-reference';
import type { Chat } from './events.ts';

// Preserve the legacy migration's interpretation; live replies transport source
// text and leave Markdown context and reference presentation to the addon.
function outsideCode(text: string, transform: (text: string) => string): string {
  let result = '',
    cursor = 0;
  for (const match of text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*(?:`|$)/g)) {
    result += transform(text.slice(cursor, match.index)) + match[0];
    cursor = match.index! + match[0].length;
  }
  return result + transform(text.slice(cursor));
}

export function migrateReplies(chats: Chat[]) {
  let messages = 0,
    references = 0;
  for (const chat of chats) {
    const aliases = new Map<string, RichReference | null>();
    for (const message of chat.messages) {
      if (message.role === 'user') {
        for (const linked of linkedReferences(message.text)) {
          if (linked.kind === 'map') {
            continue;
          }
          const candidate = {
            kind: linked.kind,
            id: linked.id,
            label: linked.name,
            payload: linked.nativeLink?.match(/\|H([^|]+)/)?.[1],
          };
          const parsed = referenceSchema.safeParse(candidate);
          const clean = parsed.success
            ? parsed
            : referenceSchema.safeParse({ ...candidate, payload: undefined });
          if (!clean.success) {
            continue;
          }
          const ref = clean.data;
          const previous = aliases.get(ref.label);
          aliases.set(
            ref.label,
            previous === undefined || JSON.stringify(previous) === JSON.stringify(ref) ? ref : null,
          );
        }
      }
      if (message.role !== 'assistant' || message.references !== undefined) {
        continue;
      }
      const catalog: Record<string, RichReference> = {};
      const add = (candidate: unknown, fallback: string) => {
        const parsed = referenceSchema.safeParse(candidate);
        if (!parsed.success) {
          return fallback;
        }
        const existing = Object.keys(catalog).find(
          (key) => JSON.stringify(catalog[key]) === JSON.stringify(parsed.data),
        );
        const key = existing || 'ref' + (Object.keys(catalog).length + 1);
        catalog[key] = parsed.data;
        return '[[ref:' + key + ']]';
      };
      message.text = outsideCode(message.text, (prose) => {
        prose = prose.replace(
          /(?:\|c[\da-f]{8})?\|H(item|spell|quest):(\d+)([^|]*)\|h\[?([^|]*?)\]?\|h(?:\|r)?/gi,
          (raw, kind, id, suffix, label) =>
            add({ kind, id: Number(id), label, payload: kind + ':' + id + suffix }, raw),
        );
        prose = prose.replace(/\[([^\]]+)\]\((item|spell|quest):(\d+)\)/g, (raw, label, kind, id) =>
          add({ kind, label, id: Number(id) }, raw),
        );
        prose = prose.replace(
          /\[([^\]]+)\]\(map:(\d+)(?::([\d.]+):([\d.]+))?\)/g,
          (raw, label, mapId, x, y) =>
            add(
              {
                kind: 'map',
                label,
                mapId: Number(mapId),
                ...(x === undefined ? {} : { x: Number(x), y: Number(y) }),
              },
              raw,
            ),
        );
        prose = prose.replace(/\[([^\]]+)\]\(macro:([\da-f]+)\)/gi, (raw, label, hex) =>
          add({ kind: 'macro', label, name: Buffer.from(hex, 'hex').toString('utf8') }, raw),
        );
        prose = prose.replace(
          /(?:\|c[\da-f]{8})?\|Hworldmap:(\d+):(\d+):(\d+)[^|]*\|h([^|]*)\|h(?:\|r)?/gi,
          (raw, mapId, x, y, label) =>
            add(
              {
                kind: 'map',
                mapId: Number(mapId),
                x: Number(x) / 100,
                y: Number(y) / 100,
                label: label.replace(/[[\]]/g, ''),
              },
              raw,
            ),
        );
        for (const [name, ref] of [...aliases].sort((a, b) => b[0].length - a[0].length)) {
          if (!ref) {
            continue;
          }
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          prose = prose.replace(
            new RegExp('(?<![\\p{L}\\p{N}_])' + escaped + '(?![\\p{L}\\p{N}_])', 'gu'),
            () => add(ref, name),
          );
        }
        return prose;
      });
      message.references = catalog;
      message.streaming = false;
      messages++;
      references += Object.keys(catalog).length;
    }
    chat.historyVersion = 3;
  }
  return { messages, references };
}
