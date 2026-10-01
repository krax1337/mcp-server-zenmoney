import type { ZenStore } from './store.js';
import type { Account, Instrument, Merchant, ReminderMarker, Tag, Transaction, User } from './types.js';

/** Zerro keeps its settings in reminders attached to this hidden account. */
export const ZERRO_DATA_ACCOUNT = '🤖 [Zerro Data]';

export const TX_TYPES = ['expense', 'income', 'transfer', 'debt_out', 'debt_in'] as const;
export type TxType = (typeof TX_TYPES)[number];

/** A transaction (or planned operation) seen from the user's side. */
export interface TxView<T extends Transaction | ReminderMarker = Transaction> {
  tx: T;
  type: TxType;
  /** The user's account the money left (expense, transfer, debt_out) or arrived at (income, debt_in). */
  accountId: string;
  amount: number;
  instrument: number;
  /** Destination of a transfer. */
  toAccountId?: string;
  toAmount?: number;
  toInstrument?: number;
  mainTagId: string | null;
}

export class UserInputError extends Error {
  override name = 'UserInputError';
}

export const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Letters and digits only, lower-cased: tolerant matching for names with emoji or punctuation.
 * Names made only of symbols (e.g. "🎁") keep their trimmed form so they stay distinguishable.
 */
export function normalizeName(value: string): string {
  const letters = value.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
  return letters || value.trim().toLowerCase();
}

interface Candidate<T> {
  item: T;
  names: string[];
}

/**
 * Matches a human reference by exact name, then punctuation/emoji-insensitive name, then (unless
 * `exactOnly`) substring; returns the hits of the first tier that matches anything.
 */
function matchByName<T>(ref: string, candidates: Candidate<T>[], exactOnly = false): T[] {
  const wanted = ref.trim().toLowerCase();
  const wantedNormalized = normalizeName(ref);
  const tiers: Array<(name: string) => boolean> = [
    (name) => name.trim().toLowerCase() === wanted,
    (name) => wantedNormalized !== '' && normalizeName(name) === wantedNormalized,
  ];
  if (!exactOnly) tiers.push((name) => wantedNormalized !== '' && normalizeName(name).includes(wantedNormalized));
  for (const matches of tiers) {
    const hits = candidates.filter((candidate) => candidate.names.some(matches));
    if (hits.length) return hits.map((hit) => hit.item);
  }
  return [];
}

/** Exactly one hit wins; otherwise the error lists candidates so the caller can retry precisely. */
function pickOne<T>(ref: string, hits: T[], known: T[], describe: (item: T) => string, kind: string): T {
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    const options = hits.slice(0, 10).map(describe).join('; ');
    throw new UserInputError(`${kind} "${ref}" is ambiguous: ${options}. Use the exact name or id.`);
  }
  const list = known.slice(0, 40).map(describe).join('; ');
  throw new UserInputError(`No ${kind.toLowerCase()} matches "${ref}". Known: ${list}`);
}

/** Read model over the synced replica: lookups, name resolution, currency maths, classification. */
export class Ledger {
  constructor(private readonly store: ZenStore) {}

  get data() {
    return this.store.data;
  }

  rootUser(): User {
    const users = [...this.data.user.values()];
    const root = users.find((user) => user.parent === null) ?? users[0];
    if (!root) throw new Error('ZenMoney returned no user; run sync with full=true');
    return root;
  }

  mainInstrument(): Instrument {
    return this.instrument(this.rootUser().currency);
  }

  instrument(id: number): Instrument {
    const instrument = this.data.instrument.get(id);
    if (!instrument) throw new Error(`Unknown currency instrument ${id}`);
    return instrument;
  }

  currencyCode(id: number | null | undefined): string {
    if (id === null || id === undefined) return '?';
    return this.data.instrument.get(id)?.shortTitle ?? String(id);
  }

  instrumentByCode(code: string): Instrument {
    const wanted = code.trim().toUpperCase();
    for (const instrument of this.data.instrument.values()) {
      if (instrument.shortTitle.toUpperCase() === wanted || String(instrument.id) === wanted) return instrument;
    }
    throw new UserInputError(`Unknown currency "${code}". Use an ISO code such as USD, EUR, RUB, KZT.`);
  }

  /** Converts with ZenMoney's current rates (`rate` = price of one unit in roubles). */
  convert(amount: number, fromId: number, toId: number): number {
    if (fromId === toId) return amount;
    return (amount * this.instrument(fromId).rate) / this.instrument(toId).rate;
  }

  // Accounts

  debtAccount(): Account | undefined {
    for (const account of this.data.account.values()) if (account.type === 'debt') return account;
    return undefined;
  }

  isServiceAccount(account: Account): boolean {
    return account.type === 'debt' || account.title === ZERRO_DATA_ACCOUNT;
  }

  /** User-facing accounts: no debt bookkeeping account, no Zerro storage account. */
  userAccounts(includeArchived: boolean): Account[] {
    return [...this.data.account.values()].filter(
      (account) => !this.isServiceAccount(account) && (includeArchived || !account.archive),
    );
  }

  accountTitle(id: string): string {
    return this.data.account.get(id)?.title ?? id;
  }

  accountInstrument(account: Account): number {
    return account.instrument ?? this.rootUser().currency;
  }

  /** By id, name (case/emoji-insensitive, unique substring) or card/account number suffix. */
  resolveAccount(ref: string): Account {
    const id = ref.trim();
    const byId = this.data.account.get(id) ?? this.data.account.get(id.toUpperCase()) ?? this.data.account.get(id.toLowerCase());
    if (byId && !this.isServiceAccount(byId)) return byId;
    const all = this.userAccounts(true);
    const digits = ref.replace(/\D/g, '');
    if (digits.length >= 4 && digits.length === ref.replace(/[\s*#№.]/g, '').length) {
      const bySync = all.filter((account) =>
        account.syncID?.some((sync) => sync.length >= 2 && (sync.endsWith(digits) || digits.endsWith(sync))),
      );
      if (bySync.length === 1) return bySync[0]!;
    }
    // Exact names win anywhere (live preferred); substrings are tried on live accounts before archived ones.
    const live = all.filter((account) => !account.archive);
    const archived = all.filter((account) => account.archive);
    const named = (accounts: Account[]) => accounts.map((item) => ({ item, names: [item.title] }));
    let hits = matchByName(ref, named(all), true);
    if (hits.length > 1 && hits.some((account) => !account.archive)) hits = hits.filter((account) => !account.archive);
    if (!hits.length) hits = matchByName(ref, named(live));
    if (!hits.length) hits = matchByName(ref, named(archived));
    const describe = (account: Account) =>
      `${account.title} [${this.currencyCode(account.instrument)}${account.archive ? ', archived' : ''}] id=${account.id}`;
    return pickOne(ref, hits, live, describe, 'Account');
  }

  // Categories (tags)

  tagPath(tagOrId: Tag | string | null | undefined): string {
    if (!tagOrId) return 'Uncategorized';
    const tag = typeof tagOrId === 'string' ? this.data.tag.get(tagOrId) : tagOrId;
    if (!tag) return 'Uncategorized';
    const parent = tag.parent ? this.data.tag.get(tag.parent) : undefined;
    return parent ? `${parent.title} / ${tag.title}` : tag.title;
  }

  /** Top-level category of a tag (itself when it has no parent). */
  rootTagId(tagId: string): string {
    const tag = this.data.tag.get(tagId);
    return tag?.parent && this.data.tag.has(tag.parent) ? tag.parent : tagId;
  }

  childTags(tagId: string): Tag[] {
    return [...this.data.tag.values()].filter((tag) => tag.parent === tagId);
  }

  /** By id, "Parent / Child" path, name (case/emoji-insensitive) or unique substring. */
  resolveTag(ref: string): Tag {
    const byId = this.data.tag.get(ref.trim());
    if (byId) return byId;
    const tags = [...this.data.tag.values()];
    if (ref.includes('/')) {
      const wanted = ref.split('/').map((part) => normalizeName(part)).join('/');
      const hit = tags.find((tag) => this.tagPath(tag).split(' / ').map((part) => normalizeName(part)).join('/') === wanted);
      if (hit) return hit;
    }
    const hits = matchByName(ref, tags.map((item) => ({ item, names: [item.title, this.tagPath(item)] })));
    return pickOne(ref, hits, tags, (tag) => `${this.tagPath(tag)} id=${tag.id}`, 'Category');
  }

  /** The tag plus its subcategories. */
  tagFamily(tagId: string): string[] {
    return [tagId, ...this.childTags(tagId).map((tag) => tag.id)];
  }

  // Merchants

  merchantTitle(id: string | null | undefined): string | undefined {
    return id ? this.data.merchant.get(id)?.title : undefined;
  }

  merchantByTitle(title: string): Merchant | undefined {
    const wanted = normalizeName(title);
    if (!wanted) return undefined;
    for (const merchant of this.data.merchant.values()) if (normalizeName(merchant.title) === wanted) return merchant;
    return undefined;
  }

  /** What the ZenMoney apps show as the counterparty: merchant title, else the free-text payee. */
  payeeOf(tx: { merchant: string | null; payee: string | null }): string | undefined {
    return this.merchantTitle(tx.merchant) ?? (tx.payee || undefined);
  }

  // Transactions

  /** Zerro's "delete permanently" overwrites both amounts with 0.00001. */
  isErased(tx: Transaction): boolean {
    return tx.income <= 0.00001 && tx.outcome <= 0.00001;
  }

  /** Soft-deleted or erased. */
  isDeleted(tx: Transaction): boolean {
    return tx.deleted || this.isErased(tx);
  }

  /** Classifies a movement; pass `debtId` when classifying many to skip the account scan. */
  view<T extends Transaction | ReminderMarker>(tx: T, debtId = this.debtAccount()?.id): TxView<T> {
    const mainTagId = tx.tag?.[0] ?? null;
    if (debtId && tx.incomeAccount === debtId) {
      return { tx, type: 'debt_out', accountId: tx.outcomeAccount, amount: tx.outcome, instrument: tx.outcomeInstrument, mainTagId };
    }
    if (debtId && tx.outcomeAccount === debtId) {
      return { tx, type: 'debt_in', accountId: tx.incomeAccount, amount: tx.income, instrument: tx.incomeInstrument, mainTagId };
    }
    if (tx.income > 0 && tx.outcome > 0) {
      return {
        tx,
        type: 'transfer',
        accountId: tx.outcomeAccount,
        amount: tx.outcome,
        instrument: tx.outcomeInstrument,
        toAccountId: tx.incomeAccount,
        toAmount: tx.income,
        toInstrument: tx.incomeInstrument,
        mainTagId,
      };
    }
    if (tx.outcome > 0) {
      return { tx, type: 'expense', accountId: tx.outcomeAccount, amount: tx.outcome, instrument: tx.outcomeInstrument, mainTagId };
    }
    return { tx, type: 'income', accountId: tx.incomeAccount, amount: tx.income, instrument: tx.incomeInstrument, mainTagId };
  }

  /** Planned operations that belong to the user (not Zerro's hidden storage). */
  isServiceMovement(movement: { incomeAccount: string; outcomeAccount: string }): boolean {
    const isZerro = (id: string) => this.data.account.get(id)?.title === ZERRO_DATA_ACCOUNT;
    return isZerro(movement.incomeAccount) || isZerro(movement.outcomeAccount);
  }

  /** Compact, name-resolved representation for tool output. Empty fields are omitted. */
  formatMovement(view: TxView<Transaction | ReminderMarker>): Record<string, unknown> {
    const { tx } = view;
    const out: Record<string, unknown> = {
      id: tx.id,
      date: tx.date,
      type: view.type,
      amount: round2(view.amount),
      currency: this.currencyCode(view.instrument),
      account: this.accountTitle(view.accountId),
    };
    if (view.type === 'transfer') {
      out.to_account = this.accountTitle(view.toAccountId!);
      out.to_amount = round2(view.toAmount!);
      out.to_currency = this.currencyCode(view.toInstrument);
    }
    if (tx.tag?.length) {
      out.category = this.tagPath(tx.tag[0]);
      if (tx.tag.length > 1) out.extra_categories = tx.tag.slice(1).map((id) => this.tagPath(id));
    }
    const payee = this.payeeOf(tx);
    if (payee) out.payee = payee;
    if (tx.comment) out.comment = tx.comment;
    if ('opOutcome' in tx) {
      const opAmount = view.type === 'income' || view.type === 'debt_in' ? tx.opIncome : tx.opOutcome;
      const opInstrument = view.type === 'income' || view.type === 'debt_in' ? tx.opIncomeInstrument : tx.opOutcomeInstrument;
      if (opAmount && opInstrument && opInstrument !== view.instrument) {
        out.original_amount = round2(opAmount);
        out.original_currency = this.currencyCode(opInstrument);
      }
      if (tx.hold) out.hold = true;
      if (this.isDeleted(tx)) out.deleted = true;
    }
    return out;
  }
}
