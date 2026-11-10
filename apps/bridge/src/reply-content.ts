import type { Message } from './chat.ts';
import { ReplyStream } from './reply-stream.ts';

// Decode reply events for transport and restored model history. Markdown stays text.
export function replyContent(original: Message): Message | null {
  const { rawReply, ...message } = original;
  if (message.role === 'assistant' && rawReply !== undefined) {
    if (message.streaming) {
      if (!message.text && !message.ui?.length) {
        return null;
      }
    } else {
      const reply = new ReplyStream();
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
