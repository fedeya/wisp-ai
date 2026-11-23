import { useEffect, useRef, type ComponentProps } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import type { Status } from '../api';
import {
  capabilityStatus,
  IntegrationIcon,
  IntegrationStatus,
  integrationType,
  mcpTransport,
  needsAddonSetup,
} from '../components/integrations/integration-presentation';
import { McpDialogTrigger } from '../components/integrations/McpDialogTrigger';
import { searchProviderLabel } from '../components/integrations/WebSearchSettings';
import { Card, Input } from '../components/ui/Controls';
import { button } from '../components/ui/Controls/styles';
import DataState from '../components/ui/DataState';
import Icon from '../components/ui/Icon';
import { useDesktop } from '../use-desktop';

const categories = [
  {
    id: 'quests',
    label: 'Quests & navigation',
    integrations: ['integration:questie', 'integration:polestar'],
  },
  {
    id: 'databases',
    label: 'Game databases',
    integrations: ['integration:thewowdb', 'mcp:everloot'],
  },
  {
    id: 'inventory',
    label: 'Inventory & auctions',
    integrations: ['integration:syndicator', 'integration:auctionator'],
  },
  { id: 'simulation', label: 'Combat simulation', integrations: ['integration:wowsims'] },
  { id: 'web', label: 'Web tools', integrations: ['web-search'] },
  { id: 'other', label: 'Other integrations', integrations: [] },
  { id: 'mcp', label: 'MCP servers', integrations: [] },
] as const;

type Category = (typeof categories)[number]['id'];
const categoryById = new Map<string, Category>();
for (const category of categories) {
  for (const id of category.integrations) categoryById.set(id, category.id);
}

type Row = {
  id: string;
  category: Category;
  icon: ComponentProps<typeof IntegrationIcon>['icon'];
  name: string;
  description: string;
  status: ComponentProps<typeof IntegrationStatus>;
  action: string;
};

function directoryRows(status: Status): Row[] {
  const entries = new Map(
    status.integrations
      .filter((entry) => entry.group === 'integrations' && !entry.parent)
      .map((entry) => [entry.id, entry]),
  );
  const web = entries.get('integration:web');
  entries.delete('integration:web');
  const mode = status.search?.provider;
  const webStatus =
    web && !web.enabled
      ? 'Disabled'
      : mode === 'disabled'
        ? 'Search off'
        : searchProviderLabel(mode);
  const rows: Row[] = [
    {
      id: 'web-search',
      category: 'web',
      icon: 'globe',
      name: 'Web search',
      description: 'Search with ChatGPT or Exa and read public pages.',
      status: { label: webStatus, tone: 'neutral' },
      action: 'Configure',
    },
  ];
  for (const server of status.mcps) {
    const id = 'mcp:' + server.name;
    const entry = entries.get(id);
    entries.delete(id);
    rows.push({
      id,
      category: 'mcp',
      icon: 'server',
      name: entry?.name ?? server.name,
      description: server.description || mcpTransport[server.transport],
      status: capabilityStatus(
        entry ?? { enabled: server.enabled, available: true, status: 'configured' },
      ),
      action: 'Manage',
    });
  }
  for (const entry of entries.values()) {
    const { icon, label } = integrationType(entry.kind);
    rows.push({
      id: entry.id,
      category: categoryById.get(entry.id) ?? 'other',
      icon,
      name: entry.name,
      description: entry.description || label,
      status: capabilityStatus(entry),
      action: needsAddonSetup(entry) ? 'Setup instructions' : 'Manage',
    });
  }
  return rows;
}

function IntegrationRow({ row, search }: { row: Row; search: string }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_minmax(96px,124px)_132px] items-center gap-3 px-3 py-2.5 max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-y-1">
      <div className="flex min-w-0 items-center gap-3 max-sm:row-span-2">
        <IntegrationIcon id={row.id} icon={row.icon} />
        <div className="min-w-0">
          <h3 className="m-0 text-[14px] font-semibold [overflow-wrap:anywhere]">{row.name}</h3>
          <p className="m-0 text-[12px] leading-snug text-muted [overflow-wrap:anywhere]">
            {row.description}
          </p>
        </div>
      </div>
      <IntegrationStatus {...row.status} />
      <Link
        to={{ pathname: '/integrations/' + encodeURIComponent(row.id), search }}
        aria-label={row.action + ' ' + row.name}
        className={button({
          class:
            'min-h-[31px] justify-self-end px-2.5 py-1 text-[12px] no-underline hover:border-[#568780] hover:bg-[#2a3d3f] max-sm:col-start-2',
        })}
      >
        {row.action}
      </Link>
    </li>
  );
}

export default function Integrations() {
  const { loading, status } = useDesktop((state) => ({
    loading: state.loading,
    status: state.status,
  }));
  const [params, setParams] = useSearchParams();
  const { search } = useLocation();
  const title = useRef<HTMLHeadingElement>(null);
  const results = useRef<HTMLDivElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, []);

  const rows = status ? directoryRows(status) : [];
  const visibleCategories = categories.filter(
    ({ id }) => id !== 'other' || rows.some((row) => row.category === id),
  );
  const selected = visibleCategories.find(({ id }) => id === params.get('category'))?.id ?? 'all';
  const query = params.get('q') ?? '';
  const normalizedQuery = query.trim().toLowerCase();
  const matches = rows.filter(
    ({ category, name, description }) =>
      (selected === 'all' || selected === category) &&
      (name + ' ' + description).toLowerCase().includes(normalizedQuery),
  );
  const showAdd = !normalizedQuery && (selected === 'all' || selected === 'mcp');

  useEffect(() => {
    if (results.current) results.current.scrollTop = 0;
  }, [selected, normalizedQuery]);

  function updateFilter(key: 'q' | 'category', value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="mb-5 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <h1 ref={title} tabIndex={-1} className="m-0 outline-none">
          Integrations
        </h1>
        {status && !loading && (
          <label className="relative w-full max-w-[225px]">
            <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-muted">
              <Icon name="search" size={16} />
            </span>
            <Input
              type="search"
              aria-label="Search integrations"
              placeholder="Search integrations"
              className="min-h-[35px] py-1 pl-8 text-[13px]"
              value={query}
              onChange={(event) => updateFilter('q', event.currentTarget.value)}
            />
          </label>
        )}
      </header>
      {loading || !status ? (
        <div className="min-h-0 overflow-y-auto">
          <DataState />
        </div>
      ) : (
        <>
          <div
            role="group"
            aria-label="Filter by category"
            className="mb-4 flex shrink-0 flex-wrap items-center gap-1"
          >
            {[{ id: 'all', label: 'All' }, ...visibleCategories].map(({ id, label }) => {
              const pressed = selected === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => updateFilter('category', id === 'all' ? '' : id)}
                  className={button({
                    intent: pressed ? 'default' : 'quiet',
                    class: 'min-h-[30px] px-2.5 py-1 text-[12px]',
                  })}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div
            ref={results}
            role="region"
            aria-label="Integration results"
            tabIndex={0}
            className="catalog-scroll -mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-5 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
          >
            <div className="grid gap-[15px]">
              {visibleCategories.map(({ id, label }) => {
                const group = matches.filter((row) => row.category === id);
                if (!group.length) return null;
                const heading = 'integration-category-' + id;
                return (
                  <section key={id} aria-labelledby={heading}>
                    <h2
                      id={heading}
                      className={
                        selected === 'all'
                          ? 'mb-2.5 ml-px text-[13px] font-semibold text-muted'
                          : 'sr-only'
                      }
                    >
                      {label}
                    </h2>
                    <Card className="mb-0 rounded-[9px] p-0">
                      <ul className="m-0 list-none divide-y [--tw-divide-style:solid] divide-border p-0">
                        {group.map((row) => (
                          <IntegrationRow key={row.id} row={row} search={search} />
                        ))}
                      </ul>
                    </Card>
                  </section>
                );
              })}
              {matches.length === 0 && !showAdd && (
                <p role="status" className="text-[13px] text-muted">
                  No integrations match your search.
                </p>
              )}
              {showAdd && (
                <Card className="mb-0 flex flex-wrap items-center gap-3 rounded-[9px] px-3 py-2.5">
                  <IntegrationIcon icon="server" />
                  <div className="min-w-[120px] flex-1">
                    <h2 className="m-0 text-[14px]">Add a server</h2>
                    <p className="m-0 text-[12px] text-muted">
                      {status.mcps.length
                        ? 'Connect another MCP server.'
                        : 'Connect an MCP server to give Wisp more tools.'}
                    </p>
                  </div>
                  <McpDialogTrigger />
                </Card>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
