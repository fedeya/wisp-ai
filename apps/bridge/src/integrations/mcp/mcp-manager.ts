import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { writeJson } from '../../json-file.ts';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { SecretVault } from '../../auth/secret-vault.ts';
import { mcpName as name, mcpDefinition, mcpSetup } from '@wisp/protocol/mcp-setup';
import { packagedRuntimeNode } from '../../runtime-node.mjs';
export { mcpDefinition, mcpSetup };
export type MCPDefinition = z.infer<typeof mcpDefinition> & {
  tools?: { name: string; description?: string }[];
  hasToken?: boolean;
  envKeys?: string[];
};
type Connected = { client: Client; tools: Tool[] };

/** Launch path for a user-configured stdio MCP command inside a packaged app. */
export function resolveStdioCommand(command: string, args: readonly string[], root: string) {
  if (/^node(?:\.exe)?$/i.test(command)) {
    return {
      command: process.env.WISP_ENGINE_EXECUTABLE ? packagedRuntimeNode(root) : process.execPath,
      args: [...args],
    };
  }
  if (/^npx(?:\.cmd)?$/i.test(command)) {
    return {
      command: process.execPath,
      args: [
        process.env.WISP_ENGINE_EXECUTABLE
          ? '--npx'
          : path.join(root, 'runtime', 'npm', 'bin', 'npx-cli.js'),
        ...args,
      ],
    };
  }
  return { command, args: [...args] };
}
export class McpManager {
  file: string;
  root: string;
  vault: SecretVault;
  servers: Record<string, MCPDefinition> = {};
  clients = new Map<string, Promise<Connected>>();
  queue: Promise<unknown> = Promise.resolve();
  constructor(file: string, root: string, vault: SecretVault) {
    this.file = file;
    this.root = root;
    this.vault = vault;
  }
  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      for (const [key, value] of Object.entries(raw.servers || {})) {
        const s = value as Record<string, unknown>;
        this.servers[key] = {
          ...mcpDefinition.parse({ ...s, name: key }),
          tools: Array.isArray(s.tools) ? (s.tools as MCPDefinition['tools']) : [],
          hasToken: s.hasToken === true,
          envKeys: Array.isArray(s.envKeys) ? (s.envKeys as string[]) : [],
        };
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw e;
      }
    }
  }
  list() {
    return Object.values(this.servers).map((s) => ({ ...s, args: [...s.args] }));
  }
  private async open(
    server: MCPDefinition,
    token?: string,
    providedEnv?: Record<string, string>,
  ): Promise<Connected> {
    const client = new Client({ name: 'WispAI', version: '0.2.0' }, { capabilities: {} });
    const secret =
      token ??
      (server.hasToken
        ? await this.vault.read('mcp:' + server.name + ':token')
        : server.tokenEnv
          ? process.env[server.tokenEnv]
          : '');
    const env =
      providedEnv ??
      (server.envKeys?.length
        ? JSON.parse((await this.vault.read('mcp:' + server.name + ':env')) || '{}')
        : {});
    let transport;
    if (server.transport === 'stdio') {
      const launch = resolveStdioCommand(server.command!, server.args, this.root);
      const command = launch.command;
      const args = launch.args;
      const allowedEnv = Object.fromEntries(
        [
          'SystemRoot',
          'WINDIR',
          'PATH',
          'Path',
          'PATHEXT',
          'TEMP',
          'TMP',
          'USERPROFILE',
          'APPDATA',
          'LOCALAPPDATA',
          'HOME',
          'ComSpec',
        ].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])),
      );
      allowedEnv.PATH =
        path.join(this.root, 'runtime') +
        path.delimiter +
        path.dirname(process.execPath) +
        path.delimiter +
        (process.env.PATH || process.env.Path || '');
      transport = new StdioClientTransport({
        command,
        args,
        cwd: this.root,
        env: { ...allowedEnv, ...env },
        stderr: 'pipe',
      });
      transport.stderr?.on('data', () => {});
    } else {
      const headers: Record<string, string> = secret ? { authorization: 'Bearer ' + secret } : {};
      transport =
        server.transport === 'sse'
          ? new SSEClientTransport(new URL(server.url!), {
              requestInit: { headers },
              eventSourceInit: {
                fetch: (url, init) =>
                  fetch(url, {
                    ...init,
                    headers: { ...headers, ...Object.fromEntries(new Headers(init?.headers)) },
                  }),
              },
            })
          : new StreamableHTTPClientTransport(new URL(server.url!), { requestInit: { headers } });
    }
    const timeout = setTimeout(() => void client.close(), 15000);
    try {
      await client.connect(transport);
      const tools: Tool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: 10000 });
        tools.push(...result.tools);
        if (!result.nextCursor) {
          break;
        }
        cursor = result.nextCursor;
      }
      if (tools.length > 1000) {
        throw Error('MCP exposes too many tools');
      }
      return { client, tools };
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }
  async test(input: z.infer<typeof mcpSetup>) {
    const parsed = mcpSetup.parse(input),
      existing = this.servers[parsed.server.name];
    const connection = await this.open({ ...existing, ...parsed.server }, parsed.token, parsed.env);
    try {
      return {
        tools: connection.tools.map((t) => ({ name: t.name, description: t.description })),
        count: connection.tools.length,
      };
    } finally {
      await connection.client.close();
    }
  }
  async save(input: z.infer<typeof mcpSetup>) {
    const parsed = mcpSetup.parse(input);
    const tested = await this.test(parsed);
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        if (parsed.token !== undefined) {
          await this.vault.write('mcp:' + parsed.server.name + ':token', parsed.token);
        }
        if (parsed.env !== undefined) {
          await this.vault.write('mcp:' + parsed.server.name + ':env', JSON.stringify(parsed.env));
        }
        const old = this.servers[parsed.server.name];
        const definition = {
          ...parsed.server,
          tools: tested.tools,
          hasToken: parsed.token !== undefined ? !!parsed.token : old?.hasToken,
          envKeys: parsed.env !== undefined ? Object.keys(parsed.env) : old?.envKeys,
        };
        const next = { ...this.servers, [definition.name]: definition };
        await this.persist(next);
        await this.disconnect(definition.name);
      });
    this.queue = work;
    await work;
    return tested;
  }
  private async persist(next: Record<string, MCPDefinition>) {
    await writeJson(this.file, { servers: next });
    this.servers = next;
  }
  async setEnabled(key: string, enabled: boolean) {
    name.parse(key);
    if (typeof enabled !== 'boolean') {
      throw Error('Invalid MCP switch');
    }
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        const server = this.servers[key];
        if (!server) {
          throw Error('Unknown MCP connection');
        }
        if (server.enabled === enabled) {
          return;
        }
        await this.persist({ ...this.servers, [key]: { ...server, enabled } });
        if (!enabled) {
          await this.disconnect(key);
        }
      });
    this.queue = work;
    await work;
  }
  async remove(key: string) {
    name.parse(key);
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        const next = { ...this.servers };
        delete next[key];
        await this.persist(next);
        await this.disconnect(key);
        await this.vault.write('mcp:' + key + ':token', '');
        await this.vault.write('mcp:' + key + ':env', '');
      });
    this.queue = work;
    await work;
  }
  async connect(key: string) {
    const server = this.servers[key];
    if (!server || !server.enabled) {
      throw Error('MCP connection is unavailable');
    }
    let pending = this.clients.get(key);
    if (!pending) {
      pending = this.open(server).catch((error) => {
        this.clients.delete(key);
        throw error;
      });
      this.clients.set(key, pending);
    }
    return pending;
  }
  async disconnect(key: string) {
    const pending = this.clients.get(key);
    this.clients.delete(key);
    if (pending) {
      await pending.then((c) => c.client.close()).catch(() => {});
    }
  }
  async close() {
    await Promise.all([...this.clients.keys()].map((key) => this.disconnect(key)));
  }
}
