import { uiNode, type UINode } from '@wisp/protocol/ui-schema';
import type { Message } from './chat.ts';
import { Marked, type Tokens } from 'marked';

const markdown = new Marked({ gfm: true });

export type ReplyPart = { type: 'text'; text: string } | { type: 'ui'; id: string };

// Presentation only: apply the same renderer to new replies and saved history.
// Never store generated table nodes back into the canonical conversation.
export function renderMessageTables(message: Message): Message {
  if (message.role !== 'assistant') {
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

// Marked owns GFM syntax; this adapter maps top-level tables to bounded native UI.
// Other tokens remain Markdown, and the canonical transcript is never rewritten.
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
    let prose = '';
    const flushText = () => {
      if (prose) {
        output.push({ type: 'text', text: prose });
        prose = '';
      }
    };
    for (const token of markdown.lexer(part.text)) {
      if (token.type !== 'table') {
        prose += token.raw;
        continue;
      }
      const table = token as Tokens.Table;
      let id: string;
      do {
        id = 'markdown_table_' + ++serial;
      } while (ids.has(id));
      const parsed = uiNode.safeParse({
        id,
        kind: 'table',
        columns: table.header.map((cell, index) => ({
          label: cell.text,
          align: table.align[index] ?? 'left',
        })),
        rows: table.rows.map((row) => row.map((cell) => cell.text)),
      });
      if (
        !parsed.success ||
        ui.length >= 48 ||
        JSON.stringify([...ui, parsed.data]).length > 24000
      ) {
        prose += token.raw;
        continue;
      }
      flushText();
      output.push({ type: 'ui', id });
      ui.push(parsed.data);
      ids.add(id);
    }
    flushText();
  }
  return { parts: output, ui };
}
