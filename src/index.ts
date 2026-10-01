#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { type Config, USAGE, loadConfig } from './config.js';
import { VERSION, createServer } from './server.js';
import { ToolContext } from './tools/context.js';
import { ZenMoneyApi } from './zenmoney/api.js';
import { ZenStore } from './zenmoney/store.js';

const log = (message: string) => console.error(`[mcp-server-zenmoney] ${message}`);

function serveHttp(config: Config, ctx: ToolContext): void {
  const { host, port, authToken } = config.http;
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!loopback && !authToken) {
    throw new Error(`Refusing to serve ZenMoney data on ${host} without MCP_HTTP_TOKEN; bind 127.0.0.1 or set a token.`);
  }
  const handler = createMcpHandler(() => createServer(ctx));
  const nodeHandler = toNodeHandler(handler, { onerror: (error) => log(`HTTP handler error: ${error.message}`) });
  // DNS-rebinding guards only make sense for loopback binds; remote binds rely on the bearer token.
  const validateHost = loopback ? localhostHostValidation() : null;
  const validateOrigin = loopback ? localhostOriginValidation() : null;
  const expected = authToken ? Buffer.from(authToken) : null;

  const server = createHttpServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (path !== '/mcp') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found; the MCP endpoint is /mcp');
      return;
    }
    if (validateHost && !validateHost(req, res)) return;
    if (validateOrigin && !validateOrigin(req, res)) return;
    if (expected) {
      // RFC 7235: the auth scheme is case-insensitive; the credential is compared in constant time.
      const [scheme = '', credential = ''] = (req.headers.authorization ?? '').trim().split(/\s+/, 2);
      const given = Buffer.from(credential);
      if (scheme.toLowerCase() !== 'bearer' || given.length !== expected.length || !timingSafeEqual(given, expected)) {
        res.writeHead(401, { 'www-authenticate': 'Bearer', 'content-type': 'text/plain' }).end('Unauthorized');
        return;
      }
    }
    void nodeHandler(req, res);
  });
  server.listen(port, host, () => log(`listening on http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp`));
  const shutdown = () => {
    server.close();
    void handler.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** `--check`: one sync with the configured token, a one-line summary, exit code 0/1. */
async function check(ctx: ToolContext): Promise<void> {
  const { store, ledger } = ctx.connected();
  const info = await store.sync();
  const user = ledger.rootUser();
  const accounts = ledger.userAccounts(false).length;
  process.stdout.write(
    `OK: ${user.login ?? `user ${user.id}`}, main currency ${ledger.currencyCode(user.currency)}, ${accounts} active accounts, ` +
      `${ledger.data.transaction.size} transactions (${info.kind} sync in ${info.durationMs} ms via ${store.apiBaseUrl})\n`,
  );
}

function main(): void {
  const config = loadConfig(process.argv.slice(2), process.env);
  if (config.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (config.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const api = config.token
    ? new ZenMoneyApi({ token: config.token, baseUrls: config.baseUrls, userAgent: `mcp-server-zenmoney/${VERSION}`, log })
    : null;
  const store = api ? new ZenStore({ api, cacheFile: config.cacheFile, syncTtlMs: config.syncTtlMs, log }) : null;
  const ctx = new ToolContext({ store, api, readOnly: config.readOnly });
  if (!config.token) log('ZENMONEY_TOKEN is not set; tools will explain how to configure it. Get a token at https://zerro.app/token');

  if (config.check) {
    check(ctx).catch((error: unknown) => {
      log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  } else if (config.transport === 'http') {
    serveHttp(config, ctx);
  } else {
    serveStdio(() => createServer(ctx));
    log(`v${VERSION} ready on stdio${config.readOnly ? ' (read-only)' : ''}`);
  }
}

try {
  main();
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
