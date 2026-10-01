import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { registerPrompts } from './prompts.js';
import type { ToolContext } from './tools/context.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';

const pkg: { version: string } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const VERSION = pkg.version;

function instructions(readOnly: boolean): string {
  const lines = [
    'ZenMoney (Дзен-мани) personal finance data of the connected user: accounts, transactions, categories, budgets, planned operations and debts.',
    '- Call get_overview first: it returns today\'s date, the main currency, balances and this month at a glance.',
    '- Amounts are positive numbers; `type` gives the direction: expense, income, transfer (between own accounts), debt_out (money given to a person: lending or repaying them), debt_in (money received from a person: borrowing or being repaid).',
    '- Accounts and categories accept names (case/emoji-insensitive; unique substrings work), "Parent / Child" category paths, or ids. Currencies are ISO codes (RUB, USD, KZT, ...).',
    '- Dates are YYYY-MM-DD in the user\'s calendar; query tools also take `period` shortcuts such as this_month or last_30_days.',
    '- Reports convert with ZenMoney\'s current exchange rates into the main currency and, like ZenMoney, count only in-balance accounts unless asked otherwise.',
    '- For "how much / where did the money go" questions use summarize_transactions (or the totals of list_transactions) instead of paging through transactions.',
    '- Data is a local replica that refreshes itself; use sync to pull changes made elsewhere right now.',
  ];
  if (readOnly) {
    lines.push('- This server is read-only: it cannot change ZenMoney data.');
  } else {
    lines.push(
      '- Write tools change the user\'s real financial data. Confirm intent before bulk edits or deletions and preview them with dry_run=true; deleted transactions can be restored with restore_transactions.',
      '- When recording transactions reuse existing category names and payee spellings (list_categories, list_payees); a missing category is filled from the payee history or ZenMoney suggestions.',
    );
  }
  return lines.join('\n');
}

/** Builds one MCP server instance over the shared context (called per connection / HTTP request). */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'zenmoney', title: 'ZenMoney', version: VERSION }, { instructions: instructions(ctx.readOnly) });
  registerReadTools(server, ctx);
  if (!ctx.readOnly) registerWriteTools(server, ctx);
  registerPrompts(server, ctx.readOnly);
  return server;
}
