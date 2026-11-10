import { z } from 'zod';
import { uiNode, validateNode, type UINode } from '@wisp/protocol/ui-schema';
import { referenceSchema, type ReferenceCatalog } from '@wisp/protocol/rich-reference';
import { conversationTitle } from './conversation-title.ts';
import type { ReplyPart } from './reply-tables.ts';
const keySchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
  .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value));
export function outsideCode(text: string, transform: (text: string) => string): string {
  let result = '',
    cursor = 0;
  for (const match of text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*(?:`|$)/g)) {
    result += transform(text.slice(cursor, match.index)) + match[0];
    cursor = match.index! + match[0].length;
  }
  return result + transform(text.slice(cursor));
}
export class ReplyStream {
  buffer = '';
  text = '';
  references: ReferenceCatalog = Object.create(null);
  ui: UINode[] = [];
  parts: ReplyPart[] = [];
  private rawText = '';
  recoveredPlainText = false;
  errors: string[] = [];
  finished = false;
  records = 0;
  noTip = false;
  title?: string;
  private error(reason: string) {
    if (this.errors.length < 8) {
      this.errors.push(reason);
    }
  }
  private line(raw: string) {
    if (!raw.trim()) {
      return;
    }
    try {
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        // Preserve a complete typed event if generation adds junk after its closing brace.
        // Never interpret prose, code fences or a partial object as a reply event.
        const trimmed = raw.trimStart();
        if (!trimmed.startsWith('{')) {
          throw new Error('Not an event');
        }
        let depth = 0,
          quoted = false,
          escaped = false,
          end = 0;
        for (let i = 0; i < trimmed.length; i++) {
          const char = trimmed[i];
          if (quoted) {
            if (escaped) {
              escaped = false;
            } else if (char === '\\') {
              escaped = true;
            } else if (char === '"') {
              quoted = false;
            }
          } else if (char === '"') {
            quoted = true;
          } else if (char === '{') {
            depth++;
          } else if (char === '}' && --depth === 0) {
            end = i + 1;
            break;
          }
        }
        if (!end) {
          throw new Error('Incomplete event');
        }
        data = JSON.parse(trimmed.slice(0, end));
        this.error('Ignored trailing data after reply event');
      }
      if (
        data.type === 'text_delta' &&
        typeof data.text === 'string' &&
        data.text.length <= 20000
      ) {
        const delta = data.text.slice(0, 20000 - this.text.length);
        this.text += delta;
        const last = this.parts.at(-1);
        if (last?.type === 'text') {
          last.text += delta;
        } else if (delta) {
          this.parts.push({ type: 'text', text: delta });
        }
        this.records++;
      } else if (data.type === 'reference') {
        const key = keySchema.parse(data.key),
          reference = referenceSchema.parse(data);
        if (Object.keys(this.references).length >= 64 && !this.references[key]) {
          throw new Error('Reference limit reached');
        }
        if (
          this.references[key] &&
          JSON.stringify(this.references[key]) !== JSON.stringify(reference)
        ) {
          throw new Error('Reference key changed meaning');
        }
        this.references[key] = reference;
        this.records++;
      } else if (data.type === 'conversation_title') {
        const title = conversationTitle(data.title);
        if (!title) {
          throw new Error('Invalid title');
        }
        this.title = title;
        this.records++;
      } else if (data.type === 'no_tip') {
        this.noTip = true;
        this.records++;
      } else if (data.type === 'ui_node') {
        const node = uiNode.parse(data.node);
        const index = this.ui.findIndex((n) => n.id === node.id);
        if (index < 0 && this.ui.length >= 48) {
          throw new Error('UI node limit');
        }
        if (
          index >= 0 &&
          (this.ui[index].kind !== node.kind || this.ui[index].parent !== node.parent)
        ) {
          throw new Error('UI identity changed');
        }
        validateNode(node, this.ui);
        const proposed =
          index < 0 ? [...this.ui, node] : this.ui.map((old, i) => (i === index ? node : old));
        if (JSON.stringify(proposed).length > 24000) {
          throw new Error('UI payload limit');
        }
        if (index < 0) {
          this.ui.push(node);
          if (!node.parent) {
            this.parts.push({ type: 'ui', id: node.id });
          }
        } else {
          this.ui[index] = node;
        }
        this.records++;
      } else {
        this.error('Unknown reply event');
      }
    } catch {
      this.error('Invalid reply event');
    }
  }
  feed(chunk: string) {
    if (this.finished) {
      return;
    }
    this.rawText += chunk.slice(0, 20000 - this.rawText.length);
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      this.line(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
    }
    if (this.buffer.length > 65536) {
      this.buffer = '';
      this.error('Reply event too large');
    }
  }
  finish() {
    if (!this.finished) {
      this.line(this.buffer);
      this.buffer = '';
      // Recover final assistant prose without replaying a turn or interpreting
      // invented links. Malformed protocol/JSON stays hidden; reasoning is never fed here.
      if (
        !this.records &&
        this.rawText.trim() &&
        !/(?:^|\n)\s*(?:[[{]|```(?:json|jsonl|ndjson)\b|"(?:type|text|node|key)"\s*:)/i.test(
          this.rawText,
        ) &&
        !/"type"\s*:/.test(this.rawText)
      ) {
        this.text = this.rawText.replace(/[\uD800-\uDBFF]$/, '');
        this.parts = [{ type: 'text', text: this.text }];
        this.recoveredPlainText = true;
      }
      this.finished = true;
    }
  }
  private pendingText() {
    // Preview only a recognized text event, never raw JSON or reference metadata.
    const prefix = this.buffer.match(/^\s*\{\s*"type"\s*:\s*"text_delta"\s*,\s*"text"\s*:\s*"/);
    if (!prefix) {
      return '';
    }
    const raw = this.buffer.slice(prefix[0].length);
    let end = 0;
    while (end < raw.length) {
      const char = raw[end];
      if (char === '"') {
        break;
      }
      if (char === '\\') {
        const escape = raw[end + 1];
        if (!escape) {
          break;
        }
        if (escape === 'u') {
          if (!/^[\da-f]{4}$/i.test(raw.slice(end + 2, end + 6))) {
            break;
          }
          end += 6;
        } else if ('"\\/bfnrt'.includes(escape)) {
          end += 2;
        } else {
          return '';
        }
      } else {
        if (char.charCodeAt(0) < 32) {
          return '';
        }
        end++;
      }
    }
    try {
      const decoded: string = JSON.parse('"' + raw.slice(0, end) + '"');
      return /[\uD800-\uDBFF]$/.test(decoded) ? decoded.slice(0, -1) : decoded;
    } catch {
      return '';
    }
  }
  view() {
    const renderText = (value: string) =>
      outsideCode(value, (prose) => {
        let visible = prose.replace(/\[\[ref:([a-zA-Z][a-zA-Z0-9_-]{0,63})\]\]/g, (token, key) =>
          this.references[key] ? token : this.finished ? '(reference unavailable)' : '...',
        );
        const start = visible.lastIndexOf('[[');
        if (
          start >= 0 &&
          !visible.slice(start).includes(']]') &&
          ('[[ref:'.startsWith(visible.slice(start)) || visible.slice(start).startsWith('[[ref:'))
        ) {
          visible = visible.slice(0, start);
        }
        return visible;
      });
    const pending = this.pendingText().slice(0, 20000 - this.text.length);
    const parts = this.parts.map((part) => ({ ...part }));
    if (pending) {
      const last = parts.at(-1);
      if (last?.type === 'text') {
        last.text += pending;
      } else {
        parts.push({ type: 'text', text: pending });
      }
    }
    const visibleParts: ReplyPart[] = parts.map((part) =>
      part.type === 'text' ? { ...part, text: renderText(part.text) } : part,
    );
    return {
      text: renderText(this.text + pending),
      parts: visibleParts,
      references: { ...this.references },
      ui: this.ui.map((node) => ({ ...node })),
      streaming: !this.finished,
    };
  }
}

export class ReplyProjection {
  sourceRevision = 0;
  kinds = new Map<string, string>();
  streams = new Map<string, { reply: ReplyStream; lastAt: number; signature: string }>();
  stream(partId: string) {
    let state = this.streams.get(partId);
    if (!state) {
      state = { reply: new ReplyStream(), lastAt: -Infinity, signature: '' };
      this.streams.set(partId, state);
    }
    return state;
  }
  capture(
    chat: {
      messages: {
        id?: string;
        role: string;
        text: string;
        phase?: string;
        rawReply?: string;
        streaming?: boolean;
      }[];
    },
    partId: string,
    value: string | undefined,
    append: boolean,
  ) {
    const id = 'text-' + partId;
    let message = chat.messages.find((entry) => entry.id === id);
    if (!message) {
      message = { id, role: 'assistant', phase: 'reply', text: '', rawReply: '', streaming: true };
      chat.messages.push(message);
    }
    const raw = append
      ? (message.rawReply ?? '') + (value ?? '')
      : (value ?? message.rawReply ?? '');
    if (message.rawReply !== raw || (!append && message.streaming)) {
      message.rawReply = raw;
      if (!append) {
        message.streaming = false;
      }
      this.sourceRevision++;
    }
  }
  flush(
    chat: {
      title?: string;
      titleGenerated?: boolean;
      proactive?: boolean;
      inline?: boolean;
      messages: {
        id?: string;
        role: string;
        text: string;
        phase?: string;
        references?: ReferenceCatalog;
        ui?: UINode[];
        streaming?: boolean;
      }[];
    },
    now = Date.now(),
    force = false,
  ) {
    let changed = false;
    for (const [partId, state] of this.streams) {
      const view = state.reply.view();
      if (state.reply.title && !view.text && !view.ui.length && !state.reply.errors.length) {
        continue;
      }
      if (!view.text && !view.ui.length && !state.reply.finished) {
        continue;
      }
      if (!force && !state.reply.finished && now - state.lastAt < 600) {
        continue;
      }
      const signature = JSON.stringify(view);
      if (state.signature === signature) {
        continue;
      }
      state.signature = signature;
      state.lastAt = now;
      const id = 'text-' + partId;
      let message = chat.messages.find((message) => message.id === id);
      if (!message) {
        message = { id, role: 'assistant', phase: 'reply', text: '' };
        chat.messages.push(message);
      }
      Object.assign(message, view);
      // Display failures belong to the renderer, never to persisted reply content.
      changed = true;
    }
    return changed;
  }
}
