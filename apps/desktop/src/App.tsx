import { useEffect } from 'react';
import {
  createMemoryRouter,
  Link,
  Outlet,
  useLocation,
  useMatches,
  useNavigate,
} from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { desktop, native } from './api';
import DesktopSidebar from './components/DesktopSidebar';
import WindowTitleBar from './components/WindowTitleBar';
import ConfirmationDialog from './components/ui/ConfirmationDialog';
import FeedbackToast from './components/ui/FeedbackToast';
import Icon from './components/ui/Icon';
import Updates from './components/updates/Updates';
import { useDesktop } from './use-desktop';
import { desktopActive, desktopReadiness, mountDesktop } from './desktop-controller';
import { installNativeShell, useAppShortcuts, useNativeNotifications } from './native-shell';
import {
  connectionsPage,
  desktopPages,
  diagnosticsPage,
  integrationsPage,
  type DesktopPage,
} from './routes/desktop-routes';
import IntegrationDetails from './routes/IntegrationDetails';
import ProviderDetails from './routes/ProviderDetails';
import Onboarding from './components/onboarding/Onboarding';
import { Spinner } from './components/ui/ActionProgress';
import { FeatureFlags } from './features';

/** Detail pages show a back link to their parent: `back`, or the page itself. */
type DesktopRouteHandle = DesktopPage & {
  detail?: true;
  back?: { path: string; title: string };
};

function DesktopShell() {
  const app = useDesktop((state) => ({
    info: state.info,
    setBusy: state.actions.setBusy,
    setAppUpdate: state.actions.setAppUpdate,
    busy: state.busy,
    clearFeedback: state.actions.clearFeedback,
    failed: state.failed,
    feedback: state.feedback,
    loading: state.loading,
    onboarding: state.onboarding,
  }));
  const navigate = useNavigate();
  const { search } = useLocation();
  const match = useMatches().at(-1);
  const page: DesktopRouteHandle =
    (match?.handle as DesktopRouteHandle | undefined) ?? desktopPages[0];
  const fixedHeight = match?.id === integrationsPage.name;
  const { busy, clearFeedback, failed, feedback, loading } = app;
  const readiness = useDesktop(desktopReadiness);
  // An automatic update restarts the bridge, so it waits until nothing uses it.
  // Whether WoW is open comes from the process list (see Updates), not the bridge.
  const idle = useDesktop((state) => !desktopActive(state));
  useAppShortcuts(!loading && !app.onboarding);
  useNativeNotifications(busy ? '' : feedback, failed, readiness);

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

  return (
    <>
      {native && loading && !app.info ? (
        <div className="flex h-screen flex-col overflow-hidden">
          <WindowTitleBar controls />
          <main className="grid flex-1 place-items-center">
            <p className="flex items-center gap-3 text-muted" role="status">
              <Spinner />
              Checking Wisp…
            </p>
          </main>
        </div>
      ) : app.onboarding ? (
        <div className="flex h-screen flex-col overflow-hidden bg-sidebar">
          <WindowTitleBar controls />
          <Onboarding />
        </div>
      ) : (
        <div className="flex h-screen flex-col overflow-hidden bg-sidebar">
          <WindowTitleBar controls />
          <div className="flex min-h-0 flex-1">
            <DesktopSidebar />
            <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-tl-[8px] border-0 border-t border-l border-solid border-divider bg-canvas [--page-gutter:32px] max-lg:[--page-gutter:24px] max-md:[--page-gutter:20px]">
              {page.detail && (
                <nav
                  aria-label="Detail navigation"
                  className="shrink-0 border-0 border-b border-solid border-border bg-sidebar"
                >
                  <div className="mx-auto flex min-h-[46px] w-full max-w-[1450px] items-center px-(--page-gutter)">
                    <Link
                      to={{ pathname: (page.back ?? page).path, search }}
                      aria-label={`Back to ${(page.back ?? page).title}`}
                      className="-ml-2 inline-flex min-h-8 items-center gap-2 rounded-md px-2 text-sm font-medium text-muted no-underline transition-colors hover:bg-surface hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      <Icon name="back" size={16} />
                      {(page.back ?? page).title}
                    </Link>
                  </div>
                </nav>
              )}
              <div
                className={`app-scroll flex min-h-0 flex-1 flex-col ${fixedHeight ? 'overflow-hidden [scrollbar-gutter:auto]' : 'overflow-y-auto'}`}
              >
                <div
                  className={`mx-auto w-full max-w-[1450px] min-w-0 px-(--page-gutter) ${page.detail ? 'pt-4' : 'pt-6'} ${fixedHeight ? 'flex min-h-0 flex-1 flex-col' : 'pb-10'}`}
                >
                  {page.name !== 'Overview' &&
                    page.name !== 'Connections' &&
                    page.name !== 'Integrations' && (
                      <header className="page-header gap-[18px] mb-[20px] flex flex-wrap items-start justify-between max-lg:gap-[12px]">
                        <div>
                          <h1>{page.title}</h1>
                          <p className="text-muted text-base">{page.caption}</p>
                        </div>
                      </header>
                    )}
                  {!native && (
                    <div className="banner gap-[12px] border border-solid border-[#355c56] px-[16px] py-[12px] flex items-center rounded-[6px] [background:#1c3330] text-[#b7e8db] mb-[20px] text-xs leading-[1.5] [&_.icon-button]:ml-auto">
                      Design preview. Desktop actions are available in the installed Wisp app.
                    </div>
                  )}
                  <Updates
                    showSettings={page.name === 'Settings'}
                    version={app.info?.version || '0.0.7'}
                    locked={!!busy}
                    openSettings={() => void navigate('/settings')}
                    onBusy={app.setBusy}
                    idle={idle && !busy}
                    onAvailable={app.setAppUpdate}
                  />
                  <Outlet />
                </div>
              </div>
            </main>
          </div>
        </div>
      )}
      <FeedbackToast message={busy ? '' : feedback} failed={failed} onDismiss={clearFeedback} />
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
        {
          path: '/connections/:provider',
          Component: ProviderDetails,
          handle: { ...connectionsPage, detail: true } satisfies DesktopRouteHandle,
        },
        {
          path: '/integrations/:integrationId',
          Component: IntegrationDetails,
          handle: { ...integrationsPage, detail: true } satisfies DesktopRouteHandle,
        },
        {
          id: diagnosticsPage.name,
          path: diagnosticsPage.path,
          Component: diagnosticsPage.Component,
          handle: {
            ...diagnosticsPage,
            detail: true,
            back: { path: '/settings', title: 'Settings' },
          } satisfies DesktopRouteHandle,
        },
      ],
    },
  ]);
}

export default function App({ router }: { router: ReturnType<typeof createDesktopRouter> }) {
  useEffect(mountDesktop, []);
  useEffect(installNativeShell, []);

  return (
    <FeatureFlags>
      <RouterProvider router={router} />
    </FeatureFlags>
  );
}
