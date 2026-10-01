/**
 * ZenMoney API v8 entities as returned by POST /v8/diff/.
 *
 * Sources: https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API plus fields
 * observed in real responses (Zerro's data-entities.ts, zenmoney-rs models).
 * Unknown extra fields are preserved verbatim in the cache and pushed back on
 * updates, so these types only list what this server reads or writes.
 */

/** Unix timestamp in seconds. */
export type UnixTime = number;
/** Calendar date `YYYY-MM-DD`. */
export type IsoDate = string;

export type InstrumentId = number;
export type UserId = number;
export type CompanyId = number;
export type AccountId = string;
export type TagId = string;
export type MerchantId = string;
export type ReminderId = string;
export type ReminderMarkerId = string;
export type TransactionId = string;

export interface Instrument {
  id: InstrumentId;
  changed: UnixTime;
  title: string;
  /** ISO 4217 code, e.g. `RUB`. */
  shortTitle: string;
  symbol: string;
  /** Price of one unit in roubles. */
  rate: number;
}

export interface Country {
  id: number;
  title: string;
  currency: InstrumentId;
  domain: string | null;
}

export interface Company {
  id: CompanyId;
  changed: UnixTime;
  title: string;
  fullTitle: string | null;
  www: string | null;
  country: number | string | null;
  countryCode?: string | null;
  deleted?: boolean;
}

export interface User {
  id: UserId;
  changed: UnixTime;
  login: string | null;
  /** Main currency used for totals and reports. */
  currency: InstrumentId;
  /** Family-accounting parent; `null` for the root user. */
  parent: UserId | null;
  country?: number | null;
  countryCode?: string | null;
  email?: string | null;
  monthStartDay?: number | null;
  isForecastEnabled?: boolean | null;
  planBalanceMode?: string | null;
  planSettings?: string | null;
  paidTill?: UnixTime | null;
  subscription?: string | null;
  subscriptionRenewalDate?: UnixTime | null;
}

export type AccountType = 'cash' | 'ccard' | 'checking' | 'loan' | 'deposit' | 'emoney' | 'debt';
export type Interval = 'day' | 'week' | 'month' | 'year';

export interface Account {
  id: AccountId;
  changed: UnixTime;
  user: UserId;
  role: UserId | null;
  instrument: InstrumentId | null;
  company: CompanyId | null;
  type: AccountType;
  title: string;
  syncID: string[] | null;
  balance: number | null;
  startBalance: number | null;
  creditLimit: number | null;
  inBalance: boolean;
  savings: boolean | null;
  enableCorrection: boolean;
  enableSMS: boolean;
  archive: boolean;
  private?: boolean | null;
  balanceCorrectionType?: string | null;
  capitalization: boolean | null;
  percent: number | null;
  startDate: IsoDate | null;
  endDateOffset: number | null;
  endDateOffsetInterval: Interval | null;
  payoffStep: number | null;
  payoffInterval: 'month' | 'year' | null;
}

export interface Tag {
  id: TagId;
  changed: UnixTime;
  user: UserId;
  title: string;
  /** At most one level of nesting. */
  parent: TagId | null;
  icon: string | null;
  picture: string | null;
  /** ARGB packed into an integer. */
  color: number | null;
  showIncome: boolean;
  showOutcome: boolean;
  budgetIncome: boolean;
  budgetOutcome: boolean;
  /** `null` means required. */
  required: boolean | null;
  staticId?: string | null;
  archive?: boolean | null;
}

export interface Merchant {
  id: MerchantId;
  changed: UnixTime;
  user: UserId;
  title: string;
}

interface MoneyMovement {
  incomeInstrument: InstrumentId;
  incomeAccount: AccountId;
  income: number;
  outcomeInstrument: InstrumentId;
  outcomeAccount: AccountId;
  outcome: number;
  tag: TagId[] | null;
  merchant: MerchantId | null;
  payee: string | null;
  comment: string | null;
}

export interface Reminder extends MoneyMovement {
  id: ReminderId;
  changed: UnixTime;
  user: UserId;
  interval: Interval | null;
  step: number | null;
  points: number[] | null;
  startDate: IsoDate;
  endDate: IsoDate | null;
  notify: boolean;
}

export type ReminderMarkerState = 'planned' | 'processed' | 'deleted';

export interface ReminderMarker extends MoneyMovement {
  id: ReminderMarkerId;
  changed: UnixTime;
  user: UserId;
  date: IsoDate;
  reminder: ReminderId;
  state: ReminderMarkerState;
  notify: boolean;
  isForecast?: boolean | null;
}

export interface Transaction extends MoneyMovement {
  id: TransactionId;
  changed: UnixTime;
  created: UnixTime;
  user: UserId;
  deleted: boolean;
  hold: boolean | null;
  originalPayee: string | null;
  date: IsoDate;
  mcc: number | null;
  reminderMarker: ReminderMarkerId | null;
  opIncome: number | null;
  opIncomeInstrument: InstrumentId | null;
  opOutcome: number | null;
  opOutcomeInstrument: InstrumentId | null;
  latitude: number | null;
  longitude: number | null;
  incomeBankID?: string | number | null;
  outcomeBankID?: string | number | null;
  qrCode?: string | null;
  source?: string | null;
  viewed?: boolean | null;
}

/** Budget for (tag, month). `tag === null` is "no category"; the all-zero UUID is the monthly total. */
export interface Budget {
  changed: UnixTime;
  user: UserId;
  tag: TagId | null;
  /** First day of the month. */
  date: IsoDate;
  income: number;
  incomeLock: boolean;
  outcome: number;
  outcomeLock: boolean;
  isIncomeForecast?: boolean | null;
  isOutcomeForecast?: boolean | null;
}

export const TOTAL_BUDGET_TAG = '00000000-0000-0000-0000-000000000000';

export type EntityName =
  | 'instrument'
  | 'country'
  | 'company'
  | 'user'
  | 'account'
  | 'tag'
  | 'merchant'
  | 'budget'
  | 'reminder'
  | 'reminderMarker'
  | 'transaction';

export interface Deletion {
  id: string | number;
  object: EntityName;
  stamp: UnixTime;
  user: UserId;
}

export interface DiffEntities {
  instrument?: Instrument[];
  country?: Country[];
  company?: Company[];
  user?: User[];
  account?: Account[];
  tag?: Tag[];
  merchant?: Merchant[];
  budget?: Budget[];
  reminder?: Reminder[];
  reminderMarker?: ReminderMarker[];
  transaction?: Transaction[];
  deletion?: Deletion[];
}

export interface DiffRequest extends DiffEntities {
  currentClientTimestamp: UnixTime;
  serverTimestamp: UnixTime;
  forceFetch?: EntityName[];
}

export interface DiffResponse extends DiffEntities {
  serverTimestamp: UnixTime;
}

/** Partial transaction accepted and returned by POST /v8/suggest/. */
export interface SuggestRequest {
  payee?: string | null;
  comment?: string | null;
  income?: number;
  outcome?: number;
  incomeAccount?: AccountId;
  outcomeAccount?: AccountId;
}

export interface SuggestResponse {
  payee?: string | null;
  merchant?: MerchantId | null;
  tag?: TagId[] | null;
}
