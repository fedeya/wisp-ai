import type { Message } from './chat.ts';
import { ReplyStream } from './reply-stream.ts';
import { renderMessageTables } from './reply-tables.ts';

export function renderReply(original: Message): Message | null {
  // Raw protocol is durable source data, not part of the addon/desktop view.
  const { rawReply, ...message } = original;
  if (message.role === 'assistant' && rawReply !== undefined) {
    if (message.streaming) {
      // Preserve the existing bounded preview cadence while the source is saved.
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
      return renderMessageTables({ ...message, ...view });
    }
  }
  return renderMessageTables(message);
}
