import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

/** Ready-made workflows clients can offer as slash commands; they only orchestrate the tools. */
export function registerPrompts(server: McpServer, readOnly: boolean): void {
  const user = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });
  const applyStep = readOnly
    ? 'This server is read-only: present the proposal only.'
    : 'Show the proposal as a compact table and ask me to confirm. Then preview with dry_run=true, apply, and report what changed.';

  server.registerPrompt(
    'monthly_review',
    {
      title: 'Monthly financial review',
      description: 'Income, spending by category vs. the previous month, budget status, upcoming payments and anomalies',
      argsSchema: z.object({ month: z.string().optional().describe('YYYY-MM; defaults to the current month') }),
    },
    ({ month }) =>
      user(
        [
          `Review my finances for ${month ?? 'the current month'} using the ZenMoney tools.`,
          '1. get_overview for context (today, main currency, balances).',
          '2. summarize_transactions with measure=both for the month and the previous month; then group_by=parent_category for both months.',
          '3. get_budget for the month; list_planned for the rest of the month.',
          'Report: income, expenses, net and savings rate; top categories with change vs. the previous month; over-budget categories; unusually large transactions (list_transactions sort=amount_desc, limit 10); uncategorized transactions count; upcoming payments.',
          'Finish with three concrete, numeric suggestions. Keep it concise and use my main currency.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'categorize_transactions',
    {
      title: 'Categorize uncategorized transactions',
      description: 'Find transactions without a category and propose categories from payee history and ZenMoney suggestions',
      argsSchema: z.object({ period: z.string().optional().describe('e.g. this_month, last_30_days; defaults to last_90_days') }),
    },
    ({ period }) =>
      user(
        [
          `Find my expense and income transactions without a category (list_transactions uncategorized=true, types=["expense","income"], period=${period ?? 'last_90_days'}).`,
          'For each, propose a category from the existing tree (list_categories) using list_payees usual_category and suggest_category; group identical payees.',
          'Mark low-confidence guesses instead of inventing new categories.',
          applyStep,
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'plan_budget',
    {
      title: 'Plan next month budget',
      description: 'Propose monthly category budgets from the last three months of spending and current budgets',
      argsSchema: z.object({ month: z.string().optional().describe('YYYY-MM to plan; defaults to next month') }),
    },
    ({ month }) =>
      user(
        [
          `Plan budgets for ${month ?? 'next month'}.`,
          'Use summarize_transactions group_by=category for each of the last three full months, get_budget for the current month, and list_planned for the target month.',
          'Propose a budget per regularly used expense category (3-month average rounded sensibly, adjusted for planned payments) plus a total, and explain notable changes.',
          applyStep.replace('apply,', 'apply with set_budgets,'),
        ].join('\n'),
      ),
  );
}
