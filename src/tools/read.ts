import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  GROUP_BYS,
  MEASURES,
  SORTS,
  balanceSummary,
  budgetReport,
  debtors,
  plannedOperations,
  queryTransactions,
  sortViews,
  summarize,
  totals,
  usualCategories,
} from '../zenmoney/analytics.js';
import { addDays, budgetMonthOf, periodRange } from '../zenmoney/dates.js';
import { type Ledger, normalizeName, round2 } from '../zenmoney/ledger.js';
import type { Account, SuggestResponse, Tag } from '../zenmoney/types.js';
import { tagKind } from '../zenmoney/writes.js';
import { type ToolContext, compact, jsonResult } from './context.js';
import { buildQuery, filterShape, isoDate, isoMonth } from './schemas.js';

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const ACCOUNT_TYPES = ['cash', 'ccard', 'checking', 'loan', 'deposit', 'emoney'] as const;

function formatAccount(ledger: Ledger, account: Account, main: number) {
  const instrument = ledger.accountInstrument(account);
  const balance = account.balance ?? 0;
  const creditLimit = account.creditLimit ?? 0;
  return compact({
    id: account.id,
    title: account.title,
    type: account.type,
    currency: ledger.currencyCode(instrument),
    balance: round2(balance),
    balance_main: instrument === main ? undefined : round2(ledger.convert(balance, instrument, main)),
    credit_limit: creditLimit > 0 ? creditLimit : undefined,
    available: creditLimit > 0 ? round2(balance + creditLimit) : undefined,
    in_balance: account.inBalance,
    savings: account.savings || undefined,
    archived: account.archive || undefined,
    bank: account.company ? ledger.data.company.get(account.company)?.title : undefined,
    card_numbers: account.syncID ?? undefined,
    interest_pct: account.percent ?? undefined,
    opened: account.startDate ?? undefined,
    term: account.endDateOffset ? `${account.endDateOffset} ${account.endDateOffsetInterval ?? 'month'}(s)` : undefined,
  });
}

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_overview',
    {
      title: 'Financial overview',
      description:
        "Start here. Returns today's date, the user's main currency, net worth, active account balances, this month's income/expenses with top categories, upcoming planned operations and data freshness.",
      annotations: READ_ONLY,
    },
    async () => {
      const ledger = await ctx.fresh();
      const store = ctx.connected().store;
      const user = ledger.rootUser();
      const main = user.currency;
      const today = ctx.today();
      const month = periodRange('this_month', today);
      const monthViews = queryTransactions(ledger, { from: month.from, to: month.to, inBalanceOnly: true });
      const topCategories = summarize(ledger, monthViews, { groupBy: 'category', measure: 'expense', currencyId: main, top: 5 });
      let first: string | undefined;
      let last: string | undefined;
      for (const tx of ledger.data.transaction.values()) {
        if (ledger.isDeleted(tx)) continue;
        if (!first || tx.date < first) first = tx.date;
        if (!last || tx.date > last) last = tx.date;
      }
      const upcoming = plannedOperations(ledger, today, addDays(today, 7), today, false);
      const accounts = ledger
        .userAccounts(false)
        .map((account) => formatAccount(ledger, account, main))
        .sort((a, b) => Number(b.balance_main ?? b.balance) - Number(a.balance_main ?? a.balance));
      return jsonResult({
        today,
        user: compact({
          login: user.login,
          main_currency: ledger.currencyCode(main),
          month_start_day: user.monthStartDay ?? 1,
          country: user.countryCode,
          subscription_paid_till: user.paidTill ? new Date(user.paidTill * 1000).toISOString().slice(0, 10) : undefined,
        }),
        balances: balanceSummary(ledger),
        accounts: accounts.map(({ id: _id, card_numbers: _cards, bank: _bank, ...rest }) => rest),
        this_month: {
          period: month,
          ...totals(ledger, monthViews, main),
          uncategorized_count: monthViews.filter(
            (view) => (view.type === 'expense' || view.type === 'income') && !(view.mainTagId && ledger.data.tag.has(view.mainTagId)),
          ).length,
          top_expense_categories: topCategories.groups,
        },
        upcoming_planned_7_days: upcoming,
        data: compact({
          transactions: ledger.data.transaction.size,
          first_transaction: first,
          last_transaction: last,
          last_sync: store.lastSyncAt ? new Date(store.lastSyncAt).toISOString() : undefined,
        }),
      });
    },
  );

  server.registerTool(
    'list_accounts',
    {
      title: 'List accounts',
      description:
        'Accounts with balances, currency, credit limit, bank and flags. balance_main is the balance converted to the main currency. Totals cover in-balance accounts. Debt bookkeeping is in list_debts.',
      inputSchema: z.object({
        include_archived: z.boolean().default(false).describe('Also return archived accounts'),
        types: z.array(z.enum(ACCOUNT_TYPES)).optional().describe('cash, ccard (card), checking, loan, deposit, emoney'),
        search: z.string().optional().describe('Substring of the account name or card number'),
      }),
      annotations: READ_ONLY,
    },
    async ({ include_archived, types, search }) => {
      const ledger = await ctx.fresh();
      const main = ledger.rootUser().currency;
      let accounts = ledger.userAccounts(include_archived);
      if (types?.length) accounts = accounts.filter((account) => types.some((type) => type === account.type));
      if (search) {
        const wanted = normalizeName(search);
        accounts = accounts.filter(
          (account) => normalizeName(account.title).includes(wanted) || account.syncID?.some((id) => id.includes(search.trim())),
        );
      }
      const byCurrency: Record<string, number> = {};
      let total = 0;
      for (const account of accounts) {
        if (!account.inBalance || account.archive) continue;
        const instrument = ledger.accountInstrument(account);
        const code = ledger.currencyCode(instrument);
        byCurrency[code] = round2((byCurrency[code] ?? 0) + (account.balance ?? 0));
        total += ledger.convert(account.balance ?? 0, instrument, main);
      }
      const rows = accounts
        .map((account) => formatAccount(ledger, account, main))
        .sort((a, b) => Number(b.in_balance) - Number(a.in_balance) || Number(b.balance_main ?? b.balance) - Number(a.balance_main ?? a.balance));
      return jsonResult({
        main_currency: ledger.currencyCode(main),
        totals: { in_balance_by_currency: byCurrency, in_balance_total_main: round2(total) },
        accounts: rows,
      });
    },
  );

  server.registerTool(
    'list_categories',
    {
      title: 'List categories',
      description:
        'Category tree (ZenMoney "tags"; one nesting level) with ids, kind (expense/income/both) and number of uses in the last 12 months. Use names, "Parent / Child" paths or ids elsewhere.',
      inputSchema: z.object({
        kind: z.enum(['expense', 'income', 'all']).default('all').describe('Only categories usable for this kind of transaction'),
        include_archived: z.boolean().default(false),
        search: z.string().optional().describe('Substring of the category name'),
      }),
      annotations: READ_ONLY,
    },
    async ({ kind, include_archived, search }) => {
      const ledger = await ctx.fresh();
      const since = addDays(ctx.today(), -365);
      const uses = new Map<string, number>();
      for (const tx of ledger.data.transaction.values()) {
        if (tx.date < since || ledger.isDeleted(tx)) continue;
        for (const id of tx.tag ?? []) uses.set(id, (uses.get(id) ?? 0) + 1);
      }
      const wanted = search ? normalizeName(search) : '';
      const visible = (tag: Tag) =>
        (include_archived || !tag.archive) &&
        (kind === 'all' || (kind === 'expense' ? tag.showOutcome : tag.showIncome)) &&
        (!wanted || normalizeName(tag.title).includes(wanted));
      const node = (tag: Tag) =>
        compact({
          id: tag.id,
          title: tag.title,
          kind: tagKind(tag),
          uses: uses.get(tag.id) ?? 0,
          archived: tag.archive || undefined,
          excluded_from_budget: (tag.showOutcome && !tag.budgetOutcome) || (tag.showIncome && !tag.budgetIncome) || undefined,
        });
      const tags = [...ledger.data.tag.values()];
      const roots = tags.filter((tag) => !tag.parent || !ledger.data.tag.has(tag.parent));
      const tree = roots
        .map((root) => {
          const children = tags.filter((tag) => tag.parent === root.id && visible(tag)).map(node);
          if (!visible(root) && !children.length) return undefined;
          return { ...node(root), ...(children.length ? { subcategories: children } : {}) };
        })
        .filter((entry) => entry !== undefined)
        .sort((a, b) => Number(b.uses) - Number(a.uses));
      return jsonResult({ categories: tree });
    },
  );

  server.registerTool(
    'list_payees',
    {
      title: 'List payees',
      description:
        'Known payees/merchants ranked by number of transactions, with last date and the category usually used for them. Useful for consistent categorization and payee spelling.',
      inputSchema: z.object({
        search: z.string().optional().describe('Substring of the payee name'),
        limit: z.number().int().min(1).max(500).default(50),
      }),
      annotations: READ_ONLY,
    },
    async ({ search, limit }) => {
      const ledger = await ctx.fresh();
      const usual = usualCategories(ledger);
      const wanted = search ? normalizeName(search) : '';
      const payees = new Map<string, { name: string; merchant_id?: string; transactions: number; last_date: string }>();
      for (const tx of ledger.data.transaction.values()) {
        if (ledger.isDeleted(tx)) continue;
        const name = ledger.payeeOf(tx);
        if (!name) continue;
        const key = normalizeName(name);
        if (!key || (wanted && !key.includes(wanted))) continue;
        const entry = payees.get(key);
        if (entry) {
          entry.transactions++;
          if (tx.date > entry.last_date) entry.last_date = tx.date;
        } else {
          payees.set(key, { name, merchant_id: tx.merchant ?? undefined, transactions: 1, last_date: tx.date });
        }
      }
      const rows = [...payees.entries()]
        .sort(([, a], [, b]) => b.transactions - a.transactions)
        .slice(0, limit)
        .map(([key, entry]) => {
          const best = usual.get(key);
          return compact({ ...entry, usual_category: best ? ledger.tagPath(best.tagId) : undefined });
        });
      return jsonResult({ total: payees.size, payees: rows });
    },
  );

  server.registerTool(
    'list_transactions',
    {
      title: 'Search transactions',
      description:
        'Find transactions with filters (dates/period, type, accounts, categories incl. subcategories, payee, free text, amount, currency). Newest first by default, paginated. Also returns income/expense totals of all matches in the main currency (in-balance accounts only, like ZenMoney reports), so "how much did I spend on X" needs only this call (or summarize_transactions for breakdowns).',
      inputSchema: z.object({
        ...filterShape,
        ids: z.array(z.string()).optional().describe('Fetch specific transactions by id'),
        include_deleted: z.boolean().default(false).describe('Include deleted transactions (they can be restored)'),
        sort: z.enum(SORTS).default('date_desc'),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: READ_ONLY,
    },
    async (input) => {
      const ledger = await ctx.fresh();
      const { query, range } = buildQuery(ledger, input, ctx.today());
      query.ids = input.ids?.length ? new Set(input.ids) : undefined;
      query.includeDeleted = input.include_deleted || Boolean(query.ids);
      const views = sortViews(ledger, queryTransactions(ledger, query), input.sort);
      const page = views.slice(input.offset, input.offset + input.limit);
      const main = ledger.rootUser().currency;
      return jsonResult(
        compact({
          period: range.from || range.to ? range : undefined,
          total_matched: views.length,
          returned: page.length,
          offset: input.offset,
          next_offset: input.offset + page.length < views.length ? input.offset + page.length : undefined,
          totals: {
            currency: ledger.currencyCode(main),
            ...totals(
              ledger,
              views.filter((view) => !ledger.isDeleted(view.tx) && ledger.data.account.get(view.accountId)?.inBalance),
              main,
            ),
          },
          transactions: page.map((view) => ledger.formatMovement(view)),
        }),
      );
    },
  );

  server.registerTool(
    'summarize_transactions',
    {
      title: 'Spending / income report',
      description:
        'Aggregate expenses and/or income by category, parent category, payee, account or time (day/week/month/year) with totals, counts and shares. measure=both gives income, expense and net per group (cash flow). Transfers and debts are excluded; amounts are converted with current rates. By default only in-balance accounts count, like ZenMoney reports.',
      inputSchema: z.object({
        ...filterShape,
        group_by: z.enum(GROUP_BYS).default('category'),
        measure: z.enum(MEASURES).default('expense'),
        report_currency: z.string().optional().describe('ISO code to report in; defaults to the main currency'),
        top: z.number().int().min(1).max(200).default(25).describe('Max groups for non-time groupings; the rest is rolled up'),
        include_off_balance: z.boolean().default(false).describe('Also count accounts excluded from the balance'),
      }),
      annotations: READ_ONLY,
    },
    async (input) => {
      const ledger = await ctx.fresh();
      const { query, range } = buildQuery(ledger, input, ctx.today());
      query.inBalanceOnly = !input.include_off_balance;
      const currencyId = input.report_currency ? ledger.instrumentByCode(input.report_currency).id : ledger.rootUser().currency;
      const summary = summarize(ledger, queryTransactions(ledger, query), {
        groupBy: input.group_by,
        measure: input.measure,
        currencyId,
        top: input.top,
      });
      return jsonResult({ period: range.from || range.to ? range : 'all time', measure: input.measure, group_by: input.group_by, ...summary });
    },
  );

  server.registerTool(
    'get_budget',
    {
      title: 'Monthly budget status',
      description:
        "ZenMoney budget for a month: per category budget, actual, remaining, % used and still-planned operations, with subcategories and totals, in the main currency. Uses the profile's month start day. Rollover between months is not modelled.",
      inputSchema: z.object({
        month: isoMonth.optional().describe('YYYY-MM; defaults to the current month'),
        side: z.enum(['expense', 'income', 'both']).default('expense'),
      }),
      annotations: READ_ONLY,
    },
    async ({ month, side }) => {
      const ledger = await ctx.fresh();
      const report = budgetReport(ledger, month ?? budgetMonthOf(ctx.today(), ledger.rootUser().monthStartDay ?? 1));
      return jsonResult({
        month: report.month,
        period: report.period,
        currency: report.currency,
        ...(side !== 'income' ? { expense: report.expense } : {}),
        ...(side !== 'expense' ? { income: report.income } : {}),
      });
    },
  );

  server.registerTool(
    'list_planned',
    {
      title: 'Planned operations',
      description:
        'Scheduled / recurring operations (ZenMoney reminders) that are still planned in a date range, with recurrence, overdue and forecast flags, plus expected expense/income totals.',
      inputSchema: z.object({
        date_from: isoDate.optional().describe('Defaults to 7 days ago (to surface overdue items)'),
        date_to: isoDate.optional().describe('Defaults to 30 days ahead'),
        include_forecast: z.boolean().default(true).describe("Include ZenMoney's auto-generated forecast entries"),
      }),
      annotations: READ_ONLY,
    },
    async ({ date_from, date_to, include_forecast }) => {
      const ledger = await ctx.fresh();
      const today = ctx.today();
      const from = date_from ?? addDays(today, -7);
      const to = date_to ?? addDays(today, 30);
      return jsonResult({ period: { from, to }, ...plannedOperations(ledger, from, to, today, include_forecast) });
    },
  );

  server.registerTool(
    'list_debts',
    {
      title: 'Debts by person',
      description:
        'Who owes whom: per-person debt balances from debt operations (positive = they owe you, negative = you owe them), per currency and in the main currency. Pass person to also get their debt transactions.',
      inputSchema: z.object({
        person: z.string().optional().describe('Substring of the person name'),
        include_settled: z.boolean().default(false).describe('Include people whose debts net to zero'),
      }),
      annotations: READ_ONLY,
    },
    async ({ person, include_settled }) => {
      const ledger = await ctx.fresh();
      const main = ledger.rootUser().currency;
      const wanted = person ? normalizeName(person) : '';
      const list = debtors(ledger)
        .filter((debtor) => include_settled || Object.keys(debtor.balance).length > 0)
        .filter((debtor) => !wanted || normalizeName(debtor.name).includes(wanted))
        .sort((a, b) => Math.abs(b.balanceInMain) - Math.abs(a.balanceInMain));
      const transactionsFor = (name: string) =>
        sortViews(
          ledger,
          queryTransactions(ledger, { types: ['debt_out', 'debt_in'] }).filter(
            (view) => normalizeName(ledger.payeeOf(view.tx) ?? '') === normalizeName(name),
          ),
          'date_desc',
        ).map((view) => ledger.formatMovement(view));
      const owedToYou = list.reduce((sum, debtor) => sum + Math.max(debtor.balanceInMain, 0), 0);
      const youOwe = list.reduce((sum, debtor) => sum + Math.max(-debtor.balanceInMain, 0), 0);
      return jsonResult({
        currency: ledger.currencyCode(main),
        owed_to_you: round2(owedToYou),
        you_owe: round2(youOwe),
        people: list.map((debtor) =>
          compact({
            name: debtor.name,
            balance: debtor.balance,
            balance_main: debtor.balanceInMain,
            transactions: debtor.transactions,
            last_date: debtor.lastDate,
            history: wanted ? transactionsFor(debtor.name) : undefined,
          }),
        ),
      });
    },
  );

  server.registerTool(
    'suggest_category',
    {
      title: 'Suggest category for payees',
      description:
        "Category and merchant suggestions for payee names, from ZenMoney's suggestion service and from this user's own history.",
      inputSchema: z.object({
        payees: z.array(z.string().min(1)).min(1).max(20).describe('Payee names as they appear on a receipt or statement'),
      }),
      annotations: READ_ONLY,
    },
    async ({ payees }) => {
      const ledger = await ctx.fresh();
      const { api } = ctx.connected();
      const usual = usualCategories(ledger);
      let remote: SuggestResponse[] = [];
      let remoteError: string | undefined;
      try {
        remote = await api.suggest(payees.map((payee) => ({ payee })), { timeoutMs: 15_000 });
      } catch (error) {
        remoteError = error instanceof Error ? error.message : String(error);
      }
      const suggestions = payees.map((payee, index) => {
        const hint = remote[index];
        const tagId = hint?.tag?.find((id) => ledger.data.tag.has(id));
        const merchantId = hint?.merchant && ledger.data.merchant.has(hint.merchant) ? hint.merchant : undefined;
        const history = usual.get(normalizeName(payee));
        return compact({
          payee,
          suggested_payee: hint?.payee && hint.payee !== payee ? hint.payee : undefined,
          category: tagId ? ledger.tagPath(tagId) : undefined,
          merchant: ledger.merchantTitle(merchantId),
          history_category: history ? ledger.tagPath(history.tagId) : undefined,
          history_uses: history?.count,
        });
      });
      return jsonResult(compact({ suggestions, suggestion_service_error: remoteError }));
    },
  );

  server.registerTool(
    'sync',
    {
      title: 'Sync with ZenMoney',
      description:
        'Pull the latest changes from ZenMoney now (tools already auto-sync when data is older than the configured TTL). full=true re-downloads everything.',
      inputSchema: z.object({ full: z.boolean().default(false) }),
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async ({ full }) => {
      const { store } = ctx.connected();
      const info = await store.sync(full);
      return jsonResult({
        ...info,
        last_sync: store.lastSyncAt ? new Date(store.lastSyncAt).toISOString() : null,
        api: store.apiBaseUrl,
        disk_cache: store.cachePath ? 'enabled' : 'disabled',
        counts: store.counts(),
      });
    },
  );
}
