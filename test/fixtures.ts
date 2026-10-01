import type { Account, Budget, DiffEntities, Reminder, ReminderMarker, Tag, Transaction } from '../src/zenmoney/types.js';
import { TOTAL_BUDGET_TAG } from '../src/zenmoney/types.js';

export const TODAY = '2026-09-28';
export const USER_ID = 1001;
export const USD = 1;
export const RUB = 2;
export const EUR = 3;

function account(id: string, title: string, type: Account['type'], instrument: number, extra: Partial<Account> = {}): Account {
  return {
    id,
    changed: 1,
    user: USER_ID,
    role: null,
    instrument,
    company: null,
    type,
    title,
    syncID: null,
    balance: 0,
    startBalance: 0,
    creditLimit: 0,
    inBalance: true,
    savings: false,
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
    ...extra,
  };
}

function tag(id: string, title: string, parent: string | null, kind: 'expense' | 'income' = 'expense', extra: Partial<Tag> = {}): Tag {
  return {
    id,
    changed: 1,
    user: USER_ID,
    title,
    parent,
    icon: null,
    picture: null,
    color: null,
    showIncome: kind === 'income',
    showOutcome: kind === 'expense',
    budgetIncome: kind === 'income',
    budgetOutcome: kind === 'expense',
    required: null,
    staticId: null,
    ...extra,
  };
}

interface Movement {
  from: string;
  to: string;
  outcome: number;
  income: number;
  outcomeInstrument: number;
  incomeInstrument: number;
}

const expense = (accountId: string, amount: number, instrument = RUB): Movement => ({
  from: accountId, to: accountId, outcome: amount, income: 0, outcomeInstrument: instrument, incomeInstrument: instrument,
});
const income = (accountId: string, amount: number, instrument = RUB): Movement => ({
  from: accountId, to: accountId, outcome: 0, income: amount, outcomeInstrument: instrument, incomeInstrument: instrument,
});
const move = (from: string, outcome: number, outcomeInstrument: number, to: string, incomeAmount: number, incomeInstrument: number): Movement => ({
  from, to, outcome, income: incomeAmount, outcomeInstrument, incomeInstrument,
});

function tx(id: string, date: string, movement: Movement, extra: Partial<Transaction> = {}): Transaction {
  return {
    id,
    changed: 1,
    created: 1,
    user: USER_ID,
    deleted: false,
    hold: false,
    viewed: true,
    incomeInstrument: movement.incomeInstrument,
    incomeAccount: movement.to,
    income: movement.income,
    outcomeInstrument: movement.outcomeInstrument,
    outcomeAccount: movement.from,
    outcome: movement.outcome,
    tag: null,
    merchant: null,
    payee: null,
    originalPayee: null,
    comment: null,
    date,
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
    ...extra,
  };
}

function budget(tagId: string | null, date: string, extra: Partial<Budget>): Budget {
  return { changed: 1, user: USER_ID, tag: tagId, date, income: 0, incomeLock: false, outcome: 0, outcomeLock: false, ...extra };
}

function reminder(id: string, movement: Movement, extra: Partial<Reminder>): Reminder {
  return {
    id,
    changed: 1,
    user: USER_ID,
    incomeInstrument: movement.incomeInstrument,
    incomeAccount: movement.to,
    income: movement.income,
    outcomeInstrument: movement.outcomeInstrument,
    outcomeAccount: movement.from,
    outcome: movement.outcome,
    tag: null,
    merchant: null,
    payee: null,
    comment: null,
    interval: 'month',
    step: 1,
    points: [0],
    startDate: '2026-01-01',
    endDate: null,
    notify: true,
    ...extra,
  };
}

function marker(id: string, reminderId: string, date: string, movement: Movement, extra: Partial<ReminderMarker> = {}): ReminderMarker {
  return {
    id,
    changed: 1,
    user: USER_ID,
    incomeInstrument: movement.incomeInstrument,
    incomeAccount: movement.to,
    income: movement.income,
    outcomeInstrument: movement.outcomeInstrument,
    outcomeAccount: movement.from,
    outcome: movement.outcome,
    tag: null,
    merchant: null,
    payee: null,
    comment: null,
    date,
    reminder: reminderId,
    state: 'planned',
    notify: true,
    ...extra,
  };
}

/**
 * A small but complete profile. Expected September 2026 figures (main currency RUB, USD = 90):
 * in-balance expenses 10 500 (groceries 5 000, cafe 2 300, transport 1 200, food/other 900,
 * uncategorized 700, not-budgeted 400), income 150 000; Masha owes +3 000 RUB, user owes Petya 10 USD.
 */
export function seedData(): DiffEntities {
  return {
    instrument: [
      { id: USD, changed: 1, title: 'US Dollar', shortTitle: 'USD', symbol: '$', rate: 90 },
      { id: RUB, changed: 1, title: 'Russian Ruble', shortTitle: 'RUB', symbol: '₽', rate: 1 },
      { id: EUR, changed: 1, title: 'Euro', shortTitle: 'EUR', symbol: '€', rate: 100 },
    ],
    company: [{ id: 4624, changed: 1, title: 'Tinkoff', fullTitle: null, www: 'tinkoff.ru', country: 1 }],
    user: [{ id: USER_ID, changed: 1, login: 'tester', currency: RUB, parent: null, monthStartDay: 1, countryCode: 'RU' }],
    account: [
      account('acc-tinkoff', 'Tinkoff Black', 'ccard', RUB, { startBalance: 10000, syncID: ['1234'], company: 4624 }),
      account('acc-cash-usd', 'Cash USD', 'cash', USD, { startBalance: 50 }),
      account('acc-credit', 'Credit Card', 'ccard', RUB, { creditLimit: 100000, syncID: ['9876'] }),
      account('acc-savings', 'Savings', 'checking', RUB, { startBalance: 200000, inBalance: false, savings: true }),
      account('acc-old', 'Old Card', 'ccard', RUB, { archive: true }),
      account('acc-debt', 'Долги', 'debt', RUB, { inBalance: false }),
      account('acc-zerro', '🤖 [Zerro Data]', 'cash', RUB, { inBalance: false }),
    ],
    tag: [
      tag('tag-food', 'Food', null),
      tag('tag-groceries', 'Groceries', 'tag-food'),
      tag('tag-cafe', 'Cafe', 'tag-food'),
      tag('tag-food-other', 'Other', 'tag-food'),
      tag('tag-transport', 'Transport', null),
      tag('tag-transport-other', 'Other', 'tag-transport'),
      tag('tag-salary', 'Salary', null, 'income'),
      tag('tag-gifts', '🎁 Gifts', null),
      tag('tag-unbudgeted', 'Not budgeted', null, 'expense', { budgetOutcome: false }),
    ],
    merchant: [
      { id: 'm-magnum', changed: 1, user: USER_ID, title: 'Magnum' },
      { id: 'm-starbucks', changed: 1, user: USER_ID, title: 'Starbucks' },
      { id: 'm-masha', changed: 1, user: USER_ID, title: 'Masha' },
      { id: 'm-mcd', changed: 1, user: USER_ID, title: 'McDonalds' },
    ],
    transaction: [
      tx('t-salary', '2026-09-01', income('acc-tinkoff', 150000), { tag: ['tag-salary'], payee: 'ACME Corp' }),
      tx('t-transfer', '2026-09-03', move('acc-tinkoff', 9000, RUB, 'acc-cash-usd', 100, USD)),
      tx('t-groceries-1', '2026-09-05', expense('acc-tinkoff', 3000), { tag: ['tag-groceries'], merchant: 'm-magnum', payee: 'Magnum' }),
      tx('t-lend', '2026-09-07', move('acc-tinkoff', 5000, RUB, 'acc-debt', 5000, RUB), { merchant: 'm-masha', payee: 'Masha' }),
      tx('t-cafe', '2026-09-10', expense('acc-tinkoff', 500), { tag: ['tag-cafe'], merchant: 'm-starbucks', payee: 'Starbucks' }),
      tx('t-deleted', '2026-09-11', expense('acc-tinkoff', 999), { tag: ['tag-cafe'], deleted: true }),
      tx('t-transport', '2026-09-12', expense('acc-credit', 1200), { tag: ['tag-transport'], payee: 'Yandex Go' }),
      tx('t-groceries-2', '2026-09-14', expense('acc-tinkoff', 2000), { tag: ['tag-groceries'], merchant: 'm-magnum', payee: 'MAGNUM' }),
      tx('t-uncat', '2026-09-15', expense('acc-credit', 700), { payee: 'Unknown shop' }),
      tx('t-savings', '2026-09-16', expense('acc-savings', 10000), { tag: ['tag-gifts'] }),
      tx('t-unbudgeted', '2026-09-18', expense('acc-tinkoff', 400), { tag: ['tag-unbudgeted'] }),
      tx('t-usd-cafe', '2026-09-20', expense('acc-cash-usd', 20, USD), { tag: ['tag-cafe'], comment: 'coffee in USD' }),
      tx('t-foreign', '2026-09-21', expense('acc-tinkoff', 900), {
        tag: ['tag-food-other'],
        opOutcome: 10,
        opOutcomeInstrument: USD,
        payee: 'Amazon',
      }),
      tx('t-repay', '2026-09-25', move('acc-debt', 2000, RUB, 'acc-tinkoff', 2000, RUB), { merchant: 'm-masha', payee: 'Masha' }),
      tx('t-borrow', '2026-09-26', move('acc-debt', 10, USD, 'acc-cash-usd', 10, USD), { payee: 'Petya' }),
      tx('t-aug-groceries', '2026-08-20', expense('acc-tinkoff', 2500), { tag: ['tag-groceries'], merchant: 'm-magnum', payee: 'Magnum' }),
    ],
    budget: [
      budget('tag-food', '2026-09-01', { outcome: 20000, outcomeLock: true }),
      budget('tag-groceries', '2026-09-01', { outcome: 8000, outcomeLock: true }),
      budget('tag-transport', '2026-09-01', { outcome: 1000, outcomeLock: false }),
      budget(TOTAL_BUDGET_TAG, '2026-09-01', { outcome: 50000, outcomeLock: true }),
      budget('tag-salary', '2026-09-01', { income: 140000, incomeLock: true }),
    ],
    reminder: [
      reminder('r-taxi', expense('acc-credit', 500), { tag: ['tag-transport'], startDate: '2026-01-28' }),
      reminder('r-rent', expense('acc-tinkoff', 30000), { payee: 'Landlord', startDate: '2026-01-05' }),
      reminder('r-zerro', expense('acc-zerro', 1), { interval: null, step: null, points: null, comment: '{"zerro":"settings"}' }),
    ],
    reminderMarker: [
      marker('mk-overdue', 'r-taxi', '2026-09-24', expense('acc-credit', 300), { tag: ['tag-transport'] }),
      marker('mk-taxi', 'r-taxi', '2026-09-29', expense('acc-credit', 500), { tag: ['tag-transport'] }),
      marker('mk-processed', 'r-taxi', '2026-08-28', expense('acc-credit', 500), { tag: ['tag-transport'], state: 'processed' }),
      marker('mk-rent', 'r-rent', '2026-10-05', expense('acc-tinkoff', 30000), { payee: 'Landlord' }),
      marker('mk-forecast', 'r-rent', '2026-10-10', expense('acc-tinkoff', 1000), { isForecast: true }),
      marker('mk-zerro', 'r-zerro', '2026-09-30', expense('acc-zerro', 1)),
    ],
  };
}
