import type { ProviderId } from '@wisp/protocol/providers';

// Input limits, in tokens, for model families whose providers do not report one
// in their model list (OpenAI, xAI, DeepSeek, Z.AI, MiniMax and others; the
// official Anthropic and Gemini APIs do). Wisp compacts conversations at a
// share of this number, so it is the largest prompt a model accepts, not its
// total window: OpenAI's 400K models take at most 272K of input. When a family
// varies by version or host the table keeps the smaller value: a low guess only
// compacts early, a high one makes requests fail. Order matters, the first
// matching pattern wins. Checked against the providers' docs in November 2026.
const families: [RegExp, number][] = [
  // OpenAI: 1.05M window minus 128K output, or 400K minus 128K.
  [/\bgpt-5(?:\.\d+)?-chat\b/, 128_000],
  [/\bgpt-5\.4-(?:mini|nano)\b/, 272_000],
  [/\bgpt-6\b|\bgpt-5\.(?:[4-9]|\d{2,})\b/, 922_000],
  [/\bgpt-5\b/, 272_000],
  [/\bgpt-4\.1\b/, 1_047_576],
  [/\bgpt-4o\b/, 128_000],
  [/\bgpt-4-(?:turbo|\d{4}-preview)\b/, 128_000],
  [/\bgpt-4\b/, 8_192],
  [/\bgpt-3\.5-turbo\b/, 16_385],
  [/\bgpt-oss\b/, 131_072],
  [/\bo1-(?:mini|preview)\b/, 128_000],
  [/\b(?:o1|o3|o4-mini|codex-mini)\b/, 200_000],
  // Anthropic: 1M from the 4.6 generation on (claude-opus-4-6, claude-opus-5-5).
  [/\bclaude-[a-z]+-(?:4[.-][6-9]|[5-9])\b/, 1_000_000],
  [/\bclaude-2\b/, 100_000],
  [/\bclaude\b/, 200_000],
  // Google
  [/\bgemini-1\.0\b|\bgemini-pro$/, 32_768],
  [/\bgemini\b/, 1_048_576],
  [/\bgemma-3\b/, 131_072],
  [/\bgemma\b/, 8_192],
  // xAI
  [/\bgrok-4\.(?:3|20)\b/, 1_000_000],
  [/\bgrok-4\.[5-9]\b|\bgrok-build\b/, 500_000],
  [/\bgrok-4\b.*\bfast\b/, 2_000_000],
  [/\bgrok-code-fast\b/, 256_000],
  [/\bgrok-4\b/, 256_000],
  [/\bgrok-[23]\b/, 131_072],
  // DeepSeek: V4 (deepseek-v4-pro, deepseek-flash) has 1M.
  [/\bdeepseek-(?:v4|flash)\b/, 1_000_000],
  [/\bdeepseek\b/, 128_000],
  // Mistral
  [/\bmagistral\b/, 40_000],
  [/\bcodestral\b/, 256_000],
  [/\b(?:mistral|ministral|pixtral|devstral)\b/, 128_000],
  // Moonshot
  [/\bkimi-k3\b/, 1_048_576],
  [/\bkimi-k2-0711\b/, 131_072],
  [/\bkimi-k2\b/, 262_144],
  [/\bkimi\b/, 131_072],
  // MiniMax: M3 advertises 1M but guarantees only 512K.
  [/\bminimax-m3\b/, 512_000],
  [/\bminimax-m1\b/, 1_000_000],
  [/\bminimax-m2\b/, 204_800],
  // Z.AI
  [/\bglm-5\.[2-9]\b/, 1_000_000],
  [/\bglm-5\b/, 200_000],
  [/\bglm-4\.[6-9]\b/, 200_000],
  [/\bglm-4\b/, 128_000],
  // Alibaba
  [/\bqwen3-coder-plus\b/, 1_000_000],
  [/\bqwen3-max\b/, 262_144],
  [/\bqwen3-coder\b|\bqwen3-.*-2507\b/, 262_144],
  [/\bqwen-max\b/, 32_768],
  [/\bqwen-(?:plus|turbo|flash)\b|\bqwq\b/, 131_072],
  [/\bqwen/, 32_768],
  // Meta
  [/\bllama-?3\.[1-3]\b|\bllama-?4\b/, 131_072],
  [/\bllama-?3\b/, 8_192],
  // Cohere
  [/\bcommand-a\b/, 256_000],
  [/\bcommand-r\b/, 128_000],
];

/** Used when neither the provider nor the table knows a model. */
export function fallbackContextWindow(provider: ProviderId) {
  // Local servers often run small windows (Ollama, LM Studio defaults).
  return provider === 'compatible' ? 32_768 : 128_000;
}

/** The known context window for a model ID, or undefined for an unknown family. */
export function knownContextWindow(id: string): number | undefined {
  // Aggregators prefix the vendor ("anthropic/claude-sonnet-4.5") and some
  // add a variant ("…:free"); only the model name says which family it is.
  const name = id.toLowerCase().replace(/^.*\//, '').replace(/:.*$/, '');
  // Names that carry their window: moonshot-v1-128k, gpt-4-32k.
  const sized = /-(\d{1,4})k\b/.exec(name);
  if (sized) {
    return Number(sized[1]) * 1024;
  }
  return families.find(([pattern]) => pattern.test(name))?.[1];
}

/** The context window Wisp should assume for a model the provider did not size. */
export function modelContextWindow(provider: ProviderId, id: string) {
  return knownContextWindow(id) ?? fallbackContextWindow(provider);
}
