/** Calendar helpers on `YYYY-MM-DD` strings; all arithmetic is done in UTC to avoid DST drift. */

export const PERIODS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_quarter',
  'last_quarter',
  'this_year',
  'last_year',
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'last_12_months',
] as const;
export type Period = (typeof PERIODS)[number];

export interface DateRange {
  from?: string;
  to?: string;
}

const DAY_MS = 86_400_000;

/** Today's date in `timeZone` (defaults to the process time zone). */
export function todayIso(timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );
}

function parse(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`);
}

function format(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return format(new Date(parse(iso).getTime() + days * DAY_MS));
}

/** Adds months keeping the day clamped to the target month's length. */
export function addMonths(iso: string, months: number): string {
  const date = parse(iso);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return format(date);
}

export function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function monthEnd(iso: string): string {
  return addDays(addMonths(monthStart(iso), 1), -1);
}

/** Monday of the ISO week containing `iso`. */
export function weekStart(iso: string): string {
  const weekday = (parse(iso).getUTCDay() + 6) % 7;
  return addDays(iso, -weekday);
}

export function weekdayName(iso: string): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][parse(iso).getUTCDay()]!;
}

export function periodRange(period: Period, today: string): Required<DateRange> {
  const quarterStart = (iso: string) => {
    const month = Number(iso.slice(5, 7));
    return `${iso.slice(0, 4)}-${String(month - ((month - 1) % 3)).padStart(2, '0')}-01`;
  };
  switch (period) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'this_week':
      return { from: weekStart(today), to: addDays(weekStart(today), 6) };
    case 'last_week':
      return { from: addDays(weekStart(today), -7), to: addDays(weekStart(today), -1) };
    case 'this_month':
      return { from: monthStart(today), to: monthEnd(today) };
    case 'last_month': {
      const start = addMonths(monthStart(today), -1);
      return { from: start, to: monthEnd(start) };
    }
    case 'this_quarter': {
      const start = quarterStart(today);
      return { from: start, to: addDays(addMonths(start, 3), -1) };
    }
    case 'last_quarter': {
      const start = addMonths(quarterStart(today), -3);
      return { from: start, to: addDays(addMonths(start, 3), -1) };
    }
    case 'this_year':
      return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
    case 'last_year': {
      const year = Number(today.slice(0, 4)) - 1;
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    }
    case 'last_7_days':
      return { from: addDays(today, -6), to: today };
    case 'last_30_days':
      return { from: addDays(today, -29), to: today };
    case 'last_90_days':
      return { from: addDays(today, -89), to: today };
    case 'last_12_months':
      return { from: addDays(addMonths(today, -12), 1), to: today };
  }
}

/** `period` gives the base range; explicit `date_from` / `date_to` override either end. */
export function resolveRange(
  input: { period?: Period; date_from?: string; date_to?: string },
  today: string,
): DateRange {
  const base: DateRange = input.period ? periodRange(input.period, today) : {};
  const range = { from: input.date_from ?? base.from, to: input.date_to ?? base.to };
  if (range.from && range.to && range.from > range.to) {
    throw new Error(`date_from ${range.from} is after date_to ${range.to}`);
  }
  return range;
}

/** Month start day as ZenMoney can use it: 1..28, so every month has that day. */
const clampStartDay = (monthStartDay: number) => Math.min(Math.max(Math.trunc(monthStartDay) || 1, 1), 28);

/**
 * Budget month `YYYY-MM` as a date range honouring ZenMoney's "month start day":
 * with start day 10, "2026-09" covers 2026-09-10 .. 2026-10-09.
 */
export function budgetMonthRange(month: string, monthStartDay: number): Required<DateRange> {
  const from = `${month}-${String(clampStartDay(monthStartDay)).padStart(2, '0')}`;
  return { from, to: addDays(addMonths(from, 1), -1) };
}

/** The budget month whose period contains `today` (the previous calendar month before the start day). */
export function budgetMonthOf(today: string, monthStartDay: number): string {
  if (Number(today.slice(8, 10)) >= clampStartDay(monthStartDay)) return today.slice(0, 7);
  return addMonths(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
}
