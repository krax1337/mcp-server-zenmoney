import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Account, Deletion, DiffEntities, SuggestResponse, Transaction } from '../src/zenmoney/types.js';
import { TOTAL_BUDGET_TAG } from '../src/zenmoney/types.js';

export const TEST_TOKEN = 'test-token';

type Collection = Exclude<keyof DiffEntities, 'deletion'>;
const COLLECTIONS: Collection[] = [
  'instrument',
  'country',
  'company',
  'user',
  'account',
  'tag',
  'merchant',
  'budget',
  'reminder',
  'reminderMarker',
  'transaction',
];
const USER_OWNED: Collection[] = ['account', 'tag', 'merchant', 'budget', 'reminder', 'reminderMarker', 'transaction'];

/** Every property the real API insists on when a transaction is pushed (explicit nulls included). */
const REQUIRED_TRANSACTION_FIELDS = [
  'id', 'changed', 'created', 'user', 'deleted', 'hold', 'incomeInstrument', 'incomeAccount', 'income',
  'outcomeInstrument', 'outcomeAccount', 'outcome', 'tag', 'merchant', 'payee', 'originalPayee', 'comment',
  'date', 'mcc', 'reminderMarker', 'opIncome', 'opIncomeInstrument', 'opOutcome', 'opOutcomeInstrument',
  'latitude', 'longitude', 'incomeBankID', 'outcomeBankID', 'qrCode',
];

interface Stored {
  value: Record<string, unknown>;
  stamp: number;
}

class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const keyOf = (collection: Collection, item: Record<string, unknown>) =>
  collection === 'budget' ? `${String(item.date)}#${String(item.tag ?? 'null')}` : String(item.id);

/**
 * In-memory stand-in for api.zenmoney.ru implementing the /v8/diff/ sync protocol and the
 * validation rules the real server is known to enforce (see the ZenMoney API wiki, Zerro's
 * errorExamples.ts and field requirements reported by other clients). Account balances are
 * recalculated after each push but only become visible on the *next* diff, like the real API.
 */
export class FakeZenMoney {
  readonly requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  readonly suggestions = new Map<string, SuggestResponse>();
  /** Applies the next push (a diff carrying entities), then loses its answer like a dropped connection or a timeout. */
  failNextPush: 'network' | 'timeout' | null = null;
  readonly rootUserId: number;
  private clock = 1;
  private readonly data = new Map<Collection, Map<string, Stored>>();
  private readonly deletions: Array<{ deletion: Deletion; stamp: number }> = [];

  constructor(seed: DiffEntities) {
    for (const collection of COLLECTIONS) {
      const map = new Map<string, Stored>();
      for (const item of (seed[collection] ?? []) as unknown as Record<string, unknown>[]) {
        map.set(keyOf(collection, item), { value: structuredClone(item), stamp: 1 });
      }
      this.data.set(collection, map);
    }
    const root = [...this.data.get('user')!.values()].find((user) => user.value.parent === null);
    this.rootUserId = Number(root?.value.id);
    this.recalculateBalances(1);
  }

  get<T>(collection: Collection, key: string): T | undefined {
    return this.data.get(collection)!.get(key)?.value as T | undefined;
  }

  all<T>(collection: Collection): T[] {
    return [...this.data.get(collection)!.values()].map((stored) => stored.value as T);
  }

  /** Simulates a change made by another client (e.g. the phone app). */
  externalChange(collection: Collection, item: Record<string, unknown>): void {
    this.clock++;
    this.data.get(collection)!.set(keyOf(collection, item), { value: item, stamp: this.clock });
    this.recalculateBalances(this.clock);
  }

  externalDeletion(collection: Collection, id: string): void {
    this.clock++;
    this.data.get(collection)!.delete(id);
    this.deletions.push({ deletion: { id, object: collection, stamp: this.clock, user: this.rootUserId }, stamp: this.clock });
    this.recalculateBalances(this.clock);
  }

  handle(path: string, authorization: string | undefined, rawBody: string): { status: number; body: string } {
    if (authorization !== `Bearer ${TEST_TOKEN}`) return { status: 401, body: 'Unauthorized' };
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: JSON.stringify({ error: { code: 'validationError', message: 'Invalid JSON' } }) };
    }
    try {
      if (path === '/v8/diff/') return { status: 200, body: JSON.stringify(this.diff(body as Record<string, unknown>)) };
      if (path === '/v8/suggest/') return { status: 200, body: JSON.stringify(this.suggest(body)) };
      return { status: 404, body: 'Not Found' };
    } catch (error) {
      if (error instanceof ApiFailure) {
        return { status: error.status, body: JSON.stringify({ error: { code: error.code, message: error.message } }) };
      }
      throw error;
    }
  }

  /** In-process `fetch` for the API client. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const rawBody = String(init?.body ?? '');
    const { status, body } = this.handle(url.pathname, headers.get('authorization') ?? undefined, rawBody);
    const isPush = url.pathname === '/v8/diff/' && /"(transaction|tag|budget|account|merchant|reminder|reminderMarker|deletion)":/.test(rawBody);
    const failure = isPush ? this.failNextPush : null;
    if (isPush) this.failNextPush = null;
    if (failure === 'network') throw new TypeError('fetch failed');
    if (failure === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
    return new Response(body, { status, headers: { 'content-type': status === 401 ? 'text/plain' : 'application/json' } });
  };

  /** Real HTTP listener for end-to-end runs of the built server (ZENMONEY_API_URL). */
  async listen(): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const { status, body } = this.handle(new URL(req.url ?? '/', 'http://x').pathname, req.headers.authorization, Buffer.concat(chunks).toString());
        res.writeHead(status, { 'content-type': 'application/json' }).end(body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
  }

  private diff(body: Record<string, unknown>) {
    this.requests.push({ path: '/v8/diff/', body });
    const clientTime = body.currentClientTimestamp;
    if (typeof clientTime !== 'number' || clientTime > 1e11) {
      throw new ApiFailure(400, 'validationError', 'Wrong Format of currentClientTimestamp. Please Check Your Local Time');
    }
    const since = Number(body.serverTimestamp ?? 0);
    const now = ++this.clock;

    const pushed = new Set<string>();
    for (const collection of COLLECTIONS) {
      for (const item of (body[collection] ?? []) as Record<string, unknown>[]) this.validate(collection, item);
    }
    for (const collection of COLLECTIONS) {
      const map = this.data.get(collection)!;
      for (const item of (body[collection] ?? []) as Record<string, unknown>[]) {
        const key = keyOf(collection, item);
        const existing = map.get(key);
        if (existing && Number(existing.value.changed) > Number(item.changed)) continue;
        map.set(key, { value: structuredClone(item), stamp: now });
        pushed.add(`${collection}:${key}`);
      }
    }
    for (const deletion of (body.deletion ?? []) as Deletion[]) {
      this.data.get(deletion.object as Collection)?.delete(String(deletion.id));
      this.deletions.push({ deletion, stamp: now });
      pushed.add(`deletion:${deletion.id}`);
    }
    // Server-side recalculation lands after this response (visible from the next diff on).
    if (pushed.size) this.recalculateBalances(now + 1);

    const response: Record<string, unknown> = { serverTimestamp: now };
    for (const collection of COLLECTIONS) {
      const changed = [...this.data.get(collection)!.entries()]
        .filter(([key, stored]) => stored.stamp > since && stored.stamp <= now && !pushed.has(`${collection}:${key}`))
        .map(([, stored]) => stored.value);
      if (changed.length) response[collection] = changed;
    }
    const deletions = this.deletions
      .filter(({ deletion, stamp }) => stamp > since && stamp <= now && !pushed.has(`deletion:${deletion.id}`))
      .map(({ deletion }) => deletion);
    if (deletions.length) response.deletion = deletions;
    return response;
  }

  private suggest(body: unknown) {
    this.requests.push({ path: '/v8/suggest/', body: { items: body } });
    const items = Array.isArray(body) ? body : [body];
    const answers = items.map((item: { payee?: string }) => {
      const hit = this.suggestions.get((item.payee ?? '').toLowerCase());
      return hit ?? { payee: item.payee ?? null };
    });
    return Array.isArray(body) ? answers : answers[0];
  }

  private validate(collection: Collection, item: Record<string, unknown>): void {
    const id = String(item.id ?? keyOf(collection, item));
    const name = collection[0]!.toUpperCase() + collection.slice(1);
    if (USER_OWNED.includes(collection) && item.user !== this.rootUserId) {
      throw new ApiFailure(400, 'validationError', `Invalid Property "User" in Object ${name} ${id}. Wrong User of Object`);
    }
    if (typeof item.changed !== 'number' || item.changed > 1e11) {
      throw new ApiFailure(400, 'validationError', `Invalid Property "Changed" in Object ${name} ${id}. Wrong Value`);
    }
    const exists = (target: Collection, key: unknown) => this.data.get(target)!.has(String(key));
    if (collection === 'transaction') {
      for (const field of REQUIRED_TRANSACTION_FIELDS) {
        if (!(field in item)) throw new ApiFailure(400, 'validationError', `Missing Property "${field}" in Object Transaction ${id}`);
      }
      if ('viewed' in item && item.viewed === null) {
        throw new ApiFailure(500, 'serverError', 'Server Inner Error. Try Again After Some Time.');
      }
      for (const field of ['incomeAccount', 'outcomeAccount'] as const) {
        if (!exists('account', item[field])) {
          throw new ApiFailure(400, 'validationError', `Invalid Relation "Account" in Object Transaction ${id}. Account ${String(item[field])} Doesn't Exist`);
        }
      }
      for (const tag of (item.tag ?? []) as string[]) {
        if (!exists('tag', tag)) throw new ApiFailure(400, 'validationError', `Invalid Relation "Tag" in Object Transaction ${id}. Tag ${tag} Doesn't Exist`);
      }
      if (item.merchant !== null && !exists('merchant', item.merchant)) {
        throw new ApiFailure(400, 'validationError', `Invalid Relation "Merchant" in Object Transaction ${id}`);
      }
      const income = Number(item.income);
      const outcome = Number(item.outcome);
      if (!(income >= 0) || !(outcome >= 0)) {
        throw new ApiFailure(400, 'validationError', `Invalid Property "Outcome" in Object Transaction ${id}. Wrong Value`);
      }
      if (!item.deleted && item.incomeAccount !== item.outcomeAccount && !(income > 0 && outcome > 0)) {
        throw new ApiFailure(400, 'validationError', `Invalid Object Transaction ${id}. Transfer Transaction Must Have Both Income and Outcome Positive`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item.date))) throw new ApiFailure(400, 'validationError', `Invalid Property "Date" in Object Transaction ${id}`);
    }
    if (collection === 'tag' && item.parent !== null) {
      const parent = this.get<Record<string, unknown>>('tag', String(item.parent));
      if (!parent || parent.parent !== null) throw new ApiFailure(400, 'validationError', `Invalid Relation "Parent" in Object Tag ${id}`);
    }
    if (collection === 'budget' && item.tag !== null && item.tag !== TOTAL_BUDGET_TAG && !exists('tag', item.tag)) {
      throw new ApiFailure(400, 'validationError', `Invalid Relation "Tag" in Object Budget ${id}. Tag ${String(item.tag)} Doesn't Exist`);
    }
    if (collection === 'account' && !exists('instrument', item.instrument)) {
      throw new ApiFailure(400, 'validationError', `Invalid Relation "Instrument" in Object Account ${id}`);
    }
  }

  private recalculateBalances(stamp: number): void {
    const flows = new Map<string, number>();
    for (const stored of this.data.get('transaction')!.values()) {
      const tx = stored.value as unknown as Transaction;
      if (tx.deleted) continue;
      flows.set(tx.incomeAccount, (flows.get(tx.incomeAccount) ?? 0) + tx.income);
      flows.set(tx.outcomeAccount, (flows.get(tx.outcomeAccount) ?? 0) - tx.outcome);
    }
    for (const [key, stored] of this.data.get('account')!) {
      const account = stored.value as unknown as Account;
      const balance = Math.round(((account.startBalance ?? 0) + (flows.get(account.id) ?? 0)) * 100) / 100;
      if (balance === account.balance) continue;
      this.data.get('account')!.set(key, { value: { ...stored.value, balance, changed: stamp }, stamp });
    }
  }
}
