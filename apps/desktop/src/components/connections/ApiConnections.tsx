import type { ConnectionView, ProviderId } from '@wisp/protocol/providers';
import { useState } from 'react';
import { bridge, call } from '../../api';
import { ActionProgress } from '../ui/ActionProgress';
import { Button, Card } from '../ui/Controls';
import ConnectionEditor from './ConnectionEditor';
import { desktopLocked } from '../../desktop-controller';
import { useDesktop, useDesktopActions } from '../../use-desktop';

export default function ApiConnections({ provider }: { provider: ProviderId }) {
  const app = useDesktop((state) => ({
    busy: state.busy,
    busyTarget: state.busyTarget,
    locked: desktopLocked(state),
    online: !!state.status,
    connections: state.status?.connections,
  }));
  const { loadModels, setConfirmation, work } = useDesktopActions();
  const [editing, setEditing] = useState<{ connection?: ConnectionView } | null>(null);
  const [dismissedInitialEditor, dismissInitialEditor] = useState(false);
  const connections =
    app.connections?.filter((connection) => provider === connection.provider) ?? [];
  const activeEditor: { connection?: ConnectionView } | null =
    editing ??
    (provider !== 'openai' &&
    provider !== 'xai' &&
    app.online &&
    !connections.length &&
    !dismissedInitialEditor
      ? {}
      : null);

  function closeEditor() {
    dismissInitialEditor(true);
    setEditing(null);
  }

  return (
    <Card kind="provider" className="p-5">
      <div className="section-title flex items-center justify-between gap-4">
        <div>
          <h2>
            {provider === 'openai'
              ? 'OpenAI API'
              : provider === 'xai'
                ? 'xAI API'
                : 'API connections'}
          </h2>
          <p className="text-muted text-[13px]">
            {provider === 'compatible'
              ? 'Use a local or custom OpenAI-compatible endpoint.'
              : 'Use your own API key. Usage is billed by the provider.'}
          </p>
        </div>
        {!activeEditor && (
          <Button disabled={app.locked || !app.online} onClick={() => setEditing({})}>
            Add API connection
          </Button>
        )}
      </div>
      {!app.online && (
        <p className="mt-3 text-muted">
          API connections are unavailable while the Wisp service is unreachable.
        </p>
      )}
      {connections.map((connection) => (
        <div
          key={connection.id}
          className="api-connection-row gap-[16px] px-0 py-[16px] flex items-center justify-between border-b-[1px] [border-bottom-style:solid] border-b-[var(--border)] max-sm:items-start max-sm:flex-col"
        >
          <div>
            <strong>{connection.name}</strong>
            <p className="muted text-muted text-[13px]">
              {connection.models.length} model{connection.models.length === 1 ? '' : 's'} ·{' '}
              {connection.hasKey
                ? 'Key saved'
                : connection.provider === 'compatible'
                  ? 'Local / no key'
                  : 'Key missing'}
            </p>
          </div>
          <div className="actions gap-[10px] mt-[22px] flex flex-wrap items-center">
            <Button
              disabled={app.locked || !!activeEditor}
              onClick={() => setEditing({ connection })}
            >
              Edit
            </Button>
            <Button
              intent="quiet"
              destructive
              disabled={app.locked || !!activeEditor}
              onClick={() =>
                setConfirmation({
                  label: `Remove “${connection.name}”? Chats and memory stay on this computer. Chats using this connection will need another model.`,
                  run: () =>
                    work(
                      'Removing AI connection',
                      async () => {
                        await call(
                          bridge.connections.remove.$post({ json: { id: connection.id } }),
                        );
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
      {activeEditor && (
        <ConnectionEditor
          connection={activeEditor.connection}
          provider={provider}
          close={closeEditor}
        />
      )}
    </Card>
  );
}
