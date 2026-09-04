/**
 * Thin Sendblue REST client. Zero deps — uses the injected (or global) fetch.
 * API facts per docs.sendblue.com (2026-07):
 *   - auth headers on every call: `sb-api-key-id`, `sb-api-secret-key`
 *   - send:   POST {apiBaseUrl}/api/send-message        (api.sendblue.co)
 *   - typing: POST {apiV2BaseUrl}/api/send-typing-indicator (api.sendblue.com!)
 *   - rate limit: 10 msg/s per line; 429 = rejected, NOT queued
 */

export interface SendblueClientOptions {
  apiBaseUrl: string;
  apiV2BaseUrl: string;
  apiKeyId: string;
  apiSecretKey: string;
  /** Our Sendblue line (E.164) — the `from_number` on every send. */
  fromNumber: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Backoff before the single retry on 429/5xx (default 1200ms). */
  retryDelayMs?: number;
}

export interface SendMessageInput {
  /** Recipient (E.164). */
  number: string;
  content: string;
  media_url?: string;
}

export interface SendMessageResult {
  status?: string;
  message_handle?: string;
  error_code?: string | number | null;
  error_message?: string | null;
  [key: string]: unknown;
}

export class SendblueClient {
  private readonly opts: SendblueClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;

  constructor(opts: SendblueClientOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retryDelayMs = opts.retryDelayMs ?? 1200;
  }

  /**
   * Send one iMessage. Non-2xx responses and `status: "ERROR"` /
   * `error_code` bodies are failures. On 429 (rate limit — rejected, not
   * queued) or 5xx, retries ONCE after {@link retryDelayMs}, then gives up.
   */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const first = await this.postSend(input);
    if (first.ok) return first.result;
    if (first.retryable) {
      await sleep(this.retryDelayMs);
      const second = await this.postSend(input);
      if (second.ok) return second.result;
      throw new Error(`sendblue send-message failed after retry: ${second.detail}`);
    }
    throw new Error(`sendblue send-message failed: ${first.detail}`);
  }

  /**
   * Best-effort typing indicator (non-group only). Never throws — returns
   * `false` on any failure so callers can fire-and-forget.
   */
  async sendTypingIndicator(number: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.opts.apiV2BaseUrl}/api/send-typing-indicator`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          number,
          from_number: this.opts.fromNumber,
          state: 'start',
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private headers(): Record<string, string> {
    return {
      'sb-api-key-id': this.opts.apiKeyId,
      'sb-api-secret-key': this.opts.apiSecretKey,
      'Content-Type': 'application/json',
    };
  }

  private async postSend(
    input: SendMessageInput,
  ): Promise<
    | { ok: true; result: SendMessageResult }
    | { ok: false; retryable: boolean; detail: string }
  > {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.apiBaseUrl}/api/send-message`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          from_number: this.opts.fromNumber,
          number: input.number,
          content: input.content,
          ...(input.media_url ? { media_url: input.media_url } : {}),
        }),
      });
    } catch (err) {
      // network-level failure — treat like a 5xx (retryable once)
      return { ok: false, retryable: true, detail: `fetch failed: ${(err as Error).message}` };
    }

    if (res.status === 429 || res.status >= 500) {
      return { ok: false, retryable: true, detail: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { ok: false, retryable: false, detail: `HTTP ${res.status} ${await safeText(res)}` };
    }

    let body: SendMessageResult;
    try {
      body = (await res.json()) as SendMessageResult;
    } catch {
      body = {};
    }
    // `error_code` counts as an error only when it carries a real code. The
    // docs use `null` for "no error", but `0` and `""` are the same statement
    // in a JSON API, and treating them as failures would raise on a message
    // that was in fact delivered — sending the user a bogus error bubble.
    const errorCode = body.error_code;
    const hasErrorCode =
      errorCode !== undefined && errorCode !== null && errorCode !== 0 && errorCode !== '';
    if (body.status === 'ERROR' || hasErrorCode) {
      return {
        ok: false,
        retryable: false,
        detail: `provider error ${String(body.error_code ?? '')}: ${String(body.error_message ?? body.status ?? '')}`,
      };
    }
    return { ok: true, result: body };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}
