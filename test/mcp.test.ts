import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, connect } from './harness.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('MCP surface', () => {
  it('hides write tools in read-only mode', async () => {
    harness = await connect({ readOnly: true });
    const { tools } = await harness.client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('list_transactions');
    expect(names).not.toContain('create_transactions');
    expect(names).not.toContain('delete_transactions');
  });

  it('explains missing token configuration instead of failing to start', async () => {
    harness = await connect({ withoutToken: true });
    const result = await harness.callRaw('get_overview');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('ZENMONEY_TOKEN');
    expect(result.text).toContain('zerro.app/token');
  });

  it('gives an overview with net worth, month totals and upcoming planned operations', async () => {
    harness = await connect();
    const overview = await harness.call('get_overview');
    expect(overview.today).toBe('2026-09-28');
    expect(overview.user.main_currency).toBe('RUB');
    expect(overview.balances).toEqual({
      currency: 'RUB',
      in_balance_accounts: 149400,
      off_balance_accounts: 190000,
      owed_to_you: 3000,
      you_owe: 900,
      net_worth: 341500,
    });
    expect(overview.this_month).toMatchObject({ expense: 10500, income: 150000, uncategorized_count: 1 });
    expect(overview.this_month.top_expense_categories[0]).toMatchObject({ group: 'Food / Groceries', amount: 5000 });
    expect(overview.accounts.map((account: { title: string }) => account.title)).not.toContain('🤖 [Zerro Data]');
    // Overdue items are outside the next-7-days window; forecasts are excluded here.
    expect(overview.upcoming_planned_7_days.items.map((item: { id: string }) => item.id)).toEqual(['mk-taxi', 'mk-rent']);
  });
});
