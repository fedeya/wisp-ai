import { Dialog } from '@base-ui/react/dialog';
import { providerDefinitions, type ProviderId } from '@wisp/protocol/providers';
import { type ReactNode, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Button, Input } from '../ui/Controls';
import { button, dialogBackdrop, floatingSurface } from '../ui/Controls/styles';
import Icon from '../ui/Icon';
import { featuredProviders, ProviderLogo, providerPresentation } from './provider-directory';

const providerOrder = new Set<ProviderId>([
  ...featuredProviders,
  ...providerDefinitions.map(({ id }) => id),
]);
const optionStyle =
  'group flex w-full justify-between whitespace-normal px-2 py-2 text-left font-normal no-underline';

export default function ProviderPicker({
  configured,
  children,
  onSelect,
}: {
  configured?: ReadonlySet<ProviderId>;
  children: ReactNode;
  onSelect?: (provider: ProviderId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchField = useRef<HTMLInputElement>(null);
  const search = query.trim().toLowerCase();
  const options = [...providerOrder]
    .filter((id) => !configured?.has(id))
    .map((id) => ({ id, ...providerPresentation(id) }))
    .filter(({ id, name, description }) =>
      [id, name, description].some((value) => value.toLowerCase().includes(search)),
    );

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setQuery('');
      }}
    >
      {children}
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdrop} />
        <Dialog.Viewport className="fixed inset-0 z-20 grid place-items-center px-4 py-6">
          <Dialog.Popup
            className={`grid h-[min(460px,calc(100dvh-48px))] w-full max-w-[520px] grid-rows-[auto_minmax(0,1fr)] overflow-hidden ${floatingSurface}`}
            initialFocus={searchField}
          >
            <div className="grid gap-3 border-0 border-b border-solid border-divider px-4 pt-3 pb-3">
              <div className="flex items-center justify-between gap-3">
                <Dialog.Title className="m-0 text-lg font-semibold">
                  {onSelect ? 'Browse providers' : 'Add provider'}
                </Dialog.Title>
                <Dialog.Close
                  aria-label="Close provider picker"
                  className={button({ intent: 'quiet', size: 'icon' })}
                >
                  <Icon name="close" size={16} />
                </Dialog.Close>
              </div>
              <Input
                ref={searchField}
                type="search"
                aria-label="Search providers"
                placeholder="Search by provider name"
                value={query}
                onChange={({ currentTarget }) => setQuery(currentTarget.value)}
              />
            </div>
            <div className="catalog-scroll min-h-0 overflow-y-auto p-1.5">
              {options.length ? (
                <ul className="m-0 grid list-none gap-0.5 p-0">
                  {options.map(({ id, name, description }) => {
                    const content = (
                      <>
                        <span className="flex min-w-0 items-center gap-3">
                          <ProviderLogo provider={id} />
                          <span className="grid min-w-0">
                            <span className="text-base font-medium">{name}</span>
                            <span className="text-sm text-muted">{description}</span>
                          </span>
                        </span>
                        <span className="shrink-0 text-muted opacity-0 transition-opacity duration-75 group-hover:opacity-100 group-focus-visible:opacity-100">
                          <Icon name="chevronRight" size={16} />
                        </span>
                      </>
                    );
                    return (
                      <li key={id}>
                        {onSelect ? (
                          <Button
                            intent="quiet"
                            className={optionStyle}
                            aria-label={name}
                            onClick={() => {
                              setOpen(false);
                              onSelect(id);
                            }}
                          >
                            {content}
                          </Button>
                        ) : (
                          <Link
                            to={`/connections/${id}`}
                            onClick={() => setOpen(false)}
                            aria-label={name}
                            className={button({ intent: 'quiet', class: optionStyle })}
                          >
                            {content}
                          </Link>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="m-0 px-3 py-3 text-sm text-muted" role="status">
                  No providers found.
                </p>
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function AddProviderTrigger() {
  return (
    <Dialog.Trigger className={button({ intent: 'primary' })}>
      <Icon name="plus" size={17} />
      Add provider
    </Dialog.Trigger>
  );
}

export function BrowseProvidersTrigger() {
  return (
    <Dialog.Trigger className={button({ intent: 'quiet', class: 'w-fit px-0 text-accent' })}>
      Browse providers
      <Icon name="arrow" size={16} />
    </Dialog.Trigger>
  );
}
