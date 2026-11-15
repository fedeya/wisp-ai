import TelemetrySettings from '../components/settings/TelemetrySettings';
import Diagnostics from './Diagnostics';
import Memory from './Memory';
import Panels from './Panels';
import Routines from './Routines';
import Connections from './Connections';
import Integrations from './Integrations';
import Overview from './Overview';

export const desktopPages = [
  {
    name: 'Overview',
    Component: Overview,
    path: '/',
    icon: 'home',
    title: 'Wisp status',
    caption: 'Check your game connection, addon and AI provider.',
  },
  {
    name: 'Connections',
    Component: Connections,
    path: '/connections',
    icon: 'link',
    title: 'AI connections',
    caption: 'Connect AI providers and choose your default model.',
  },
  {
    name: 'Integrations',
    Component: Integrations,
    path: '/integrations',
    icon: 'tools',
    title: 'Integrations',
    caption: 'Manage web search, game addons, and other tools Wisp can use.',
  },
  {
    name: 'Memory',
    Component: Memory,
    path: '/memory',
    icon: 'logs',
    title: 'Memory',
    caption: 'Control saved preferences and character plans.',
  },
  {
    name: 'Panels',
    Component: Panels,
    path: '/panels',
    icon: 'panel',
    title: 'Panels',
    caption: 'Manage your in-game trackers.',
  },
  {
    name: 'Routines',
    Component: Routines,
    path: '/routines',
    icon: 'spark',
    title: 'Routines',
    caption: 'Manage routines created in chat and review their runs.',
  },
  {
    name: 'Settings',
    Component: TelemetrySettings,
    path: '/settings',
    icon: 'refresh',
    title: 'Settings',
    caption: 'Updates and preferences for the desktop app.',
  },
  {
    name: 'Diagnostics',
    Component: Diagnostics,
    path: '/diagnostics',
    icon: 'logs',
    title: 'Diagnostics',
    caption: 'View connection details and logs.',
  },
] as const;

export type DesktopPage = (typeof desktopPages)[number];
