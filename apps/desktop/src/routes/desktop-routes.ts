import TelemetrySettings from '../components/settings/TelemetrySettings';
import Diagnostics from './Diagnostics';
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
    Component: TelemetrySettings,
    path: '/settings',
    group: 'application',
    icon: 'settings',
    title: 'Settings',
    caption: 'Updates and preferences for the desktop app.',
  },
  {
    name: 'Diagnostics',
    Component: Diagnostics,
    path: '/diagnostics',
    group: 'application',
    icon: 'scrollText',
    title: 'Diagnostics',
    caption: 'View connection details and logs.',
  },
] as const;

export type DesktopPage = (typeof desktopPages)[number];
