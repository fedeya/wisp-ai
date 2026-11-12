import {
  PRESENT_UI_TOOL,
  replyPresentation,
  type ReplyPresentation,
} from '@wisp/protocol/reply-presentation';
import type { ReferenceCatalog } from '@wisp/protocol/rich-reference';
import type { Chat, Message, ReplyPart } from './chat.ts';
import { setReplyPreview, type PresentationProgress } from './reply-content.ts';

const MAX_PRESENTATION_PREFIX = 32_768;

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
  signature: string;
  force: boolean;
}
interface Presentation {
  group: Group;
  pending: boolean;
  requested: boolean;
  label?: string;
  accepted?: ReplyPresentation;
  value?: ReplyPresentation;
}
interface Component {
  group: Group;
  node: NonNullable<Message['ui']>[number];
}

// Project Eve's ordered text/tool events into native message parts. Presentation
// calls occupy a stable position but never become visible tool/activity rows.
export class ReplyProjection {
  sourceRevision = 0;
  presentationProgressRevision = 0;
  noTip = false;
  kinds = new Map<string, string>();
  streams = new Map<string, { reply: ReplyStream; group: Group; part: TextPart }>();
  private groups: Group[] = [];
  private presentations = new Map<string, Presentation>();
  private presentationInputs = new Map<string, string>();
  private components = new Map<string, Component>();
  private roots = new Map<string, string[]>();
  private references: ReferenceCatalog = Object.create(null);
  private skipCalls = new Set<string>();
  private turn = new AbortController();
  private started = false;
  private waiters = new Map<string, Set<() => void>>();

  beginTurn() {
    // Execution can reach the RPC before the first turn.started event is read.
    // Keep those waiters alive; subsequent turns must invalidate the old ones.
    if (this.started) {
      this.finish();
      this.turn = new AbortController();
    }
    this.started = true;
    for (const group of this.groups) {
      setReplyPreview(group.message, { ...group.message });
    }
    this.groups = [];
    this.streams.clear();
    this.kinds.clear();
    this.presentations.clear();
    this.presentationInputs.clear();
    this.components.clear();
    this.roots.clear();
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
    this.started = true;
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

  presentationInput(chat: Chat, callId: string, delta: string, name: unknown) {
    const buffered = this.presentationInputs.get(callId);
    if (name !== PRESENT_UI_TOOL && (name !== undefined || buffered === undefined)) {
      return false;
    }
    const previous = buffered ?? '';
    const existing = this.presentations.get(callId);
    if (
      (existing && (existing.requested || !existing.pending)) ||
      existing?.label === 'Creating comparison' ||
      previous.length >= MAX_PRESENTATION_PREFIX
    ) {
      return false;
    }
    // References can precede nodes and occupy most of the presentation input.
    const prefix = previous + delta.slice(0, MAX_PRESENTATION_PREFIX - previous.length);
    this.presentationInputs.set(callId, prefix);
    if (/"nodes"\s*:\s*\[\s*\{/.test(prefix)) {
      const label = /"kind"\s*:\s*"comparison"/.test(prefix)
        ? 'Creating comparison'
        : 'Creating panel';
      if (label !== existing?.label) {
        this.setPresentation(chat, callId, label);
        return true;
      }
    }
    return false;
  }

  requestPresentation(chat: Chat, callId: string, input?: unknown) {
    this.presentationInputs.delete(callId);
    const existing = this.presentations.get(callId);
    if (existing && (existing.requested || !existing.pending)) {
      return;
    }
    const nodes = (input as { nodes?: { kind?: unknown }[] } | undefined)?.nodes;
    const label =
      Array.isArray(nodes) && nodes.length
        ? nodes.some((node) => node?.kind === 'comparison')
          ? 'Creating comparison'
          : 'Creating panel'
        : input === undefined
          ? existing?.label
          : undefined;
    const presentation = this.setPresentation(chat, callId, label);
    presentation.requested = true;
    for (const resolve of this.waiters.get(callId) ?? []) {
      resolve();
    }
  }

  private setPresentation(chat: Chat, callId: string, label?: string) {
    const existing = this.presentations.get(callId);
    if (existing) {
      if (existing.pending && existing.label !== label) {
        existing.label = label;
        existing.group.force = true;
        if (label) {
          this.presentationProgressRevision++;
        }
      }
      return existing;
    }
    const group = this.group(chat, 'presentation-' + callId);
    const presentation = { group, pending: true, requested: false, label };
    this.presentations.set(callId, presentation);
    if (label) {
      group.force = true;
      this.presentationProgressRevision++;
    }
    group.segments.push({ type: 'presentation', callId });
    this.update(group);
    return presentation;
  }

  async acceptPresentation(callId: string, input: unknown, signal: AbortSignal) {
    const active = AbortSignal.any([signal, this.turn.signal, AbortSignal.timeout(5000)]);
    active.throwIfAborted();
    if (!this.presentations.get(callId)?.requested) {
      await new Promise<void>((resolve, reject) => {
        const waiting = this.waiters.get(callId) ?? new Set<() => void>();
        const cleanup = () => {
          active.removeEventListener('abort', abort);
          waiting.delete(ready);
          if (!waiting.size) {
            this.waiters.delete(callId);
          }
        };
        const ready = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(active.reason);
        };
        waiting.add(ready);
        this.waiters.set(callId, waiting);
        active.addEventListener('abort', abort, { once: true });
      });
    }
    active.throwIfAborted();
    const presentation = this.presentations.get(callId)!;
    const existing = presentation.accepted ?? presentation.value;
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(replyPresentation.parse(input))) {
        throw Error('This presentation call already has a different payload. Use a new call.');
      }
      return existing;
    }
    if (!presentation.pending) {
      throw Error('This presentation call has already finished. Use a new call.');
    }
    const value = this.validatePresentation(presentation, input);
    // Reserve before acknowledging, but publish only on call.settled so replay
    // and live output agree, including failed or cancelled tool executions.
    presentation.accepted = value;
    return value;
  }

  private validatePresentation(presentation: Presentation, input: unknown): ReplyPresentation {
    const value = replyPresentation.parse(input);
    const staged = [...this.presentations.values()]
      .filter((entry) => entry !== presentation && entry.pending && entry.accepted)
      .map((entry) => ({ group: entry.group, value: entry.accepted! }));
    staged.push({ group: presentation.group, value });
    const references = { ...this.references };
    for (const entry of staged) {
      for (const [key, reference] of Object.entries(entry.value.references)) {
        if (references[key] && JSON.stringify(references[key]) !== JSON.stringify(reference)) {
          throw Error(`Reference "${key}" already identifies something else. Use a new key.`);
        }
        references[key] = reference;
      }
    }
    if (Object.keys(references).length > 64) {
      throw Error('The reply cannot contain more than 64 references. Reuse existing keys.');
    }
    const components = new Map(this.components);
    for (const entry of staged) {
      for (const node of entry.value.nodes) {
        const old = components.get(node.id);
        if (old && (old.node.kind !== node.kind || old.node.parent !== node.parent)) {
          throw Error(`Component "${node.id}" cannot change kind or parent. Use a new ID.`);
        }
        const group =
          this.components.get(node.id)?.group ??
          (node.parent ? components.get(node.parent)?.group : undefined) ??
          entry.group;
        if (old && old.group !== group) {
          throw Error(
            `Component "${node.id}" is pending in another message. Retry after that presentation finishes.`,
          );
        }
        // Reserve the larger version in its owning message, including new
        // children of an existing panel and updates from later tool rounds.
        if (!old || JSON.stringify(node).length > JSON.stringify(old.node).length) {
          components.set(node.id, { group, node });
        }
      }
    }
    for (const group of this.groups) {
      const nodes = [...components.values()]
        .filter((entry) => entry.group === group)
        .map((entry) => entry.node);
      if (nodes.length > 48) {
        throw Error('The message cannot contain more than 48 components. Reuse existing IDs.');
      }
      if (JSON.stringify({ nodes, references }).length > 24000) {
        throw Error(
          'The combined presentation is too large. Use less content or fewer references.',
        );
      }
    }
    return value;
  }

  settlePresentation(callId: string, output: unknown, success: boolean) {
    this.presentationInputs.delete(callId);
    if (this.skipCalls.delete(callId) && success) {
      this.noTip = true;
    }
    const presentation = this.presentations.get(callId);
    if (!presentation || !presentation.pending) {
      return;
    }
    if (success) {
      try {
        const value = presentation.accepted ?? this.validatePresentation(presentation, output);
        presentation.value = value;
        this.references = { ...this.references, ...value.references };
      } catch {
        // Old or malformed history can lack the live RPC acceptance step.
      }
    }
    presentation.pending = false;
    presentation.accepted = undefined;
    this.rebuildComponents();
    for (const group of this.groups) {
      group.force = true;
      this.update(group);
    }
  }

  private rebuildComponents() {
    // An ID keeps its first successful presentation's owner and inline slot.
    // Reapply values in request order so late settlements cannot undo an update.
    for (const [callId, presentation] of this.presentations) {
      for (const node of presentation.value?.nodes ?? []) {
        let component = this.components.get(node.id);
        if (!component) {
          component = {
            group: node.parent ? this.components.get(node.parent)!.group : presentation.group,
            node,
          };
          this.components.set(node.id, component);
          if (!node.parent) {
            const roots = this.roots.get(callId) ?? [];
            roots.push(node.id);
            this.roots.set(callId, roots);
          }
        }
        component.node = node;
      }
    }
    for (const group of this.groups) {
      group.message.ui = [];
    }
    for (const component of this.components.values()) {
      component.group.message.ui!.push(component.node);
    }
  }

  private update(group: Group) {
    const parts: ReplyPart[] = [];
    for (const segment of group.segments) {
      if (segment.type === 'text') {
        parts.push({ ...segment });
      } else {
        for (const id of this.roots.get(segment.callId) ?? []) {
          parts.push({ type: 'ui', id });
        }
      }
    }
    // Canonical prose is kept verbatim, including beyond display limits. The
    // display layer bounds text and resolves references without rewriting history.
    group.message.text = parts
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('');
    group.message.parts = parts;
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
    this.started = true;
    this.turn.abort(Error('The presentation turn has finished.'));
    for (const state of this.streams.values()) {
      state.reply.finish();
    }
    for (const presentation of this.presentations.values()) {
      presentation.pending = false;
      presentation.accepted = undefined;
    }
    this.presentationInputs.clear();
    for (const group of this.groups) {
      this.update(group);
    }
  }

  flush(_chat: Chat, now = Date.now(), force = false) {
    let changed = false;
    for (const group of this.groups) {
      if (!force && !group.force && group.message.streaming && now - group.lastAt < 600) {
        continue;
      }
      let progress: PresentationProgress | undefined;
      for (const segment of group.segments) {
        if (segment.type === 'presentation') {
          const presentation = this.presentations.get(segment.callId);
          if (presentation?.pending && presentation.label) {
            progress = { id: segment.callId, label: presentation.label };
          }
        }
      }
      const signature = JSON.stringify([group.message, progress]);
      if (signature === group.signature) {
        continue;
      }
      group.signature = signature;
      group.lastAt = now;
      group.force = false;
      setReplyPreview(group.message, { ...group.message }, progress);
      changed = true;
    }
    return changed;
  }
}
