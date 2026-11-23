import { useEffect, useRef } from 'react';
import { Navigate, useLocation, useParams } from 'react-router';
import { integrationGuide } from '../components/integrations/integration-guides';
import {
  capabilityStatus,
  IntegrationIcon,
  IntegrationStatus,
  integrationType,
  mcpTransport,
  needsAddonSetup,
} from '../components/integrations/integration-presentation';
import {
  AboutIntegration,
  IntegrationTools,
  TryAsking,
} from '../components/integrations/IntegrationSections';
import { McpDialogTrigger } from '../components/integrations/McpDialogTrigger';
import WebSearchSettings from '../components/integrations/WebSearchSettings';
import { ActionProgress } from '../components/ui/ActionProgress';
import { Button, Card } from '../components/ui/Controls';
import DataState from '../components/ui/DataState';
import Icon from '../components/ui/Icon';
import Toggle from '../components/ui/Toggle';
import { desktopLocked } from '../desktop-controller';
import { useDesktop, useDesktopActions } from '../use-desktop';

export default function IntegrationDetails() {
  const { integrationId } = useParams();
  const { search } = useLocation();
  const webSearch = integrationId === 'web-search';
  const id = webSearch ? 'integration:web' : integrationId;
  const { loading, status, locked, busy, busyTarget } = useDesktop((state) => ({
    loading: state.loading,
    status: state.status,
    locked: desktopLocked(state),
    busy: state.busy,
    busyTarget: state.busyTarget,
  }));
  const { setIntegration, testMcp, removeMcp } = useDesktopActions();
  const entry = status?.integrations.find(
    (item) => item.id === id && item.group === 'integrations' && !item.parent,
  );
  const server = status?.mcps.find((item) => 'mcp:' + item.name === id);
  const name = webSearch ? 'Web search' : (entry?.name ?? server?.name);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, [id, name]);

  if (loading || !status || !id) return <DataState />;
  if (!name || integrationId === 'integration:web') {
    return <Navigate to={{ pathname: '/integrations', search }} replace />;
  }

  const { icon, label } = integrationType(entry?.kind);
  const guide = integrationGuide(id);
  const tools = status.integrations.filter((tool) => tool.parent === id);
  const updating =
    busy === 'Updating integration' &&
    (busyTarget === id || tools.some((tool) => tool.id === busyTarget));
  const meta = [
    server ? mcpTransport[server.transport] : label,
    entry?.version && `v${entry.version}`,
  ].filter(Boolean);
  const description = webSearch
    ? 'Search with ChatGPT or Exa and read public pages.'
    : entry?.description;

  return (
    <div>
      <header className="mb-3 flex items-center gap-3">
        <IntegrationIcon id={id} icon={webSearch ? 'globe' : server ? 'server' : icon} />
        <div className="min-w-0 flex-1">
          <h1 className="m-0 outline-none [overflow-wrap:anywhere]" ref={title} tabIndex={-1}>
            {name}
          </h1>
          <p className="m-0 text-[13px] text-muted">{meta.join(' · ')}</p>
        </div>
        {entry && (
          <div className="flex shrink-0 items-center gap-3">
            {updating && <ActionProgress label={busy} />}
            {!webSearch && <IntegrationStatus {...capabilityStatus(entry)} />}
            <Toggle
              label={`Enable ${entry.name}`}
              checked={entry.enabled}
              disabled={locked}
              onChange={(checked) => setIntegration(entry.id, checked)}
            />
          </div>
        )}
      </header>
      {description && <p className="mt-0 mb-5 text-base text-subtle">{description}</p>}
      {entry?.reason && (
        <p className="mt-0 mb-5 flex items-start gap-2 rounded-[6px] bg-warning-dim px-4 py-3 text-sm text-warning">
          <Icon name="warning" size={15} />
          <span>{entry.reason}</span>
        </p>
      )}
      {entry && needsAddonSetup(entry) && (
        <Card>
          <h2>Set up {entry.name}</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] text-muted">
            <li>
              Install or update {entry.id === 'integration:questie' ? 'QuestieDB' : entry.name} for
              WoW Forever.
            </li>
            <li>Enable the addon in WoW’s AddOns menu, then reload your UI.</li>
          </ol>
        </Card>
      )}
      {webSearch && <WebSearchSettings />}
      {guide && <TryAsking examples={guide.examples} />}
      {entry && (
        <IntegrationTools
          label={webSearch ? 'Web tools' : 'What Wisp can do'}
          entry={entry}
          tools={tools}
          locked={locked}
          set={setIntegration}
        />
      )}
      {server && (
        <Card className="grid gap-3">
          <h2 className="m-0">Connection</h2>
          <div className="flex flex-wrap items-center gap-2.5">
            <McpDialogTrigger key={server.name} server={server} />
            <Button onClick={() => testMcp(server)} disabled={locked}>
              Test connection
            </Button>
            <Button intent="quiet" destructive onClick={() => removeMcp(server)} disabled={locked}>
              Remove
            </Button>
            <ActionProgress label={busyTarget === id && !updating ? busy : ''} />
          </div>
        </Card>
      )}
      {guide && <AboutIntegration guide={guide} />}
    </div>
  );
}
