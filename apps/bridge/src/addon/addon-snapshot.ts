import { COMPACTION_THRESHOLD } from '@wisp/protocol/context-usage';
import type { CapabilityView } from '@wisp/protocol/capabilities';
import type { Panel } from '@wisp/protocol/panels';
import {
  describeRoutineTrigger,
  routineEvents,
  type Routine,
  type RoutineRun,
} from '@wisp/protocol/routines';
import { projectChats } from '../chat/chat-projection.ts';
import type { GameRequests } from './game-requests.ts';
import type { SessionState } from '../session-state.ts';

/** Longest routine trigger text shown on the addon's Routines page. */
export const ROUTINE_TRIGGER_MAX_LENGTH = 160;
/** Longest routine instruction shown on the addon's routine detail page. */
export const ROUTINE_INSTRUCTION_MAX_LENGTH = 280;

export interface AddonSnapshotInputs {
  state: SessionState;
  /** Whether Eve is ready to answer. */
  connected: boolean;
  bridgeVersion: string;
  expectedAddonVersion: string | undefined;
  /** Newer desktop app version available to install, if the desktop found one. */
  appUpdateVersion: string | null;
  /** Resolved feature flags, by name. */
  features: Record<string, boolean>;
  /** Context window Eve reported for its configured model, if any. */
  contextWindowTokens: number | undefined;
  defaultModel: string;
  /** Panels, routines and runs of the current character; empty when none is known. */
  panels: Panel[];
  routines: Routine[];
  routineRuns: RoutineRun[];
  /** Whether the routine tool (`tool:manage_routine`) is enabled. */
  routinesAllowed: boolean;
  capabilities: CapabilityView[];
  requests: ReturnType<GameRequests['snapshot']>;
  now?: number;
}

/**
 * Build the UI payload the addon reads. Pure: everything comes from `inputs`.
 * Key order is part of the payload's signature (`SnapshotGate` compares the
 * serialized object), so keep it stable.
 */
export function buildAddonSnapshot(inputs: AddonSnapshotInputs) {
  const { state } = inputs;
  const character = state.currentCharacterKey;
  const routinesAllowed = !!character && inputs.routinesAllowed;
  const activeModel = state.chats.find((c) => c.id === state.activeChat)?.modelSettings?.model;
  return {
    v: 1,
    session: state.activeTransport,
    connected: inputs.connected,
    bridgeVersion: inputs.bridgeVersion,
    expectedAddonVersion: inputs.expectedAddonVersion,
    appUpdateVersion: inputs.appUpdateVersion,
    features: inputs.features,
    contextPolicy: {
      windowTokens:
        state.modelCatalog.find((m) => m.slug === activeModel)?.contextWindow ||
        inputs.contextWindowTokens,
      compactAt: COMPACTION_THRESHOLD,
    },
    modelCatalog: {
      models: state.modelCatalog,
      defaultModel: inputs.defaultModel,
      error: state.modelCatalogError,
    },
    acks: state.acknowledgments,
    questRevision: state.questRevision || 0,
    characterRevision: state.characterRevision || 0,
    activeChat: state.activeChat,
    ...projectChats(state, inputs.now),
    panels: character ? inputs.panels : [],
    panelCommand: state.panelCommand,
    routineCommand: state.routineCommand,
    routines: character
      ? inputs.routines.map((r) => ({
          id: r.id,
          title: r.title,
          enabled: r.enabled,
          // Short, human trigger text for the addon's Routines page.
          trigger: r.triggers
            .map(describeRoutineTrigger)
            .join(' or ')
            .slice(0, ROUTINE_TRIGGER_MAX_LENGTH),
          // What the routine asks Wisp to do, shortened for the routine's detail page.
          instruction: r.instruction.slice(0, ROUTINE_INSTRUCTION_MAX_LENGTH),
          lastStartedAt: r.lastStartedAt,
        }))
      : [],
    routineRuns: character ? inputs.routineRuns.map(({ summary: _summary, ...r }) => r) : [],
    routineSubscriptions: routinesAllowed
      ? [
          ...new Set(
            inputs.routines
              .filter((r) => r.enabled)
              .flatMap((r) => r.triggers.filter((t) => t.kind === 'event').map((t) => t.event)),
          ),
        ].map((event) => ({ event, native: routineEvents[event].native }))
      : [],
    routinesEnabled: routinesAllowed && inputs.routines.some((r) => r.enabled),
    memory: state.memoryView,
    capabilities: {
      entries: inputs.capabilities,
      acks: state.capabilityAcks,
      error: state.capabilityError,
    },
    requests: inputs.requests,
  };
}
