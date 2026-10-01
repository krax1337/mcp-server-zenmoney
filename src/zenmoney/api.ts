import { setTimeout as delay } from 'node:timers/promises';
import type { DiffRequest, DiffResponse, SuggestRequest, SuggestResponse } from './types.js';

export const DEFAULT_BASE_URLS = ['https://api.zenmoney.ru', 'https://api.zenmoney.app'];
export const TOKEN_HELP = 'Get a fresh token at https://zerro.app/token and update ZENMONEY_TOKEN.';

export class ZenMoneyError extends Error {
  override name = 'ZenMoneyError';
}

/** The API rejected the token (HTTP 401). */
export class ZenMoneyAuthError extends ZenMoneyError {
  override name = 'ZenMoneyAuthError';
}

/** The API answered with an error payload, e.g. `{"error":{"code":"validationError",...}}`. */
export class ZenMoneyApiError extends ZenMoneyError {
  override name = 'ZenMoneyApiError';
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface ZenMoneyApiOptions {
  token: string;
  /** Candidate API origins; the first one that accepts the token is kept for the session. */
  baseUrls?: string[];
  fetch?: typeof fetch;
  userAgent?: string;
  log?: (message: string) => void;
}

interface PostOptions {
  timeoutMs: number;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 2000];

/** Thin client for the two ZenMoney API v8 endpoints: /v8/diff/ and /v8/suggest/. */
export class ZenMoneyApi {
  private readonly token: string;
  private readonly baseUrls: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly log: (message: string) => void;
  private active = 0;
  /** Set once any origin accepted the token; after that a 401 means the token itself is dead. */
  private confirmed = false;

  constructor(options: ZenMoneyApiOptions) {
    this.token = options.token;
    this.baseUrls = options.baseUrls?.length ? options.baseUrls : DEFAULT_BASE_URLS;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? 'mcp-server-zenmoney';
    this.log = options.log ?? (() => {});
  }

  get baseUrl(): string {
    return this.baseUrls[this.active]!;
  }

  /** POST /v8/diff/. `currentClientTimestamp` is stamped at send time. */
  async diff(request: Omit<DiffRequest, 'currentClientTimestamp'>, options: PostOptions): Promise<DiffResponse> {
    const response = await this.post<DiffResponse>('/v8/diff/', () => ({
      ...request,
      currentClientTimestamp: Math.floor(Date.now() / 1000),
    }), options);
    if (typeof response?.serverTimestamp !== 'number') {
      throw new ZenMoneyApiError('ZenMoney /v8/diff/ response has no serverTimestamp', 200);
    }
    return response;
  }

  /** POST /v8/suggest/ with a batch of partial transactions; returns one suggestion per item. */
  async suggest(items: SuggestRequest[], options: PostOptions): Promise<SuggestResponse[]> {
    const response = await this.post<SuggestResponse[] | SuggestResponse>('/v8/suggest/', () => items, options);
    return Array.isArray(response) ? response : [response];
  }

  private async post<T>(path: string, body: () => unknown, options: PostOptions): Promise<T> {
    for (;;) {
      try {
        const result = await this.postWithRetry<T>(this.baseUrl + path, body, options);
        this.confirmed = true;
        return result;
      } catch (error) {
        if (error instanceof ZenMoneyAuthError && !this.confirmed && this.active < this.baseUrls.length - 1) {
          this.active += 1;
          this.log(`token rejected, retrying against ${this.baseUrl}`);
          continue;
        }
        throw error;
      }
    }
  }

  private async postWithRetry<T>(url: string, body: () => unknown, options: PostOptions): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': this.userAgent,
          },
          body: JSON.stringify(body()),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error) {
        if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
          throw new ZenMoneyError(`ZenMoney API did not answer within ${Math.round(options.timeoutMs / 1000)}s (${url})`);
        }
        if (attempt < RETRY_DELAYS_MS.length) {
          await delay(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw new ZenMoneyError(`Cannot reach ZenMoney API at ${url}: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (RETRYABLE_STATUS.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
        await response.body?.cancel();
        await delay(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return parseResponse<T>(response);
    }
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (response.status === 401) {
    throw new ZenMoneyAuthError(`ZenMoney rejected the token (HTTP 401). ${TOKEN_HELP}`);
  }
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  const apiError = extractError(json);
  if (apiError) {
    const { code, message, details } = apiError;
    throw new ZenMoneyApiError(`ZenMoney API error${code ? ` [${code}]` : ''}: ${message}`, response.status, code, details);
  }
  if (!response.ok) {
    throw new ZenMoneyApiError(`ZenMoney API HTTP ${response.status}: ${text.slice(0, 500) || response.statusText}`, response.status);
  }
  if (json === undefined) {
    throw new ZenMoneyApiError(`ZenMoney API returned a non-JSON body: ${text.slice(0, 200)}`, response.status);
  }
  // Payloads are large (full history) and the API adds fields over time, so they are
  // trusted structurally instead of schema-parsed; callers check the fields they rely on.
  return json as T;
}

function extractError(json: unknown): { code?: string; message: string; details?: unknown } | undefined {
  if (!json || typeof json !== 'object' || !('error' in json) || !json.error) return undefined;
  const error = json.error;
  if (typeof error !== 'object') return { message: String(error) };
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const message = 'message' in error && typeof error.message === 'string' ? error.message : JSON.stringify(error);
  const details = 'details' in error ? error.details : undefined;
  return { code, message, details };
}
