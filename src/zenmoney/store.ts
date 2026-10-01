import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as z from 'zod/v4';
import { type ZenMoneyApi, ZenMoneyApiError, ZenMoneyAuthError, ZenMoneyError } from './api.js';
import type {
  Account,
  Budget,
  Company,
  Country,
  DiffEntities,
  DiffResponse,
  Instrument,
  Merchant,
  Reminder,
  ReminderMarker,
  Tag,
  Transaction,
  User,
} from './types.js';

const CACHE_VERSION = 1;
const FULL_SYNC_TIMEOUT_MS = 180_000;
const SYNC_TIMEOUT_MS = 60_000;

/** A write planned against the freshly synced replica. */
export interface Mutation<T> {
  /** Entities to push; nothing is sent when absent or empty (dry runs, no-ops). */
  changes?: DiffEntities;
  /** Produces the tool result after the push and follow-up sync have landed. */
  done: () => T;
}

export interface Collections {
  instrument: Map<number, Instrument>;
  country: Map<number, Country>;
  company: Map<number, Company>;
  user: Map<number, User>;
  account: Map<string, Account>;
  tag: Map<string, Tag>;
  merchant: Map<string, Merchant>;
  /** Keyed by {@link budgetKey}; budgets have no id of their own. */
  budget: Map<string, Budget>;
  reminder: Map<string, Reminder>;
  reminderMarker: Map<string, ReminderMarker>;
  transaction: Map<string, Transaction>;
}

type CollectionName = keyof Collections;
/** Any collection viewed through its common shape; per-key typing is restored by the getters on `data`. */
type AnyCollection = Map<string | number, unknown>;

const COLLECTIONS: CollectionName[] = [
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

export const budgetKey = (budget: Pick<Budget, 'tag' | 'date'>) => `${budget.date}#${budget.tag ?? 'null'}`;

function entityKey(name: CollectionName, entity: unknown): string | number {
  if (name === 'budget') return budgetKey(entity as Budget);
  return (entity as { id: string | number }).id;
}

function emptyCollections(): Collections {
  return {
    instrument: new Map(),
    country: new Map(),
    company: new Map(),
    user: new Map(),
    account: new Map(),
    tag: new Map(),
    merchant: new Map(),
    budget: new Map(),
    reminder: new Map(),
    reminderMarker: new Map(),
    transaction: new Map(),
  };
}

const CacheFileSchema = z.object({
  version: z.literal(CACHE_VERSION),
  serverTimestamp: z.number(),
  savedAt: z.number(),
  data: z.record(z.string(), z.array(z.unknown())),
});
type CacheFile = z.infer<typeof CacheFileSchema>;

export interface StoreOptions {
  api: ZenMoneyApi;
  /** Where to persist the synced snapshot between runs; `null` keeps it in memory only. */
  cacheFile: string | null;
  /** Data older than this is re-synced before serving a tool call. */
  syncTtlMs: number;
  log?: (message: string) => void;
}

export interface SyncInfo {
  kind: 'full' | 'incremental';
  changed: number;
  deleted: number;
  durationMs: number;
}

/**
 * Local replica of the user's ZenMoney database kept in sync through /v8/diff/.
 * All network operations run strictly one at a time so `serverTimestamp` never races.
 */
export class ZenStore {
  data: Collections = emptyCollections();
  serverTimestamp = 0;
  /** Epoch ms of the last successful round trip with the server. */
  lastSyncAt: number | null = null;
  lastSync: SyncInfo | null = null;

  private readonly api: ZenMoneyApi;
  private readonly cacheFile: string | null;
  private readonly syncTtlMs: number;
  private readonly log: (message: string) => void;
  private queue: Promise<unknown> = Promise.resolve();
  private cacheLoaded = false;
  private dirty = false;

  constructor(options: StoreOptions) {
    this.api = options.api;
    this.cacheFile = options.cacheFile;
    this.syncTtlMs = options.syncTtlMs;
    this.log = options.log ?? (() => {});
  }

  get apiBaseUrl(): string {
    return this.api.baseUrl;
  }

  get cachePath(): string | null {
    return this.cacheFile;
  }

  /** Syncs when the replica is empty or older than the TTL. */
  ensureFresh(): Promise<void> {
    return this.exclusive(async () => {
      await this.loadCacheOnce();
      if (this.lastSyncAt !== null && Date.now() - this.lastSyncAt < this.syncTtlMs) return;
      await this.syncLocked(this.serverTimestamp === 0);
    });
  }

  /** Forces a round trip; `full` re-downloads everything instead of fetching changes. */
  sync(full = false): Promise<SyncInfo> {
    return this.exclusive(async () => {
      await this.loadCacheOnce();
      return this.syncLocked(full || this.serverTimestamp === 0);
    });
  }

  /**
   * Runs a write without races: syncs first so `plan` builds on the server's current state
   * (no TTL gap, no interleaving with other calls), pushes what it returns, folds the answer
   * back in and performs one follow-up sync so server-side recalculations (balances) land too.
   */
  mutate<T>(plan: () => Mutation<T> | Promise<Mutation<T>>): Promise<T> {
    return this.exclusive(async () => {
      await this.loadCacheOnce();
      await this.syncLocked(this.serverTimestamp === 0);
      const { changes, done } = await plan();
      if (changes && Object.values(changes).some((items) => Array.isArray(items) && items.length > 0)) {
        await this.pushLocked(changes);
      }
      return done();
    });
  }

  private async pushLocked(changes: DiffEntities): Promise<void> {
    let response: DiffResponse;
    try {
      response = await this.api.diff({ ...changes, serverTimestamp: this.serverTimestamp }, { timeoutMs: SYNC_TIMEOUT_MS });
    } catch (error) {
      // The server may have applied the push before the answer got lost: never trust the replica blindly now.
      this.lastSyncAt = null;
      const refused = error instanceof ZenMoneyAuthError || (error instanceof ZenMoneyApiError && error.status < 500);
      if (refused) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ZenMoneyError(`${message}. The change may or may not have been saved: check (e.g. list_transactions) before retrying.`);
    }
    this.applyDiff(changes);
    this.applyDiff(response);
    this.serverTimestamp = response.serverTimestamp;
    this.lastSyncAt = Date.now();
    try {
      await this.syncLocked(false);
    } catch (error) {
      this.lastSyncAt = null;
      this.log(`follow-up sync after push failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.dirty) await this.saveCache();
  }

  counts(): Record<CollectionName, number> {
    const counts = {} as Record<CollectionName, number>;
    for (const name of COLLECTIONS) counts[name] = this.data[name].size;
    return counts;
  }

  /** Upserts every entity in `diff` and applies its deletions. */
  applyDiff(diff: DiffEntities): { changed: number; deleted: number } {
    let changed = 0;
    for (const name of COLLECTIONS) {
      const items = diff[name];
      if (!items?.length) continue;
      const map = this.data[name] as AnyCollection;
      for (const item of items) map.set(entityKey(name, item), item);
      changed += items.length;
    }
    let deleted = 0;
    for (const { object, id } of diff.deletion ?? []) {
      const map = this.data[object] as AnyCollection | undefined;
      if (!map) continue;
      const alternate = typeof id === 'number' ? String(id) : Number(id);
      if (map.delete(id) || map.delete(alternate)) deleted++;
    }
    if (changed || deleted) this.dirty = true;
    return { changed, deleted };
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async syncLocked(full: boolean): Promise<SyncInfo> {
    const started = Date.now();
    const response = await this.api.diff(
      { serverTimestamp: full ? 0 : this.serverTimestamp },
      { timeoutMs: full ? FULL_SYNC_TIMEOUT_MS : SYNC_TIMEOUT_MS },
    );
    if (full) this.data = emptyCollections();
    const { changed, deleted } = this.applyDiff(response);
    this.serverTimestamp = response.serverTimestamp;
    this.lastSyncAt = Date.now();
    this.lastSync = { kind: full ? 'full' : 'incremental', changed, deleted, durationMs: Date.now() - started };
    if (this.dirty) await this.saveCache();
    return this.lastSync;
  }

  private async loadCacheOnce(): Promise<void> {
    if (this.cacheLoaded || !this.cacheFile) return;
    this.cacheLoaded = true;
    let raw: string;
    try {
      raw = await readFile(this.cacheFile, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        this.log(`ignoring unreadable cache ${this.cacheFile}`);
      }
      return;
    }
    let parsed: CacheFile;
    try {
      parsed = CacheFileSchema.parse(JSON.parse(raw));
    } catch {
      this.log(`ignoring incompatible cache ${this.cacheFile}`);
      return;
    }
    const data = emptyCollections();
    for (const name of COLLECTIONS) {
      const map = data[name] as AnyCollection;
      for (const item of parsed.data[name] ?? []) map.set(entityKey(name, item), item);
    }
    this.data = data;
    this.serverTimestamp = parsed.serverTimestamp;
    this.log(`loaded cached snapshot with ${data.transaction.size} transactions`);
  }

  private async saveCache(): Promise<void> {
    this.dirty = false;
    if (!this.cacheFile) return;
    const payload: CacheFile = {
      version: CACHE_VERSION,
      serverTimestamp: this.serverTimestamp,
      savedAt: Date.now(),
      data: {},
    };
    for (const name of COLLECTIONS) payload.data[name] = [...this.data[name].values()];
    const tmp = `${this.cacheFile}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.cacheFile), { recursive: true, mode: 0o700 });
      await writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
      await rename(tmp, this.cacheFile);
    } catch (error) {
      this.log(`cannot write cache ${this.cacheFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
