import { Fragment } from 'react';
import { Link, NavLink } from 'react-router';
import { desktopReadiness } from '../desktop-controller';
import { desktopPages, type DesktopPage } from '../routes/desktop-routes';
import { useDesktop } from '../use-desktop';
import { shortcutFor } from '../native-shell';
import { navigationLink } from './ui/Controls/styles';
import Icon from './ui/Icon';

const overview = desktopPages[0];
const mainGroups = [
  { label: 'Setup', pages: desktopPages.filter((page) => page.group === 'setup') },
  {
    label: 'Workspace',
    pages: desktopPages.filter((page) => page.group === 'workspace'),
  },
];
const applicationPages = desktopPages.filter((page) => page.group === 'application');

const readinessLabels = {
  loading: 'Checking Wisp…',
  update: 'Addon update needed',
  starting: 'Starting Wisp…',
  unavailable: 'Wisp unavailable',
  setup: 'Set up WoW',
  agent: 'Waiting for the agent',
  account: 'Connect an AI provider',
  waiting: 'Ready · waiting for WoW',
  ready: 'Wisp is ready',
};

function renderNavigation(page: DesktopPage) {
  const shortcut = shortcutFor(page.path);
  return (
    <NavLink
      key={page.path}
      to={page.path}
      title={shortcut ? `${page.title} (${shortcut})` : undefined}
      aria-keyshortcuts={shortcut?.replace(',', 'Comma')}
      end={page.path === '/'}
      className={({ isActive }) => navigationLink({ selected: isActive })}
    >
      <Icon name={page.icon} size={16} />
      {page.title}
    </NavLink>
  );
}

export default function DesktopSidebar() {
  const readiness = useDesktop(desktopReadiness);
  const dotColor =
    readiness === 'ready'
      ? 'bg-accent'
      : readiness === 'update' || readiness === 'account' || readiness === 'setup'
        ? 'bg-warning'
        : 'bg-muted';

  return (
    <aside className="app-scroll flex h-full w-[224px] shrink-0 flex-col gap-2 overflow-y-auto bg-sidebar px-2 pt-3 pb-2 max-md:w-[200px]">
      <nav className="flex flex-col gap-2" aria-label="Main navigation">
        {renderNavigation(overview)}
        {mainGroups.map(({ label, pages }) => (
          <Fragment key={label}>
            <div aria-hidden="true" className="mx-2.5 h-px bg-divider" />
            <div role="group" aria-label={label} className="flex flex-col gap-0.5">
              {pages.map(renderNavigation)}
            </div>
          </Fragment>
        ))}
      </nav>
      <nav className="mt-auto flex flex-col gap-0.5" aria-label="App settings">
        {applicationPages.map(renderNavigation)}
      </nav>
      <div className="border-0 border-t border-solid border-divider pt-1.5">
        <Link
          to={overview.path}
          className="flex min-h-[34px] items-center gap-2 rounded-[4px] px-2.5 text-sm leading-tight text-subtle no-underline transition-colors duration-75 hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent"
        >
          <span aria-hidden="true" className={`size-[7px] shrink-0 rounded-full ${dotColor}`} />
          <span
            className="min-w-0 flex-1 truncate"
            title={readinessLabels[readiness]}
            aria-live="polite"
          >
            {readinessLabels[readiness]}
          </span>
          <Icon name="chevronRight" size={14} />
        </Link>
      </div>
    </aside>
  );
}
