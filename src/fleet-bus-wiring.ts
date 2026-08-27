/**
 * Plugin-side Stage 4 wiring for @artifice-ia/fleet-bus.
 *
 * The package (`bazfer/fleet-bus`) owns the wire: transport, ledgers, baton,
 * request/reply, rate limits, frame escape/caps. This module owns the SESSION
 * side: how the plugin exposes bus operations as MCP tools, how injection
 * frames reach the model, and how observability data (counters, audit tail,
 * connection state) is surfaced back to the model via `bus_status`.
 *
 * Design doc: `~/vault/projects/fleet/bus/adapter-designs/CLAUDE-CODE-SESSION-ADAPTER-DESIGN.md`
 * (v3). Every knob added here traces to a design-doc requirement — see PR body.
 */

import { readFileSync } from 'node:fs'
import {
  buildFleetBusFrameMeta,
  buildFleetBusFramePayloadBody,
  defaultRateLimiters,
  escapeFrameIdentifier,
  FleetBus,
  loadFleetManifestAllowlist,
  normalizeBotName,
  type FleetBusConfig,
  type FleetBusMode,
  type FleetBusRateLimiters,
  type FleetBusSessionEvent,
  type TokenBucket,
} from '@artifice-ia/fleet-bus'
import type { ConnectionOptions, NatsConnection } from 'nats'

/* -------------------------------------------------------------------------- */
/* Counting bucket — proxies a TokenBucket, tallying allow/deny per key so    */
/* `bus_status` can surface rate-limit pressure without asking the package    */
/* to expose its private counters.                                             */
/* -------------------------------------------------------------------------- */

export interface BucketSnapshot {
  allowed: number
  denied: number
  top_denials: { key: string; count: number }[]
}

export class CountingBucket implements TokenBucket {
  private allowed = 0
  private denied = 0
  private readonly denialsByKey = new Map<string, number>()

  constructor(private readonly inner: TokenBucket) {}

  allow(key: string): boolean {
    const ok = this.inner.allow(key)
    if (ok) this.allowed += 1
    else {
      this.denied += 1
      this.denialsByKey.set(key, (this.denialsByKey.get(key) ?? 0) + 1)
    }
    return ok
  }

  snapshot(): BucketSnapshot {
    // Sort a fresh copy — snapshot is called from a tool handler while
    // allow() may fire concurrently; iterate an array, not the live map.
    const entries = [...this.denialsByKey.entries()]
    entries.sort((a, b) => b[1] - a[1])
    return {
      allowed: this.allowed,
      denied: this.denied,
      top_denials: entries.slice(0, 5).map(([key, count]) => ({ key, count })),
    }
  }
}

export interface CountingRateLimiters extends FleetBusRateLimiters {
  perFrom: CountingBucket
  perSubject: CountingBucket
  perSessionInject: CountingBucket
}

export function wrapRateLimiters(inner: FleetBusRateLimiters): CountingRateLimiters {
  return {
    perFrom: new CountingBucket(inner.perFrom),
    perSubject: new CountingBucket(inner.perSubject),
    perSessionInject: new CountingBucket(inner.perSessionInject),
  }
}

/* -------------------------------------------------------------------------- */
/* Injection frame construction                                                */
/*                                                                             */
/* The MCP `notifications/claude/channel` notification builds the outer         */
/* `<channel ...>content</channel>` tag from `meta` (attributes) + `content`   */
/* (inner body). We use the package's frame helpers so escape/cap discipline   */
/* stays wire-consistent, and additively expose baton lineage as attributes    */
/* so the model can trace who started the conversation and who owns it now.    */
/* -------------------------------------------------------------------------- */

export interface InjectionFrame {
  content: string
  meta: Record<string, string>
}

export function buildInjectionFrame(event: FleetBusSessionEvent): InjectionFrame {
  const base = buildFleetBusFrameMeta(event)
  const meta: Record<string, string> = { ...base }
  const { envelope, unsolicited } = event
  if (unsolicited === true) meta.unsolicited = 'true'
  // Baton lineage — surface every field that arrived on the wire so the model
  // can distinguish origin (who started the conversation) from owner (who is
  // authoritative right now, post-any handoffs). Mirror the escape discipline
  // buildFleetBusFrame uses on the identifier path.
  for (const field of ['root_id', 'origin', 'owner', 'hops'] as const) {
    const value = envelope[field]
    if (value === undefined || value === null) continue
    meta[field] = escapeFrameIdentifier(value)
  }
  const { body } = buildFleetBusFramePayloadBody(envelope)
  return { content: `<payload>${body}</payload>`, meta }
}

/* -------------------------------------------------------------------------- */
/* Reply-discipline hint appending (bus_request ergonomic)                    */
/*                                                                             */
/* When THIS bot sends `kind: 'text_message'` to a codex-container peer,       */
/* the peer's session model needs to know it should reply on the bus with a   */
/* `<BUS to='<us>' kind='result'><payload>...</payload></BUS>` block — that's  */
/* how codex-container's `bus.py` recognizes bus-bound replies. Silent         */
/* omission = peer replies to their own Discord channel and the request       */
/* silently times out. Caller can opt out with `payloadWrapHint: false`.       */
/*                                                                             */
/* Motivation: memory [[feedback_bus_reply_needs_bus_tag]]. Plugin-side       */
/* ergonomic — kept out of the package because it's a Claude Code session      */
/* adapter concern, not a wire concern.                                        */
/* -------------------------------------------------------------------------- */

export function buildReplyDisciplineHint(senderBot: string): string {
  return (
    `\n\n[bus reply-discipline] Reply on the bus: wrap your reply in ` +
    `<BUS to='${senderBot}' kind='result'><payload>{...}</payload></BUS>. ` +
    `Do not reply via Discord — the sender is waiting on the bus subject.`
  )
}

export function appendReplyDisciplineHint(payload: unknown, senderBot: string): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload
  const record = payload as Record<string, unknown>
  if (typeof record.text !== 'string') return payload
  // Clone — never mutate caller-owned objects. Bare spread is enough because
  // we only touch a top-level string field.
  return { ...record, text: record.text + buildReplyDisciplineHint(senderBot) }
}

/* -------------------------------------------------------------------------- */
/* Audit-log tail (bus_history)                                                */
/* -------------------------------------------------------------------------- */

export interface AuditEntry {
  ts?: string
  dir?: string
  subject?: string
  reason?: string
  envelope_id?: string
  req_id?: string
  note?: string
  [k: string]: unknown
}

/**
 * Read the trailing N JSONL entries from the audit log. Bounded by
 * `maxScanBytes` so a hostile writer can't pin the plugin reading a gigabyte
 * of log every tool call — default 1MB is enough for ~5000 typical entries.
 *
 * Ordering: returns oldest→newest across the tail. Malformed lines are
 * skipped silently (the audit log is best-effort — one bad write shouldn't
 * poison the whole read).
 */
export function readAuditTail(path: string, limit: number, maxScanBytes = 1_048_576): AuditEntry[] {
  let raw: string
  try {
    const buf = readFileSync(path)
    const startOffset = buf.length > maxScanBytes ? buf.length - maxScanBytes : 0
    // Skip the first (possibly partial) line if we started mid-file.
    raw = buf.subarray(startOffset).toString('utf8')
    if (startOffset > 0) {
      const firstNewline = raw.indexOf('\n')
      raw = firstNewline === -1 ? '' : raw.slice(firstNewline + 1)
    }
  } catch {
    return []
  }
  const lines = raw.split('\n').filter(line => line.length > 0)
  const tail = lines.slice(-limit)
  const out: AuditEntry[] = []
  for (const line of tail) {
    try {
      const parsed = JSON.parse(line) as AuditEntry
      out.push(parsed)
    } catch {
      // ignore malformed line
    }
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Session bus runtime — encapsulates the supervisor loop, config, state,     */
/* and counters. server.ts owns lifecycle; this owns everything else.         */
/* -------------------------------------------------------------------------- */

export type BusState = 'disabled' | 'connecting' | 'connected' | 'stopping' | 'error'

export interface BusRuntimeConfig {
  botName: string
  password: string
  url: string
  mode: FleetBusMode
  pluginVersion: string
  manifestPath: string
  auditLogPath: string
  subscribeBroadcast: boolean
  heartbeatIntervalMs?: number
  supervisorSleepMs?: number
  logger: (message: string) => void
  injectIntoSession: (frame: InjectionFrame, event: FleetBusSessionEvent) => Promise<void>
  /**
   * Test-only injection: mock the NATS `connect()` call so the supervisor
   * loop runs against a fake connection. Never set from production paths.
   */
  connectFn?: (options: ConnectionOptions) => Promise<NatsConnection>
}

export class BusRuntime {
  readonly config: BusRuntimeConfig
  readonly rateLimiters: CountingRateLimiters
  readonly bus: FleetBus
  private supervisorPromise?: Promise<void>
  state: BusState = 'connecting'
  injectionsDelivered = 0
  injectionsFailed = 0
  lastInjectionTs?: string
  lastError?: string
  private readonly allowlist: ReadonlySet<string>

  constructor(config: BusRuntimeConfig) {
    this.config = config
    this.allowlist = loadFleetManifestAllowlist(config.manifestPath)
    this.rateLimiters = wrapRateLimiters(defaultRateLimiters())

    const fleetConfig: FleetBusConfig = {
      botName: config.botName,
      user: config.botName,
      password: config.password,
      url: config.url,
      subscribeBroadcast: config.subscribeBroadcast,
      mode: config.mode,
      pluginVersion: config.pluginVersion,
      logger: config.logger,
      auditLogPath: config.auditLogPath,
      rateLimiters: this.rateLimiters,
      injectIntoSession: async event => {
        const frame = buildInjectionFrame(event)
        try {
          await config.injectIntoSession(frame, event)
          this.injectionsDelivered += 1
          this.lastInjectionTs = new Date().toISOString()
        } catch (error) {
          this.injectionsFailed += 1
          this.lastError = String(error)
          throw error
        }
      },
    }
    if (config.heartbeatIntervalMs !== undefined) fleetConfig.heartbeatIntervalMs = config.heartbeatIntervalMs
    if (config.supervisorSleepMs !== undefined) fleetConfig.supervisorSleepMs = config.supervisorSleepMs
    if (config.connectFn !== undefined) fleetConfig.connectFn = config.connectFn

    this.bus = new FleetBus(fleetConfig, this.allowlist)
  }

  /**
   * Kick off the supervisor loop. Never awaits — the loop runs in the
   * background and reconnects across NATS blips until stop() fires.
   */
  start(): void {
    this.supervisorPromise = this.bus.run().then(
      () => {
        this.state = 'stopping'
      },
      error => {
        this.state = 'error'
        this.lastError = String(error)
        this.config.logger(`supervisor exited with error: ${String(error)}`)
      },
    )
    // Nudge state to 'connected' after first successful heartbeat window —
    // no callback from package yet, so lean on the audit log's 'in' entries
    // OR check nc state on next tool call. For now, state flips to
    // 'connected' via markConnected() below, triggered by the plugin either
    // on its own connect callback OR on first injection. Cheap heuristic.
  }

  markConnected(): void {
    if (this.state === 'connecting') this.state = 'connected'
  }

  async stop(): Promise<void> {
    this.state = 'stopping'
    await this.bus.stop()
    if (this.supervisorPromise) await this.supervisorPromise.catch(() => {})
  }

  statusSnapshot(): Record<string, unknown> {
    return {
      state: this.state,
      bot_name: this.config.botName,
      mode: this.config.mode,
      url: this.config.url,
      manifest_size: this.allowlist.size,
      subscribe_broadcast: this.config.subscribeBroadcast,
      heartbeat_interval_ms: this.config.heartbeatIntervalMs ?? 30_000,
      supervisor_sleep_ms: this.config.supervisorSleepMs ?? 2_000,
      audit_log_path: this.config.auditLogPath,
      injections_delivered: this.injectionsDelivered,
      injections_failed: this.injectionsFailed,
      last_injection_ts: this.lastInjectionTs ?? null,
      last_error: this.lastError ?? null,
      rate_limits: {
        per_from: this.rateLimiters.perFrom.snapshot(),
        per_subject: this.rateLimiters.perSubject.snapshot(),
        per_session_inject: this.rateLimiters.perSessionInject.snapshot(),
      },
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Config parsing                                                              */
/* -------------------------------------------------------------------------- */

export function parseFleetBusMode(raw: string | undefined): FleetBusMode {
  if (raw === undefined || raw === '' || raw === 'primary') return 'primary'
  if (raw === 'publish-only') return 'publish-only'
  throw new Error(`FLEET_BUS_MODE: expected 'primary' or 'publish-only', got '${raw}'`)
}

export function parseOptionalPositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name}: expected a positive integer, got '${raw}'`)
  }
  return parsed
}

// Re-export the package pieces server.ts needs so the import surface stays
// concentrated in one place.
export { normalizeBotName, loadFleetManifestAllowlist }
