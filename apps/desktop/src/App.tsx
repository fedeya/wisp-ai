import { useEffect } from 'react';
import { createMemoryRouter, NavLink, Outlet, useMatches, useNavigate } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import logo from '../../../assets/wisp.png';
import { desktop, native } from './api';
import ConfirmationDialog from './components/ui/ConfirmationDialog';
import Icon from './components/ui/Icon';
import { Button } from './components/ui/Controls';
import { navigationLink } from './components/ui/Controls/styles';
import Updates from './components/updates/Updates';
import { useDesktop } from './use-desktop';
import { mountDesktop } from './desktop-controller';
import { connectionsPage, desktopPages, type DesktopPage } from './routes/desktop-routes';
import ProviderDetails from './routes/ProviderDetails';
import Onboarding from './components/onboarding/Onboarding';
import { Spinner } from './components/ui/ActionProgress';

function isUtilityPage(page: DesktopPage) {
  return page.name === 'Settings' || page.name === 'Diagnostics';
}

function DesktopShell() {
  const app = useDesktop((state) => ({
    showLogs: state.actions.showLogs,
    info: state.info,
    setBusy: state.actions.setBusy,
    busy: state.busy,
    clearFeedback: state.actions.clearFeedback,
    failed: state.failed,
    feedback: state.feedback,
    loading: state.loading,
    onboarding: state.onboarding,
  }));
  const navigate = useNavigate();
  const page = (useMatches().at(-1)?.handle as DesktopPage | undefined) ?? desktopPages[0];
  const { busy, clearFeedback, failed, feedback, loading } = app;

  useEffect(() => {
    if (native && !loading && !app.onboarding) {
      void desktop('telemetry_screen', { screen: page.name }).catch(() => {});
    }
  }, [app.onboarding, loading, page.name]);

  useEffect(() => {
    if (!feedback || busy) return;
    const timer = setTimeout(clearFeedback, failed ? 10000 : 5000);
    return () => clearTimeout(timer);
  }, [busy, clearFeedback, failed, feedback]);

  function renderNavigation(item: DesktopPage) {
    return (
      <NavLink
        key={item.name}
        to={item.path}
        end={item.name !== 'Connections'}
        className={({ isActive }) => navigationLink({ selected: isActive })}
        onClick={(event) => {
          if (item.name === page.name && item.name === 'Diagnostics') {
            event.preventDefault();
            void app.showLogs();
          }
        }}
      >
        <Icon name={item.icon} />
        {item.name}
      </NavLink>
    );
  }

  return (
    <>
      {native && loading && !app.info ? (
        <main className="grid min-h-screen place-items-center">
          <p className="flex items-center gap-3 text-muted" role="status">
            <Spinner />
            Checking Wisp…
          </p>
        </main>
      ) : app.onboarding ? (
        <Onboarding />
      ) : (
        <div className="flex min-h-screen">
          <aside className="px-[14px] py-[26px] w-[210px] shrink-0 [background:#0f1316] fixed top-[0] right-[auto] bottom-[0] left-[0] flex flex-col border-r-[1px] [border-right-style:solid] border-r-[#1b2529] overflow-y-auto max-md:w-[190px] [@media(height<=700px)]:py-[20px]">
            <div className="brand gap-[10px] px-[8px] py-0 flex items-center [@media(height<=700px)]:mb-[24px]">
              <img className="w-[36px] h-[48px] object-contain" src={logo} alt="" />
              <div>
                <strong className="text-[29px] tracking-[-1px] block">Wisp</strong>
                <span className="block text-[#798f96] tracking-[1.5px] text-[9px] whitespace-nowrap mt-[4px]">
                  AI COMPANION
                </span>
              </div>
            </div>
            <p className="tagline px-[12px] py-0 mx-0 text-muted text-[12px] mt-[22px] mb-[30px] [@media(height<=700px)]:hidden">
              A little help in Azeroth.
            </p>
            <nav
              className="gap-[4px] flex flex-col [@media(height<=700px)]:gap-[2px]"
              aria-label="Main navigation"
            >
              <span className="nav-label px-[14px] pt-0 pb-[9px] text-muted text-[11px] tracking-[1px] uppercase">
                Workspace
              </span>
              {desktopPages.filter((item) => !isUtilityPage(item)).map(renderNavigation)}
            </nav>
            <nav
              className="utility-nav gap-[4px] flex flex-col mt-auto pt-[28px] [@media(height<=700px)]:gap-[2px] [@media(height<=700px)]:pt-[16px]"
              aria-label="App settings"
            >
              <span className="nav-label px-[14px] pt-0 pb-[9px] text-muted text-[11px] tracking-[1px] uppercase">
                Application
              </span>
              {desktopPages.filter(isUtilityPage).map(renderNavigation)}
            </nav>
            <div className="rail-footer gap-[7px] px-[12px] mt-[18px] pt-[18px] pb-0 text-[#769099] tracking-[0.8px] text-[12px] flex items-center flex-wrap [@media(height<=700px)]:mt-[12px] [@media(height<=700px)]:pt-[12px]">
              <span>Wisp AI</span>
              <span className="version ml-auto tracking-[0]">v{app.info?.version || '0.0.7'}</span>
            </div>
          </aside>
          <main className="px-[32px] ml-[210px] pt-[34px] pb-[80px] min-w-[0] w-[calc(100%_-_210px)] max-w-[1450px] max-lg:px-[24px] max-lg:pt-[27px] max-md:px-[22px] max-md:ml-[190px] max-md:pt-[26px] max-md:w-[calc(100%_-_190px)]">
            {page.name !== 'Overview' && page.name !== 'Connections' && (
              <header className="page-header gap-[18px] mb-[28px] flex flex-wrap items-start justify-between max-lg:gap-[12px]">
                <div>
                  <h1>{page.title}</h1>
                  <p className="text-muted text-[13px]">{page.caption}</p>
                </div>
              </header>
            )}
            {!native && (
              <div className="banner gap-[12px] border border-solid border-[#355c56] px-[16px] py-[12px] flex items-center rounded-[9px] [background:#1c3330] text-[#b7e8db] mb-[20px] text-[12px] leading-[1.5] [&_.icon-button]:ml-auto">
                Design preview. Desktop actions are available in the installed Wisp app.
              </div>
            )}
            <Updates
              showSettings={page.name === 'Settings'}
              version={app.info?.version || '0.0.7'}
              locked={!!busy}
              openSettings={() => void navigate('/settings')}
              onBusy={app.setBusy}
            />
            <Outlet />
          </main>
        </div>
      )}
      {feedback && !busy && (
        <div
          className={`notification gap-[12px] border border-solid border-[#40695e] px-[15px] py-[13px] fixed right-[24px] bottom-[22px] z-[30] flex items-center w-[max-content] max-w-[min(580px,_calc(100vw_-_48px))] rounded-[12px] [background:#20352f] text-[#d5eee4] [box-shadow:0_8px_32px_#0005] text-[13px] leading-[1.5] [&_>_svg]:shrink-0 [&.error]:border-[#89564c] [&.error]:[background:#382824] [&.error]:text-[#ffd2c8]${failed ? ' error' : ''}`}
          role="status"
          aria-live="polite"
        >
          <Icon name={failed ? 'logs' : 'check'} size={18} />
          <span className="[overflow-wrap:anywhere]">{feedback}</span>
          <Button
            intent="quiet"
            size="icon"
            className="shrink-0"
            aria-label="Dismiss notification"
            onClick={clearFeedback}
          >
            <Icon name="close" size={16} />
          </Button>
        </div>
      )}
      <ConfirmationDialog />
    </>
  );
}

export function createDesktopRouter() {
  return createMemoryRouter([
    {
      Component: DesktopShell,
      children: [
        ...desktopPages.map((page) => ({
          id: page.name,
          path: page.path,
          Component: page.Component,
          handle: page,
        })),
        { path: '/connections/:provider', Component: ProviderDetails, handle: connectionsPage },
      ],
    },
  ]);
}

export default function App({ router }: { router: ReturnType<typeof createDesktopRouter> }) {
  useEffect(mountDesktop, []);

  return <RouterProvider router={router} />;
}
