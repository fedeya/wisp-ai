import {
  maxConnectionModels,
  type ConnectionModel,
  type DiscoveredConnectionModel,
  type ProviderId,
} from '@wisp/protocol/providers';
import { useState } from 'react';
import { Button, Checkbox, Input } from '../ui/Controls';

export default function ModelCatalog({
  provider,
  models,
  selected,
  locked,
  onAdd,
}: {
  provider: ProviderId;
  models: DiscoveredConnectionModel[];
  selected: ConnectionModel[];
  locked: boolean;
  onAdd: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [toolsFilter, setToolsFilter] = useState<boolean>();
  const toolsOnly =
    toolsFilter ??
    ((provider === 'openrouter' || provider === 'gateway') &&
      models.some(({ supportsTools }) => supportsTools !== undefined));
  const search = query.trim().toLowerCase();
  const results = models.filter(
    ({ id, name, supportsTools }) =>
      (!toolsOnly || supportsTools === true) &&
      (id.toLowerCase().includes(search) || name?.toLowerCase().includes(search)),
  );
  const selectedIds = new Set(selected.map(({ id }) => id));
  const atLimit = selected.length >= maxConnectionModels;

  return (
    <section aria-label="Provider model catalog" className="grid min-w-0 gap-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <Input
          type="search"
          aria-label="Search provider models"
          placeholder="Search by name or model ID"
          className="min-w-0 flex-1"
          value={query}
          onChange={({ currentTarget }) => setQuery(currentTarget.value)}
        />
        <label className="flex shrink-0 items-center gap-2 text-[13px] text-muted">
          <Checkbox
            checked={toolsOnly}
            onChange={({ currentTarget }) => setToolsFilter(currentTarget.checked)}
          />
          Tool calling only
        </label>
      </div>
      <p role="status" className="m-0 text-[12px] text-muted">
        {results.length} of {models.length} models
        {atLimit && ` · Connection limit of ${maxConnectionModels} reached`}
      </p>
      {results.length ? (
        <ul className="m-0 max-h-[250px] list-none divide-y [--tw-divide-style:solid] divide-border overflow-y-auto rounded-[9px] border border-solid border-border bg-surface p-0">
          {results.map(({ id, name, supportsTools }) => {
            const added = selectedIds.has(id);
            const canAdd = !locked && !added && !atLimit;
            return (
              <li
                key={id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 p-2.5"
              >
                <div className="min-w-0 [overflow-wrap:anywhere]">
                  <strong className="block text-[13px]">{name || id}</strong>
                  {name && name !== id && (
                    <span className="block text-[12px] text-muted">{id}</span>
                  )}
                  <span className="block text-[12px] text-muted">
                    {supportsTools === true
                      ? 'Tool calling'
                      : supportsTools === false
                        ? 'No tool calling'
                        : 'Tool calling unknown'}
                  </span>
                </div>
                <Button
                  intent="quiet"
                  className="aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:border-transparent aria-disabled:hover:bg-transparent"
                  aria-disabled={!canAdd}
                  aria-label={`${added ? 'Added' : 'Add'} ${id}`}
                  onClick={() => {
                    if (canAdd) onAdd(id);
                  }}
                >
                  {added ? 'Added' : 'Add'}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="m-0 rounded-[9px] border border-solid border-border p-3 text-[13px] text-muted">
          {toolsOnly
            ? 'No matches with tool calling. Turn off the filter to see other models.'
            : 'No models match your search.'}
        </p>
      )}
    </section>
  );
}
