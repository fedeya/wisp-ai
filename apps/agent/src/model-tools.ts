import type { createOpenAI } from '@ai-sdk/openai';
type CallOptions = Parameters<
  ReturnType<ReturnType<typeof createOpenAI>['responses']>['doStream']
>[0];

export const toolGroupNames = [
  'settings',
  'macros',
  'simulation',
  'panels',
  'routines',
  'ui',
  'quests',
  'group',
  'locations',
  'inventory',
  'training',
  'chat',
  'knowledge',
  'memory',
] as const;
const groupTools: Record<(typeof toolGroupNames)[number], string[]> = {
  settings: ['wow__get_settings', 'wow__update_settings', 'wow__undo_settings'],
  macros: ['wow__inspect_macros', 'wow__create_macro'],
  simulation: ['wowsims__simulate_dps'],
  panels: ['wisp__manage_panel'],
  routines: ['wisp__manage_routine'],
  ui: [],
  quests: ['questie__get_quest', 'questie__get_quest_chain', 'wow__query_progression'],
  group: ['wow__inspect_group'],
  locations: [
    'wow__inspect_map',
    'questie__find_npc_locations',
    'questie__find_object_locations',
    'wow__set_map_waypoint',
    'wow__clear_map_waypoint',
  ],
  inventory: [
    'wow__query_resources',
    'wow__compare_items',
    'wow__inspect_auctions',
    'syndicator__find_item',
    'auctionator__get_item_prices',
  ],
  training: ['wow__query_training', 'wow__inspect_trainer'],
  chat: ['wow__read_chat'],
  knowledge: [
    'thewowdb__search_database',
    'thewowdb__get_database_entity',
    'web__web_search',
    'web_fetch',
    'eve__search',
    'eve__tool',
    'web_search',
  ],
  memory: [
    'character__save_memory',
    'character__remove_memory',
    'preferences__save_memory',
    'preferences__remove_memory',
  ],
};
const groupDescriptions: Record<(typeof toolGroupNames)[number], string> = {
  settings: 'game addon settings configuration cvar graphics audio opciones ajustes configurar',
  macros: 'macro macros create crear',
  simulation: 'simulate simulation dps damage rotation simular daño rotacion',
  panels: 'panel tracker persistent saved materials seguimiento materiales',
  routines: 'routine recurring automatic schedule rutina automatico recurrente',
  ui: 'rich ui components controls cards interfaz botones',
  quests:
    'quest quests mission missions mision misiones chain prerequisites reputation cadena requisitos reputacion',
  group:
    'group party roster members helpful aura auras buff buffs missing grupo miembros beneficios',
  locations:
    'map npc trainer coordinates city service waypoint transmog transmogrifier location travel mapa ubicacion ciudad coordenadas entrenador',
  inventory:
    'inventory items gear equipment bags bank auction prices resources money skills crafting inventario objetos equipo bolsas banco subasta precios dinero profesiones',
  chat: 'chat messages said say yell party raid guild officer whisper public channel historial mensajes dijo dijeron grupo hermandad susurros',
  training:
    'trainer training offers skills abilities spells level catalog entrenador aprender entrenamiento habilidades hechizos nivel catalogo',
  knowledge:
    'database catalog search knowledge web fetch url page read scrape wowhead everloot source spell item npc guide buscar leer pagina enlace base datos fuente guia hechizo',
  memory: 'memory remember forget preference guide plan memoria recordar olvidar preferencias',
};
export function searchToolGroups(query: string) {
  const words = query
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
  const matches = toolGroupNames
    .map((group) => ({
      group,
      score: words.reduce(
        (score, word) =>
          score +
          ((' ' + groupDescriptions[group] + ' ' + groupTools[group].join(' '))
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .includes(word)
            ? 1
            : 0),
        0,
      ),
    }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return {
    enabledGroups: matches.map((match) => match.group),
    matches: matches.map(({ group }) => ({ group, tools: groupTools[group] })),
  };
}
const triggers: Record<string, (typeof toolGroupNames)[number][]> = {
  wow__get_settings: ['settings', 'ui'],
  wow__inspect_macros: ['macros'],
  wow__compare_items: ['ui'],
  wowsims__simulate_dps: ['simulation', 'ui'],
  wisp__manage_panel: ['panels', 'ui'],
  wisp__manage_routine: ['routines'],
};

export function compactModelContext(options: CallOptions): CallOptions {
  // Compaction and other non-interactive calls must retain their full context.
  if (!options.tools?.some((tool) => tool.name === 'wisp__load_tools')) {
    return options;
  }
  const groups = new Set<string>();
  let turnStart = 0;
  for (let i = 0; i < options.prompt.length; i++) {
    const message = options.prompt[i]!;
    if (
      message.role === 'user' &&
      message.content.some((part) => part.type === 'text' && part.text.includes('<user_message>'))
    ) {
      turnStart = i;
    }
  }
  for (const message of options.prompt.slice(turnStart)) {
    if (message.role !== 'tool') {
      continue;
    }
    for (const part of message.content) {
      if (part.type !== 'tool-result') {
        continue;
      }
      for (const [group, names] of Object.entries(groupTools)) {
        if (names.includes(part.toolName)) {
          groups.add(group);
        }
      }
      for (const group of triggers[part.toolName] || []) {
        groups.add(group);
      }
      if (
        (part.toolName === 'wisp__load_tools' || part.toolName === 'wisp__search_tools') &&
        part.output.type === 'json'
      ) {
        const value = part.output.value;
        const enabled =
          value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>).enabledGroups
            : undefined;
        if (Array.isArray(enabled)) {
          for (const group of enabled) {
            if (
              typeof group === 'string' &&
              toolGroupNames.includes(group as (typeof toolGroupNames)[number])
            ) {
              groups.add(group);
            }
          }
        }
      }
    }
  }
  if (groups.has('settings') || groups.has('simulation') || groups.has('panels')) {
    groups.add('ui');
  }
  const hidden = new Set(
    Object.entries(groupTools).flatMap(([group, tools]) => (groups.has(group) ? [] : tools)),
  );
  const tools = options.tools
    .filter((tool) => !hidden.has(tool.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    ...options,
    tools,
    toolChoice:
      options.toolChoice?.type === 'tool' && hidden.has(options.toolChoice.toolName)
        ? { type: 'auto' }
        : options.toolChoice,
    prompt: options.prompt.map((message) =>
      message.role === 'system'
        ? {
            ...message,
            content: message.content.replace(
              /<wisp_module name="([a-z]+)">([\s\S]*?)<\/wisp_module>/g,
              (_block, group: string, text: string) => (groups.has(group) ? text : ''),
            ),
          }
        : message,
    ),
  };
}

export function subscriptionCallOptions(options: CallOptions): CallOptions {
  const openai = { ...options.providerOptions?.openai };
  // The SDK must know this before it serializes reasoning/tool history. Setting
  // it only in the HTTP proxy makes the next turn reference unpersisted items.
  openai.store = false;
  // Eve adds this for API-key providers. ChatGPT subscription grants reject it.
  delete openai.safetyIdentifier;
  return { ...options, providerOptions: { ...options.providerOptions, openai } };
}

export function filterWebSearch(options: CallOptions, enabled: boolean): CallOptions {
  if (enabled) {
    return options;
  }
  const blocked = (options.tools || []).filter(
    (tool) =>
      tool.name === 'web_search' ||
      tool.name === 'web__web_search' ||
      tool.name === 'wowhead__web_search' ||
      (tool.type !== 'function' && tool.id.startsWith('openai.web_search')),
  );
  const names = new Set(blocked.map((tool) => tool.name));
  // Filtering preserves the input model's tool version (v2/v3/v4).
  return {
    ...options,
    tools: options.tools?.filter((tool) => !names.has(tool.name)),
    toolChoice:
      options.toolChoice?.type === 'tool' && names.has(options.toolChoice.toolName)
        ? { type: 'auto' }
        : options.toolChoice,
  } as CallOptions;
}
