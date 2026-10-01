import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, connect } from './harness.js';

let h: Harness;
beforeEach(async () => {
  h = await connect({ readOnly: true });
});
afterEach(async () => {
  await h.close();
});

describe('list_transactions', () => {
  it('classifies every movement type from the double-entry shape', async () => {
    const result = await h.call('list_transactions', { ids: ['t-salary', 't-transfer', 't-groceries-1', 't-lend', 't-repay'] });
    const byId = Object.fromEntries(result.transactions.map((tx: { id: string }) => [tx.id, tx]));
    expect(byId['t-salary']).toMatchObject({ type: 'income', amount: 150000, account: 'Tinkoff Black', category: 'Salary' });
    expect(byId['t-transfer']).toMatchObject({
      type: 'transfer',
      amount: 9000,
      currency: 'RUB',
      account: 'Tinkoff Black',
      to_account: 'Cash USD',
      to_amount: 100,
      to_currency: 'USD',
    });
    expect(byId['t-groceries-1']).toMatchObject({ type: 'expense', category: 'Food / Groceries', payee: 'Magnum' });
    expect(byId['t-lend']).toMatchObject({ type: 'debt_out', amount: 5000, account: 'Tinkoff Black', payee: 'Masha' });
    expect(byId['t-repay']).toMatchObject({ type: 'debt_in', amount: 2000, account: 'Tinkoff Black', payee: 'Masha' });
  });

  it('filters by parent category including subcategories, newest first, with totals over all matches', async () => {
    const result = await h.call('list_transactions', { categories: ['Food'], period: 'this_month', limit: 2 });
    expect(result.total_matched).toBe(5);
    expect(result.returned).toBe(2);
    expect(result.next_offset).toBe(2);
    expect(result.transactions.map((tx: { id: string }) => tx.id)).toEqual(['t-foreign', 't-usd-cafe']);
    expect(result.totals).toEqual({ currency: 'RUB', expense: 8200, income: 0, net: -8200 });
  });

  it('shows the original currency of a foreign-currency purchase', async () => {
    const result = await h.call('list_transactions', { search: 'amazon' });
    expect(result.transactions).toEqual([
      expect.objectContaining({ id: 't-foreign', amount: 900, currency: 'RUB', original_amount: 10, original_currency: 'USD' }),
    ]);
  });

  it('hides deleted transactions unless asked', async () => {
    const visible = await h.call('list_transactions', { date_from: '2026-09-11', date_to: '2026-09-11' });
    expect(visible.total_matched).toBe(0);
    const withDeleted = await h.call('list_transactions', { date_from: '2026-09-11', date_to: '2026-09-11', include_deleted: true });
    expect(withDeleted.transactions).toEqual([expect.objectContaining({ id: 't-deleted', deleted: true })]);
  });

  it('matches accounts by card digits and payees across merchant and free-text spellings', async () => {
    const byCard = await h.call('list_transactions', { accounts: ['*9876'] });
    expect(byCard.transactions.map((tx: { id: string }) => tx.id).sort()).toEqual(['t-transport', 't-uncat']);
    const byPayee = await h.call('list_transactions', { payee: 'magnum' });
    expect(byPayee.total_matched).toBe(3);
  });

  it('rejects ambiguous category names with the candidate paths', async () => {
    const result = await h.callRaw('list_transactions', { categories: ['Other'] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('ambiguous');
    expect(result.text).toContain('Food / Other');
    expect(result.text).toContain('Transport / Other');
    const byPath = await h.call('list_transactions', { categories: ['food/other'] });
    expect(byPath.transactions.map((tx: { id: string }) => tx.id)).toEqual(['t-foreign']);
  });
});

describe('summarize_transactions', () => {
  it('reports September spending by category in the main currency, excluding off-balance accounts, transfers and debts', async () => {
    const report = await h.call('summarize_transactions', { period: 'this_month' });
    expect(report.total).toBe(10500);
    expect(report.groups.map((group: { group: string; amount: number }) => [group.group, group.amount])).toEqual([
      ['Food / Groceries', 5000],
      ['Food / Cafe', 2300],
      ['Transport', 1200],
      ['Food / Other', 900],
      ['Uncategorized', 700],
      ['Not budgeted', 400],
    ]);
  });

  it('rolls subcategories up to their parent and supports other report currencies', async () => {
    const report = await h.call('summarize_transactions', { period: 'this_month', group_by: 'parent_category', report_currency: 'USD' });
    expect(report.currency).toBe('USD');
    expect(report.groups[0]).toMatchObject({ group: 'Food', amount: 91.11 });
  });

  it('gives monthly cash flow with measure=both', async () => {
    const report = await h.call('summarize_transactions', { date_from: '2026-08-01', date_to: '2026-09-30', group_by: 'month', measure: 'both' });
    expect(report.groups).toEqual([
      { group: '2026-08', income: 0, expense: 2500, net: -2500, count: 1 },
      { group: '2026-09', income: 150000, expense: 10500, net: 139500, count: 9 },
    ]);
  });

  it('counts off-balance accounts when asked', async () => {
    const report = await h.call('summarize_transactions', { period: 'this_month', include_off_balance: true });
    expect(report.total).toBe(20500);
  });
});

describe('get_budget', () => {
  it('compares budgets with actuals, adding planned operations to unlocked budgets', async () => {
    const budget = await h.call('get_budget', { month: '2026-09', side: 'both' });
    const food = budget.expense.categories.find((row: { category: string }) => row.category === 'Food');
    expect(food).toMatchObject({ budget: 20000, actual: 8200, remaining: 11800, used_pct: 41 });
    expect(food.subcategories).toContainEqual(expect.objectContaining({ category: 'Food / Groceries', budget: 8000, actual: 5000 }));
    const transport = budget.expense.categories.find((row: { category: string }) => row.category === 'Transport');
    expect(transport).toMatchObject({ budget: 1800, actual: 1200, planned: 800, remaining: 600 });
    expect(budget.expense.total).toMatchObject({ budget: 50000, actual: 10100 });
    expect(budget.expense.total_is_explicit_monthly_budget).toBe(true);
    expect(budget.expense.categories.map((row: { category: string }) => row.category)).not.toContain('Not budgeted');
    expect(budget.income.categories).toEqual([
      expect.objectContaining({ category: 'Salary', budget: 140000, actual: 150000, remaining: -10000 }),
    ]);
  });
});

describe('debts, planned operations and accounts', () => {
  it('nets debts per person and currency', async () => {
    const debts = await h.call('list_debts');
    expect(debts).toMatchObject({ currency: 'RUB', owed_to_you: 3000, you_owe: 900 });
    expect(debts.people).toEqual([
      expect.objectContaining({ name: 'Masha', balance: { RUB: 3000 }, balance_main: 3000, transactions: 2 }),
      expect.objectContaining({ name: 'Petya', balance: { USD: -10 }, balance_main: -900 }),
    ]);
  });

  it('lists planned operations with overdue and forecast flags, ignoring Zerro storage reminders', async () => {
    const planned = await h.call('list_planned');
    expect(planned.items.map((item: { id: string }) => item.id)).toEqual(['mk-overdue', 'mk-taxi', 'mk-rent', 'mk-forecast']);
    expect(planned.items[0]).toMatchObject({ overdue: true, category: 'Transport', recurrence: 'every month from 2026-01-28' });
    expect(planned.items[3]).toMatchObject({ forecast: true });
    expect(planned.totals).toEqual({ currency: 'RUB', expense: 31800, income: 0 });
  });

  it('lists live accounts with converted balances and credit availability', async () => {
    const accounts = await h.call('list_accounts');
    const titles = accounts.accounts.map((account: { title: string }) => account.title);
    expect(titles).not.toContain('Old Card');
    expect(titles).not.toContain('Долги');
    expect(accounts.accounts.find((account: { title: string }) => account.title === 'Cash USD')).toMatchObject({ balance: 140, balance_main: 12600 });
    expect(accounts.accounts.find((account: { title: string }) => account.title === 'Credit Card')).toMatchObject({ balance: -1900, available: 98100 });
    expect(accounts.totals.in_balance_total_main).toBe(149400);
  });

  it('suggests categories from history and from the ZenMoney service', async () => {
    h.fake.suggestions.set('mcdonalds', { payee: 'McDonalds', merchant: 'm-mcd', tag: ['tag-cafe'] });
    const result = await h.call('suggest_category', { payees: ['magnum', 'McDonalds'] });
    expect(result.suggestions).toEqual([
      expect.objectContaining({ payee: 'magnum', history_category: 'Food / Groceries', history_uses: 3 }),
      expect.objectContaining({ payee: 'McDonalds', category: 'Food / Cafe', merchant: 'McDonalds' }),
    ]);
  });
});
