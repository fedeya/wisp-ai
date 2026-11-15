import { Link, NavLink } from 'react-router';
import logo from '../../../../assets/wisp.png';
import { desktopReadiness } from '../desktop-controller';
import { desktopPages, type DesktopPage } from '../routes/desktop-routes';
import { useDesktop } from '../use-desktop';
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
  stopped: 'Wisp stopped',
  account: 'Connect an AI provider',
  waiting: 'Waiting for WoW',
  ready: 'Wisp is ready',
};

function renderNavigation(page: DesktopPage) {
  return (
    <NavLink
      key={page.path}
      to={page.path}
      end={page.name !== 'Connections' && page.name !== 'Integrations'}
      className={({ isActive }) => navigationLink({ selected: isActive })}
    >
      <Icon name={page.icon} size={18} />
      {page.title}
    </NavLink>
  );
}

export default function DesktopSidebar() {
  const readiness = useDesktop(desktopReadiness);
  const dotColor =
    readiness === 'ready'
      ? 'bg-accent'
      : readiness === 'update' || readiness === 'account'
        ? 'bg-[#e8ba78]'
        : 'bg-muted';

  return (
    <aside className="sticky top-0 flex h-screen w-[210px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-r-[#1b2529] bg-[#0f1316] px-[14px] pt-5 pb-[14px] [border-right-style:solid] max-md:w-[190px] max-md:px-3">
      <div className="flex items-center gap-[10px] px-2">
        <img className="h-[38px] w-[30px] object-contain" src={logo} alt="" />
        <strong className="text-[27px] tracking-[-1px]">Wisp</strong>
      </div>
      <nav className="flex flex-col gap-3" aria-label="Main navigation">
        {renderNavigation(overview)}
        {mainGroups.map(({ label, pages }) => (
          <div key={label} role="group" aria-label={label} className="flex flex-col gap-0.5">
            {pages.map(renderNavigation)}
          </div>
        ))}
      </nav>
      <nav className="mt-auto flex flex-col gap-0.5" aria-label="App settings">
        {applicationPages.map(renderNavigation)}
      </nav>
      <div className="border-t border-t-[#1b2529] pt-1.5 [border-top-style:solid]">
        <Link
          to={overview.path}
          className="flex min-h-[40px] items-center gap-2 rounded-[7px] px-2.5 text-[12px] leading-tight text-inherit no-underline hover:bg-[#1e3333] hover:text-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent"
        >
          <span aria-hidden="true" className={`size-[7px] shrink-0 rounded-full ${dotColor}`} />
          <span className="flex-1" aria-live="polite">
            {readinessLabels[readiness]}
          </span>
          <Icon name="chevronRight" size={14} />
        </Link>
      </div>
    </aside>
  );
}
