import { desktopLocked } from '../desktop-controller';
import { Dialog } from '@base-ui/react/dialog';
import { useRef } from 'react';
import type { Mcp } from '../api';
import IntegrationCard from '../components/integrations/IntegrationCard';
import McpDialog, { type McpFormActions } from '../components/integrations/McpDialog';
import WebSearchSettings from '../components/integrations/WebSearchSettings';
import { ActionProgress } from '../components/ui/ActionProgress';
import DataState from '../components/ui/DataState';
import Icon from '../components/ui/Icon';
import { button } from '../components/ui/Controls/styles';
import { Button, Card } from '../components/ui/Controls';
import { useDesktop } from '../use-desktop';

function useIntegrations() {
  return useDesktop((state) => ({
    locked: desktopLocked(state),
    busy: state.busy,
    busyTarget: state.busyTarget,
    setIntegration: state.actions.setIntegration,
    testMcp: state.actions.testMcp,
    removeMcp: state.actions.removeMcp,
    loading: state.loading,
    status: state.status,
    refreshAfterWrite: state.actions.refreshAfterWrite,
  }));
}

type IntegrationsView = ReturnType<typeof useIntegrations>;

function IntegrationList({
  app,
  status,
}: {
  app: IntegrationsView;
  status: NonNullable<IntegrationsView['status']>;
}) {
  const entries = status.integrations.filter(
    (entry) => entry.group === 'integrations' && !entry.parent,
  );
  return (
    <>
      <div className="toolbar flex items-center justify-between mb-[18px]">
        <p className="muted text-muted text-[12px]">{status.mcps.length} custom connections</p>
        <Dialog.Trigger
          className={button({ intent: 'primary' })}
          disabled={app.locked}
          payload={null}
        >
          <Icon name="plus" size={17} />
          Add MCP
        </Dialog.Trigger>
      </div>
      <div className="connection-list">
        {entries.map((entry) => {
          const tools = status.integrations.filter((tool) => tool.parent === entry.id);
          const server = status.mcps.find((item) => entry.id === 'mcp:' + item.name);
          const updating =
            app.busy === 'Updating integration' &&
            (app.busyTarget === entry.id || tools.some((tool) => tool.id === app.busyTarget));
          return (
            <div
              key={entry.id}
              className="integration-group border border-solid border-border rounded-[12px] [background:var(--surface)] mb-[14px] overflow-hidden [&_.integration]:border-0 [&_.integration]:m-0 [&_.integration]:rounded-[0] [&_.integration]:[background:transparent]"
            >
              <IntegrationCard
                entry={entry}
                tools={tools}
                locked={app.locked}
                busy={updating ? app.busy : ''}
                set={app.setIntegration}
              />
              {server && (
                <div className="actions gap-[10px] px-[22px] py-[12px] m-0 flex flex-wrap items-center border-t-[1px] [border-top-style:solid] border-t-[var(--border)]">
                  <ActionProgress label={app.busyTarget === entry.id ? app.busy : ''} />
                  <Dialog.Trigger className={button()} payload={server} disabled={app.locked}>
                    Edit
                  </Dialog.Trigger>
                  <Button onClick={() => app.testMcp(server)} disabled={app.locked}>
                    Test connection
                  </Button>
                  <Button
                    intent="quiet"
                    destructive
                    onClick={() => app.removeMcp(server)}
                    disabled={app.locked}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </div>
          );
        })}
        {entries.length === 0 && (
          <Card kind="empty" className="text-center [&_>_svg]:text-[#577e7c] [&_>_svg]:mb-[16px]">
            <h2 className="text-[21px]">No game or custom integrations yet</h2>
            <p className="mx-auto text-muted text-[13px] max-w-[400px] mt-[12px] mb-[23px]">
              Connect WoW to discover supported addons, or add an MCP server to give Wisp more
              tools.
            </p>
          </Card>
        )}
      </div>
      <p className="footnote text-[11px]! text-muted mt-[12px]">
        Changes apply to new tool calls. Disabling an integration preserves individual tool choices.
        Addon availability updates when WoW connects.
      </p>
    </>
  );
}

export default function Integrations() {
  const app = useIntegrations();
  const actions = useRef<Dialog.Root.Actions>(null);
  const formRef = useRef<McpFormActions>(null);
  return (
    <Dialog.Root<Mcp | null>
      actionsRef={actions}
      disablePointerDismissal
      onOpenChange={(open, details) => {
        if (!open && details.reason !== 'imperative-action' && formRef.current?.isSubmitting()) {
          details.cancel();
        }
      }}
    >
      {({ payload }) => (
        <>
          <WebSearchSettings />
          {app.loading || !app.status ? (
            <DataState />
          ) : (
            <IntegrationList app={app} status={app.status} />
          )}
          <McpDialog
            server={payload ?? null}
            formRef={formRef}
            close={() => actions.current?.close()}
            saved={app.refreshAfterWrite}
          />
        </>
      )}
    </Dialog.Root>
  );
}
