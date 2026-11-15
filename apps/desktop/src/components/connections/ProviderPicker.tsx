import { Dialog } from '@base-ui/react/dialog';
import { providerDefinitions, type ProviderId } from '@wisp/protocol/providers';
import { type ReactNode, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Input } from '../ui/Controls';
import { button } from '../ui/Controls/styles';
import Icon from '../ui/Icon';
import { featuredProviders, ProviderLogo, providerPresentation } from './provider-directory';

const providerOrder = new Set<ProviderId>([
  ...featuredProviders,
  ...providerDefinitions.map(({ id }) => id),
]);

export default function ProviderPicker({
  configured,
  children,
}: {
  configured: ReadonlySet<ProviderId>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchField = useRef<HTMLInputElement>(null);
  const search = query.trim().toLowerCase();
  const options = [...providerOrder]
    .filter((id) => !configured.has(id))
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
        <Dialog.Backdrop className="fixed inset-0 z-20 bg-[#050c10b8]" />
        <Dialog.Viewport className="fixed inset-0 z-20 grid place-items-center px-4 py-6">
          <Dialog.Popup
            className="flex max-h-[min(460px,calc(100vh-48px))] w-full max-w-[540px] flex-col rounded-[13px] border border-solid border-[#40555a] bg-surface shadow-[0_25px_100px_#0009]"
            initialFocus={searchField}
          >
            <div className="grid gap-3 border-b [border-bottom-style:solid] border-b-border p-4">
              <div className="flex items-center justify-between gap-3">
                <Dialog.Title className="m-0 text-[18px] font-semibold">Add provider</Dialog.Title>
                <Dialog.Close
                  aria-label="Close provider picker"
                  className={button({ intent: 'quiet', size: 'icon' })}
                >
                  <Icon name="close" size={17} />
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
            <div className="catalog-scroll min-h-0 overflow-y-auto p-2.5">
              {options.length ? (
                <ul className="m-0 grid list-none gap-0.5 p-0">
                  {options.map(({ id, name, description }) => (
                    <li key={id}>
                      <Link
                        to={`/connections/${id}`}
                        onClick={() => setOpen(false)}
                        aria-label={name}
                        className={button({
                          intent: 'quiet',
                          class:
                            'flex w-full justify-between whitespace-normal px-2 py-1.5 text-left no-underline hover:bg-[#293b40]',
                        })}
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <ProviderLogo provider={id} />
                          <span className="grid min-w-0 text-[13px]">
                            <strong>{name}</strong>
                            <span className="text-muted">{description}</span>
                          </span>
                        </span>
                        <span className="shrink-0 text-muted">
                          <Icon name="arrow" size={16} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 px-3 py-3 text-[13px] text-muted" role="status">
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
