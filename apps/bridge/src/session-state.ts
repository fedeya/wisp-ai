import type { Chat } from './events.ts';
import type { AccountModel } from './chat-model.ts';
import type { MemoryView } from './agent-server.ts';
import type { PanelCommand } from './desktop-handler.ts';
import type { RoutineStore } from './routines.ts';

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
  firstReadyRevision: number;
  questRevision?: number;
  characterRevision?: number;
  activeChat: string;
  inlineChat: string;
  currentCharacterKey?: string;
  routineCommand?: { seq: number; id: string };
  routineHistory?: ReturnType<RoutineStore['addonHistoryPage']> & {
    requestId: string;
    routineId: string;
  };
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
    firstReadyRevision: 0,
    activeChat: '',
    inlineChat: '',
    modelCatalog: [],
    acknowledgments: [],
    capabilityAcks: {},
    handled: new Set(),
    deletedChatIds: new Set(),
  };
}
