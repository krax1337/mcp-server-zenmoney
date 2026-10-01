import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../src/server.js';
import { ToolContext } from '../src/tools/context.js';
import { ZenMoneyApi } from '../src/zenmoney/api.js';
import { Ledger } from '../src/zenmoney/ledger.js';
import { ZenStore } from '../src/zenmoney/store.js';
import { FakeZenMoney, TEST_TOKEN } from './fake-zenmoney.js';
import { TODAY, seedData } from './fixtures.js';

export interface Harness {
  fake: FakeZenMoney;
  store: ZenStore;
  ledger: Ledger;
  client: Client;
  /** Calls a tool and parses its JSON output; tool errors throw with the tool's message. */
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  /** Calls a tool and returns the raw result (for asserting on errors). */
  callRaw: (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; text: string }>;
  close: () => Promise<void>;
}

export function makeStore(fake: FakeZenMoney, cacheFile: string | null = null): ZenStore {
  const api = new ZenMoneyApi({ token: TEST_TOKEN, baseUrls: ['https://fake.zenmoney.test'], fetch: fake.fetch });
  return new ZenStore({ api, cacheFile, syncTtlMs: 60_000 });
}

export async function connect(options: { readOnly?: boolean; withoutToken?: boolean } = {}): Promise<Harness> {
  const fake = new FakeZenMoney(seedData());
  const api = new ZenMoneyApi({ token: TEST_TOKEN, baseUrls: ['https://fake.zenmoney.test'], fetch: fake.fetch });
  const store = new ZenStore({ api, cacheFile: null, syncTtlMs: 60_000 });
  const ctx = options.withoutToken
    ? new ToolContext({ store: null, api: null, readOnly: Boolean(options.readOnly), today: () => TODAY })
    : new ToolContext({ store, api, readOnly: Boolean(options.readOnly), today: () => TODAY });
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);

  const callRaw = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    return { isError: Boolean(result.isError), text: content.map((block) => block.text ?? '').join('') };
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const { isError, text } = await callRaw(name, args);
    if (isError) throw new Error(text);
    return JSON.parse(text);
  };
  return {
    fake,
    store,
    ledger: new Ledger(store),
    client,
    call,
    callRaw,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
