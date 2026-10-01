import * as z from 'zod/v4';
import type { TxQuery } from '../zenmoney/analytics.js';
import { type DateRange, PERIODS, resolveRange } from '../zenmoney/dates.js';
import { type Ledger, TX_TYPES } from '../zenmoney/ledger.js';

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'Not a real calendar date');
export const isoMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
export const txType = z.enum(TX_TYPES);

export const TX_TYPE_HELP =
  'expense | income | transfer (between own accounts) | debt_out (money given to a person: lending, or repaying them) | debt_in (money received from a person: borrowing, or them repaying you)';

/** Filters shared by list_transactions and summarize_transactions. */
export const filterShape = {
  period: z
    .enum(PERIODS)
    .optional()
    .describe('Date range relative to today (weeks start on Monday). date_from/date_to override either end.'),
  date_from: isoDate.optional().describe('Inclusive start date, YYYY-MM-DD'),
  date_to: isoDate.optional().describe('Inclusive end date, YYYY-MM-DD'),
  types: z.array(txType).optional().describe(`Transaction types to include: ${TX_TYPE_HELP}`),
  accounts: z
    .array(z.string())
    .optional()
    .describe('Account names, ids or card last digits; matches money leaving or arriving'),
  categories: z
    .array(z.string())
    .optional()
    .describe('Category names, "Parent / Child" paths or ids; subcategories are included'),
  uncategorized: z.boolean().optional().describe('Only transactions without a category'),
  payee: z.string().optional().describe('Substring of the payee / merchant name'),
  search: z.string().optional().describe('Free text matched against payee, merchant, comment and category names'),
  min_amount: z.number().nonnegative().optional().describe("Minimum amount in the account's currency"),
  max_amount: z.number().nonnegative().optional().describe("Maximum amount in the account's currency"),
  currency: z.string().optional().describe('Only transactions in this currency (ISO code)'),
};

export type FilterInput = {
  [K in keyof typeof filterShape]?: z.infer<(typeof filterShape)[K]>;
};

/** Resolves human references in filters into a query; unknown names fail with the list of known ones. */
export function buildQuery(ledger: Ledger, input: FilterInput, today: string): { query: TxQuery; range: DateRange } {
  const range = resolveRange(input, today);
  const query: TxQuery = {
    from: range.from,
    to: range.to,
    types: input.types?.length ? input.types : undefined,
    uncategorized: input.uncategorized,
    payee: input.payee,
    query: input.search,
    minAmount: input.min_amount,
    maxAmount: input.max_amount,
  };
  if (input.accounts?.length) query.accountIds = new Set(input.accounts.map((ref) => ledger.resolveAccount(ref).id));
  if (input.categories?.length) {
    query.tagIds = new Set(input.categories.flatMap((ref) => ledger.tagFamily(ledger.resolveTag(ref).id)));
  }
  if (input.currency) query.currencyIds = new Set([ledger.instrumentByCode(input.currency).id]);
  return { query, range };
}
