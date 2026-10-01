import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZenMoneyApi, ZenMoneyApiError, ZenMoneyAuthError } from '../src/zenmoney/api.js';
import type { Transaction } from '../src/zenmoney/types.js';
import { FakeZenMoney, TEST_TOKEN } from './fake-zenmoney.js';
import { seedData } from './fixtures.js';
import { makeStore } from './harness.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ZenStore sync', () => {
  it('does one full sync for concurrent callers, then incremental syncs that apply changes and deletions', async () => {
    const fake = new FakeZenMoney(seedData());
    const store = makeStore(fake);
    await Promise.all([store.ensureFresh(), store.ensureFresh(), store.ensureFresh()]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.body.serverTimestamp).toBe(0);
    expect(store.data.transaction.size).toBe(16);

    const salary = store.data.transaction.get('t-salary')!;
    fake.externalChange('transaction', { ...salary, comment: 'edited on phone', changed: 5 });
    fake.externalDeletion('transaction', 't-uncat');
    const info = await store.sync();
    expect(info.kind).toBe('incremental');
    expect(fake.requests[1]!.body.serverTimestamp).toBeGreaterThan(0);
    expect(store.data.transaction.get('t-salary')!.comment).toBe('edited on phone');
    expect(store.data.transaction.has('t-uncat')).toBe(false);
    // The deletion changed the credit card balance server-side; the replica follows.
    expect(store.data.account.get('acc-credit')!.balance).toBe(-1200);
  });

  it('serves from the TTL window without new requests', async () => {
    const fake = new FakeZenMoney(seedData());
    const store = makeStore(fake);
    await store.ensureFresh();
    await store.ensureFresh();
    expect(fake.requests).toHaveLength(1);
  });

  it('persists a private snapshot and resumes incrementally after a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zenmoney-mcp-'));
    dirs.push(dir);
    const cacheFile = join(dir, 'nested', 'snapshot.json');
    const fake = new FakeZenMoney(seedData());
    await makeStore(fake, cacheFile).ensureFresh();

    const contents = await readFile(cacheFile, 'utf8');
    expect(contents).not.toContain(TEST_TOKEN);
    expect((await stat(cacheFile)).mode & 0o777).toBe(0o600);

    const restarted = makeStore(fake, cacheFile);
    await restarted.ensureFresh();
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.body.serverTimestamp).toBeGreaterThan(0);
    expect(restarted.data.transaction.get('t-salary')).toMatchObject<Partial<Transaction>>({ income: 150000 });
  });

  it('ignores an unreadable snapshot and falls back to a full sync', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zenmoney-mcp-'));
    dirs.push(dir);
    const cacheFile = join(dir, 'snapshot.json');
    await writeFile(cacheFile, '{"version":999}');
    const fake = new FakeZenMoney(seedData());
    await makeStore(fake, cacheFile).ensureFresh();
    expect(fake.requests[0]!.body.serverTimestamp).toBe(0);
  });
});

describe('ZenMoneyApi', () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it('falls back to the alternate origin when the first rejects the token, then sticks to it', async () => {
    const calls: string[] = [];
    const api = new ZenMoneyApi({
      token: 't',
      baseUrls: ['https://ru.example', 'https://app.example'],
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        return url.startsWith('https://ru.example') ? new Response('Unauthorized', { status: 401 }) : ok({ serverTimestamp: 1 });
      },
    });
    await api.diff({ serverTimestamp: 0 }, { timeoutMs: 1000 });
    await api.diff({ serverTimestamp: 1 }, { timeoutMs: 1000 });
    expect(calls).toEqual(['https://ru.example/v8/diff/', 'https://app.example/v8/diff/', 'https://app.example/v8/diff/']);
    expect(api.baseUrl).toBe('https://app.example');
  });

  it('reports an expired token with instructions once every origin rejects it', async () => {
    const api = new ZenMoneyApi({ token: 't', fetch: async () => new Response('Unauthorized', { status: 401 }) });
    await expect(api.diff({ serverTimestamp: 0 }, { timeoutMs: 1000 })).rejects.toThrow(ZenMoneyAuthError);
    await expect(api.diff({ serverTimestamp: 0 }, { timeoutMs: 1000 })).rejects.toThrow(/zerro\.app\/token/);
  });

  it('surfaces ZenMoney validation errors and retries transient gateway failures', async () => {
    let attempts = 0;
    const flaky = new ZenMoneyApi({
      token: 't',
      fetch: async () => (++attempts < 2 ? new Response('busy', { status: 503 }) : ok({ serverTimestamp: 7 })),
    });
    await expect(flaky.diff({ serverTimestamp: 0 }, { timeoutMs: 1000 })).resolves.toMatchObject({ serverTimestamp: 7 });
    expect(attempts).toBe(2);

    const invalid = new ZenMoneyApi({
      token: 't',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'validationError', message: 'Invalid Relation "Tag" in Object Budget x' } }), { status: 400 }),
    });
    const error = await invalid.diff({ serverTimestamp: 0 }, { timeoutMs: 1000 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ZenMoneyApiError);
    expect(error).toMatchObject({ status: 400, code: 'validationError' });
    expect(String((error as Error).message)).toContain('Invalid Relation "Tag"');
  });
});
