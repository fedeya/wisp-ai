import type { ProviderId } from '@wisp/protocol/providers';
import ApiConnections from './ApiConnections';
import ChatGptConnection from './ChatGptConnection';

export default function ProviderConfiguration({ provider }: { provider: ProviderId }) {
  return (
    <>
      {provider === 'openai' && <ChatGptConnection />}
      <ApiConnections key={provider} provider={provider} />
    </>
  );
}
