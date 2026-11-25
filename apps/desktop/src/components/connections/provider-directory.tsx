import { providerDefinitions, providerId, type ProviderId } from '@wisp/protocol/providers';
import Icon from '../ui/Icon';

const featured = {
  openai: { name: 'ChatGPT', description: 'Subscription or API key' },
  anthropic: { name: 'Claude', description: 'Anthropic API key' },
  google: { name: 'Gemini', description: 'Google API key' },
  deepseek: { name: 'DeepSeek', description: 'DeepSeek API key' },
  xai: { name: 'Grok', description: 'Subscription or API key' },
  mistral: { name: 'Mistral', description: 'Mistral API key' },
  alibaba: { name: 'Qwen', description: 'Alibaba Cloud API key' },
  moonshotai: { name: 'Kimi', description: 'Moonshot API key' },
  minimax: { name: 'MiniMax', description: 'MiniMax API key' },
} satisfies Partial<Record<ProviderId, { name: string; description: string }>>;

export const featuredProviders = Object.keys(featured) as (keyof typeof featured)[];

const modelProviderAliases = new Map<string, ProviderId>([
  ['mistralai', 'mistral'],
  ['moonshot', 'moonshotai'],
  ['qwen', 'alibaba'],
  ['spacexai', 'xai'],
  ['x-ai', 'xai'],
  ['z-ai', 'zai'],
]);

export function modelProvider(provider: ProviderId, modelId: string): ProviderId {
  if (provider !== 'openrouter' && provider !== 'gateway' && provider !== 'compatible') {
    return provider;
  }
  const separator = modelId.indexOf('/');
  if (separator === -1) return provider;
  const namespace = modelId.slice(0, separator).toLowerCase();
  return (
    modelProviderAliases.get(namespace) ?? providerId.safeParse(namespace).data ?? 'compatible'
  );
}

export function providerPresentation(id: ProviderId) {
  const definition = providerDefinitions.find((provider) => provider.id === id)!;
  const entry = (featured as Partial<Record<ProviderId, { name: string; description: string }>>)[
    id
  ];
  return {
    name: entry?.name ?? definition.name,
    description:
      entry?.description ?? (id === 'compatible' ? 'Local or custom endpoint' : 'API key'),
  };
}

const logos = import.meta.glob<string>('../../assets/providers/*.svg', {
  eager: true,
  import: 'default',
  query: '?url&no-inline',
});
const lightLogos = new Set<ProviderId>([
  'openai',
  'xai',
  'moonshotai',
  'gateway',
  'groq',
  'baseten',
  'zai',
]);

export function ProviderLogo({ provider }: { provider: ProviderId }) {
  const src = logos[`../../assets/providers/${provider}.svg`];
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-selected text-muted">
      {src ? (
        <img
          className={`size-[22px] object-contain ${lightLogos.has(provider) ? 'invert' : ''}`}
          src={src}
          alt=""
        />
      ) : (
        <Icon name="server" size={19} />
      )}
    </span>
  );
}
