import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/zenmoney/types.js';
import { type Harness, connect } from './harness.js';

let h: Harness;
beforeEach(async () => {
  h = await connect();
  await h.call('list_accounts'); // warm the replica so writes would otherwise run inside the TTL window
});
afterEach(async () => {
  await h.close();
});

const serverTx = (id: string) => h.fake.get<Transaction>('transaction', id)!;

describe('writes against a changing server', () => {
  it('keeps edits made elsewhere moments before (no stale-replica overwrite)', async () => {
    h.fake.externalChange('transaction', { ...serverTx('t-cafe'), comment: 'edited on phone', changed: 10 });
    await h.call('update_transactions', { updates: [{ id: 't-cafe', amount: 600 }] });
    expect(serverTx('t-cafe')).toMatchObject({ outcome: 600, comment: 'edited on phone' });
  });

  it('serializes concurrent edits of the same transaction', async () => {
    await Promise.all([
      h.call('update_transactions', { updates: [{ id: 't-cafe', comment: 'parallel comment' }] }),
      h.call('update_transactions', { updates: [{ id: 't-cafe', category: 'Groceries' }] }),
    ]);
    expect(serverTx('t-cafe')).toMatchObject({ comment: 'parallel comment', tag: ['tag-groceries'] });
  });

  it('still edits transactions whose merchant was deleted in the app', async () => {
    h.fake.externalDeletion('merchant', 'm-starbucks');
    await h.call('update_transactions', { updates: [{ id: 't-cafe', comment: 'still editable' }] });
    expect(serverTx('t-cafe')).toMatchObject({ comment: 'still editable', merchant: null });
  });

  it('replaces only the main category and keeps secondary tags', async () => {
    h.fake.externalChange('transaction', { ...serverTx('t-cafe'), tag: ['tag-cafe', 'tag-gifts'], changed: 10 });
    await h.call('update_transactions', { updates: [{ id: 't-cafe', category: 'Groceries' }] });
    expect(serverTx('t-cafe').tag).toEqual(['tag-groceries', 'tag-gifts']);
  });

  it('keeps the fee of a same-currency transfer when only the sent amount changes', async () => {
    const created = await h.call('create_transactions', {
      transactions: [{ type: 'transfer', amount: 1000, account: 'Tinkoff Black', to_account: 'Credit Card', to_amount: 990 }],
    });
    const id = created.created[0].id;
    await h.call('update_transactions', { updates: [{ id, amount: 1100 }] });
    expect(serverTx(id)).toMatchObject({ outcome: 1100, income: 990 });
  });

  it('rejects empty updates and impossible dates', async () => {
    const empty = await h.callRaw('update_transactions', { updates: [{ id: 't-cafe' }] });
    expect(empty.text).toContain('Nothing to change');
    const badDate = await h.callRaw('create_transactions', {
      transactions: [{ type: 'expense', amount: 1, account: 'Tinkoff Black', date: '2026-02-30' }],
    });
    expect(badDate.isError).toBe(true);
    expect(badDate.text).toContain('Not a real calendar date');
    const badMonth = await h.callRaw('get_budget', { month: '2026-13' });
    expect(badMonth.isError).toBe(true);
  });

  it('turns a lost push answer into a warning-backed retry instead of a silent duplicate', async () => {
    const transaction = { type: 'expense', amount: 777, account: 'Tinkoff Black', category: 'Cafe', date: '2026-09-27' };
    h.fake.failNextPush = 'timeout';
    const lost = await h.callRaw('create_transactions', { transactions: [transaction] });
    expect(lost.isError).toBe(true);
    expect(lost.text).toContain('may or may not have been saved');

    const retry = await h.call('create_transactions', { transactions: [transaction] });
    expect(retry.warnings?.[0]).toMatch(/looks like a duplicate of existing transaction/);
  });

  it('retries dropped connections transparently without duplicating the push', async () => {
    h.fake.failNextPush = 'network';
    await h.call('create_transactions', { transactions: [{ type: 'expense', amount: 4321, account: 'Tinkoff Black' }] });
    expect(h.fake.all<Transaction>('transaction').filter((tx) => tx.outcome === 4321)).toHaveLength(1);
  });

  it('restores a deleted transaction only once', async () => {
    await h.call('delete_transactions', { ids: ['t-cafe'] });
    const first = await h.call('restore_transactions', { ids: ['t-cafe'] });
    const second = await h.call('restore_transactions', { ids: ['t-cafe'] });
    expect(second.restored).toBeUndefined();
    expect(second.already_restored).toEqual([{ id: 't-cafe', restored_as: first.restored[0].id }]);
  });
});

describe('report consistency', () => {
  it('computes list_transactions totals like ZenMoney reports (in-balance, not deleted)', async () => {
    const listed = await h.call('list_transactions', { period: 'this_month', include_deleted: true });
    expect(listed.totals).toMatchObject({ expense: 10500, income: 150000 });
  });
});
