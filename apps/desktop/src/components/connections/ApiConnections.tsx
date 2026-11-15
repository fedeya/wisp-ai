import { providerDefinitions, type ConnectionView } from '@wisp/protocol/providers';
import { useState } from 'react';
import { Link } from 'react-router';
import { request } from '../../api';
import { ActionProgress } from '../ui/ActionProgress';
import { Button, Card } from '../ui/Controls';
import ConnectionEditor from './ConnectionEditor';
import { desktopLocked } from '../../desktop-controller';
import { useDesktop, useDesktopActions } from '../../use-desktop';

export default function ApiConnections({ firstRun = false }: { firstRun?: boolean }) {
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
    <Card
      kind="provider"
      className={firstRun ? (editing ? 'col-span-full p-5' : 'p-5') : undefined}
    >
      <div
        className={`section-title flex gap-4 ${firstRun ? 'flex-col items-start' : 'items-center justify-between'}`}
      >
        <div>
          <h2>{firstRun ? 'API provider' : 'API connections'}</h2>
          <p className="text-muted text-[13px]">
            Use your own API key. Usage is billed by the selected provider.
          </p>
        </div>
        <Button disabled={app.locked || !app.online || !!editing} onClick={() => setEditing({})}>
          {firstRun ? 'Add API provider' : 'Add connection'}
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
      {!firstRun && (
        <p className="mt-4 text-[13px] text-muted">
          API keys are protected by your operating system.{' '}
          <Link to="/integrations" className="text-accent">
            Configure web search in Integrations
          </Link>
          .
        </p>
      )}
    </Card>
  );
}
