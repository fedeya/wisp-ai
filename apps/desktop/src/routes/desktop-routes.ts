export const desktopPages = [
  {
    name: 'Overview',
    path: '/',
    icon: 'home',
    title: 'Wisp status',
    caption: 'Check your game connection, addon and AI provider.',
  },
  {
    name: 'Connections',
    path: '/connections',
    icon: 'link',
    title: 'AI connections',
    caption: 'Connect AI providers and choose your default model.',
  },
  {
    name: 'Integrations',
    path: '/integrations',
    icon: 'tools',
    title: 'Integrations',
    caption: 'Choose which addons, data sources and tools Wisp can use.',
  },
  {
    name: 'Memory',
    path: '/memory',
    icon: 'logs',
    title: 'Memory',
    caption: 'Control saved preferences and character plans.',
  },
  {
    name: 'Panels',
    path: '/panels',
    icon: 'panel',
    title: 'Panels',
    caption: 'Manage your in-game trackers.',
  },
  {
    name: 'Routines',
    path: '/routines',
    icon: 'spark',
    title: 'Routines',
    caption: 'Manage routines created in chat and review their runs.',
  },
  {
    name: 'Settings',
    path: '/settings',
    icon: 'refresh',
    title: 'Settings',
    caption: 'Updates and preferences for the desktop app.',
  },
  {
    name: 'Diagnostics',
    path: '/diagnostics',
    icon: 'logs',
    title: 'Diagnostics',
    caption: 'View connection details and logs.',
  },
] as const;

export type DesktopPage = (typeof desktopPages)[number];
