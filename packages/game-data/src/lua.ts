// Writes plain data as a Lua 5.1 table literal with sorted keys, so a
// regeneration only changes the lines whose game data changed.
export type LuaValue = string | number | boolean | null | undefined | LuaValue[] | LuaTable;
export interface LuaTable {
  [key: string]: LuaValue;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEYWORDS = new Set(
  'and break do else elseif end false for function if in local nil not or repeat return then true until while'.split(
    ' ',
  ),
);

function key(name: string): string {
  if (/^-?\d+$/.test(name)) {
    return `[${name}]`;
  }
  return IDENTIFIER.test(name) && !KEYWORDS.has(name) ? name : `[${luaString(name)}]`;
}

export function luaString(value: string): string {
  return (
    '"' +
    value.replace(/[\\"\n\r\0]/g, (char) =>
      char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\0' ? '\\0' : '\\' + char,
    ) +
    '"'
  );
}

function scalar(value: LuaValue): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return luaString(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot write ${value} to Lua`);
    }
    return String(value);
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

// Tables that fit in the line (StyLua's 100 columns, counting what precedes
// the value and a trailing comma) stay on one line; others put one entry per line.
export function luaValue(value: LuaValue, indent = '', before = indent.length): string {
  const simple = scalar(value);
  if (simple !== undefined) {
    return simple;
  }
  if (value === null || value === undefined) {
    return 'nil';
  }
  const inner = indent + '    ';
  const table = value as LuaTable;
  const entries = Array.isArray(value)
    ? value.map((item) => luaValue(item, inner))
    : Object.keys(table)
        .filter((name) => table[name] !== undefined && table[name] !== null)
        .sort((a, b) => {
          const na = Number(a);
          const nb = Number(b);
          return Number.isInteger(na) && Number.isInteger(nb)
            ? na - nb
            : a < b
              ? -1
              : a > b
                ? 1
                : 0;
        })
        .map(
          (name) =>
            `${key(name)} = ${luaValue(table[name], inner, inner.length + key(name).length + 3)}`,
        );
  const line = `{ ${entries.join(', ')} }`;
  if (!entries.length) {
    return '{}';
  }
  if (before + line.length + 1 <= 100 && !line.includes('\n')) {
    return line;
  }
  return `{\n${entries.map((entry) => inner + entry + ',').join('\n')}\n${indent}}`;
}

// A generated addon file: header comment, then ns.Data.<name> = <value>.
export function luaModule(name: string, header: string[], value: LuaValue): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Invalid data name ${name}`);
  }
  return [
    ...header.map((line) => `-- ${line}`.trimEnd()),
    'local _, ns = ...',
    '',
    `ns.Data.${name} = ${luaValue(value, '', `ns.Data.${name} = `.length)}`,
    '',
  ].join('\n');
}
