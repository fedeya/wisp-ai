import { openaiModelCatalog } from '@ai-sdk/openai/internal';
import { getGoogleLanguageModelEntry } from '@ai-sdk/google/internal';
import type { ModelCapability } from '@ai-sdk/provider';
import type { ProviderId } from '@wisp/protocol/providers';

// Provider model lists from OpenAI and Google say nothing about tool calling, and
// they mix in embedding, image, speech and live models. The pinned SDK catalogs
// say which language models accept function tools. Unknown models stay
// undefined so discovery does not offer a model Wisp cannot use.
const openaiReasoningModels = new Set(['o1', 'o3', 'o3-mini', 'o3-pro', 'o4-mini']);
const googleAliases = /^gemini-(?:pro|flash|flash-lite)-latest$/;

function declared(capability: ModelCapability | undefined) {
  return typeof capability === 'boolean' ? capability : undefined;
}

export function modelToolSupport(provider: ProviderId, id: string): boolean | undefined {
  if (provider === 'openai') {
    const snapshotBase = id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    const entry = openaiModelCatalog[id] || openaiModelCatalog[snapshotBase];
    if (!entry && openaiReasoningModels.has(snapshotBase)) {
      return true;
    }
    return declared(entry?.capabilities.language?.tools.usage);
  }
  if (provider === 'google') {
    if (googleAliases.test(id)) {
      return true;
    }
    return declared(getGoogleLanguageModelEntry(id).capabilities.language.tools.usage);
  }
  return undefined;
}
