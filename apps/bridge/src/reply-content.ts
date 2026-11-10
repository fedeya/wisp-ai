import type { Message } from './chat.ts';
import { LegacyReplyStream, outsideCode } from './legacy-reply.ts';

// Streaming previews are ephemeral; canonical text and parts always persist in full.
const previews = new WeakMap<Message, Message | null>();
export function setReplyPreview(message: Message, preview: Message | null) {
  previews.set(message, preview);
}

// Shared interpretation for display and restored model history; no table layout.
export function replyContent(original: Message): Message | null {
  const preview = previews.get(original);
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
    const render = (text: string) =>
      outsideCode(text, (prose) => {
        let visible = prose.replace(/\[\[ref:([a-zA-Z][a-zA-Z0-9_-]{0,63})\]\]/g, (token, key) =>
          message.references?.[key] ? token : message.streaming ? '...' : '(reference unavailable)',
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
    const bound = (text: string, limit: number) =>
      text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');
    let remaining = 20000;
    const parts = message.parts?.map((part) => {
      if (part.type !== 'text') {
        return part;
      }
      const text = bound(part.text, remaining);
      remaining -= text.length;
      return { ...part, text: render(text) };
    });
    return { ...message, text: render(bound(message.text, 20000)), parts };
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
