import { useEffect } from 'react';
import { createMemoryRouter, Outlet, useMatches, useNavigate } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { desktop, native } from './api';
import DesktopSidebar from './components/DesktopSidebar';
import ConfirmationDialog from './components/ui/ConfirmationDialog';
import FeedbackToast from './components/ui/FeedbackToast';
import Updates from './components/updates/Updates';
import { useDesktop } from './use-desktop';
import { mountDesktop } from './desktop-controller';
import { connectionsPage, desktopPages, type DesktopPage } from './routes/desktop-routes';
import ProviderDetails from './routes/ProviderDetails';
import Onboarding from './components/onboarding/Onboarding';
import { Spinner } from './components/ui/ActionProgress';

function DesktopShell() {
  const app = useDesktop((state) => ({
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
          <DesktopSidebar />
          <main className="min-w-0 max-w-[1450px] flex-1 px-[32px] pt-[34px] pb-[80px] max-lg:px-[24px] max-lg:pt-[27px] max-md:px-[22px] max-md:pt-[26px]">
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
        { path: '/connections/:provider', Component: ProviderDetails, handle: connectionsPage },
      ],
    },
  ]);
}

export default function App({ router }: { router: ReturnType<typeof createDesktopRouter> }) {
  useEffect(mountDesktop, []);

  return <RouterProvider router={router} />;
}
