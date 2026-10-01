# mcp-server-zenmoney

[![CI](https://github.com/krax1337/mcp-server-zenmoney/actions/workflows/ci.yml/badge.svg)](https://github.com/krax1337/mcp-server-zenmoney/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-server-zenmoney)](https://www.npmjs.com/package/mcp-server-zenmoney)

MCP server for [ZenMoney](https://zenmoney.app) (Дзен-мани). It gives an AI agent access to your accounts and balances, lets it search transactions and build reports, read and set monthly budgets, see planned (recurring) operations and debts, categorize spending, and record or edit transactions with safety rails. It talks to the official ZenMoney API v8 (`POST /v8/diff/` sync protocol and `POST /v8/suggest/`) using an OAuth token, e.g. one issued through [Zerro](https://zerro.app).

Unofficial project, not affiliated with ZenMoney or Zerro. Your token and data stay on your machine.

## Quick start

Requirements: Node.js >= 22.

1. Get a token: open https://zerro.app/token, log in with your ZenMoney account and copy the token shown.
2. Verify it: `ZENMONEY_TOKEN=... npx -y mcp-server-zenmoney --check` prints `OK: <login>, main currency …, N active accounts, M transactions` (exit code 1 with the reason otherwise).
3. Add the server to your agent (below).

Without a token the server still starts; every tool then explains how to configure one.

## Connect to an agent (stdio)

### Claude Code

```sh
claude mcp add zenmoney -e ZENMONEY_TOKEN=YOUR_TOKEN -- npx -y mcp-server-zenmoney
```

### Claude Desktop / Cursor / most MCP clients

`claude_desktop_config.json`, `~/.cursor/mcp.json`, …:

```json
{
  "mcpServers": {
    "zenmoney": {
      "command": "npx",
      "args": ["-y", "mcp-server-zenmoney"],
      "env": { "ZENMONEY_TOKEN": "YOUR_TOKEN" }
    }
  }
}
```

### omp

User-wide config `~/.omp/agent/mcp.json` (or per project `.omp/mcp.json`), inside `mcpServers`:

```json
"zenmoney": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "mcp-server-zenmoney"],
  "env": { "ZENMONEY_TOKEN": "${ZENMONEY_TOKEN}" }
}
```

omp expands `${VAR}` placeholders, so the token can stay in your shell environment. Then `/mcp reload`.

### Keeping the token out of config files

```sh
umask 077 && printf '%s' 'YOUR_TOKEN' > ~/.config/zenmoney-token
```

and use `"env": { "ZENMONEY_TOKEN_FILE": "~/.config/zenmoney-token" }` instead of `ZENMONEY_TOKEN`.

### Read-only

Add `"ZENMONEY_READ_ONLY": "true"` to `env`, or `--read-only` to `args`. Write tools are then not registered at all.

### HTTP mode

```sh
ZENMONEY_TOKEN=... npx -y mcp-server-zenmoney --http --port 3000
```

- MCP endpoint (Streamable HTTP): `http://127.0.0.1:3000/mcp`; `GET /health` returns `{"ok":true}`; any other path is 404.
- Default bind is `127.0.0.1`. Loopback binds (`127.0.0.1`, `localhost`, `::1`) apply Host/Origin validation against DNS rebinding.
- Any other `--host` / `MCP_HTTP_HOST` is refused unless `MCP_HTTP_TOKEN` is set. When set (on any bind), clients must send `Authorization: Bearer <MCP_HTTP_TOKEN>`, otherwise they get 401. It is a single-user server: whoever has that token has your ZenMoney access, so keep it on a private network.

## Configuration

| Variable / flag | Default | Meaning |
| --- | --- | --- |
| `ZENMONEY_TOKEN` | — | ZenMoney API token from https://zerro.app/token |
| `ZENMONEY_TOKEN_FILE` | — | File containing the token (used when `ZENMONEY_TOKEN` is empty; `~` expanded) |
| `ZENMONEY_READ_ONLY` / `--read-only` | `false` | `1`/`true`/`yes`/`on` registers only read tools |
| `ZENMONEY_SYNC_TTL` | `30` | Seconds before data is re-synced on the next tool call |
| `ZENMONEY_CACHE_DIR` | `$XDG_CACHE_HOME/mcp-server-zenmoney`, else `~/.cache/mcp-server-zenmoney` | Snapshot cache directory |
| `ZENMONEY_CACHE` | on | `0`/`false`/`no`/`off` keeps data in memory only |
| `ZENMONEY_API_URL` | `https://api.zenmoney.ru`, fallback `https://api.zenmoney.app` | Pin a single API origin |
| `MCP_TRANSPORT` / `--http` | `stdio` | `http` serves Streamable HTTP |
| `MCP_HTTP_HOST` / `--host` | `127.0.0.1` | HTTP bind address |
| `MCP_HTTP_PORT` / `--port` | `3000` | HTTP port |
| `MCP_HTTP_TOKEN` | — | Bearer token HTTP clients must send; required for non-loopback binds |
| `--check` | — | Sync once with the configured token, print a one-line summary and exit |
| `--help`, `-h` / `--version`, `-v` | — | Print usage / version |

CLI flags take precedence over the corresponding environment variables.

## Tools

Read tools (always registered, annotated `readOnlyHint`):

| Tool | Purpose |
| --- | --- |
| `get_overview` | Start here: today's date, main currency, net worth, account balances, this month's income/expenses, upcoming planned operations, data freshness |
| `list_accounts` | Accounts with balances (also in main currency), credit limits, bank and flags |
| `list_categories` | Category tree with kind (expense/income/both) and 12-month usage counts |
| `list_payees` | Known payees ranked by use, with last date and usual category |
| `list_transactions` | Filtered, paginated transaction search plus income/expense totals of all matches |
| `summarize_transactions` | Aggregate by category, parent category, payee, account or day/week/month/year; `measure=both` for cash flow |
| `get_budget` | Monthly budget vs. actual, remaining, % used and still-planned operations per category |
| `list_planned` | Planned / recurring operations still pending in a date range, with expected totals |
| `list_debts` | Per-person debt balances (positive = they owe you); optionally a person's debt transactions |
| `suggest_category` | Category/merchant suggestions for payee names from ZenMoney and your own history |
| `sync` | Pull changes from ZenMoney now; `full=true` re-downloads everything |

Write tools (not registered in read-only mode):

| Tool | Purpose |
| --- | --- |
| `create_transactions` | Record up to 50 expenses, incomes, transfers or debt operations; auto-categorizes, warns about duplicates |
| `update_transactions` | Edit amount, account, category, payee, comment, date, original amount; transfer destination. Type cannot change |
| `delete_transactions` | Soft-delete transactions by id |
| `restore_transactions` | Bring deleted transactions back (as copies with new ids) |
| `create_category` | Create a category or subcategory (one nesting level) |
| `update_category` | Rename, move, change kind, budget inclusion, mandatory flag, archive |
| `delete_category` | Delete a category, moving its transactions and planned operations to `move_to` or uncategorizing them |
| `set_budgets` | Set exact monthly budgets per category, `total` or `uncategorized`; `0` removes |
| `create_account` | Create a cash, card, checking or e-money account |
| `update_account` | Rename, archive, include/exclude from balance, savings flag, credit limit |
| `adjust_account_balance` | Match a real balance by recording a correction income/expense |

Write tools carry MCP annotations: creating tools are non-destructive (`destructiveHint: false`); editing/deleting tools are `destructiveHint: true`, so clients that honor hints can ask for confirmation.

`create_transactions`, `update_transactions`, `delete_transactions`, `delete_category` and `set_budgets` accept `dry_run: true`: they resolve everything and return the would-be result (for updates: `before`/`after` per transaction) without sending anything to ZenMoney.

### Prompts

Clients that support MCP prompts (e.g. as slash commands) get three workflows that only orchestrate the tools above:

| Prompt | Arguments | What it does |
| --- | --- | --- |
| `monthly_review` | `month` (YYYY-MM) | Income, spending vs. previous month, budget status, large transactions, upcoming payments, suggestions |
| `categorize_transactions` | `period` | Proposes categories for uncategorized transactions, applies after confirmation (dry run first) |
| `plan_budget` | `month` (YYYY-MM) | Proposes budgets from the last three months and planned payments, applies with `set_budgets` after confirmation |

## Conventions

These are also sent to the agent as server instructions.

- Amounts are always positive; `type` gives the direction: `expense`, `income`, `transfer` (between own accounts), `debt_out` (money given to a person: lending or repaying), `debt_in` (money received: borrowing or being repaid).
- Accounts and categories are referenced by name (case- and emoji-insensitive, unique substrings work), `"Parent / Child"` category paths, or ids. Accounts can also be referenced by card last digits (4+).
- Currencies are ISO codes (`RUB`, `USD`, `KZT`, ...). Dates are `YYYY-MM-DD`.
- Query tools accept `period`: `today`, `yesterday`, `this_week`, `last_week`, `this_month`, `last_month`, `this_quarter`, `last_quarter`, `this_year`, `last_year`, `last_7_days`, `last_30_days`, `last_90_days`, `last_12_months` (weeks start Monday; `date_from`/`date_to` override either end).
- Reports are in the main currency at ZenMoney's current exchange rates and, like ZenMoney, count only in-balance accounts unless asked otherwise. Transfers and debts are excluded from summaries. The totals returned by `list_transactions` follow the same rules (in-balance, not deleted), even when the listed transactions include off-balance or deleted ones.
- A missing expense/income category on new transactions is filled from this payee's history first, then from the ZenMoney suggestion service (only live categories of the right kind). A new transaction matching an existing one (same date, type, account and amount) produces a duplicate warning; it is still recorded.
- `update_transactions` `category` replaces the main category and keeps secondary tags; `null` leaves the transaction uncategorized. Moving a transaction to an account in another currency requires the new `amount`. Changing only `amount` of a same-currency transfer updates both sides unless the received amount differed (a fee), which is kept.
- Every write syncs with ZenMoney first and runs one at a time, so edits made in the app moments earlier are not overwritten and parallel tool calls cannot clobber each other. References to categories/merchants deleted in the app are dropped from pushed objects instead of failing the whole batch.
- If ZenMoney accepts a write but the answer is lost (timeout), the tool says the change may or may not have been saved; the next call re-syncs, so a retry gets a duplicate warning instead of silently doubling.
- Deletes are soft. ZenMoney cannot undelete in place, so `restore_transactions` re-creates each transaction under a new id; restoring the same transaction again is a no-op that points at the existing copy.
- Budgets: `set_budgets` sets an exact amount (lock on); `0` removes the budget. Budgets without the lock (set in the app) also include the month's planned operations, as in ZenMoney. The profile's month start day is honored. Rollover between months is not modelled.
- Zerro's hidden `🤖 [Zerro Data]` account and the reminders attached to it are ignored everywhere.

## Example prompts

- "How did October go? Biggest categories and anything unusual compared to September."
- "Add: Magnum 12 450 KZT today from Kaspi Gold, groceries."
- "Recategorize all Yandex Go rides from last month to Transport / Taxi."
- "Copy this month's budgets to next month, but raise Restaurants to 80 000."
- "Who owes me money, and how much in total?"
- "What payments are scheduled for the next two weeks?"
- "My cash wallet actually has 23 000; fix the balance."

## Data, privacy and sync

- The server keeps a local replica of your ZenMoney database synced via `/v8/diff/`: a full download on first use, incremental diffs afterwards. Data older than `ZENMONEY_SYNC_TTL` seconds is refreshed automatically before a tool runs; `sync` forces it.
- The replica is persisted to `<cache dir>/snapshot-<hash>.json` (directory created `0700`, file `0600`). The filename is a hash of token and API origin; the token itself is never written to disk. The snapshot does contain your financial data. Set `ZENMONEY_CACHE=off` to keep everything in memory.
- API origin: `https://api.zenmoney.ru` first; if it rejects the token before any request has succeeded, `https://api.zenmoney.app` is tried. `ZENMONEY_API_URL` pins a single origin.
- HTTP 401 from ZenMoney means the token is no longer valid: get a fresh one at https://zerro.app/token.
- "Today" and default dates use the process time zone; set `TZ` (e.g. `TZ=Asia/Almaty`) in the server's `env` if the agent host runs in a different zone.
- Snapshots of tokens you no longer use stay in the cache directory; delete old `snapshot-*.json` files after rotating a token.
- Logs go to stderr only.

## Limitations

- Planned (recurring) operations can be read but not created or edited.
- Loan and deposit accounts cannot be created; bank-synced accounts are created by ZenMoney itself.
- Balances are not edited directly; `adjust_account_balance` records a correction transaction.
- Currency conversions in reports use current exchange rates, not historical ones.
- Zerro's envelope budget rollover is not computed.

## Development

```sh
git clone https://github.com/krax1337/mcp-server-zenmoney && cd mcp-server-zenmoney
npm install         # also builds dist/
npm run typecheck   # tsc --noEmit
npm test            # vitest; offline, against an in-repo fake ZenMoney server in test/
node dist/index.js  # run the local build
```

Releases: bump `version` in `package.json` and `server.json`, then push a `vX.Y.Z` tag. The Publish workflow tests, publishes to npm via Trusted Publishing (no token, with provenance) and to the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.krax1337/mcp-server-zenmoney`.

Source layout:

- `src/index.ts` — entry point, stdio and HTTP transports
- `src/config.ts` — environment variables and CLI flags
- `src/server.ts` — MCP server and agent instructions
- `src/prompts.ts` — MCP prompts (`monthly_review`, `categorize_transactions`, `plan_budget`)
- `src/tools/` — MCP tools (`read.ts`, `write.ts`, shared schemas and context)
- `src/zenmoney/` — API client (`api.ts`), sync store and cache (`store.ts`), ledger semantics (`ledger.ts`), analytics (`analytics.ts`), write builders (`writes.ts`), dates and types

## License

MIT
