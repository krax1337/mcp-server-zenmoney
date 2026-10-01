import { randomUUID } from 'node:crypto';
import { budgetKey } from './store.js';
import { type Ledger, type TxType, UserInputError } from './ledger.js';
import type { Account, AccountType, Budget, Reminder, ReminderMarker, Tag, Transaction } from './types.js';

/** Unix seconds; ZenMoney rejects millisecond stamps. */
export const unixNow = () => Math.floor(Date.now() / 1000);

/** A `changed` stamp the server will treat as newer than its own copy. */
const bump = (previous: number, now: number) => Math.max(now, previous + 1);

/** Copy of a stored entity with `changes` applied and a fresh `changed` stamp. */
export function touch<T extends { changed: number }>(existing: T, changes: Partial<T>, now: number): T {
  return { ...existing, ...changes, changed: bump(existing.changed, now) };
}

/**
 * Push-ready copy. Drops references the server would reject because their target was deleted
 * since (tags, merchant, planned marker) and `viewed: null`, which makes the server answer 500.
 */
export function forPush<T extends Transaction | Reminder | ReminderMarker>(ledger: Ledger, item: T): T {
  const copy: Transaction | Reminder | ReminderMarker = { ...item };
  const tags = copy.tag?.filter((id) => ledger.data.tag.has(id)) ?? [];
  copy.tag = tags.length ? tags : null;
  if (copy.merchant && !ledger.data.merchant.has(copy.merchant)) copy.merchant = null;
  if ('reminderMarker' in copy) {
    if (copy.reminderMarker && !ledger.data.reminderMarker.has(copy.reminderMarker)) copy.reminderMarker = null;
    if (copy.viewed === null || copy.viewed === undefined) delete copy.viewed;
  }
  return copy as T;
}

export interface NewTransaction {
  type: TxType;
  amount: number;
  account: Account;
  toAccount?: Account;
  toAmount?: number;
  tagIds: string[] | null;
  payee: string | null;
  merchantId: string | null;
  comment: string | null;
  date: string;
  /** Amount in the operation's own currency when it differs from the account's (e.g. paid USD from a RUB card). */
  original?: { amount: number; instrument: number };
}

/**
 * Full transaction object in ZenMoney's double-entry shape. Every documented property is
 * present (explicit nulls included): the API rejects partial objects.
 */
export function buildTransaction(ledger: Ledger, input: NewTransaction, now: number): Transaction {
  const instrument = ledger.accountInstrument(input.account);
  const base = {
    id: randomUUID(),
    changed: now,
    created: now,
    user: ledger.rootUser().id,
    deleted: false,
    hold: false,
    tag: input.tagIds?.length ? input.tagIds : null,
    merchant: input.merchantId,
    payee: input.payee,
    originalPayee: null,
    comment: input.comment,
    date: input.date,
    mcc: null,
    reminderMarker: null,
    opIncome: null,
    opIncomeInstrument: null,
    opOutcome: null,
    opOutcomeInstrument: null,
    latitude: null,
    longitude: null,
    incomeBankID: null,
    outcomeBankID: null,
    qrCode: null,
  } satisfies Partial<Transaction>;
  const original = input.original && input.original.instrument !== instrument ? input.original : undefined;
  const outgoing = original ? { opOutcome: original.amount, opOutcomeInstrument: original.instrument } : {};
  const incoming = original ? { opIncome: original.amount, opIncomeInstrument: original.instrument } : {};
  const own = { incomeAccount: input.account.id, outcomeAccount: input.account.id, incomeInstrument: instrument, outcomeInstrument: instrument };

  switch (input.type) {
    case 'expense':
      return {
        ...base,
        ...own,
        income: 0,
        outcome: input.amount,
        ...outgoing,
      };
    case 'income':
      return {
        ...base,
        ...own,
        income: input.amount,
        outcome: 0,
        ...incoming,
      };
    case 'transfer': {
      const to = input.toAccount;
      if (!to) throw new UserInputError('to_account is required for a transfer');
      if (to.id === input.account.id) throw new UserInputError('A transfer needs two different accounts');
      if (input.original) throw new UserInputError('original_amount does not apply to transfers; give amount and to_amount instead');
      const toInstrument = ledger.accountInstrument(to);
      let toAmount = input.toAmount;
      if (toAmount === undefined) {
        if (toInstrument !== instrument) {
          throw new UserInputError(
            `to_amount is required: ${input.account.title} is in ${ledger.currencyCode(instrument)} and ${to.title} is in ${ledger.currencyCode(toInstrument)}`,
          );
        }
        toAmount = input.amount;
      }
      return {
        ...base,
        outcomeAccount: input.account.id,
        outcomeInstrument: instrument,
        outcome: input.amount,
        incomeAccount: to.id,
        incomeInstrument: toInstrument,
        income: toAmount,
      };
    }
    case 'debt_out':
    case 'debt_in': {
      const debt = ledger.debtAccount();
      if (!debt) {
        throw new UserInputError('This ZenMoney profile has no debt account yet; record the first debt in the ZenMoney app.');
      }
      if (!input.payee) throw new UserInputError('payee (the person) is required for debt operations');
      // Debt movements are recorded in the real account's currency on both sides (API rule).
      const outcomeAccount = input.type === 'debt_out' ? input.account.id : debt.id;
      const incomeAccount = input.type === 'debt_out' ? debt.id : input.account.id;
      return {
        ...base,
        outcomeAccount,
        incomeAccount,
        outcomeInstrument: instrument,
        incomeInstrument: instrument,
        outcome: input.amount,
        income: input.amount,
        ...(input.type === 'debt_out' ? outgoing : incoming),
      };
    }
  }
}

export interface TransactionPatch {
  amount?: number;
  toAmount?: number;
  account?: Account;
  toAccount?: Account;
  /** New main category, keeping secondary tags; `null` leaves the transaction uncategorized. */
  mainTagId?: string | null;
  payee?: string | null;
  merchantId?: string | null;
  comment?: string | null;
  date?: string;
  /** `null` removes the original-currency amount. */
  original?: { amount: number; instrument: number } | null;
}

/** Applies a patch to a stored transaction, keeping both sides of the double entry consistent. */
export function patchTransaction(ledger: Ledger, existing: Transaction, patch: TransactionPatch, now: number): Transaction {
  const view = ledger.view(existing);
  const next: Transaction = { ...existing, changed: bump(existing.changed, now) };
  for (const account of [patch.account, patch.toAccount]) {
    if (account && ledger.isServiceAccount(account)) {
      throw new UserInputError('Use a regular account; debt operations go through the debt_out/debt_in types');
    }
  }
  /** Moving money to an account in another currency without a new amount would silently reinterpret the number. */
  const requireAmount = (from: number, to: number, given: boolean, field: 'amount' | 'to_amount') => {
    if (from !== to && !given) {
      throw new UserInputError(
        `The account currency changes from ${ledger.currencyCode(from)} to ${ledger.currencyCode(to)}; pass ${field} in ${ledger.currencyCode(to)}`,
      );
    }
  };

  switch (view.type) {
    case 'expense':
    case 'income': {
      if (patch.toAccount || patch.toAmount !== undefined) {
        throw new UserInputError(`to_account/to_amount apply only to transfers; this transaction is an ${view.type}`);
      }
      if (patch.account) {
        const instrument = ledger.accountInstrument(patch.account);
        requireAmount(view.instrument, instrument, patch.amount !== undefined, 'amount');
        Object.assign(next, { incomeAccount: patch.account.id, outcomeAccount: patch.account.id, incomeInstrument: instrument, outcomeInstrument: instrument });
      }
      if (patch.amount !== undefined) {
        if (view.type === 'expense') next.outcome = patch.amount;
        else next.income = patch.amount;
      }
      break;
    }
    case 'transfer': {
      if (patch.account) {
        next.outcomeInstrument = ledger.accountInstrument(patch.account);
        next.outcomeAccount = patch.account.id;
        requireAmount(existing.outcomeInstrument, next.outcomeInstrument, patch.amount !== undefined, 'amount');
      }
      if (patch.toAccount) {
        next.incomeInstrument = ledger.accountInstrument(patch.toAccount);
        next.incomeAccount = patch.toAccount.id;
        // A new same-currency destination can take its amount from `amount`.
        const derived = patch.amount !== undefined && next.incomeInstrument === next.outcomeInstrument;
        requireAmount(existing.incomeInstrument, next.incomeInstrument, patch.toAmount !== undefined || derived, 'to_amount');
      }
      if (next.incomeAccount === next.outcomeAccount) throw new UserInputError('A transfer needs two different accounts');
      if (patch.amount !== undefined) next.outcome = patch.amount;
      if (patch.toAmount !== undefined) next.income = patch.toAmount;
      // Mirror `amount` only for plain same-currency transfers; a differing received amount is a fee to keep.
      else if (patch.amount !== undefined && next.incomeInstrument === next.outcomeInstrument && (existing.income === existing.outcome || patch.toAccount)) {
        next.income = patch.amount;
      }
      if (patch.original !== undefined) throw new UserInputError('original_amount does not apply to transfers');
      break;
    }
    case 'debt_out':
    case 'debt_in': {
      if (patch.toAccount || patch.toAmount !== undefined) {
        throw new UserInputError('to_account/to_amount apply only to transfers');
      }
      if (patch.account) {
        const instrument = ledger.accountInstrument(patch.account);
        requireAmount(view.instrument, instrument, patch.amount !== undefined, 'amount');
        if (view.type === 'debt_out') next.outcomeAccount = patch.account.id;
        else next.incomeAccount = patch.account.id;
        next.incomeInstrument = instrument;
        next.outcomeInstrument = instrument;
      }
      if (patch.amount !== undefined) {
        next.income = patch.amount;
        next.outcome = patch.amount;
      }
      break;
    }
  }

  if (patch.mainTagId !== undefined) {
    const main = patch.mainTagId;
    next.tag = main === null ? null : [main, ...(existing.tag ?? []).slice(1).filter((id) => id !== main)];
  }
  if (patch.payee !== undefined) next.payee = patch.payee;
  if (patch.merchantId !== undefined) next.merchant = patch.merchantId;
  if (patch.comment !== undefined) next.comment = patch.comment;
  if (patch.date !== undefined) next.date = patch.date;
  if (patch.original !== undefined) {
    const incoming = view.type === 'income' || view.type === 'debt_in';
    const accountInstrument = incoming ? next.incomeInstrument : next.outcomeInstrument;
    // An "original" amount in the account's own currency carries no information; store none.
    const original = patch.original && patch.original.instrument !== accountInstrument ? patch.original : null;
    const fields = { amount: original?.amount ?? null, instrument: original?.instrument ?? null };
    if (incoming) Object.assign(next, { opIncome: fields.amount, opIncomeInstrument: fields.instrument });
    else Object.assign(next, { opOutcome: fields.amount, opOutcomeInstrument: fields.instrument });
  }
  if (next.income < 0 || next.outcome < 0) throw new UserInputError('Amounts must be positive');
  return next;
}

/**
 * Deleted transactions cannot be revived in place, so a restore re-creates them under a new id
 * (as Zerro does), detached from the planned operation that produced the original.
 */
export function restoredCopy(existing: Transaction, now: number): Transaction {
  return { ...existing, id: randomUUID(), deleted: false, changed: now, reminderMarker: null };
}

// Categories

export type TagKind = 'expense' | 'income' | 'both';

export function tagKindFlags(kind: TagKind) {
  const showOutcome = kind !== 'income';
  const showIncome = kind !== 'expense';
  return { showOutcome, showIncome, budgetOutcome: showOutcome, budgetIncome: showIncome };
}

export function tagKind(tag: Tag): TagKind | 'none' {
  if (tag.showIncome && tag.showOutcome) return 'both';
  if (tag.showIncome) return 'income';
  if (tag.showOutcome) return 'expense';
  return 'none';
}

export interface NewTag {
  title: string;
  parent: Tag | null;
  kind: TagKind;
  required: boolean;
}

export function buildTag(ledger: Ledger, input: NewTag, now: number): Tag {
  return {
    id: randomUUID(),
    changed: now,
    user: ledger.rootUser().id,
    title: input.title,
    parent: input.parent?.id ?? null,
    icon: null,
    picture: null,
    color: null,
    staticId: null,
    required: input.required,
    ...tagKindFlags(input.kind),
  };
}

// Budgets

export interface BudgetChange {
  /** First day of the month. */
  date: string;
  /** Tag id, `null` for "uncategorized", or the all-zero total tag. */
  tag: string | null;
  expense?: number;
  income?: number;
}

/**
 * Sets the exact monthly amount (lock on). An amount of 0 clears that side: per the API,
 * unlocking with 0 removes the budget.
 */
export function buildBudget(ledger: Ledger, change: BudgetChange, now: number): Budget {
  const existing = ledger.data.budget.get(budgetKey(change));
  const next: Budget = {
    ...(existing ?? { income: 0, incomeLock: false, outcome: 0, outcomeLock: false }),
    changed: bump(existing?.changed ?? 0, now),
    user: ledger.rootUser().id,
    tag: change.tag,
    date: change.date,
  };
  if (change.expense !== undefined) {
    next.outcome = change.expense;
    next.outcomeLock = change.expense !== 0;
    if (existing && 'isOutcomeForecast' in existing) next.isOutcomeForecast = false;
  }
  if (change.income !== undefined) {
    next.income = change.income;
    next.incomeLock = change.income !== 0;
    if (existing && 'isIncomeForecast' in existing) next.isIncomeForecast = false;
  }
  return next;
}

// Accounts

export const CREATABLE_ACCOUNT_TYPES = ['cash', 'ccard', 'checking', 'emoney'] as const satisfies readonly AccountType[];

export interface NewAccount {
  title: string;
  type: (typeof CREATABLE_ACCOUNT_TYPES)[number];
  instrument: number;
  balance: number;
  creditLimit: number;
  inBalance: boolean;
  savings: boolean;
}

export function buildAccount(ledger: Ledger, input: NewAccount, now: number): Account {
  return {
    id: randomUUID(),
    changed: now,
    user: ledger.rootUser().id,
    role: null,
    instrument: input.instrument,
    company: null,
    type: input.type,
    title: input.title,
    syncID: null,
    balance: input.balance,
    startBalance: input.balance,
    creditLimit: input.creditLimit,
    inBalance: input.inBalance,
    savings: input.savings,
    enableCorrection: false,
    enableSMS: false,
    archive: false,
    private: false,
    capitalization: null,
    percent: null,
    startDate: null,
    endDateOffset: null,
    endDateOffsetInterval: null,
    payoffStep: null,
    payoffInterval: null,
  };
}
