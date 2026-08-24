import type { NatsConnection, Msg, Subscription } from 'nats'

export const DEFAULT_MAX_ENVELOPE_BYTES = 1_044_480

export interface Envelope<P = unknown> {
  envelope_version: 1
  id: string
  from: string
  to?: string
  kind: string
  in_reply_to?: string
  ts: string
  payload: P
}

export interface FleetBusConfig {
  botName: string
  url: string
  user: string
  password: string
  subscribeBroadcast?: boolean
  maxEnvelopeBytes?: number
}

export interface FleetBusRequestOptions {
  to: string
  kind: string
  payload: unknown
  wait?: boolean
  timeoutMs?: number
  force?: boolean
}

export interface FleetBusRequestResult {
  ok: boolean
  envelope?: Envelope
  delivered_to_subscriber?: boolean
  error?: string
}

export interface FleetBusReplyResult {
  ok: boolean
  envelope?: Envelope
  error?: 'req_id_unknown' | string
  req_id?: string
}

export type EnvelopeValidationResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; error: string }

const BOT_NAME_PATTERN = /^[a-z0-9_-]+$/

/** Return the canonical bus identity, or null for a non-ASCII/invalid claim. */
export function normalizeBotName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').toLowerCase()
  return BOT_NAME_PATTERN.test(normalized) ? normalized : null
}

/** Normalize a manifest bot_names list, rejecting invalid entries. */
export function normalizeAllowlist(values: Iterable<unknown>): Set<string> {
  const result = new Set<string>()
  for (const value of values) {
    const normalized = normalizeBotName(value)
    if (normalized === null) throw new TypeError(`Invalid fleet bot name: ${String(value)}`)
    result.add(normalized)
  }
  return result
}

/** Validate the v1 wire envelope before it reaches any bus handler. */
export function validateEnvelope(
  value: unknown,
  allowedFromClaims: ReadonlySet<string>,
  maxBytes = DEFAULT_MAX_ENVELOPE_BYTES,
): EnvelopeValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'envelope_not_object' }
  }

  const candidate = value as Record<string, unknown>
  if (candidate.envelope_version !== 1) return { ok: false, error: 'unsupported_envelope_version' }
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return { ok: false, error: 'invalid_id' }
  if (typeof candidate.kind !== 'string' || candidate.kind.length === 0) return { ok: false, error: 'invalid_kind' }
  if (typeof candidate.ts !== 'string' || Number.isNaN(Date.parse(candidate.ts))) return { ok: false, error: 'invalid_ts' }
  if (!Object.hasOwn(candidate, 'payload')) return { ok: false, error: 'missing_payload' }
  if (candidate.to !== undefined && typeof candidate.to !== 'string') return { ok: false, error: 'invalid_to' }
  if (candidate.in_reply_to !== undefined && typeof candidate.in_reply_to !== 'string') {
    return { ok: false, error: 'invalid_in_reply_to' }
  }

  const from = normalizeBotName(candidate.from)
  if (from === null || !allowedFromClaims.has(from)) return { ok: false, error: 'from_claim_rejected' }

  let encodedBytes: number
  try {
    encodedBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8')
  } catch {
    return { ok: false, error: 'payload_not_serializable' }
  }
  if (encodedBytes > maxBytes) return { ok: false, error: 'envelope_too_large' }

  return { ok: true, envelope: { ...candidate, from } as unknown as Envelope }
}

/**
 * Session-owned NATS transport. Stage 1 defines its contract only; transport,
 * subscriptions, heartbeat, injection, ledgers, and rate limiting land in the
 * subsequent implementation commits described by the v0.6 spec.
 */
export class FleetBus {
  private nc?: NatsConnection
  private readonly subscriptions = new Set<Subscription>()

  constructor(
    private readonly config: FleetBusConfig,
    private readonly allowedFromClaims: ReadonlySet<string>,
  ) {}

  async connect(): Promise<void> {
    // TODO(stage-1): connect with per-bot user/password and scoped inbox prefix.
    throw new Error('FleetBus.connect is not implemented')
  }

  async disconnect(): Promise<void> {
    // TODO(stage-1): stop heartbeat/subscriptions and drain the NATS connection.
    throw new Error('FleetBus.disconnect is not implemented')
  }

  async request(_options: FleetBusRequestOptions): Promise<FleetBusRequestResult> {
    // TODO(stage-3): publish request and optionally await the ephemeral inbox.
    throw new Error('FleetBus.request is not implemented')
  }

  publishReply(_reqId: string, _payload: unknown, _kind = 'result'): FleetBusReplyResult {
    // TODO(stage-3): resolve the server-side inflight ledger and publish reply.
    throw new Error('FleetBus.publishReply is not implemented')
  }

  protected onRequest(_message: Msg): void {
    // TODO(stage-2): validate, gate, ledger, audit, then inject into the session.
  }

  protected onResult(_message: Msg): void {
    // TODO(stage-3): validate, gate, dedupe, and resolve waiter or inject result.
  }
}
