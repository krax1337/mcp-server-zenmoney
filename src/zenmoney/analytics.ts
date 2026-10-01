import { budgetMonthRange, weekStart, weekdayName } from './dates.js';
import { type Ledger, type TxType, type TxView, normalizeName, round2 } from './ledger.js';
import type { Budget, Reminder, ReminderMarker, Transaction } from './types.js';
import { TOTAL_BUDGET_TAG } from './types.js';

export interface TxQuery {
  from?: string;
  to?: string;
  ids?: Set<string>;
  types?: TxType[];
  /** Matches the source or destination account. */
  accountIds?: Set<string>;
  /** Matches any tag on the transaction. */
  tagIds?: Set<string>;
  uncategorized?: boolean;
  payee?: string;
  query?: string;
  minAmount?: number;
  maxAmount?: number;
  currencyIds?: Set<number>;
  includeDeleted?: boolean;
  /** Only movements on accounts that count in ZenMoney's balance and reports. */
  inBalanceOnly?: boolean;
}

export const SORTS = ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'] as const;
export type Sort = (typeof SORTS)[number];

export const GROUP_BYS = ['category', 'parent_category', 'payee', 'account', 'day', 'week', 'month', 'year', 'none'] as const;
export type GroupBy = (typeof GROUP_BYS)[number];
const TIME_GROUPS: GroupBy[] = ['day', 'week', 'month', 'year'];

export const MEASURES = ['expense', 'income', 'both'] as const;
export type Measure = (typeof MEASURES)[number];

export function queryTransactions(ledger: Ledger, query: TxQuery): TxView[] {
  const debtId = ledger.debtAccount()?.id;
  const payee = query.payee?.trim().toLowerCase();
  const text = query.query?.trim().toLowerCase();
  const out: TxView[] = [];
  for (const tx of ledger.data.transaction.values()) {
    if (!query.includeDeleted && ledger.isDeleted(tx)) continue;
    if (query.from && tx.date < query.from) continue;
    if (query.to && tx.date > query.to) continue;
    if (query.ids && !query.ids.has(tx.id)) continue;
    const view = ledger.view(tx, debtId);
    if (query.types && !query.types.includes(view.type)) continue;
    if (query.accountIds && !query.accountIds.has(view.accountId) && !(view.toAccountId && query.accountIds.has(view.toAccountId))) {
      continue;
    }
    if (query.inBalanceOnly && !ledger.data.account.get(view.accountId)?.inBalance) continue;
    if (query.uncategorized && view.mainTagId && ledger.data.tag.has(view.mainTagId)) continue;
    if (query.tagIds && !tx.tag?.some((id) => query.tagIds!.has(id))) continue;
    if (query.minAmount !== undefined && view.amount < query.minAmount) continue;
    if (query.maxAmount !== undefined && view.amount > query.maxAmount) continue;
    if (query.currencyIds && !query.currencyIds.has(view.instrument) && !(view.toInstrument && query.currencyIds.has(view.toInstrument))) {
      continue;
    }
    if (payee) {
      const names = [tx.payee, tx.originalPayee, ledger.merchantTitle(tx.merchant)];
      if (!names.some((name) => name?.toLowerCase().includes(payee))) continue;
    }
    if (text) {
      const haystack = [tx.payee, tx.originalPayee, ledger.merchantTitle(tx.merchant), tx.comment, ...(tx.tag ?? []).map((id) => ledger.tagPath(id))];
      if (!haystack.some((value) => value?.toLowerCase().includes(text))) continue;
    }
    out.push(view);
  }
  return out;
}

export function sortViews(ledger: Ledger, views: TxView[], sort: Sort): TxView[] {
  const main = ledger.rootUser().currency;
  const inMain = (view: TxView) => ledger.convert(view.amount, view.instrument, main);
  const byDate = (a: TxView, b: TxView) => a.tx.date.localeCompare(b.tx.date) || a.tx.created - b.tx.created;
  switch (sort) {
    case 'date_desc':
      return views.sort((a, b) => byDate(b, a));
    case 'date_asc':
      return views.sort(byDate);
    case 'amount_desc':
      return views.sort((a, b) => inMain(b) - inMain(a));
    case 'amount_asc':
      return views.sort((a, b) => inMain(a) - inMain(b));
  }
}

/** Totals of expense and income (transfers and debts excluded) in `currencyId`. */
export function totals(ledger: Ledger, views: TxView[], currencyId: number) {
  let expense = 0;
  let income = 0;
  for (const view of views) {
    if (view.type === 'expense') expense += ledger.convert(view.amount, view.instrument, currencyId);
    if (view.type === 'income') income += ledger.convert(view.amount, view.instrument, currencyId);
  }
  return { expense: round2(expense), income: round2(income), net: round2(income - expense) };
}

export interface UsualCategory {
  tagId: string;
  /** How many past transactions of this payee carried that category. */
  count: number;
}

/** Most frequent main category per normalized payee among past transactions of `types`. */
export function usualCategories(ledger: Ledger, types: TxType[] = ['expense', 'income']): Map<string, UsualCategory> {
  const counts = new Map<string, Map<string, number>>();
  const debtId = ledger.debtAccount()?.id;
  for (const tx of ledger.data.transaction.values()) {
    if (ledger.isDeleted(tx)) continue;
    const payee = ledger.payeeOf(tx);
    const tagId = tx.tag?.[0];
    if (!payee || !tagId || !ledger.data.tag.has(tagId)) continue;
    if (!types.includes(ledger.view(tx, debtId).type)) continue;
    const key = normalizeName(payee);
    let perTag = counts.get(key);
    if (!perTag) counts.set(key, (perTag = new Map()));
    perTag.set(tagId, (perTag.get(tagId) ?? 0) + 1);
  }
  const usual = new Map<string, UsualCategory>();
  for (const [key, perTag] of counts) {
    let best: UsualCategory | undefined;
    for (const [tagId, count] of perTag) if (!best || count > best.count) best = { tagId, count };
    if (best) usual.set(key, best);
  }
  return usual;
}

interface Group {
  label: string;
  income: number;
  expense: number;
  count: number;
}

function groupKey(ledger: Ledger, view: TxView, groupBy: GroupBy): { key: string; label: string } {
  const date = view.tx.date;
  switch (groupBy) {
    case 'category':
      return { key: view.mainTagId ?? '', label: ledger.tagPath(view.mainTagId) };
    case 'parent_category': {
      const root = view.mainTagId && ledger.data.tag.has(view.mainTagId) ? ledger.rootTagId(view.mainTagId) : '';
      return { key: root, label: ledger.tagPath(root) };
    }
    case 'payee': {
      const payee = ledger.payeeOf(view.tx) ?? '(no payee)';
      return { key: normalizeName(payee) || payee, label: payee };
    }
    case 'account':
      return { key: view.accountId, label: ledger.accountTitle(view.accountId) };
    case 'day':
      return { key: date, label: date };
    case 'week':
      return { key: weekStart(date), label: `week of ${weekStart(date)}` };
    case 'month':
      return { key: date.slice(0, 7), label: date.slice(0, 7) };
    case 'year':
      return { key: date.slice(0, 4), label: date.slice(0, 4) };
    case 'none':
      return { key: 'total', label: 'total' };
  }
}

export interface SummaryOptions {
  groupBy: GroupBy;
  measure: Measure;
  currencyId: number;
  top: number;
}

/** Aggregates expense and/or income movements into groups with shares of the total. */
export function summarize(ledger: Ledger, views: TxView[], options: SummaryOptions) {
  const { groupBy, measure, currencyId, top } = options;
  const relevant = views.filter((view) =>
    measure === 'both' ? view.type === 'expense' || view.type === 'income' : view.type === measure,
  );
  const groups = new Map<string, Group>();
  for (const view of relevant) {
    const { key, label } = groupKey(ledger, view, groupBy);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { label, income: 0, expense: 0, count: 0 }));
    const amount = ledger.convert(view.amount, view.instrument, currencyId);
    if (view.type === 'expense') group.expense += amount;
    else group.income += amount;
    group.count++;
  }
  const sum = totals(ledger, relevant, currencyId);
  const isTime = TIME_GROUPS.includes(groupBy);
  const ordered = [...groups.entries()].sort(([keyA, a], [keyB, b]) =>
    isTime ? keyA.localeCompare(keyB) : measure === 'income' ? b.income - a.income : b.expense + b.income - (a.expense + a.income),
  );
  const shown = isTime ? ordered : ordered.slice(0, top);
  const hidden = isTime ? [] : ordered.slice(top);

  const total = measure === 'income' ? sum.income : sum.expense;
  const row = (label: string, group: Omit<Group, 'label'>) => {
    if (measure === 'both') {
      return { group: label, income: round2(group.income), expense: round2(group.expense), net: round2(group.income - group.expense), count: group.count };
    }
    const amount = measure === 'income' ? group.income : group.expense;
    return { group: label, amount: round2(amount), count: group.count, share_pct: total ? round2((amount / total) * 100) : 0 };
  };
  const rows = shown.map(([, group]) => row(group.label, group));
  if (hidden.length) {
    const rest = hidden.reduce(
      (acc, [, group]) => ({ income: acc.income + group.income, expense: acc.expense + group.expense, count: acc.count + group.count }),
      { income: 0, expense: 0, count: 0 },
    );
    rows.push(row(`(${hidden.length} more groups)`, rest));
  }
  const averages =
    isTime && groups.size
      ? measure === 'both'
        ? { average_income: round2(sum.income / groups.size), average_expense: round2(sum.expense / groups.size) }
        : { average_per_group: round2(total / groups.size) }
      : {};
  return {
    currency: ledger.currencyCode(currencyId),
    ...(measure === 'both' ? sum : { total, count: relevant.length }),
    ...averages,
    groups: rows,
  };
}

// Budgets

interface BudgetLine {
  budget: number | null;
  actual: number;
  planned: number;
}

function lineOutput(line: BudgetLine, fromChildren = false) {
  const out: Record<string, unknown> = { budget: line.budget === null ? null : round2(line.budget), actual: round2(line.actual) };
  if (line.budget !== null) {
    out.remaining = round2(line.budget - line.actual);
    out.used_pct = line.budget ? round2((line.actual / line.budget) * 100) : null;
  }
  if (line.planned) out.planned = round2(line.planned);
  if (fromChildren) out.budget_from_subcategories = true;
  return out;
}

/**
 * ZenMoney monthly budget vs. actuals. A budget without lock also counts the month's planned
 * operations (API semantics). Only in-balance accounts and categories included in the budget count.
 */
export function budgetReport(ledger: Ledger, month: string) {
  const user = ledger.rootUser();
  const main = user.currency;
  const range = budgetMonthRange(month, user.monthStartDay ?? 1);
  const debtId = ledger.debtAccount()?.id;
  type Side = 'expense' | 'income';
  const actual: Record<Side, Map<string, number>> = { expense: new Map(), income: new Map() };
  const planned: Record<Side, Map<string, number>> = { expense: new Map(), income: new Map() };
  const add = (map: Map<string, number>, key: string, amount: number) => map.set(key, (map.get(key) ?? 0) + amount);
  const tagKey = (view: TxView<Transaction | ReminderMarker>) =>
    view.mainTagId && ledger.data.tag.has(view.mainTagId) ? view.mainTagId : 'null';
  const counts = (view: TxView<Transaction | ReminderMarker>, side: Side) => {
    const tag = view.mainTagId ? ledger.data.tag.get(view.mainTagId) : undefined;
    const inBudget = !tag || (side === 'expense' ? tag.budgetOutcome : tag.budgetIncome);
    return inBudget && ledger.data.account.get(view.accountId)?.inBalance;
  };

  for (const tx of ledger.data.transaction.values()) {
    if (tx.date < range.from || tx.date > range.to || ledger.isDeleted(tx)) continue;
    const view = ledger.view(tx, debtId);
    if ((view.type === 'expense' || view.type === 'income') && counts(view, view.type)) {
      add(actual[view.type], tagKey(view), ledger.convert(view.amount, view.instrument, main));
    }
  }
  for (const marker of ledger.data.reminderMarker.values()) {
    if (marker.state !== 'planned' || marker.date < range.from || marker.date > range.to) continue;
    if (ledger.isServiceMovement(marker)) continue;
    const view = ledger.view(marker, debtId);
    if ((view.type === 'expense' || view.type === 'income') && counts(view, view.type)) {
      add(planned[view.type], tagKey(view), ledger.convert(view.amount, view.instrument, main));
    }
  }

  const budgets = new Map<string, Budget>();
  for (const budget of ledger.data.budget.values()) {
    if (budget.date !== `${month}-01`) continue;
    // Budgets can outlive their (deleted) category; those no longer show up anywhere in ZenMoney.
    if (budget.tag && budget.tag !== TOTAL_BUDGET_TAG && !ledger.data.tag.has(budget.tag)) continue;
    budgets.set(budget.tag ?? 'null', budget);
  }
  const ownBudget = (key: string, side: Side): number | null => {
    const budget = budgets.get(key);
    if (!budget) return null;
    const amount = side === 'expense' ? budget.outcome : budget.income;
    const lock = side === 'expense' ? budget.outcomeLock : budget.incomeLock;
    if (!amount && !lock) return null;
    return lock ? amount : amount + (planned[side].get(key) ?? 0);
  };

  const buildSide = (side: Side) => {
    const keys = new Set<string>([...actual[side].keys(), ...planned[side].keys()]);
    for (const [key] of budgets) if (key !== TOTAL_BUDGET_TAG && ownBudget(key, side) !== null) keys.add(key);
    const roots = new Map<string, string[]>();
    for (const key of keys) {
      const root = key === 'null' ? 'null' : ledger.rootTagId(key);
      if (!roots.has(root)) roots.set(root, []);
      if (root !== key) roots.get(root)!.push(key);
    }
    const line = (key: string): BudgetLine => ({
      budget: ownBudget(key, side),
      actual: actual[side].get(key) ?? 0,
      planned: planned[side].get(key) ?? 0,
    });
    const entries = [...roots.entries()].map(([root, children]) => {
      const own = line(root);
      const childLines = children.map((key) => ({ key, line: line(key) }));
      const childBudget = childLines.reduce((sum, child) => sum + (child.line.budget ?? 0), 0);
      const fromChildren = own.budget === null && childLines.some((child) => child.line.budget !== null);
      const total: BudgetLine = {
        budget: fromChildren ? childBudget : own.budget,
        actual: own.actual + childLines.reduce((sum, child) => sum + child.line.actual, 0),
        planned: own.planned + childLines.reduce((sum, child) => sum + child.line.planned, 0),
      };
      const row = {
        category: root === 'null' ? 'Uncategorized' : ledger.tagPath(root),
        ...(root === 'null' ? {} : { id: root }),
        ...lineOutput(total, fromChildren),
        ...(childLines.length
          ? {
              subcategories: childLines
                .sort((a, b) => b.line.actual - a.line.actual)
                .map((child) => ({ category: ledger.tagPath(child.key), id: child.key, ...lineOutput(child.line) })),
            }
          : {}),
      };
      return { total, row };
    });
    entries.sort((a, b) => b.total.actual - a.total.actual);
    const actualTotal = [...actual[side].values()].reduce((sum, value) => sum + value, 0);
    const plannedTotal = [...planned[side].values()].reduce((sum, value) => sum + value, 0);
    const explicitTotal = ownBudget(TOTAL_BUDGET_TAG, side);
    const categoriesBudget = entries.reduce((sum, entry) => sum + (entry.total.budget ?? 0), 0);
    return {
      total: lineOutput({ budget: explicitTotal ?? (categoriesBudget || null), actual: actualTotal, planned: plannedTotal }),
      ...(explicitTotal !== null ? { total_is_explicit_monthly_budget: true } : {}),
      categories: entries.map((entry) => entry.row),
    };
  };

  return {
    month,
    period: range,
    currency: ledger.currencyCode(main),
    expense: buildSide('expense'),
    income: buildSide('income'),
  };
}

// Debts

export interface Debtor {
  name: string;
  /** Positive: they owe you. Negative: you owe them. Keyed by currency code. */
  balance: Record<string, number>;
  balanceInMain: number;
  transactions: number;
  lastDate: string;
}

/** Per-person debt balances from movements through the debt account (same rules as Zerro). */
export function debtors(ledger: Ledger): Debtor[] {
  const debtId = ledger.debtAccount()?.id;
  if (!debtId) return [];
  const main = ledger.rootUser().currency;
  const byKey = new Map<string, Debtor & { amounts: Map<number, number> }>();
  for (const tx of ledger.data.transaction.values()) {
    if (ledger.isDeleted(tx)) continue;
    const view = ledger.view(tx, debtId);
    if (view.type !== 'debt_out' && view.type !== 'debt_in') continue;
    // Debts recorded without a person still count towards totals and net worth.
    const name = ledger.payeeOf(tx) ?? '(unknown person)';
    const key = normalizeName(name);
    let debtor = byKey.get(key);
    if (!debtor) {
      byKey.set(key, (debtor = { name, balance: {}, balanceInMain: 0, transactions: 0, lastDate: tx.date, amounts: new Map() }));
    }
    const signed = view.type === 'debt_out' ? view.amount : -view.amount;
    debtor.amounts.set(view.instrument, (debtor.amounts.get(view.instrument) ?? 0) + signed);
    debtor.transactions++;
    if (tx.date > debtor.lastDate) debtor.lastDate = tx.date;
  }
  return [...byKey.values()].map(({ amounts, ...debtor }) => {
    for (const [instrument, amount] of amounts) {
      if (Math.abs(amount) < 0.005) continue;
      debtor.balance[ledger.currencyCode(instrument)] = round2(amount);
      debtor.balanceInMain += ledger.convert(amount, instrument, main);
    }
    debtor.balanceInMain = round2(debtor.balanceInMain);
    return debtor;
  });
}

// Planned operations

export function describeRecurrence(reminder: Reminder | undefined): string {
  if (!reminder?.interval) return 'one-time';
  const step = reminder.step ?? 1;
  const unit = step === 1 ? reminder.interval : `${step} ${reminder.interval}s`;
  let text = `every ${unit}`;
  if (reminder.interval === 'day' && step === 7 && reminder.points?.length) {
    const days = reminder.points.map((offset) => {
      const date = new Date(`${reminder.startDate}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + offset);
      return weekdayName(date.toISOString().slice(0, 10));
    });
    text = `weekly on ${days.join(', ')}`;
  } else if (reminder.points?.length && !(reminder.points.length === 1 && reminder.points[0] === 0)) {
    text += ` (points ${reminder.points.join(', ')})`;
  }
  text += ` from ${reminder.startDate}`;
  if (reminder.endDate) text += ` until ${reminder.endDate}`;
  return text;
}

export function plannedOperations(ledger: Ledger, from: string, to: string, today: string, includeForecast = true) {
  const debtId = ledger.debtAccount()?.id;
  const main = ledger.rootUser().currency;
  const items: Array<Record<string, unknown>> = [];
  let expense = 0;
  let income = 0;
  for (const marker of ledger.data.reminderMarker.values()) {
    if (marker.state !== 'planned' || marker.date < from || marker.date > to) continue;
    if (ledger.isServiceMovement(marker) || (!includeForecast && marker.isForecast)) continue;
    const view = ledger.view(marker, debtId);
    if (view.type === 'expense') expense += ledger.convert(view.amount, view.instrument, main);
    if (view.type === 'income') income += ledger.convert(view.amount, view.instrument, main);
    const formatted = ledger.formatMovement(view);
    formatted.recurrence = describeRecurrence(ledger.data.reminder.get(marker.reminder));
    if (marker.date < today) formatted.overdue = true;
    if (marker.isForecast) formatted.forecast = true;
    items.push(formatted);
  }
  items.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { totals: { currency: ledger.currencyCode(main), expense: round2(expense), income: round2(income) }, items };
}

// Balances

export function balanceSummary(ledger: Ledger) {
  const main = ledger.rootUser().currency;
  let inBalance = 0;
  let offBalance = 0;
  for (const account of ledger.userAccounts(false)) {
    const value = ledger.convert(account.balance ?? 0, ledger.accountInstrument(account), main);
    if (account.inBalance) inBalance += value;
    else offBalance += value;
  }
  let owedToYou = 0;
  let youOwe = 0;
  for (const debtor of debtors(ledger)) {
    if (debtor.balanceInMain > 0) owedToYou += debtor.balanceInMain;
    else youOwe -= debtor.balanceInMain;
  }
  return {
    currency: ledger.currencyCode(main),
    in_balance_accounts: round2(inBalance),
    off_balance_accounts: round2(offBalance),
    owed_to_you: round2(owedToYou),
    you_owe: round2(youOwe),
    net_worth: round2(inBalance + offBalance + owedToYou - youOwe),
  };
}
