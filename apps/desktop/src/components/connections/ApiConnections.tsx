import { providerDefinitions, type ConnectionView } from '@wisp/protocol/providers';
import { useState } from 'react';
import { request } from '../../api';
import { ActionProgress } from '../ui/ActionProgress';
import { Button, Card } from '../ui/Controls';
import ConnectionEditor from './ConnectionEditor';
import { desktopLocked } from '../../desktop-controller';
import { useDesktop, useDesktopActions } from '../../use-desktop';

export default function ApiConnections() {
  const app = useDesktop((state) => ({
    busy: state.busy,
    busyTarget: state.busyTarget,
    locked: desktopLocked(state),
    online: !!state.status,
    connections: state.status?.connections,
  }));
  const { loadModels, setConfirmation, work } = useDesktopActions();
  const [editing, setEditing] = useState<{ connection?: ConnectionView } | null>(null);

  return (
    <Card kind="provider">
      <div className="section-title gap-[18px] flex items-center justify-between [&_>_svg]:text-muted">
        <div>
          <h2>API connections</h2>
          <p className="text-muted text-[13px]">
            Use your own API key. Usage is billed by the selected provider.
          </p>
        </div>
        <Button disabled={app.locked || !app.online || !!editing} onClick={() => setEditing({})}>
          Add connection
        </Button>
      </div>
      {app.connections?.map((connection) => (
        <div
          key={connection.id}
          className="api-connection-row gap-[16px] px-0 py-[16px] flex items-center justify-between border-b-[1px] [border-bottom-style:solid] border-b-[var(--border)] max-sm:items-start max-sm:flex-col"
        >
          <div>
            <strong>{connection.name}</strong>
            <p className="muted text-muted text-[13px]">
              {providerDefinitions.find((item) => item.id === connection.provider)?.name} ·{' '}
              {connection.models.length} model{connection.models.length === 1 ? '' : 's'} ·{' '}
              {connection.hasKey
                ? 'Key saved'
                : connection.provider === 'compatible'
                  ? 'Local / no key'
                  : 'Key missing'}
            </p>
          </div>
          <div className="actions gap-[10px] mt-[22px] flex flex-wrap items-center">
            <Button disabled={app.locked || !!editing} onClick={() => setEditing({ connection })}>
              Edit
            </Button>
            <Button
              intent="quiet"
              destructive
              disabled={app.locked || !!editing}
              onClick={() =>
                setConfirmation({
                  label: `Remove “${connection.name}”? Chats and memory stay on this computer. Chats using this connection will need another model.`,
                  run: () =>
                    work(
                      'Removing AI connection',
                      async () => {
                        await request('/connections/remove', { id: connection.id });
                        await loadModels();
                      },
                      'Connection removed.',
                      'connections',
                    ),
                })
              }
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
      <ActionProgress label={app.busyTarget === 'connections' ? app.busy : ''} />
      {editing && (
        <ConnectionEditor connection={editing.connection} close={() => setEditing(null)} />
      )}
      <p className="privacy-note gap-[7px] text-[11px]! flex items-center mt-[25px] text-[#789c91]!">
        API keys are protected by your operating system. Configure Exa under Web search to use web
        search with API models. Game tools and other enabled databases work independently of the
        search service.
      </p>
    </Card>
  );
}
