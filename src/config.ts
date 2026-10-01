import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_BASE_URLS } from './zenmoney/api.js';

export interface HttpConfig {
  host: string;
  port: number;
  /** Bearer token required from HTTP clients; mandatory when binding beyond loopback. */
  authToken: string | null;
}

export interface Config {
  token: string | null;
  baseUrls: string[];
  readOnly: boolean;
  cacheFile: string | null;
  syncTtlMs: number;
  transport: 'stdio' | 'http';
  http: HttpConfig;
  help: boolean;
  version: boolean;
  /** Verify the token with one sync, print a summary and exit. */
  check: boolean;
}

export const USAGE = `mcp-server-zenmoney — MCP server for ZenMoney

Usage: mcp-server-zenmoney [--http] [--host 127.0.0.1] [--port 3000] [--read-only]
       mcp-server-zenmoney --check     verify the token and print a short account summary

Environment:
  ZENMONEY_TOKEN        ZenMoney API token (get one at https://zerro.app/token)
  ZENMONEY_TOKEN_FILE   File containing the token (alternative to ZENMONEY_TOKEN)
  ZENMONEY_READ_ONLY    true = register only read tools
  ZENMONEY_SYNC_TTL     Seconds before cached data is re-synced (default 30)
  ZENMONEY_CACHE_DIR    Snapshot cache directory (default ~/.cache/mcp-server-zenmoney)
  ZENMONEY_CACHE        off = keep data in memory only
  ZENMONEY_API_URL      Pin the API origin (default: api.zenmoney.ru, falling back to api.zenmoney.app)
  MCP_TRANSPORT         stdio (default) or http
  MCP_HTTP_HOST         HTTP bind address (default 127.0.0.1)
  MCP_HTTP_PORT         HTTP port (default 3000)
  MCP_HTTP_TOKEN        Bearer token HTTP clients must send (required off-loopback)
`;

const expandHome = (path: string) => path.replace(/^~(?=$|\/)/, homedir());

function readToken(env: NodeJS.ProcessEnv): string | null {
  const inline = env.ZENMONEY_TOKEN?.trim();
  if (inline) return inline;
  const file = env.ZENMONEY_TOKEN_FILE?.trim();
  if (!file) return null;
  const fromFile = readFileSync(expandHome(file), 'utf8').trim();
  return fromFile || null;
}

export function loadConfig(argv: string[], env: NodeJS.ProcessEnv): Config {
  const { values } = parseArgs({
    args: argv,
    options: {
      http: { type: 'boolean' },
      host: { type: 'string' },
      port: { type: 'string' },
      'read-only': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      check: { type: 'boolean' },
    },
    strict: true,
  });

  const token = readToken(env);
  const pinned = env.ZENMONEY_API_URL?.trim().replace(/\/+$/, '');
  const baseUrls = pinned ? [pinned] : DEFAULT_BASE_URLS;

  let cacheFile: string | null = null;
  if (token && !/^(0|false|no|off)$/i.test(env.ZENMONEY_CACHE?.trim() ?? '')) {
    const configured = env.ZENMONEY_CACHE_DIR?.trim();
    const dir = configured ? expandHome(configured) : join(env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache'), 'mcp-server-zenmoney');
    // One snapshot per token+origin, named by a hash so the token never lands on disk.
    const id = createHash('sha256').update(`${token}\n${baseUrls.join(',')}`).digest('hex').slice(0, 16);
    cacheFile = join(dir, `snapshot-${id}.json`);
  }

  // Empty strings count as "not set" everywhere below.
  const ttlRaw = env.ZENMONEY_SYNC_TTL?.trim();
  const ttlSeconds = ttlRaw ? Number(ttlRaw) : 30;
  const portRaw = values.port?.trim() || env.MCP_HTTP_PORT?.trim() || '3000';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid HTTP port: ${portRaw}`);

  return {
    token,
    baseUrls,
    readOnly: Boolean(values['read-only']) || /^(1|true|yes|on)$/i.test(env.ZENMONEY_READ_ONLY?.trim() ?? ''),
    cacheFile,
    syncTtlMs: Number.isFinite(ttlSeconds) && ttlSeconds >= 0 ? ttlSeconds * 1000 : 30_000,
    transport: values.http || env.MCP_TRANSPORT?.trim().toLowerCase() === 'http' ? 'http' : 'stdio',
    http: {
      host: values.host?.trim() || env.MCP_HTTP_HOST?.trim() || '127.0.0.1',
      port,
      authToken: env.MCP_HTTP_TOKEN?.trim() || null,
    },
    help: Boolean(values.help),
    version: Boolean(values.version),
    check: Boolean(values.check),
  };
}
