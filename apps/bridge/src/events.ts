import type { Chat } from './chat.ts';
export type { Chat, Message, Activity } from './chat.ts';
import { ReplyProjection, ReplyStream } from './reply-stream.ts';
import { recordContextUsage } from '@wisp/protocol/context-usage';
import { z } from 'zod';
const streamEvent = z.object({ type: z.string(), data: z.record(z.string(), z.unknown()) });
export function applyEvent(chat: Chat, rawEvent: unknown, parts: ReplyProjection): boolean {
  const event = streamEvent.parse(rawEvent);
  const data = event.data;
  if (recordContextUsage(chat, event)) {
    return true;
  }
  if (event.type === 'call.requested') {
    const cap = data.capability as { name?: string; label?: string; kind?: string } | undefined;
    if (cap?.kind !== 'control' && cap?.name !== 'wisp__set_conversation_title') {
      const activity = {
        id: String(data.callId),
        name: cap?.name || 'tool',
        label: cap?.label || cap?.name || 'Working',
        status: 'running',
      };
      chat.activity.push(activity);
      chat.messages.push({
        id: 'tool-' + activity.id,
        role: 'tool',
        text: activity.label,
        tool: activity,
      });
      return true;
    }
  } else if (event.type === 'call.settled') {
    const call = chat.activity.find((c) => c.id === data.callId);
    const changed =
      !!call &&
      (call.status !== String(data.outcome) || (!!data.label && call.label !== String(data.label)));
    if (call) {
      call.status = String(data.outcome);
      if (data.label) {
        call.label = String(data.label);
      }
    }
    const message = chat.messages.find((m) => m.id === 'tool-' + String(data.callId));
    if (message?.tool) {
      message.tool.status = String(data.outcome);
      if (data.label) {
        message.tool.label = String(data.label);
      }
      message.text = message.tool.label;
    }
    return changed;
  } else if (event.type === 'call.progress') {
    const call = chat.activity.find((c) => c.id === data.callId);
    if (call && data.label && call.label !== String(data.label)) {
      call.label = String(data.label);
      const message = chat.messages.find((m) => m.id === 'tool-' + String(data.callId));
      if (message?.tool) {
        message.tool.label = call.label;
        message.text = call.label;
      }
      return true;
    }
  } else if (event.type === 'content.delta') {
    const id = String(data.partId);
    if (typeof data.kind === 'string') {
      parts.kinds.set(id, data.kind);
    }
    if (parts.kinds.get(id) === 'text' && typeof data.delta === 'string') {
      parts.capture(chat, id, data.delta, true);
      parts.stream(id).reply.feed(data.delta);
      return parts.flush(chat);
    }
  } else if (event.type === 'content.completed' && data.kind === 'text') {
    parts.capture(
      chat,
      String(data.partId),
      typeof data.value === 'string' ? data.value : undefined,
      false,
    );
    const state = parts.stream(String(data.partId));
    if (typeof data.value === 'string') {
      state.reply = new ReplyStream();
      state.reply.feed(data.value);
    }
    state.reply.finish();
    return parts.flush(chat);
  } else if (event.type === 'interaction.opened') {
    const changed = chat.status !== 'needs_input';
    chat.status = 'needs_input';
    return changed;
  }
  return false;
}
