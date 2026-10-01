import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Budget, Tag, Transaction } from '../src/zenmoney/types.js';
import { TOTAL_BUDGET_TAG } from '../src/zenmoney/types.js';
import { type Harness, connect } from './harness.js';
import { TODAY, USD, USER_ID } from './fixtures.js';

let h: Harness;
beforeEach(async () => {
  h = await connect();
});
afterEach(async () => {
  await h.close();
});

const serverTx = (id: string) => h.fake.get<Transaction>('transaction', id)!;

describe('create_transactions', () => {
  it('records an expense the server accepts and reports the recalculated balance', async () => {
    const result = await h.call('create_transactions', {
      transactions: [{ type: 'expense', amount: 1500, account: 'tinkoff', category: 'Cafe', payee: 'Coffee Lab', comment: 'flat white' }],
    });
    const created = result.created[0];
    expect(created).toMatchObject({ type: 'expense', amount: 1500, account: 'Tinkoff Black', category: 'Food / Cafe', date: TODAY });
    const stored = serverTx(created.id);
    expect(stored).toMatchObject({
      user: USER_ID,
      outcomeAccount: 'acc-tinkoff',
      incomeAccount: 'acc-tinkoff',
      outcome: 1500,
      income: 0,
      tag: ['tag-cafe'],
      payee: 'Coffee Lab',
      comment: 'flat white',
      deleted: false,
    });
    expect(stored).not.toHaveProperty('viewed');
    expect(result.balances).toEqual([{ account: 'Tinkoff Black', balance: 137200, currency: 'RUB' }]);
  });

  it('fills a missing category from the payee history before asking the suggestion service', async () => {
    h.fake.suggestions.set('magnum', { payee: 'Magnum', tag: ['tag-gifts'] });
    h.fake.suggestions.set('mcdonalds', { payee: 'McDonalds', merchant: 'm-mcd', tag: ['tag-cafe'] });
    const result = await h.call('create_transactions', {
      transactions: [
        { type: 'expense', amount: 800, account: 'Tinkoff Black', payee: 'magnum' },
        { type: 'expense', amount: 450, account: 'Tinkoff Black', payee: 'McDonalds' },
        { type: 'expense', amount: 300, account: 'Tinkoff Black', payee: 'Nowhere Inc' },
      ],
    });
    expect(result.created[0]).toMatchObject({ category: 'Food / Groceries', category_source: 'payee history', payee: 'Magnum' });
    expect(result.created[1]).toMatchObject({ category: 'Food / Cafe', category_source: 'ZenMoney suggestion' });
    expect(result.created[2]).not.toHaveProperty('category');
    expect(serverTx(result.created[0].id).merchant).toBe('m-magnum');
    expect(serverTx(result.created[1].id).merchant).toBe('m-mcd');
  });

  it('requires to_amount for transfers between currencies and books both sides', async () => {
    const missing = await h.callRaw('create_transactions', {
      transactions: [{ type: 'transfer', amount: 9000, account: 'Tinkoff Black', to_account: 'Cash USD' }],
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('transactions[0]: to_amount is required');

    const result = await h.call('create_transactions', {
      transactions: [{ type: 'transfer', amount: 9000, account: 'Tinkoff Black', to_account: 'Cash USD', to_amount: 100 }],
    });
    expect(serverTx(result.created[0].id)).toMatchObject({
      outcomeAccount: 'acc-tinkoff',
      outcome: 9000,
      outcomeInstrument: 2,
      incomeAccount: 'acc-cash-usd',
      income: 100,
      incomeInstrument: USD,
    });
  });

  it('routes debt operations through the debt account in the real account currency', async () => {
    const missingPerson = await h.callRaw('create_transactions', { transactions: [{ type: 'debt_out', amount: 10, account: 'Cash USD' }] });
    expect(missingPerson.text).toContain('payee (the person) is required');

    const result = await h.call('create_transactions', {
      transactions: [{ type: 'debt_out', amount: 30, account: 'Cash USD', payee: 'Masha' }],
    });
    expect(serverTx(result.created[0].id)).toMatchObject({
      outcomeAccount: 'acc-cash-usd',
      incomeAccount: 'acc-debt',
      outcome: 30,
      income: 30,
      outcomeInstrument: USD,
      incomeInstrument: USD,
      merchant: 'm-masha',
    });
    const debts = await h.call('list_debts', { person: 'masha' });
    expect(debts.people[0].balance).toEqual({ RUB: 3000, USD: 30 });
  });

  it('stores the original currency of a foreign purchase and warns about likely duplicates', async () => {
    const result = await h.call('create_transactions', {
      transactions: [
        { type: 'expense', amount: 3000, account: 'Tinkoff Black', category: 'Groceries', date: '2026-09-05', original_amount: 33, original_currency: 'USD' },
      ],
    });
    expect(serverTx(result.created[0].id)).toMatchObject({ opOutcome: 33, opOutcomeInstrument: USD });
    expect(result.warnings).toEqual(['transactions[0] looks like a duplicate of existing transaction t-groceries-1']);
  });

  it('refuses unknown accounts with the list of known ones and pushes nothing', async () => {
    const pushesBefore = h.fake.requests.length;
    const result = await h.callRaw('create_transactions', {
      transactions: [
        { type: 'expense', amount: 1, account: 'Tinkoff Black' },
        { type: 'expense', amount: 1, account: 'Revolut' },
      ],
    });
    expect(result.text).toContain('transactions[1]: No account matches "Revolut"');
    expect(result.text).toContain('Tinkoff Black');
    expect(h.fake.requests.slice(pushesBefore).some((request) => 'transaction' in request.body)).toBe(false);
  });
});

describe('update, delete and restore', () => {
  it('previews edits, deletions and merges with dry_run without touching ZenMoney', async () => {
    const pushes = () => h.fake.requests.filter((request) => ['transaction', 'tag', 'budget', 'deletion'].some((key) => key in request.body)).length;
    const preview = await h.call('update_transactions', { updates: [{ id: 't-cafe', amount: 650, category: 'Groceries' }], dry_run: true });
    expect(preview.changes[0].before).toMatchObject({ amount: 500, category: 'Food / Cafe' });
    expect(preview.changes[0].after).toMatchObject({ amount: 650, category: 'Food / Groceries' });
    const merge = await h.call('delete_category', { category: 'Cafe', move_to: 'Groceries', dry_run: true });
    expect(merge).toMatchObject({ dry_run: true, would_delete: 'Food / Cafe', transactions_updated: 2 });
    const removal = await h.call('delete_transactions', { ids: ['t-cafe'], dry_run: true });
    expect(removal.would_delete).toHaveLength(1);
    expect(pushes()).toBe(0);
    expect(serverTx('t-cafe')).toMatchObject({ outcome: 500, tag: ['tag-cafe'], deleted: false });
    expect(h.fake.get('tag', 'tag-cafe')).toBeDefined();
  });

  it('edits category, payee and comment, relinking the merchant', async () => {
    const result = await h.call('update_transactions', {
      updates: [{ id: 't-uncat', category: 'Groceries', payee: 'Starbucks', comment: 'fixed' }],
    });
    expect(result.updated[0]).toMatchObject({ id: 't-uncat', category: 'Food / Groceries', payee: 'Starbucks', comment: 'fixed' });
    expect(serverTx('t-uncat')).toMatchObject({ tag: ['tag-groceries'], merchant: 'm-starbucks', payee: 'Starbucks', comment: 'fixed' });

    await h.call('update_transactions', { updates: [{ id: 't-uncat', category: null, payee: null }] });
    expect(serverTx('t-uncat')).toMatchObject({ tag: null, merchant: null, payee: null });
  });

  it('keeps both sides of a same-currency transfer in step and rejects transfer fields on expenses', async () => {
    const created = await h.call('create_transactions', {
      transactions: [{ type: 'transfer', amount: 1000, account: 'Tinkoff Black', to_account: 'Credit Card' }],
    });
    const id = created.created[0].id;
    await h.call('update_transactions', { updates: [{ id, amount: 1200 }] });
    expect(serverTx(id)).toMatchObject({ outcome: 1200, income: 1200 });

    const wrong = await h.callRaw('update_transactions', { updates: [{ id: 't-cafe', to_account: 'Cash USD' }] });
    expect(wrong.text).toContain('updates[0]: to_account/to_amount apply only to transfers');
  });

  it('soft-deletes and restores as a new copy with balances following along', async () => {
    const deleted = await h.call('delete_transactions', { ids: ['t-cafe'] });
    expect(deleted.deleted[0]).toMatchObject({ id: 't-cafe' });
    expect(serverTx('t-cafe').deleted).toBe(true);
    expect(deleted.balances).toEqual([{ account: 'Tinkoff Black', balance: 139200, currency: 'RUB' }]);

    const restored = await h.call('restore_transactions', { ids: ['t-cafe'] });
    const copy = restored.restored[0];
    expect(copy.restored_from).toBe('t-cafe');
    expect(copy.id).not.toBe('t-cafe');
    expect(serverTx(copy.id)).toMatchObject({ deleted: false, outcome: 500, tag: ['tag-cafe'] });
    expect(restored.balances).toEqual([{ account: 'Tinkoff Black', balance: 138700, currency: 'RUB' }]);
  });

  it('requires a new amount when moving a transaction to an account in another currency', async () => {
    const refused = await h.callRaw('update_transactions', { updates: [{ id: 't-cafe', account: 'Cash USD' }] });
    expect(refused.text).toContain('currency changes from RUB to USD; pass amount in USD');
    expect(serverTx('t-cafe')).toMatchObject({ outcomeAccount: 'acc-tinkoff', outcome: 500 });

    await h.call('update_transactions', { updates: [{ id: 't-cafe', account: 'Cash USD', amount: 5.5 }] });
    expect(serverTx('t-cafe')).toMatchObject({ outcomeAccount: 'acc-cash-usd', incomeAccount: 'acc-cash-usd', outcome: 5.5, outcomeInstrument: USD, incomeInstrument: USD });
  });

  it('refuses to edit deleted transactions', async () => {
    const result = await h.callRaw('update_transactions', { updates: [{ id: 't-deleted', amount: 1 }] });
    expect(result.text).toContain('is deleted; restore it first');
  });
});

describe('categories', () => {
  it('creates subcategories inheriting the parent kind and enforces one nesting level and unique names', async () => {
    const created = await h.call('create_category', { title: 'Restaurants', parent: 'Food' });
    expect(created.created).toMatchObject({ category: 'Food / Restaurants', kind: 'expense' });
    expect(h.fake.get<Tag>('tag', created.created.id)).toMatchObject({ parent: 'tag-food', showOutcome: true, budgetOutcome: true, user: USER_ID });

    const nested = await h.callRaw('create_category', { title: 'Sushi', parent: 'Food / Restaurants' });
    expect(nested.text).toContain('already a subcategory');
    const duplicate = await h.callRaw('create_category', { title: 'groceries', parent: 'Food' });
    expect(duplicate.text).toContain('already exists');
  });

  it('merges a category into another, retagging transactions and planned operations', async () => {
    const blocked = await h.callRaw('delete_category', { category: 'Transport' });
    expect(blocked.text).toContain('has subcategories');
    await h.call('delete_category', { category: 'Transport / Other', uncategorize: true });

    const unconfirmed = await h.callRaw('delete_category', { category: 'Transport' });
    expect(unconfirmed.text).toContain('Pass move_to');

    const result = await h.call('delete_category', { category: 'Transport', move_to: 'Cafe' });
    expect(result).toMatchObject({ deleted: 'Transport', moved_to: 'Food / Cafe', transactions_updated: 1, planned_updated: 4 });
    expect(h.fake.get('tag', 'tag-transport')).toBeUndefined();
    expect(serverTx('t-transport').tag).toEqual(['tag-cafe']);
    const categories = await h.call('list_categories', { search: 'transport' });
    expect(categories.categories).toEqual([]);
  });

  it('renames, archives and moves categories', async () => {
    await h.call('update_category', { category: 'Gifts', title: 'Presents', parent: 'Food', archived: true });
    expect(h.fake.get<Tag>('tag', 'tag-gifts')).toMatchObject({ title: 'Presents', parent: 'tag-food', archive: true });
    const hidden = await h.call('list_categories', { search: 'presents' });
    expect(hidden.categories).toEqual([]);
  });
});

describe('budgets and accounts', () => {
  it('sets exact budgets (lock on) and removes them with 0', async () => {
    const result = await h.call('set_budgets', {
      budgets: [
        { month: '2026-10', category: 'Groceries', expense: 9000 },
        { month: '2026-10', category: 'total', expense: 60000 },
        { month: '2026-10', category: 'uncategorized', expense: 1000 },
        { month: '2026-09', category: 'Food', expense: 0 },
      ],
    });
    expect(result.budgets).toEqual([
      { month: '2026-10', category: 'Food / Groceries', expense: 9000, income: null },
      { month: '2026-10', category: 'total', expense: 60000, income: null },
      { month: '2026-10', category: 'Uncategorized', expense: 1000, income: null },
      { month: '2026-09', category: 'Food', expense: null, income: null },
    ]);
    expect(h.fake.get<Budget>('budget', '2026-10-01#tag-groceries')).toMatchObject({ outcome: 9000, outcomeLock: true, user: USER_ID });
    expect(h.fake.get<Budget>('budget', `2026-10-01#${TOTAL_BUDGET_TAG}`)).toMatchObject({ outcome: 60000 });
    expect(h.fake.get<Budget>('budget', '2026-09-01#tag-food')).toMatchObject({ outcome: 0, outcomeLock: false });

    const october = await h.call('get_budget', { month: '2026-10' });
    expect(october.expense.total).toMatchObject({ budget: 60000 });
  });

  it('creates and archives accounts', async () => {
    const created = await h.call('create_account', { title: 'Wallet EUR', currency: 'EUR', balance: 120 });
    expect(created.created).toMatchObject({ title: 'Wallet EUR', type: 'cash', currency: 'EUR', balance: 120 });
    const duplicate = await h.callRaw('create_account', { title: 'wallet eur' });
    expect(duplicate.text).toContain('already exists');

    await h.call('update_account', { account: 'Wallet EUR', archived: true });
    const accounts = await h.call('list_accounts');
    expect(accounts.accounts.map((account: { title: string }) => account.title)).not.toContain('Wallet EUR');
  });

  it('reconciles a balance with a correction transaction', async () => {
    const result = await h.call('adjust_account_balance', { account: 'Credit Card', actual_balance: -2000 });
    expect(result).toMatchObject({ previous_balance: -1900, balance_now: -2000 });
    expect(result.correction).toMatchObject({ type: 'expense', amount: 100, comment: 'Balance correction' });

    const again = await h.call('adjust_account_balance', { account: 'Credit Card', actual_balance: -2000 });
    expect(again.already_matches).toBe(true);
  });
});
