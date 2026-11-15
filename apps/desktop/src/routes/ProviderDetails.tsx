import { providerId } from '@wisp/protocol/providers';
import { useEffect, useRef } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import ProviderConfiguration from '../components/connections/ProviderConfiguration';
import { ProviderLogo, providerPresentation } from '../components/connections/provider-directory';
import Icon from '../components/ui/Icon';

export default function ProviderDetails() {
  const { provider } = useParams();
  const parsed = providerId.safeParse(provider);
  const title = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    title.current?.focus();
  }, [provider]);

  if (!parsed.success) return <Navigate to="/connections" replace />;
  const id = parsed.data;
  const { name } = providerPresentation(id);

  return (
    <div className="max-w-[780px]">
      <Link
        className="mb-4 inline-flex items-center gap-2 text-[13px] text-accent no-underline hover:underline"
        to="/connections"
      >
        <Icon name="back" size={16} />
        Back to AI Providers
      </Link>
      <header className="mb-5 flex items-center gap-3">
        <ProviderLogo provider={id} />
        <h1 className="mb-0 outline-none" ref={title} tabIndex={-1}>
          {name}
        </h1>
      </header>
      <ProviderConfiguration provider={id} />
    </div>
  );
}
