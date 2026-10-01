import type { CallToolResult } from '@modelcontextprotocol/server';
import { TOKEN_HELP } from '../zenmoney/api.js';
import type { ZenMoneyApi } from '../zenmoney/api.js';
import { todayIso } from '../zenmoney/dates.js';
import { Ledger } from '../zenmoney/ledger.js';
import type { ZenStore } from '../zenmoney/store.js';

export interface ToolContextOptions {
  /** `null` when no token is configured: tools then answer with setup instructions. */
  store: ZenStore | null;
  api: ZenMoneyApi | null;
  readOnly: boolean;
  /** Local calendar date provider (injectable for tests). */
  today?: () => string;
}

/** Shared state behind every tool; one instance lives for the whole process. */
export class ToolContext {
  readonly store: ZenStore | null;
  readonly api: ZenMoneyApi | null;
  readonly ledger: Ledger | null;
  readonly readOnly: boolean;
  readonly today: () => string;

  constructor(options: ToolContextOptions) {
    this.store = options.store;
    this.api = options.api;
    this.readOnly = options.readOnly;
    this.ledger = options.store ? new Ledger(options.store) : null;
    this.today = options.today ?? (() => todayIso());
  }

  /** Ensures a token is configured and the replica is fresh, then returns the read model. */
  async fresh(): Promise<Ledger> {
    const { store, ledger } = this.connected();
    await store.ensureFresh();
    return ledger;
  }

  connected(): { store: ZenStore; ledger: Ledger; api: ZenMoneyApi } {
    if (!this.store || !this.ledger || !this.api) {
      throw new Error(`ZENMONEY_TOKEN is not configured for this MCP server. ${TOKEN_HELP}`);
    }
    return { store: this.store, ledger: this.ledger, api: this.api };
  }
}

/** Tool output as compact JSON text: cheapest for the model to read and parse. */
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** Removes `undefined`, `null`, empty strings and empty arrays so outputs stay small. */
export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null || item === '' || (Array.isArray(item) && !item.length)) continue;
    out[key as keyof T] = item as T[keyof T];
  }
  return out;
}
