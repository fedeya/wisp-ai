import { uiNode, type UINode } from '@wisp/protocol/ui-schema';
import type { Message } from './chat.ts';

export type ReplyPart = { type: 'text'; text: string } | { type: 'ui'; id: string };

// Presentation only: apply the same renderer to new replies and saved history.
// Never store generated table nodes back into the canonical conversation.
export function renderMessageTables(message: Message): Message {
  if (message.role !== 'assistant' || message.streaming) {
    return message;
  }
  const ui = message.ui ?? [];
  const parts: ReplyPart[] = message.parts?.length
    ? message.parts
    : [
        { type: 'text', text: message.text },
        ...ui
          .filter((node) => !node.parent)
          .map((node): ReplyPart => ({ type: 'ui', id: node.id })),
      ];
  const display = nativeTables(parts, ui);
  return display.ui.length === ui.length ? message : { ...message, ...display };
}

function cells(line: string): string[] {
  const value = line.trim();
  const result: string[] = [];
  let cell = '',
    ticks = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '\\' && ['|', '\\'].includes(value[i + 1])) {
      cell += value[++i];
    } else if (char === '`') {
      const run = /^`+/.exec(value.slice(i))![0];
      if (!ticks) {
        ticks = run.length;
      } else if (ticks === run.length) {
        ticks = 0;
      }
      cell += run;
      i += run.length - 1;
    } else if (char === '|' && !ticks) {
      result.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  result.push(cell.trim());
  if (value.startsWith('|')) {
    result.shift();
  }
  if (!cell && value.endsWith('|')) {
    result.pop();
  }
  return result;
}

// Convert only complete, bounded Markdown tables, leaving code and unsupported
// tables intact. The original transcript text remains available for history.
export function nativeTables(parts: ReplyPart[], existing: UINode[]) {
  const ui = [...existing],
    output: ReplyPart[] = [];
  const ids = new Set(ui.map((node) => node.id));
  let serial = 0;
  for (const part of parts) {
    if (part.type !== 'text') {
      output.push(part);
      continue;
    }
    const lines = [...part.text.matchAll(/[^\n]+\n?|\n/g)];
    let cursor = 0,
      fence = '';
    for (let i = 0; i + 2 < lines.length; i++) {
      const line = lines[i][0].trimEnd();
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) {
          fence = marker;
        } else if (marker[0] === fence[0] && marker.length >= fence.length) {
          fence = '';
        }
        continue;
      }
      if (fence || !line.includes('|')) {
        continue;
      }
      const headers = cells(line),
        separators = cells(lines[i + 1][0]);
      if (
        headers.length < 2 ||
        headers.length > 6 ||
        separators.length !== headers.length ||
        !separators.every((value) => /^:?-{3,}:?$/.test(value))
      ) {
        continue;
      }
      const rows: string[][] = [];
      let end = i + 2;
      while (end < lines.length && lines[end][0].trim() && lines[end][0].includes('|')) {
        rows.push(cells(lines[end][0]));
        end++;
      }
      let id: string;
      do {
        id = 'markdown_table_' + ++serial;
      } while (ids.has(id));
      const parsed = uiNode.safeParse({
        id,
        kind: 'table',
        columns: headers.map((label, index) => ({
          label,
          align: separators[index].endsWith(':')
            ? separators[index].startsWith(':')
              ? 'center'
              : 'right'
            : 'left',
        })),
        rows,
      });
      if (
        !parsed.success ||
        ui.length >= 48 ||
        JSON.stringify([...ui, parsed.data]).length > 24000
      ) {
        i = end - 1;
        continue;
      }
      const before = part.text.slice(cursor, lines[i].index);
      if (before) {
        output.push({ type: 'text', text: before });
      }
      output.push({ type: 'ui', id });
      ui.push(parsed.data);
      ids.add(id);
      cursor = lines[end - 1].index! + lines[end - 1][0].length;
      i = end - 1;
    }
    const after = part.text.slice(cursor);
    if (after) {
      output.push({ type: 'text', text: after });
    }
  }
  return { parts: output, ui };
}
