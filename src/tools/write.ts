import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { usualCategories } from '../zenmoney/analytics.js';
import { type Ledger, UserInputError, normalizeName, round2 } from '../zenmoney/ledger.js';
import type { Mutation } from '../zenmoney/store.js';
import type { Account, Budget, Deletion, Reminder, ReminderMarker, Tag, Transaction } from '../zenmoney/types.js';
import { TOTAL_BUDGET_TAG } from '../zenmoney/types.js';
import {
  CREATABLE_ACCOUNT_TYPES,
  type NewTransaction,
  type TagKind,
  type TransactionPatch,
  buildAccount,
  buildBudget,
  buildTag,
  buildTransaction,
  forPush,
  patchTransaction,
  restoredCopy,
  tagKind,
  tagKindFlags,
  touch,
  unixNow,
} from '../zenmoney/writes.js';
import { type ToolContext, compact, jsonResult } from './context.js';
import { TX_TYPE_HELP, isoDate, isoMonth, txType } from './schemas.js';

const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const MODIFY = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

/** Prefixes resolution errors with the batch position so the model can fix the right item. */
function atIndex<T>(label: string, index: number, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof UserInputError) throw new UserInputError(`${label}[${index}]: ${error.message}`);
    throw error;
  }
}

/** A dry run or no-op: nothing is pushed. */
const preview = (value: unknown): Mutation<CallToolResult> => ({ done: () => jsonResult(value) });

function accountBalances(ledger: Ledger, ids: Iterable<string>) {
  return [...new Set(ids)]
    .map((id) => ledger.data.account.get(id))
    .filter((account): account is Account => account !== undefined && !ledger.isServiceAccount(account))
    .map((account) => ({
      account: account.title,
      balance: round2(account.balance ?? 0),
      currency: ledger.currencyCode(ledger.accountInstrument(account)),
    }));
}

function resolveOriginal(ledger: Ledger, amount: number | null | undefined, currency: string | undefined) {
  if (amount === undefined && currency === undefined) return undefined;
  if (amount === null) return null;
  if (amount === undefined || !currency) {
    throw new UserInputError('original_amount and original_currency must be given together');
  }
  return { amount, instrument: ledger.instrumentByCode(currency).id };
}

const newTransactionSchema = z.object({
  type: txType.describe(TX_TYPE_HELP),
  amount: z.number().positive().describe("Amount in the account's currency (for transfers: amount leaving `account`)"),
  account: z.string().describe('Account name, id or card last digits (source account for transfers and debt_out)'),
  to_account: z.string().optional().describe('Transfers only: destination account'),
  to_amount: z
    .number()
    .positive()
    .optional()
    .describe('Transfers only: amount arriving in to_account; required when the currencies differ'),
  category: z.string().optional().describe('Category name, "Parent / Child" path or id'),
  payee: z.string().optional().describe('Payee / merchant; for debt operations the person'),
  comment: z.string().optional(),
  date: isoDate.optional().describe('YYYY-MM-DD; defaults to today'),
  original_amount: z
    .number()
    .positive()
    .optional()
    .describe('Expense/income/debt: amount in the original currency when it differs from the account currency (e.g. 10 USD paid from a RUB card)'),
  original_currency: z.string().optional().describe('ISO code of original_amount'),
});

const updateSchema = z.object({
  id: z.string().describe('Transaction id'),
  amount: z
    .number()
    .positive()
    .optional()
    .describe("New amount in the account's currency (transfers: amount leaving; a plain same-currency transfer updates both sides)"),
  to_amount: z.number().positive().optional().describe('Transfers: new amount arriving'),
  account: z.string().optional().describe('Move to another account (transfers: source account); a currency change requires amount'),
  to_account: z.string().optional().describe('Transfers: new destination account'),
  category: z
    .string()
    .nullable()
    .optional()
    .describe('New main category (secondary tags are kept); null leaves the transaction uncategorized'),
  payee: z.string().nullable().optional().describe('New payee; null clears it'),
  comment: z.string().nullable().optional().describe('New comment; null clears it'),
  date: isoDate.optional(),
  original_amount: z.number().positive().nullable().optional().describe('Original-currency amount; null removes it'),
  original_currency: z.string().optional(),
});

const dryRun = z.boolean().default(false).describe('Preview the outcome without saving anything');

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'create_transactions',
    {
      title: 'Add transactions',
      description:
        "Record one or more transactions (expense, income, transfer between own accounts, debt_out / debt_in with a person). Amounts are positive in the account currency. Without a category, one is picked from this payee's history or ZenMoney suggestions (auto_categorize). Returns the created transactions, updated balances and possible-duplicate warnings.",
      inputSchema: z.object({
        transactions: z.array(newTransactionSchema).min(1).max(50),
        auto_categorize: z
          .boolean()
          .default(true)
          .describe('Fill a missing expense/income category from history or ZenMoney suggestions'),
        dry_run: dryRun,
      }),
      annotations: CREATE,
    },
    async ({ transactions, auto_categorize, dry_run }) => {
      const { store, ledger, api } = ctx.connected();
      const today = ctx.today();
      return store.mutate(async () => {
        const now = unixNow();
        const drafts = transactions.map((item, index) =>
          atIndex('transactions', index, () => {
            if (item.type !== 'transfer' && (item.to_account || item.to_amount !== undefined)) {
              throw new UserInputError('to_account/to_amount are only for transfers');
            }
            const draft: NewTransaction & { categorySource?: string } = {
              type: item.type,
              amount: item.amount,
              account: ledger.resolveAccount(item.account),
              toAccount: item.to_account ? ledger.resolveAccount(item.to_account) : undefined,
              toAmount: item.to_amount,
              tagIds: item.category ? [ledger.resolveTag(item.category).id] : null,
              payee: item.payee?.trim() || null,
              merchantId: null,
              comment: item.comment?.trim() || null,
              date: item.date ?? today,
              original: resolveOriginal(ledger, item.original_amount, item.original_currency) ?? undefined,
            };
            return draft;
          }),
        );

        const warnings: string[] = [];
        if (auto_categorize) {
          const pending = drafts.filter((draft) => !draft.tagIds && draft.payee && (draft.type === 'expense' || draft.type === 'income'));
          const history = pending.length
            ? { expense: usualCategories(ledger, ['expense']), income: usualCategories(ledger, ['income']) }
            : undefined;
          const remaining = pending.filter((draft) => {
            const fromHistory = history?.[draft.type === 'income' ? 'income' : 'expense'].get(normalizeName(draft.payee!));
            if (!fromHistory) return true;
            draft.tagIds = [fromHistory.tagId];
            draft.categorySource = 'payee history';
            return false;
          });
          if (remaining.length) {
            try {
              const hints = await api.suggest(remaining.map((draft) => ({ payee: draft.payee })), { timeoutMs: 15_000 });
              remaining.forEach((draft, index) => {
                const hint = hints[index];
                // Only live categories of the right kind: the service knows nothing about this profile's flags.
                const tagId = hint?.tag?.find((id) => {
                  const tag = ledger.data.tag.get(id);
                  return tag && !tag.archive && (draft.type === 'income' ? tag.showIncome : tag.showOutcome);
                });
                if (tagId) {
                  draft.tagIds = [tagId];
                  draft.categorySource = 'ZenMoney suggestion';
                }
                if (hint?.merchant && ledger.data.merchant.has(hint.merchant)) draft.merchantId = hint.merchant;
              });
            } catch (error) {
              warnings.push(`category suggestion unavailable: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        for (const draft of drafts) {
          if (!draft.merchantId && draft.payee) draft.merchantId = ledger.merchantByTitle(draft.payee)?.id ?? null;
        }

        const built = drafts.map((draft, index) => atIndex('transactions', index, () => buildTransaction(ledger, draft, now)));
        const debtId = ledger.debtAccount()?.id;
        const dates = new Set(built.map((tx) => tx.date));
        const sameDay = [...ledger.data.transaction.values()]
          .filter((existing) => dates.has(existing.date) && !ledger.isDeleted(existing))
          .map((existing) => ledger.view(existing, debtId));
        built.forEach((tx, index) => {
          const view = ledger.view(tx, debtId);
          const twin = sameDay.find(
            (other) =>
              other.tx.date === tx.date && other.type === view.type && other.accountId === view.accountId && Math.abs(other.amount - view.amount) < 0.005,
          );
          if (twin) warnings.push(`transactions[${index}] looks like a duplicate of existing transaction ${twin.tx.id}`);
        });

        const describe = (tx: Transaction, index: number) =>
          compact({ ...ledger.formatMovement(ledger.view(ledger.data.transaction.get(tx.id) ?? tx)), category_source: drafts[index]!.categorySource });
        if (dry_run) return preview(compact({ dry_run: true, would_create: built.map(describe), warnings }));
        return {
          changes: { transaction: built.map((tx) => forPush(ledger, tx)) },
          done: () =>
            jsonResult(
              compact({
                created: built.map(describe),
                balances: accountBalances(ledger, built.flatMap((tx) => [tx.outcomeAccount, tx.incomeAccount])),
                warnings,
              }),
            ),
        };
      });
    },
  );

  server.registerTool(
    'update_transactions',
    {
      title: 'Edit transactions',
      description:
        'Change one or more existing transactions: amount, account, main category (null = uncategorized), payee, comment, date, original currency amount; transfers also to_account / to_amount. The type cannot change (delete and re-create instead). Use list_transactions to find ids.',
      inputSchema: z.object({ updates: z.array(updateSchema).min(1).max(100), dry_run: dryRun }),
      annotations: MODIFY,
    },
    async ({ updates, dry_run }) => {
      const { store, ledger } = ctx.connected();
      return store.mutate(() => {
        const now = unixNow();
        const seen = new Set<string>();
        const next = updates.map((update, index) =>
          atIndex('updates', index, () => {
            const existing = ledger.data.transaction.get(update.id);
            if (!existing) throw new UserInputError(`No transaction with id ${update.id}`);
            if (ledger.isDeleted(existing)) throw new UserInputError(`Transaction ${update.id} is deleted; restore it first`);
            if (seen.has(update.id)) throw new UserInputError(`Transaction ${update.id} appears twice; merge the changes`);
            seen.add(update.id);
            const { id: _id, ...fields } = update;
            if (Object.values(fields).every((value) => value === undefined)) throw new UserInputError(`Nothing to change for ${update.id}`);
            const patch: TransactionPatch = {
              amount: update.amount,
              toAmount: update.to_amount,
              account: update.account ? ledger.resolveAccount(update.account) : undefined,
              toAccount: update.to_account ? ledger.resolveAccount(update.to_account) : undefined,
              comment: update.comment === undefined ? undefined : update.comment?.trim() || null,
              date: update.date,
              original: resolveOriginal(ledger, update.original_amount, update.original_currency),
            };
            if (update.category !== undefined) patch.mainTagId = update.category === null ? null : ledger.resolveTag(update.category).id;
            if (update.payee !== undefined) {
              patch.payee = update.payee?.trim() || null;
              patch.merchantId = patch.payee ? (ledger.merchantByTitle(patch.payee)?.id ?? null) : null;
            }
            return { before: existing, after: patchTransaction(ledger, existing, patch, now) };
          }),
        );
        if (dry_run) {
          return preview({
            dry_run: true,
            changes: next.map(({ before, after }) => ({
              before: ledger.formatMovement(ledger.view(before)),
              after: ledger.formatMovement(ledger.view(after)),
            })),
          });
        }
        return {
          changes: { transaction: next.map(({ after }) => forPush(ledger, after)) },
          done: () =>
            jsonResult({
              updated: next.map(({ after }) => ledger.formatMovement(ledger.view(ledger.data.transaction.get(after.id) ?? after))),
              balances: accountBalances(
                ledger,
                next.flatMap(({ before, after }) => [before.outcomeAccount, before.incomeAccount, after.outcomeAccount, after.incomeAccount]),
              ),
            }),
        };
      });
    },
  );

  server.registerTool(
    'delete_transactions',
    {
      title: 'Delete transactions',
      description: 'Delete transactions by id (soft delete; restore_transactions brings them back).',
      inputSchema: z.object({ ids: z.array(z.string()).min(1).max(100), dry_run: dryRun }),
      annotations: MODIFY,
    },
    async ({ ids, dry_run }) => {
      const { store, ledger } = ctx.connected();
      return store.mutate(() => {
        const now = unixNow();
        const targets = [...new Set(ids)].map((id, index) =>
          atIndex('ids', index, () => {
            const existing = ledger.data.transaction.get(id);
            if (!existing) throw new UserInputError(`No transaction with id ${id}`);
            return existing;
          }),
        );
        const toDelete = targets.filter((tx) => !ledger.isDeleted(tx));
        const alreadyDeleted = targets.filter((tx) => !toDelete.includes(tx)).map((tx) => tx.id);
        const listed = toDelete.map((tx) => ledger.formatMovement(ledger.view(tx)));
        if (dry_run) return preview(compact({ dry_run: true, would_delete: listed, already_deleted: alreadyDeleted }));
        return {
          changes: { transaction: toDelete.map((tx) => forPush(ledger, touch(tx, { deleted: true }, now))) },
          done: () =>
            jsonResult(
              compact({
                deleted: listed,
                already_deleted: alreadyDeleted,
                balances: accountBalances(ledger, toDelete.flatMap((tx) => [tx.outcomeAccount, tx.incomeAccount])),
              }),
            ),
        };
      });
    },
  );

  server.registerTool(
    'restore_transactions',
    {
      title: 'Restore deleted transactions',
      description:
        'Bring back deleted transactions (find them with list_transactions include_deleted=true). ZenMoney cannot undelete in place, so each comes back as a copy with a new id; already-restored ones are skipped.',
      inputSchema: z.object({ ids: z.array(z.string()).min(1).max(100) }),
      annotations: { ...CREATE, idempotentHint: true },
    },
    async ({ ids }) => {
      const { store, ledger } = ctx.connected();
      return store.mutate(() => {
        const now = unixNow();
        const live = [...ledger.data.transaction.values()].filter((tx) => !ledger.isDeleted(tx));
        const items = [...new Set(ids)].map((id, index) =>
          atIndex('ids', index, () => {
            const existing = ledger.data.transaction.get(id);
            if (!existing) throw new UserInputError(`No transaction with id ${id}`);
            if (!existing.deleted) throw new UserInputError(`Transaction ${id} is not deleted`);
            if (ledger.isErased(existing)) throw new UserInputError(`Transaction ${id} was erased (zero amounts) and cannot be restored`);
            for (const accountId of [existing.incomeAccount, existing.outcomeAccount]) {
              if (!ledger.data.account.has(accountId)) throw new UserInputError(`Transaction ${id} references a deleted account`);
            }
            const twin = live.find(
              (tx) =>
                tx.created === existing.created &&
                tx.date === existing.date &&
                tx.incomeAccount === existing.incomeAccount &&
                tx.outcomeAccount === existing.outcomeAccount &&
                tx.income === existing.income &&
                tx.outcome === existing.outcome,
            );
            return { from: id, twin, copy: twin ? undefined : restoredCopy(existing, now) };
          }),
        );
        const copies = items.flatMap(({ from, copy }) => (copy ? [{ from, copy }] : []));
        return {
          changes: { transaction: copies.map(({ copy }) => forPush(ledger, copy)) },
          done: () =>
            jsonResult(
              compact({
                restored: copies.map(({ from, copy }) => ({
                  restored_from: from,
                  ...ledger.formatMovement(ledger.view(ledger.data.transaction.get(copy.id) ?? copy)),
                })),
                already_restored: items.flatMap(({ from, twin }) => (twin ? [{ id: from, restored_as: twin.id }] : [])),
                balances: accountBalances(ledger, copies.flatMap(({ copy }) => [copy.outcomeAccount, copy.incomeAccount])),
              }),
            ),
        };
      });
    },
  );

  server.registerTool(
    'create_category',
    {
      title: 'Create category',
      description: 'Create a category, optionally as a subcategory of a top-level category (ZenMoney allows one nesting level).',
      inputSchema: z.object({
        title: z.string().min(1),
        parent: z.string().optional().describe('Top-level parent category (name or id)'),
        kind: z.enum(['expense', 'income', 'both']).optional().describe("Defaults to the parent's kind, else expense"),
        required: z.boolean().default(false).describe('Mark as a mandatory (non-discretionary) expense'),
      }),
      annotations: CREATE,
    },
    async ({ title, parent, kind, required }) => {
      const { store, ledger } = ctx.connected();
      return store.mutate(() => {
        const parentTag = parent ? ledger.resolveTag(parent) : null;
        if (parentTag?.parent) throw new UserInputError(`"${ledger.tagPath(parentTag)}" is already a subcategory; pick a top-level parent`);
        const name = title.trim();
        const clash = [...ledger.data.tag.values()].find(
          (tag) => (tag.parent ?? null) === (parentTag?.id ?? null) && normalizeName(tag.title) === normalizeName(name),
        );
        if (clash) throw new UserInputError(`Category "${ledger.tagPath(clash)}" already exists (id ${clash.id})`);
        const parentKind = parentTag ? tagKind(parentTag) : 'none';
        const resolvedKind: TagKind = kind ?? (parentKind === 'none' ? 'expense' : parentKind);
        const tag = buildTag(ledger, { title: name, parent: parentTag, kind: resolvedKind, required }, unixNow());
        return {
          changes: { tag: [tag] },
          done: () => jsonResult({ created: { id: tag.id, category: ledger.tagPath(tag), kind: resolvedKind } }),
        };
      });
    },
  );

  server.registerTool(
    'update_category',
    {
      title: 'Edit category',
      description: 'Rename, move (parent null = top level), change kind, budget inclusion, mandatory flag or archive a category.',
      inputSchema: z.object({
        category: z.string().describe('Category name, path or id'),
        title: z.string().min(1).optional(),
        parent: z.string().nullable().optional().describe('New top-level parent; null makes it top-level'),
        kind: z.enum(['expense', 'income', 'both']).optional(),
        include_in_budget: z.boolean().optional().describe('Whether the category counts in budget calculations'),
        required: z.boolean().optional(),
        archived: z.boolean().optional(),
      }),
      annotations: MODIFY,
    },
    async (input) => {
      const { store, ledger } = ctx.connected();
      return store.mutate(() => {
        const tag = ledger.resolveTag(input.category);
        const changes: Partial<Tag> = {};
        if (input.title !== undefined) changes.title = input.title.trim();
        if (input.parent !== undefined) {
          const parentTag = input.parent === null ? null : ledger.resolveTag(input.parent);
          if (parentTag) {
            if (parentTag.id === tag.id) throw new UserInputError('A category cannot be its own parent');
            if (parentTag.parent) throw new UserInputError(`"${ledger.tagPath(parentTag)}" is a subcategory; pick a top-level parent`);
            if (ledger.childTags(tag.id).length) throw new UserInputError(`"${tag.title}" has subcategories and cannot become a subcategory`);
          }
          changes.parent = parentTag?.id ?? null;
        }
        const destination = changes.parent === undefined ? tag.parent : changes.parent;
        const finalTitle = changes.title ?? tag.title;
        const clash = [...ledger.data.tag.values()].find(
          (other) =>
            other.id !== tag.id && (other.parent ?? null) === (destination ?? null) && normalizeName(other.title) === normalizeName(finalTitle),
        );
        if (clash) throw new UserInputError(`Category "${ledger.tagPath(clash)}" already exists at that level`);
        if (input.kind) Object.assign(changes, tagKindFlags(input.kind));
        if (input.include_in_budget !== undefined) {
          changes.budgetOutcome = (changes.showOutcome ?? tag.showOutcome) && input.include_in_budget;
          changes.budgetIncome = (changes.showIncome ?? tag.showIncome) && input.include_in_budget;
        }
        if (input.required !== undefined) changes.required = input.required;
        if (input.archived !== undefined) changes.archive = input.archived;
        if (!Object.keys(changes).length) throw new UserInputError('Nothing to change');
        const next = touch(tag, changes, unixNow());
        return {
          changes: { tag: [next] },
          done: () =>
            jsonResult({ updated: { id: next.id, category: ledger.tagPath(next), kind: tagKind(next), archived: next.archive ?? false } }),
        };
      });
    },
  );

  server.registerTool(
    'delete_category',
    {
      title: 'Delete category',
      description:
        'Delete a category. Its transactions and planned operations are moved to move_to (merge categories) or, with uncategorize=true, left without this category. Subcategories must be moved or deleted first.',
      inputSchema: z.object({
        category: z.string().describe('Category name, path or id'),
        move_to: z.string().optional().describe('Category that takes over its transactions'),
        uncategorize: z
          .boolean()
          .default(false)
          .describe('Confirm removing the category from its transactions and planned operations when move_to is not given'),
        dry_run: dryRun,
      }),
      annotations: MODIFY,
    },
    async ({ category, move_to, uncategorize, dry_run }) => {
      const { store, ledger } = ctx.connected();
      return store.mutate(() => {
        const tag = ledger.resolveTag(category);
        const children = ledger.childTags(tag.id);
        if (children.length) {
          throw new UserInputError(
            `"${tag.title}" has subcategories (${children.map((child) => child.title).join(', ')}); move or delete them first`,
          );
        }
        const target = move_to ? ledger.resolveTag(move_to) : null;
        if (target?.id === tag.id) throw new UserInputError('move_to must be a different category');
        const now = unixNow();
        const retag = <T extends Transaction | Reminder | ReminderMarker>(item: T): T | undefined => {
          if (!item.tag?.includes(tag.id)) return undefined;
          const tags = [...new Set(item.tag.map((id) => (id === tag.id ? target?.id : id)).filter((id): id is string => Boolean(id)))];
          return touch(item, { tag: tags.length ? tags : null } as Partial<T>, now);
        };
        const transactions = [...ledger.data.transaction.values()]
          .filter((tx) => !ledger.isDeleted(tx))
          .map(retag)
          .filter((tx) => tx !== undefined);
        const reminders = [...ledger.data.reminder.values()].map(retag).filter((item) => item !== undefined);
        const markers = [...ledger.data.reminderMarker.values()].map(retag).filter((item) => item !== undefined);
        const summary = compact({
          moved_to: target ? ledger.tagPath(target) : undefined,
          transactions_updated: transactions.length,
          planned_updated: reminders.length + markers.length,
        });
        if (dry_run) return preview({ dry_run: true, would_delete: ledger.tagPath(tag), ...summary });
        const users = transactions.length + reminders.length + markers.length;
        if (users && !target && !uncategorize) {
          throw new UserInputError(
            `${transactions.length} transactions and ${reminders.length + markers.length} planned operations use "${ledger.tagPath(tag)}". Pass move_to, or uncategorize=true to confirm.`,
          );
        }
        const deletion: Deletion = { id: tag.id, object: 'tag', stamp: now, user: ledger.rootUser().id };
        return {
          changes: {
            // retag() already replaced or dropped the deleted tag on every pushed object.
            transaction: transactions.map((tx) => forPush(ledger, tx)),
            reminder: reminders.map((item) => forPush(ledger, item)),
            reminderMarker: markers.map((item) => forPush(ledger, item)),
            deletion: [deletion],
          },
          done: () => jsonResult({ deleted: ledger.tagPath(tag), ...summary }),
        };
      });
    },
  );

  server.registerTool(
    'set_budgets',
    {
      title: 'Set monthly budgets',
      description:
        'Set exact monthly budget amounts (main currency) per category, for "total" (overall monthly budget) or "uncategorized". 0 removes that budget. Batch-friendly: e.g. copy last month\'s budgets to next month.',
      inputSchema: z.object({
        budgets: z
          .array(
            z.object({
              month: isoMonth.describe('YYYY-MM'),
              category: z.string().describe('Category name/path/id, "total" or "uncategorized"'),
              expense: z.number().min(0).optional().describe('Expense budget; 0 removes it'),
              income: z.number().min(0).optional().describe('Income budget; 0 removes it'),
            }),
          )
          .min(1)
          .max(100),
        dry_run: dryRun,
      }),
      annotations: MODIFY,
    },
    async ({ budgets, dry_run }) => {
      const { store, ledger } = ctx.connected();
      return store.mutate(() => {
        const now = unixNow();
        const built: Budget[] = budgets.map((item, index) =>
          atIndex('budgets', index, () => {
            if (item.expense === undefined && item.income === undefined) throw new UserInputError('Give expense and/or income');
            const key = item.category.trim().toLowerCase();
            const tag = key === 'total' ? TOTAL_BUDGET_TAG : key === 'uncategorized' ? null : ledger.resolveTag(item.category).id;
            return buildBudget(ledger, { date: `${item.month}-01`, tag, expense: item.expense, income: item.income }, now);
          }),
        );
        const result = {
          currency: ledger.currencyCode(ledger.rootUser().currency),
          budgets: built.map((budget) => ({
            month: budget.date.slice(0, 7),
            category: budget.tag === TOTAL_BUDGET_TAG ? 'total' : ledger.tagPath(budget.tag),
            expense: budget.outcomeLock || budget.outcome ? budget.outcome : null,
            income: budget.incomeLock || budget.income ? budget.income : null,
          })),
        };
        if (dry_run) return preview({ dry_run: true, ...result });
        return { changes: { budget: built }, done: () => jsonResult(result) };
      });
    },
  );

  server.registerTool(
    'create_account',
    {
      title: 'Create account',
      description: 'Create a cash, card, checking or e-money account. Bank-synced accounts are created by ZenMoney itself.',
      inputSchema: z.object({
        title: z.string().min(1),
        type: z.enum(CREATABLE_ACCOUNT_TYPES).default('cash').describe('cash, ccard (card), checking, emoney'),
        currency: z.string().optional().describe('ISO code; defaults to the main currency'),
        balance: z.number().default(0).describe('Opening balance'),
        credit_limit: z.number().min(0).default(0),
        in_balance: z.boolean().default(true).describe('Count in the total balance and reports'),
        savings: z.boolean().default(false),
      }),
      annotations: CREATE,
    },
    async (input) => {
      const { store, ledger } = ctx.connected();
      return store.mutate(() => {
        const title = input.title.trim();
        const clash = ledger.userAccounts(true).find((account) => normalizeName(account.title) === normalizeName(title));
        if (clash) throw new UserInputError(`Account "${clash.title}" already exists (id ${clash.id})`);
        const instrument = input.currency ? ledger.instrumentByCode(input.currency).id : ledger.rootUser().currency;
        const account = buildAccount(
          ledger,
          {
            title,
            type: input.type,
            instrument,
            balance: input.balance,
            creditLimit: input.credit_limit,
            inBalance: input.in_balance,
            savings: input.savings,
          },
          unixNow(),
        );
        return {
          changes: { account: [account] },
          done: () => {
            const stored = ledger.data.account.get(account.id) ?? account;
            return jsonResult({
              created: { id: stored.id, title: stored.title, type: stored.type, currency: ledger.currencyCode(instrument), balance: stored.balance },
            });
          },
        };
      });
    },
  );

  server.registerTool(
    'update_account',
    {
      title: 'Edit account',
      description:
        'Rename, archive/unarchive, include in or exclude from balance, mark as savings, or change the credit limit. To fix a balance use adjust_account_balance.',
      inputSchema: z.object({
        account: z.string().describe('Account name, id or card last digits'),
        title: z.string().min(1).optional(),
        archived: z.boolean().optional(),
        in_balance: z.boolean().optional(),
        savings: z.boolean().optional(),
        credit_limit: z.number().min(0).optional(),
      }),
      annotations: MODIFY,
    },
    async (input) => {
      const { store, ledger } = ctx.connected();
      return store.mutate(() => {
        const account = ledger.resolveAccount(input.account);
        const changes: Partial<Account> = {};
        if (input.title !== undefined) {
          const title = input.title.trim();
          const clash = ledger
            .userAccounts(true)
            .find((other) => other.id !== account.id && normalizeName(other.title) === normalizeName(title));
          if (clash) throw new UserInputError(`Account "${clash.title}" already exists (id ${clash.id})`);
          changes.title = title;
        }
        if (input.archived !== undefined) changes.archive = input.archived;
        if (input.in_balance !== undefined) changes.inBalance = input.in_balance;
        if (input.savings !== undefined) changes.savings = input.savings;
        if (input.credit_limit !== undefined) changes.creditLimit = input.credit_limit;
        if (!Object.keys(changes).length) throw new UserInputError('Nothing to change');
        const next = touch(account, changes, unixNow());
        return {
          changes: { account: [next] },
          done: () => {
            const stored = ledger.data.account.get(next.id) ?? next;
            return jsonResult({
              updated: compact({
                id: stored.id,
                title: stored.title,
                archived: stored.archive,
                in_balance: stored.inBalance,
                savings: stored.savings ?? false,
                credit_limit: stored.creditLimit,
              }),
            });
          },
        };
      });
    },
  );

  server.registerTool(
    'adjust_account_balance',
    {
      title: 'Reconcile account balance',
      description:
        'Make an account balance match reality by recording the difference as an income or expense correction transaction (computed against freshly synced data).',
      inputSchema: z.object({
        account: z.string().describe('Account name, id or card last digits'),
        actual_balance: z.number().describe("The real current balance in the account's currency"),
        category: z.string().optional().describe('Optional category for the correction'),
        comment: z.string().default('Balance correction'),
        date: isoDate.optional().describe('Defaults to today'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const { store, ledger } = ctx.connected();
      const today = ctx.today();
      return store.mutate(() => {
        const account = ledger.resolveAccount(input.account);
        const previous = account.balance ?? 0;
        const difference = round2(input.actual_balance - previous);
        const currency = ledger.currencyCode(ledger.accountInstrument(account));
        if (Math.abs(difference) < 0.005) {
          return preview({ account: account.title, balance: round2(previous), currency, already_matches: true });
        }
        const tx = buildTransaction(
          ledger,
          {
            type: difference > 0 ? 'income' : 'expense',
            amount: Math.abs(difference),
            account,
            tagIds: input.category ? [ledger.resolveTag(input.category).id] : null,
            payee: null,
            merchantId: null,
            comment: input.comment,
            date: input.date ?? today,
          },
          unixNow(),
        );
        return {
          changes: { transaction: [forPush(ledger, tx)] },
          done: () =>
            jsonResult({
              account: account.title,
              currency,
              previous_balance: round2(previous),
              balance_now: round2(ledger.data.account.get(account.id)?.balance ?? input.actual_balance),
              correction: ledger.formatMovement(ledger.view(tx)),
            }),
        };
      });
    },
  );
}
