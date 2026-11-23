import Settings from './Settings';
import Diagnostics from './Diagnostics';
import Experimental from './Experimental';
import Memory from './Memory';
import Panels from './Panels';
import Routines from './Routines';
import Connections from './Connections';
import Integrations from './Integrations';
import Overview from './Overview';

export const connectionsPage = {
  name: 'Connections',
  Component: Connections,
  path: '/connections',
  group: 'setup',
  icon: 'plug',
  title: 'AI Providers',
} as const;

export const integrationsPage = {
  name: 'Integrations',
  Component: Integrations,
  path: '/integrations',
  group: 'setup',
  icon: 'puzzle',
  title: 'Integrations',
} as const;

export const desktopPages = [
  {
    name: 'Overview',
    Component: Overview,
    path: '/',
    group: 'overview',
    icon: 'home',
    title: 'Overview',
    caption: 'Check your game connection, addon and AI provider.',
  },
  connectionsPage,
  integrationsPage,
  {
    name: 'Memory',
    Component: Memory,
    path: '/memory',
    group: 'workspace',
    icon: 'brain',
    title: 'Memory',
    caption: 'Control saved preferences and character plans.',
  },
  {
    name: 'Panels',
    Component: Panels,
    path: '/panels',
    group: 'workspace',
    icon: 'panel',
    title: 'Panels',
    caption: 'Manage your in-game trackers.',
  },
  {
    name: 'Routines',
    Component: Routines,
    path: '/routines',
    group: 'workspace',
    icon: 'workflow',
    title: 'Routines',
    caption: 'Manage routines created in chat and review their runs.',
  },
  {
    name: 'Settings',
    Component: Settings,
    path: '/settings',
    group: 'application',
    icon: 'settings',
    title: 'Settings',
    caption: 'Updates and preferences for the desktop app.',
  },
] as const;

/** Troubleshooting page, reached from Settings and from failing checks, not the sidebar. */
export const diagnosticsPage = {
  name: 'Diagnostics',
  Component: Diagnostics,
  path: '/settings/diagnostics',
  group: 'application',
  icon: 'scrollText',
  title: 'Diagnostics',
  caption: 'Logs and connection details for troubleshooting.',
} as const;

/** Feature flags this build ships, reached from Settings only while there are any. */
export const experimentalPage = {
  name: 'Experimental',
  Component: Experimental,
  path: '/settings/experimental',
  group: 'application',
  icon: 'spark',
  title: 'Experimental',
  caption: 'Try features that are still in testing, or turn them off.',
} as const;

export type DesktopPage =
  | (typeof desktopPages)[number]
  | typeof diagnosticsPage
  | typeof experimentalPage;
