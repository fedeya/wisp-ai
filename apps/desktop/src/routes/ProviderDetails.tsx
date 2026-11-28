import { Option, Schema } from 'effect';
import { providerId } from '@wisp/protocol/providers';
import { useEffect, useRef } from 'react';
import { Navigate, useParams } from 'react-router';
import ProviderConfiguration from '../components/connections/ProviderConfiguration';
import { ProviderLogo, providerPresentation } from '../components/connections/provider-directory';

const decodeProvider = Schema.decodeUnknownOption(providerId);

export default function ProviderDetails() {
  const { provider } = useParams();
  const parsed = decodeProvider(provider);
  const title = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    title.current?.focus();
  }, [provider]);

  if (Option.isNone(parsed)) return <Navigate to="/connections" replace />;
  const id = parsed.value;
  const { name } = providerPresentation(id);

  return (
    <div className="max-w-[780px]">
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
