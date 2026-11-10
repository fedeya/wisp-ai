import type { SessionState } from './session-state.ts';
import { replyContent } from './reply-content.ts';
export function projectChats(state: SessionState, now = Date.now()) {
  let ordinaryCount = 0;
  let otherCount = 0;
  return {
    chats: state.chats
      .filter((c) => !(c.routineId && c.proactive && c.tipSkipped && c.status === 'done'))
      .filter(
        (c) =>
          !!c.routineId ||
          (!c.inline && !c.proactive) ||
          c.id === state.activeChat ||
          c.id === state.inlineChat ||
          c.status === 'working' ||
          (c.proactive && !c.dismissed && !c.tipSkipped && now - (c.lastUsedAt || 0) < 900000),
      )
      .sort(
        (a, b) =>
          Number(b.id === state.activeChat) - Number(a.id === state.activeChat) ||
          (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0),
      )
      .filter((c) => {
        if (c.id === state.activeChat || c.id === state.inlineChat || c.status === 'working') {
          return true;
        }
        return !c.routineId && !c.inline && !c.proactive
          ? ++ordinaryCount <= 40
          : ++otherCount <= 40;
      })
      .map((c) => ({
        id: c.id,
        title: c.title,
        status: c.status,
        unread: c.unread,
        usage: c.usage,
        modelSettings: c.modelSettings,
        modelRequestId: c.modelRequestId,
        modelError: c.modelError,
        lastActivityAt: c.lastActivityAt,
        activity: c.activity,
        inline: c.inline,
        proactive: c.proactive,
        routineId: c.routineId,
        messages:
          c.id === state.activeChat ||
          c.id === state.inlineChat ||
          (c.inline && c.status === 'working') ||
          (c.proactive && c.status === 'done')
            ? c.messages.flatMap((m, index) => {
                // A routine's initial user turn is generated execution context.
                // Keep it in model history, but never expose it in the conversation.
                if (c.routineId && index === 0 && m.role === 'user') {
                  return [];
                }
                const display = replyContent(m);
                return display
                  ? [
                      {
                        ...display,
                        id: m.id || c.id + '-message-' + index,
                        text: display.text.slice(0, 20000),
                      },
                    ]
                  : [];
              })
            : undefined,
      })),
    notifications: state.chats
      .filter(
        (c) =>
          c.proactive &&
          c.characterKey === state.currentCharacterKey &&
          c.status === 'done' &&
          !c.dismissed &&
          !c.tipSkipped &&
          now - (c.lastUsedAt || 0) < 900000 &&
          c.messages.some((m) => m.role === 'assistant' && (m.text || m.ui?.length)),
      )
      .slice(-3)
      .map((c) => ({ id: c.id, title: c.title })),
  };
}
