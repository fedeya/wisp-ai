export const BIT_COUNT = 128;
export const SLOT_COUNT = 1024;

export function* addonHelperTocs(version?: string) {
  const versionHeader = version ? `## Version: ${version}\n` : '';
  for (let n = 1; n <= BIT_COUNT; n++) {
    const name = `WispAI_B${String(n).padStart(3, '0')}`;
    yield {
      name,
      toc: `## Interface: 16001\n## Title: Wisp bit ${n}\n${versionHeader}## Group: WispAI\n## LoadOnDemand: 1\n`,
    };
  }
  for (let n = 1; n <= SLOT_COUNT; n++) {
    const name = `WispAI_S${String(n).padStart(4, '0')}`;
    yield {
      name,
      toc: `## Interface: 16001\n## Title: Wisp canal ${n}\n${versionHeader}## Group: WispAI\n## DefaultState: enabled\n## LoadOnDemand: 1\n## Dependencies: WispAI\n\n..\\WispAI_Payload\\Payload.lua\n`,
    };
  }
}

export function luaJson(json: string): string {
  let eq = '=';
  while (json.includes(']' + eq + ']')) {
    eq += '=';
  }
  return `WispAI_Receive([${eq}[${json}]${eq}])\n`;
}

export const initialAddonPayload = luaJson(JSON.stringify({ v: 1, session: '', connected: false }));
