import type { desktopReadiness } from '../desktop-controller';

export type Readiness = ReturnType<typeof desktopReadiness>;
export type CheckTone = 'ok' | 'problem' | 'pending' | 'idle';
/** The fix a check offers; Overview turns each one into a button. */
export type CheckAction =
  | 'update-addon'
  | 'dismiss-reload'
  | 'view-diagnostics'
  | 'change-provider'
  | 'connect-provider';

export type OverviewCheck = {
  id: 'addon' | 'service' | 'provider' | 'game';
  tone: CheckTone;
  title: string;
  detail?: string;
  /** Short status shown on the right when there is no action. */
  status?: string;
  action?: CheckAction;
};

export type OverviewInput = {
  readiness: Readiness;
  addonUpdateNotice?: 'reload_required' | 'failed' | null;
  status?: { ready: boolean; gameConnected: boolean; model: string } | null;
  starting: boolean;
  providerConnected: boolean;
  modelName?: string;
};

const headers: Record<Readiness, { title: string; description: string; tone: CheckTone }> = {
  loading: {
    title: 'Checking Wisp…',
    description: 'Checking your installation and connections.',
    tone: 'pending',
  },
  updating: {
    title: 'Updating your Wisp addon',
    description: 'Wisp is updating the addon in your WoW folder to match this app.',
    tone: 'pending',
  },
  update: {
    title: 'Update your Wisp addon',
    description: 'The addon in your WoW folder is older than this app.',
    tone: 'problem',
  },
  starting: {
    title: 'Wisp is starting',
    description: 'The checks update when the local service is ready.',
    tone: 'pending',
  },
  unavailable: {
    title: 'Wisp is unavailable',
    description: 'The local service isn’t running. Diagnostics shows why.',
    tone: 'problem',
  },
  setup: {
    title: 'Set up World of Warcraft',
    description: 'Install the Wisp addon to use your companion in game.',
    tone: 'problem',
  },
  agent: {
    title: 'Waiting for the agent',
    description: 'You can manage AI providers and saved data while you wait.',
    tone: 'pending',
  },
  account: {
    title: 'Connect your AI account',
    description: 'Wisp needs a model to answer in game.',
    tone: 'problem',
  },
  // WoW not running is not a problem: everything Wisp controls is ready.
  waiting: {
    title: 'Wisp is ready',
    description: 'Open WoW and type /wisp in chat.',
    tone: 'ok',
  },
  ready: {
    title: 'Wisp is ready',
    description: 'Type /wisp in WoW chat to open your companion.',
    tone: 'ok',
  },
};

/** Title, one-line hint and tone for the Overview header. */
export function overviewHeader(readiness: Readiness, addonUpdateNotice?: string | null) {
  const header = headers[readiness];
  return readiness === 'update' && addonUpdateNotice === 'failed'
    ? {
        ...header,
        description: 'Wisp couldn’t update the addon automatically. Try updating it again below.',
      }
    : header;
}

function addonCheck({ readiness, addonUpdateNotice }: OverviewInput): OverviewCheck {
  if (readiness === 'updating') {
    return {
      id: 'addon',
      tone: 'pending',
      title: 'Updating addon',
      detail: 'This usually takes a few seconds.',
      status: 'Updating…',
    };
  }
  if (readiness === 'update') {
    return {
      id: 'addon',
      tone: 'problem',
      title: addonUpdateNotice === 'failed' ? 'Addon update failed' : 'Addon out of date',
      detail: 'Update the addon, then type /reload in WoW.',
      action: 'update-addon',
    };
  }
  if (addonUpdateNotice === 'reload_required') {
    return {
      id: 'addon',
      tone: 'ok',
      title: 'Addon updated',
      detail: 'Wisp updated the addon. Type /reload in WoW to finish updating.',
      action: 'dismiss-reload',
    };
  }
  return { id: 'addon', tone: 'ok', title: 'Addon installed', detail: 'Up to date' };
}

function serviceCheck({ status, starting, readiness }: OverviewInput): OverviewCheck {
  if (status?.ready) return { id: 'service', tone: 'ok', title: 'Wisp service running' };
  if (status) {
    return {
      id: 'service',
      tone: 'pending',
      title: 'Starting the agent',
      detail: 'This usually takes a few seconds.',
      action: 'view-diagnostics',
    };
  }
  if (starting || readiness === 'starting') {
    return { id: 'service', tone: 'pending', title: 'Starting the Wisp service' };
  }
  return {
    id: 'service',
    tone: 'problem',
    title: 'Wisp service isn’t running',
    detail: 'Wisp runs a local service while it’s in the tray.',
    action: 'view-diagnostics',
  };
}

function providerCheck({ status, providerConnected, modelName }: OverviewInput): OverviewCheck {
  if (!status) {
    return {
      id: 'provider',
      tone: 'idle',
      title: 'AI provider',
      detail: 'Checked when the Wisp service starts.',
    };
  }
  if (providerConnected) {
    return {
      id: 'provider',
      tone: 'ok',
      title: 'AI provider connected',
      detail: modelName || status.model,
      action: 'change-provider',
    };
  }
  return {
    id: 'provider',
    tone: 'problem',
    title: 'No AI provider connected',
    detail: 'Use a ChatGPT or Grok plan, or an API key.',
    action: 'connect-provider',
  };
}

function gameCheck({ status }: OverviewInput): OverviewCheck {
  return status?.gameConnected
    ? { id: 'game', tone: 'ok', title: 'World of Warcraft', detail: 'Connected' }
    : {
        id: 'game',
        tone: 'idle',
        title: 'World of Warcraft',
        detail: 'Connects automatically when you log in with the addon enabled.',
        status: 'Not connected',
      };
}

/** What Overview checks, in display order. Pure, so every state is testable. */
export function overviewChecks(input: OverviewInput): OverviewCheck[] {
  return [addonCheck(input), serviceCheck(input), providerCheck(input), gameCheck(input)];
}
