import type { Message } from './chat.ts';
import { LegacyReplyStream } from './legacy-reply.ts';

// Streaming previews are ephemeral; canonical text and parts always persist in full.
export type PresentationProgress = { id: string; label: string };
const previews = new WeakMap<
  Message,
  { message: Message | null; presentation?: PresentationProgress }
>();
export function setReplyPreview(
  message: Message,
  preview: Message | null,
  presentation?: PresentationProgress,
) {
  previews.set(message, { message: preview, presentation });
}

export function replyPresentationProgress(message: Message) {
  return previews.get(message)?.presentation;
}

// Decode reply events for transport and restored model history. Markdown stays text.
export function replyContent(original: Message): Message | null {
  const preview = previews.get(original)?.message;
  if (preview === null) {
    return null;
  }
  if (preview) {
    original = preview;
  }
  const { rawReply, replyFormat, ...message } = original;
  if (message.role === 'assistant' && replyFormat === 'text') {
    if (!message.text && !message.ui?.length) {
      return null;
    }
    const bound = (text: string, limit: number) =>
      text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');
    let remaining = 20000;
    const parts = message.parts?.map((part) => {
      if (part.type !== 'text') {
        return part;
      }
      const text = bound(part.text, remaining);
      remaining -= text.length;
      return { ...part, text };
    });
    return { ...message, text: bound(message.text, 20000), parts };
  }
  if (message.role === 'assistant' && rawReply !== undefined) {
    if (message.streaming) {
      if (!message.text && !message.ui?.length) {
        return null;
      }
    } else {
      const reply = new LegacyReplyStream();
      reply.feed(rawReply);
      reply.finish();
      const view = reply.view();
      if (!view.text && !view.ui.length) {
        if (!reply.errors.length) {
          return null;
        }
        return {
          ...message,
          ...view,
          role: 'system',
          text: 'The reply could not be displayed. Please try again.',
        };
      }
      return { ...message, ...view };
    }
  }
  return message;
}
