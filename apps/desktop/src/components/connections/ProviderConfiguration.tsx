import type { ProviderId } from '@wisp/protocol/providers';
import ApiConnections from './ApiConnections';
import ChatGptConnection from './ChatGptConnection';
import GrokConnection from './GrokConnection';

export default function ProviderConfiguration({ provider }: { provider: ProviderId }) {
  return (
    <>
      {provider === 'openai' && <ChatGptConnection />}
      {provider === 'xai' && <GrokConnection />}
      <ApiConnections key={provider} provider={provider} />
    </>
  );
}
