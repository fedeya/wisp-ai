import {
  maxConnectionModels,
  type ConnectionModel,
  type DiscoveredConnectionModel,
  type ProviderId,
} from '@wisp/protocol/providers';
import { useState } from 'react';
import { Button, Input } from '../ui/Controls';
import Icon from '../ui/Icon';
import { modelProvider, ProviderLogo } from './provider-directory';

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
  const available = models.filter(({ supportsTools }) => supportsTools === true);
  const search = query.trim().toLowerCase();
  const results = available.filter(
    ({ id, name }) => id.toLowerCase().includes(search) || name?.toLowerCase().includes(search),
  );
  const selectedIds = new Set(selected.map(({ id }) => id));
  const atLimit = selected.length >= maxConnectionModels;

  return (
    <section aria-label="Provider model catalog" className="grid min-w-0 gap-2.5">
      {available.length > 0 && (
        <>
          <Input
            type="search"
            aria-label="Search provider models"
            placeholder="Search by name or model ID"
            value={query}
            onChange={({ currentTarget }) => setQuery(currentTarget.value)}
          />
          <p role="status" className="m-0 text-[12px] text-muted">
            {search
              ? `${results.length} of ${available.length} models`
              : `${available.length} ${available.length === 1 ? 'model' : 'models'}`}
            {atLimit && ` · Connection limit of ${maxConnectionModels} reached`}
          </p>
        </>
      )}
      {results.length ? (
        <ul className="catalog-scroll m-0 max-h-[250px] list-none divide-y [--tw-divide-style:solid] divide-border overflow-y-auto rounded-[9px] border border-solid border-border bg-surface p-0">
          {results.map(({ id, name }) => {
            const added = selectedIds.has(id);
            const canAdd = !locked && !added && !atLimit;
            return (
              <li
                key={id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 p-2.5"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <ProviderLogo provider={modelProvider(provider, id)} />
                  <div className="min-w-0 [overflow-wrap:anywhere]">
                    <strong className="block text-[13px]">{name || id}</strong>
                    {name && name !== id && (
                      <span className="block text-[12px] text-muted">{id}</span>
                    )}
                  </div>
                </div>
                <Button
                  className={`min-h-8 min-w-[80px] gap-1.5 rounded-[7px] px-2.5 py-1 text-[12px] font-semibold aria-disabled:cursor-default ${
                    added
                      ? 'border-transparent bg-transparent text-muted enabled:hover:border-transparent enabled:hover:bg-transparent'
                      : 'border-[#375d53] bg-[#263f39] text-accent enabled:hover:border-[#629b8f] enabled:hover:bg-[#2d4b43] aria-disabled:opacity-50'
                  }`}
                  aria-disabled={!canAdd}
                  aria-label={`${added ? 'Added' : 'Add'} ${id}`}
                  onClick={() => {
                    if (canAdd) onAdd(id);
                  }}
                >
                  <Icon name={added ? 'check' : 'plus'} size={15} />
                  {added ? 'Added' : 'Add'}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="m-0 rounded-[9px] border border-solid border-border p-3 text-[13px] text-muted">
          {available.length
            ? 'No models match your search.'
            : 'No supported models found. You can add a model manually below.'}
        </p>
      )}
    </section>
  );
}
