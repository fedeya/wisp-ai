import { replyPresentation, type ReplyPresentation } from '@wisp/protocol/reply-presentation';
import type { ReferenceCatalog } from '@wisp/protocol/rich-reference';
import type { Chat, Message } from './chat.ts';
import type { ReplyPart } from './reply-tables.ts';
import { setReplyPreview } from './reply-content.ts';
export { outsideCode } from './legacy-reply.ts';

export class ReplyStream {
  text = '';
  finished = false;
  feed(chunk: string) {
    if (!this.finished) {
      this.text += chunk;
    }
  }
  finish() {
    this.finished = true;
  }
  view() {
    return { text: this.text, streaming: !this.finished };
  }
}

type TextPart = Extract<ReplyPart, { type: 'text' }>;
type Segment = TextPart | { type: 'presentation'; callId: string };
interface Group {
  message: Message;
  segments: Segment[];
  lastAt: number;
  updates: number;
  signature: string;
  force: boolean;
}
interface Presentation {
  group: Group;
  pending: boolean;
  value?: ReplyPresentation;
}

// Project Eve's ordered text/tool events into native message parts. Presentation
// calls occupy a stable position but never become visible tool/activity rows.
export class ReplyProjection {
  sourceRevision = 0;
  noTip = false;
  kinds = new Map<string, string>();
  streams = new Map<string, { reply: ReplyStream; group: Group; part: TextPart }>();
  private groups: Group[] = [];
  private presentations = new Map<string, Presentation>();
  private references: ReferenceCatalog = Object.create(null);
  private skipCalls = new Set<string>();

  beginTurn() {
    this.finish();
    for (const group of this.groups) {
      setReplyPreview(group.message, { ...group.message });
    }
    this.groups = [];
    this.streams.clear();
    this.kinds.clear();
    this.presentations.clear();
    this.skipCalls.clear();
    this.references = Object.create(null);
    this.noTip = false;
  }

  requestSkipTip(callId: string, automatic: boolean) {
    if (automatic) {
      this.skipCalls.add(callId);
    }
  }

  private group(chat: Chat, id: string): Group {
    const current = this.groups.at(-1);
    if (current && chat.messages.at(-1) === current.message) {
      return current;
    }
    const message: Message = {
      id,
      role: 'assistant',
      phase: 'reply',
      replyFormat: 'text',
      text: '',
      parts: [],
      ui: [],
      references: { ...this.references },
      streaming: true,
    };
    const group: Group = {
      message,
      segments: [],
      lastAt: -Infinity,
      updates: 0,
      signature: '',
      force: false,
    };
    this.groups.push(group);
    chat.messages.push(message);
    setReplyPreview(message, null);
    return group;
  }

  text(chat: Chat, partId: string, value: string | undefined, append: boolean) {
    let state = this.streams.get(partId);
    if (!state) {
      const group = this.group(chat, 'text-' + partId);
      const part: TextPart = { type: 'text', text: '' };
      state = { reply: new ReplyStream(), group, part };
      group.segments.push(part);
      group.updates = 0;
      group.lastAt = -Infinity;
      this.streams.set(partId, state);
    }
    if (append) {
      state.reply.feed(value ?? '');
    } else {
      if (value !== undefined) {
        state.reply.text = value;
      }
      state.reply.finish();
    }
    state.part.text = state.reply.text;
    this.update(state.group);
  }

  requestPresentation(chat: Chat, callId: string) {
    if (this.presentations.has(callId)) {
      return;
    }
    const group = this.group(chat, 'presentation-' + callId);
    this.presentations.set(callId, { group, pending: true });
    group.segments.push({ type: 'presentation', callId });
    this.update(group);
  }

  settlePresentation(callId: string, output: unknown, success: boolean) {
    if (this.skipCalls.delete(callId) && success) {
      this.noTip = true;
    }
    const presentation = this.presentations.get(callId);
    if (!presentation || !presentation.pending) {
      return;
    }
    presentation.pending = false;
    const parsed = success && replyPresentation.safeParse(output);
    if (parsed && parsed.success) {
      const value = parsed.data;
      const ui = presentation.group.message.ui ?? [];
      const compatible =
        value.nodes.every((node) => {
          const old = ui.find((entry) => entry.id === node.id);
          return !old || (old.kind === node.kind && old.parent === node.parent);
        }) &&
        Object.entries(value.references).every(
          ([key, reference]) =>
            !this.references[key] ||
            JSON.stringify(this.references[key]) === JSON.stringify(reference),
        );
      const nodes = new Map([...ui, ...value.nodes].map((node) => [node.id, node]));
      const references = { ...this.references, ...value.references };
      if (
        compatible &&
        nodes.size <= 48 &&
        Object.keys(references).length <= 64 &&
        JSON.stringify({ nodes: [...nodes.values()], references }).length <= 24000
      ) {
        presentation.value = value;
        this.references = references;
      }
    }
    for (const group of this.groups) {
      group.force = true;
      this.update(group);
    }
  }

  private update(group: Group) {
    const parts: ReplyPart[] = [];
    const nodes = new Map<string, NonNullable<Message['ui']>[number]>();
    for (const segment of group.segments) {
      if (segment.type === 'text') {
        parts.push({ ...segment });
      } else {
        for (const node of this.presentations.get(segment.callId)?.value?.nodes ?? []) {
          if (!node.parent && !nodes.has(node.id)) {
            parts.push({ type: 'ui', id: node.id });
          }
          nodes.set(node.id, node);
        }
      }
    }
    // Canonical prose is kept verbatim, including beyond display limits. The
    // display layer bounds text and resolves references without rewriting history.
    group.message.text = parts
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('');
    group.message.parts = parts;
    group.message.ui = [...nodes.values()];
    group.message.references = { ...this.references };
    group.message.streaming =
      [...this.streams.values()].some((state) => state.group === group && !state.reply.finished) ||
      [...this.presentations.values()].some((entry) => entry.group === group && entry.pending);
    this.sourceRevision++;
  }

  get hasContent() {
    return this.groups.some(({ message }) => message.text.trim() || message.ui?.length);
  }

  finish() {
    for (const state of this.streams.values()) {
      state.reply.finish();
    }
    for (const presentation of this.presentations.values()) {
      presentation.pending = false;
    }
    for (const group of this.groups) {
      this.update(group);
    }
  }

  flush(_chat: Chat, now = Date.now(), force = false) {
    let changed = false;
    for (const group of this.groups) {
      if (
        !force &&
        !group.force &&
        group.message.streaming &&
        (group.updates >= 8 || now - group.lastAt < 600)
      ) {
        continue;
      }
      const signature = JSON.stringify(group.message);
      if (signature === group.signature) {
        continue;
      }
      group.signature = signature;
      group.lastAt = now;
      if (group.message.streaming) {
        group.updates++;
      }
      group.force = false;
      setReplyPreview(group.message, { ...group.message });
      changed = true;
    }
    return changed;
  }
}
