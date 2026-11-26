import type { Chat } from './chat/events.ts';
import type { AccountModel } from './chat/chat-model.ts';

export interface MemoryView {
  entries?: unknown[];
  status: string;
  error?: string;
  requestId?: string;
}

export interface PanelCommand {
  seq: number;
  id: string;
  characterKey: string;
  action: 'show' | 'hide';
}

export interface RoutinePresence {
  identity: string;
  context: unknown;
  ready: boolean;
  at: number;
  session: string;
}
export interface SessionState {
  chats: Chat[];
  activeTransport: string;
  questRevision?: number;
  characterRevision?: number;
  activeChat: string;
  inlineChat: string;
  currentCharacterKey?: string;
  routineCommand?: { seq: number; id: string };
  panelCommand?: PanelCommand;
  memoryView?: MemoryView;
  memoryViewRequest?: string;
  modelCatalog: AccountModel[];
  modelCatalogError?: string;
  acknowledgments: number[];
  capabilityAcks: Record<string, string>;
  capabilityError?: { requestId?: string; message: string };
  routinePresence?: RoutinePresence;
  handled: Set<string>;
  deletedChatIds: Set<string>;
}
export function createSessionState(chats: Chat[] = []): SessionState {
  return {
    chats,
    activeTransport: '',
    activeChat: '',
    inlineChat: '',
    modelCatalog: [],
    acknowledgments: [],
    capabilityAcks: {},
    handled: new Set(),
    deletedChatIds: new Set(),
  };
}
