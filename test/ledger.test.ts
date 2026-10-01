import { beforeAll, describe, expect, it } from 'vitest';
import { addMonths, budgetMonthOf, budgetMonthRange, periodRange, resolveRange } from '../src/zenmoney/dates.js';
import { Ledger } from '../src/zenmoney/ledger.js';
import { FakeZenMoney } from './fake-zenmoney.js';
import { seedData } from './fixtures.js';
import { makeStore } from './harness.js';

describe('date ranges', () => {
  it('resolves calendar periods with Monday weeks and clamped month ends', () => {
    expect(periodRange('this_week', '2026-10-04')).toEqual({ from: '2026-09-28', to: '2026-10-04' });
    expect(periodRange('last_month', '2026-03-31')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('this_quarter', '2026-09-28')).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(periodRange('last_quarter', '2026-01-15')).toEqual({ from: '2025-10-01', to: '2025-12-31' });
    expect(periodRange('last_12_months', '2026-09-28')).toEqual({ from: '2025-09-29', to: '2026-09-28' });
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('lets explicit dates override a period end and rejects inverted ranges', () => {
    expect(resolveRange({ period: 'this_month', date_to: '2026-09-15' }, '2026-09-28')).toEqual({ from: '2026-09-01', to: '2026-09-15' });
    expect(() => resolveRange({ date_from: '2026-09-10', date_to: '2026-09-01' }, '2026-09-28')).toThrow(/after/);
  });

  it('shifts budget months by the profile month start day', () => {
    expect(budgetMonthRange('2026-09', 1)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(budgetMonthRange('2026-09', 10)).toEqual({ from: '2026-09-10', to: '2026-10-09' });
    expect(budgetMonthRange('2026-12', 25)).toEqual({ from: '2026-12-25', to: '2027-01-24' });
    expect(budgetMonthOf('2026-10-05', 25)).toBe('2026-09');
    expect(budgetMonthOf('2026-10-25', 25)).toBe('2026-10');
    expect(budgetMonthOf('2026-01-03', 10)).toBe('2025-12');
  });
});

describe('name resolution', () => {
  let ledger: Ledger;
  beforeAll(async () => {
    const store = makeStore(new FakeZenMoney(seedData()));
    await store.ensureFresh();
    ledger = new Ledger(store);
  });

  it('prefers live accounts and falls back to archived ones only when nothing live matches', () => {
    expect(ledger.resolveAccount('card').title).toBe('Credit Card');
    expect(ledger.resolveAccount('old').title).toBe('Old Card');
    expect(ledger.resolveAccount('1234').title).toBe('Tinkoff Black');
  });

  it('never resolves service accounts as regular accounts', () => {
    expect(() => ledger.resolveAccount('Долги')).toThrow(/No account matches/);
    expect(() => ledger.resolveAccount('acc-zerro')).toThrow(/No account matches/);
  });

  it('matches categories ignoring emoji and punctuation', () => {
    expect(ledger.resolveTag('gifts').id).toBe('tag-gifts');
    expect(ledger.resolveTag('Food / Groceries').id).toBe('tag-groceries');
    expect(ledger.resolveTag('groceries').id).toBe('tag-groceries');
  });
});
