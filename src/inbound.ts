import type { IncomingAttachment, IncomingTurn } from '@omadia/channel-sdk';

/**
 * Inbound Sendblue webhook payload (receive-webhook AND status-callback share
 * this shape — status callbacks carry `is_outbound: true` / a non-RECEIVED
 * status). Field set per docs.sendblue.com (2026-07); everything optional
 * because the wire is untyped JSON.
 */
export interface SendbluePayload {
  accountEmail?: string;
  content?: string;
  is_outbound?: boolean;
  status?: string;
  error_code?: string | number | null;
  error_message?: string | null;
  message_handle?: string;
  date_sent?: string;
  date_updated?: string;
  from_number?: string;
  number?: string;
  to_number?: string;
  was_downgraded?: boolean;
  plan?: string;
  media_url?: string;
  message_type?: string;
  group_id?: string;
  participants?: string[];
  send_style?: string;
  group_display_name?: string | null;
  opted_out?: boolean;
  error_detail?: string | null;
  sendblue_number?: string;
  service?: string;
}

export type DropReason =
  | 'malformed'
  | 'not-inbound'
  | 'group-unsupported'
  | 'self'
  | 'not-allowlisted'
  | 'duplicate'
  | 'empty';

export type InboundResult = { drop: DropReason } | { turn: IncomingTurn };

/**
 * Bounded insertion-order dedupe set. Sendblue retries webhook deliveries
 * (up to 3x on 5xx/timeout), so a `message_handle` we already accepted must
 * be dropped. Capped so a long-running channel can't grow unboundedly.
 */
export interface LruSet {
  has(key: string): boolean;
  add(key: string): void;
  clear(): void;
}

export function createLruSet(cap: number): LruSet {
  const entries = new Set<string>();
  return {
    has: (key) => entries.has(key),
    add: (key) => {
      if (entries.has(key)) return;
      entries.add(key);
      if (entries.size > cap) {
        // Set iterates in insertion order — evict the oldest entry.
        const oldest = entries.values().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
    clear: () => entries.clear(),
  };
}

export interface InboundOptions {
  /** The channel plugin's catalog id (`ctx.agentId`). */
  channelId: string;
  /** Digits-only allowed numbers; empty set = everyone allowed. */
  allowlist: ReadonlySet<string>;
  /** Shared dedupe set for `message_handle` values. */
  seen: LruSet;
}

/**
 * Validate + filter one raw webhook body and map it to an {@link IncomingTurn}.
 * Pure apart from the injected dedupe set. Returns either a drop reason or
 * the mapped turn — never throws.
 */
export function evaluateInbound(raw: unknown, opts: InboundOptions): InboundResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { drop: 'malformed' };
  }
  const p = raw as SendbluePayload;

  const fromNumber = typeof p.from_number === 'string' ? p.from_number.trim() : '';
  if (fromNumber.length === 0) return { drop: 'malformed' };

  // Status callbacks (outbound delivery updates) and our own echoes share the
  // webhook — only status RECEIVED inbound messages become turns.
  if (p.is_outbound === true || p.status !== 'RECEIVED') return { drop: 'not-inbound' };

  // v1: group chats unsupported (replying needs the undocumented
  // /send-group-message endpoint).
  const groupId = typeof p.group_id === 'string' ? p.group_id.trim() : '';
  if (p.message_type === 'group' || groupId.length > 0) return { drop: 'group-unsupported' };

  if (typeof p.sendblue_number === 'string' && fromNumber === p.sendblue_number) {
    return { drop: 'self' };
  }

  if (opts.allowlist.size > 0 && !opts.allowlist.has(normalizePhone(fromNumber))) {
    return { drop: 'not-allowlisted' };
  }

  const handle = typeof p.message_handle === 'string' ? p.message_handle : '';
  if (handle.length > 0) {
    if (opts.seen.has(handle)) return { drop: 'duplicate' };
    opts.seen.add(handle);
  }

  const content = typeof p.content === 'string' ? p.content : '';
  const mediaUrl = typeof p.media_url === 'string' ? p.media_url.trim() : '';
  if (content.trim().length === 0 && mediaUrl.length === 0) return { drop: 'empty' };

  const attachment = mediaUrl.length > 0 ? attachmentFromUrl(mediaUrl) : undefined;

  const turn: IncomingTurn = {
    channelId: opts.channelId,
    conversationId: fromNumber,
    channelType: 'imessage',
    channelKey: fromNumber,
    userRef: { kind: 'imessage-handle', id: fromNumber },
    text: content,
    ...(attachment ? { attachments: [attachment] } : {}),
    metadata: {
      ...(typeof p.service === 'string' ? { service: p.service } : {}),
      ...(typeof p.opted_out === 'boolean' ? { opted_out: p.opted_out } : {}),
    },
    rawEvent: raw,
  };
  return { turn };
}

/** Digits-only normalisation so `+49 170 ...`, `0049170...` variants compare. */
export function normalizePhone(value: string): string {
  return value.replace(/\D/g, '');
}

/** Extension → attachment kind/mediaType, best-effort. */
export function attachmentFromUrl(url: string): IncomingAttachment {
  const ext = extensionOf(url);
  const { kind, mediaType } = EXT_MAP[ext] ?? {
    kind: 'file' as const,
    mediaType: 'application/octet-stream',
  };
  return { kind, url, mediaType };
}

const EXT_MAP: Record<string, { kind: IncomingAttachment['kind']; mediaType: string }> = {
  jpg: { kind: 'image', mediaType: 'image/jpeg' },
  jpeg: { kind: 'image', mediaType: 'image/jpeg' },
  png: { kind: 'image', mediaType: 'image/png' },
  gif: { kind: 'image', mediaType: 'image/gif' },
  webp: { kind: 'image', mediaType: 'image/webp' },
  heic: { kind: 'image', mediaType: 'image/heic' },
  mp4: { kind: 'video', mediaType: 'video/mp4' },
  mov: { kind: 'video', mediaType: 'video/quicktime' },
  mp3: { kind: 'audio', mediaType: 'audio/mpeg' },
  m4a: { kind: 'audio', mediaType: 'audio/mp4' },
  caf: { kind: 'audio', mediaType: 'audio/x-caf' },
};

function extensionOf(url: string): string {
  // strip query/fragment, take the segment after the last dot of the path
  const path = url.split(/[?#]/, 1)[0] ?? '';
  const lastSegment = path.split('/').pop() ?? '';
  const dot = lastSegment.lastIndexOf('.');
  return dot >= 0 ? lastSegment.slice(dot + 1).toLowerCase() : '';
}
