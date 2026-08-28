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
import { connect as natsConnect, type ConnectionOptions, type NatsConnection } from 'nats'

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
/* Reply-discipline hint appending (bus_request text_message ergonomic)       */
/*                                                                             */
/* When THIS bot sends `kind: 'text_message'`, the peer's session model needs  */
/* to know which reply channel it should use back to us. The routing splits    */
/* by peer runtime:                                                            */
/*                                                                             */
/*  - codex-container peers (chis/helm/myc/ohm/vec by default) extract         */
/*    `<BUS to='<us>' kind='result'>` prose via codex-container's `bus.py`.   */
/*  - Claude Code peers (deet/kat/koi/luna/optimus by default) publish via     */
/*    the `bus_reply` MCP tool exposed by this same plugin.                    */
/*  - Unknown recipient runtimes get a protocol-neutral instruction — no wire  */
/*    discipline the plugin can guarantee.                                     */
/*                                                                             */
/* Silent omission (or a codex hint sent to a Claude peer) = the peer replies  */
/* down the wrong channel and the sender's `wait: true` request times out.     */
/* Caller can opt out with `payloadWrapHint: false`.                           */
/*                                                                             */
/* Motivation: memory [[feedback_bus_reply_needs_bus_tag]] plus PR #23 Ohm     */
/* round-2 P1 (adapter-aware routing). Plugin-side ergonomic — kept out of    */
/* the package because runtime-classification is a Claude Code session         */
/* adapter concern, not a wire concern.                                        */
/* -------------------------------------------------------------------------- */

export const DEFAULT_CODEX_BOTS: readonly string[] = ['chis', 'helm', 'myc', 'ohm', 'vec']
export const DEFAULT_CLAUDE_BOTS: readonly string[] = ['deet', 'kat', 'koi', 'luna', 'optimus']

export type RecipientRuntime = 'codex-container' | 'claude-code' | 'unknown'

/**
 * Parse a comma-separated env value into a canonical bot-name set, falling
 * back to `defaults` when the raw value is undefined or empty. Entries run
 * through `normalizeBotName` so operators can't smuggle an invalid identity
 * in via env; anything that fails normalization is silently dropped.
 */
export function parsePeerRuntimeSet(raw: string | undefined, defaults: readonly string[]): ReadonlySet<string> {
  const source = raw === undefined || raw.trim() === '' ? defaults : raw.split(',')
  const out = new Set<string>()
  for (const entry of source) {
    const canonical = normalizeBotName(entry.trim())
    if (canonical !== null) out.add(canonical)
  }
  return out
}

export interface FleetPeerRuntimes {
  codexBots: ReadonlySet<string>
  claudeBots: ReadonlySet<string>
}

/**
 * Parse the plugin's peer-runtime classification env vars. Two overlapping
 * lists on purpose — a bot in BOTH lists is ambiguous; codex-container wins
 * (see `classifyRecipientRuntime`). Operators moving a bot from one runtime
 * to the other should drop it from the losing list.
 */
export function parseFleetPeerRuntimes(env: NodeJS.ProcessEnv): FleetPeerRuntimes {
  return {
    codexBots: parsePeerRuntimeSet(env.FLEET_CODEX_BOTS, DEFAULT_CODEX_BOTS),
    claudeBots: parsePeerRuntimeSet(env.FLEET_CLAUDE_BOTS, DEFAULT_CLAUDE_BOTS),
  }
}

/**
 * Classify a recipient by which bus-reply channel its session model uses.
 * Codex wins ties — if a bot is in both lists, the `<BUS>` hint reaches
 * codex-container's extractor and gets published; the `bus_reply` MCP tool
 * variant would be a no-op if the recipient's runtime is actually codex.
 */
export function classifyRecipientRuntime(
  recipientBot: string,
  codexBots: ReadonlySet<string>,
  claudeBots: ReadonlySet<string>,
): RecipientRuntime {
  const canonical = normalizeBotName(recipientBot)
  if (canonical === null) return 'unknown'
  if (codexBots.has(canonical)) return 'codex-container'
  if (claudeBots.has(canonical)) return 'claude-code'
  return 'unknown'
}

// codex-container peers extract `<BUS to='...' kind='result'>` from prose via
// codex-container's `bus.py`. Historical name kept — this is the ORIGINAL
// reply-discipline hint; per-runtime siblings below.
export function buildReplyDisciplineHint(senderBot: string): string {
  return (
    `\n\n[bus reply-discipline] Reply on the bus: wrap your reply in ` +
    `<BUS to='${senderBot}' kind='result'><payload>{...}</payload></BUS>. ` +
    `Do not reply via Discord — the sender is waiting on the bus subject.`
  )
}

// Claude Code peers reply via the `bus_reply` MCP tool (this same plugin,
// or a future sibling). The req_id comes from the recipient's inbound
// <channel source='fleet-bus' req_id='...'> frame; we can't know it from
// the sender side, so the model is instructed to read it off its own frame.
export function buildClaudeCodeReplyHint(senderBot: string): string {
  return (
    `\n\n[bus reply-discipline] Reply via the bus_reply MCP tool: ` +
    `bus_reply(req_id=<the req_id attribute on your inbound channel frame>, payload=...). ` +
    `Do not narrate — the MCP tool call is the reply. ` +
    `Sender ${senderBot} is waiting on the bus subject.`
  )
}

// Unknown recipient runtimes get a protocol-neutral instruction — no wire
// discipline the plugin can enforce, just an ask to publish `.result` on the
// bus with in_reply_to set. Explicitly flags that the plugin can't guarantee
// extraction so operators debugging a stuck request know where to look.
export function buildProtocolNeutralReplyHint(senderBot: string): string {
  return (
    `\n\n[bus reply-discipline] Reply on the fleet-bus with in_reply_to ` +
    `set to this envelope's id. Sender ${senderBot} is waiting on the bus ` +
    `subject. Note: this plugin cannot enforce reply extraction for this ` +
    `recipient runtime — the reply must reach the bus for the sender to hear it.`
  )
}

export interface BuiltReplyHint {
  hint: string
  runtime: RecipientRuntime
}

/**
 * Adapter-aware reply-discipline hint. Classifies the recipient's runtime
 * against the configured peer sets and returns the matching hint text plus
 * the resolved runtime (useful for observability + tests).
 *
 * See design doc:
 *   ~/vault/projects/fleet/bus/adapter-designs/CLAUDE-CODE-SESSION-ADAPTER-DESIGN.md
 */
export function buildReplyHint(args: {
  recipientBot: string
  senderBot: string
  codexBots: ReadonlySet<string>
  claudeBots: ReadonlySet<string>
}): BuiltReplyHint {
  const runtime = classifyRecipientRuntime(args.recipientBot, args.codexBots, args.claudeBots)
  switch (runtime) {
    case 'codex-container':
      return { hint: buildReplyDisciplineHint(args.senderBot), runtime }
    case 'claude-code':
      return { hint: buildClaudeCodeReplyHint(args.senderBot), runtime }
    case 'unknown':
      return { hint: buildProtocolNeutralReplyHint(args.senderBot), runtime }
  }
}

/**
 * Append a caller-provided hint string to a `text_message`-style payload's
 * `text` field. Non-object / non-text-string payloads pass through unchanged
 * — this hint is a text_message ergonomic, not a general payload rewrite.
 * Never mutates the caller object; agents that reuse payload templates
 * across sends stay untouched.
 */
export function appendReplyHint(payload: unknown, hint: string): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload
  const record = payload as Record<string, unknown>
  if (typeof record.text !== 'string') return payload
  return { ...record, text: record.text + hint }
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

/**
 * Runtime state for `bus_status.state`. Transitions:
 *   `starting`   — supervisor kicked off, but the first NATS connect has not
 *                  yet resolved. Health checks reading this should treat it
 *                  as "bus not yet usable."
 *   `connected`  — first `connectFn(...)` call resolved. Set inside a wrapped
 *                  `connectFn` on the FleetBusConfig so a health check never
 *                  sees `connected` before nats.js has handed back a live
 *                  connection. Ohm PR #23 round-3 blocker; see
 *                  [[feedback_mutation_test_the_controls]].
 *   `stopping`   — `stop()` fired, or the supervisor loop resolved cleanly.
 *   `error`      — `bus.run()` unrecoverably rejected. Rare (the supervisor
 *                  catches per-connect failures and retries), but the branch
 *                  exists so a genuinely broken supervisor doesn't sit in
 *                  `starting` forever.
 *   `disabled`   — reserved for future explicit off state; unused today.
 */
export type BusState = 'disabled' | 'starting' | 'connected' | 'stopping' | 'error'

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
   * Peer-runtime classification sets — used by the bus_request handler to
   * pick the correct reply-discipline hint for each recipient. Populate via
   * `parseFleetPeerRuntimes(process.env)` in server.ts; test callers can pass
   * arbitrary sets to exercise routing branches.
   */
  codexBots: ReadonlySet<string>
  claudeBots: ReadonlySet<string>
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
  state: BusState = 'starting'
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

    // Wrap the connectFn so `state` flips to 'connected' only after nats.js
    // has actually handed us a live NatsConnection. Previously the plugin
    // called `markConnected()` right after `start()` returned — but `start()`
    // just spawns the supervisor loop's promise; the underlying connect can
    // still be pending or repeatedly failing. Health checks reading
    // `bus_status.state` saw 'connected' during a full outage (Ohm PR #23
    // round-3 blocker; issue #24).
    //
    // Tests can still inject a fake connect via `config.connectFn` — we wrap
    // whichever one they provide, or default to `nats.connect`. The wrapper
    // never touches state on reconnect (stays 'connected'); explicit stop or
    // an unrecoverable `run()` rejection are what transition it out.
    const underlyingConnectFn = config.connectFn ?? natsConnect
    fleetConfig.connectFn = async (options: ConnectionOptions): Promise<NatsConnection> => {
      const nc = await underlyingConnectFn(options)
      if (this.state === 'starting') this.state = 'connected'
      return nc
    }

    this.bus = new FleetBus(fleetConfig, this.allowlist)
  }

  /**
   * Kick off the supervisor loop. Never awaits — the loop runs in the
   * background and reconnects across NATS blips until stop() fires.
   *
   * `state` transitions are handled by the wrapped `connectFn` (starting
   * → connected on first live nats.js connection) and by the promise chain
   * below (→ stopping on clean resolve, → error on unrecoverable reject).
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

/**
 * Node's setTimeout/setInterval silently coerce delays above INT32_MAX
 * (2,147,483,647 ms — ~24.85 days) to 1ms. Every current consumer of
 * `parseOptionalPositiveInt` feeds a `setInterval` (heartbeat, supervisor
 * sleep), so a fat-fingered `FLEET_BUS_HEARTBEAT_INTERVAL_MS=99999999999`
 * would heartbeat 1000×/sec — the opposite of the operator's intent. Cap
 * lives on the parser (class check per [[feedback_class_vs_instance]]) so
 * every future interval-shaped env inherits it. See Node docs on Timeout
 * (`Timeout.refresh()` / `setInterval(callback, delay)` clamping).
 */
const NODE_SETTIMEOUT_MAX_MS = 2_147_483_647

/**
 * Strict positive-integer env parse. Undefined/empty means "operator left it
 * unset — use the default." Anything else must be a complete integer literal
 * with no trailing units or whitespace, or we throw so startup can hard-fail
 * loudly rather than silently drop half the value (e.g. `Number.parseInt`
 * happily returns `30` for `'30sec'`). Applied to every numeric FLEET_BUS_*
 * env this module owns; see [[feedback_class_vs_instance]].
 *
 * Also enforces the Node setTimeout maximum (INT32_MAX ms). Above that,
 * setInterval silently rewinds to 1ms — so we reject at parse time rather
 * than ship a supervisor that heartbeats a thousand times a second.
 */
export function parseOptionalPositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined
  // Reject anything that isn't a bare integer literal — no leading/trailing
  // whitespace, no unit suffix, no decimal point. `parseInt` alone would
  // partially parse '30sec' → 30 and hide operator typos.
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name}: expected an integer, got '${raw}'`)
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name}: expected a positive integer, got '${raw}'`)
  }
  if (parsed > NODE_SETTIMEOUT_MAX_MS) {
    throw new Error(
      `${name}: interval exceeds ${NODE_SETTIMEOUT_MAX_MS} ms (Node setTimeout maximum) — got '${raw}'`,
    )
  }
  return parsed
}

export interface FleetBusStartupConfig {
  mode: FleetBusMode
  heartbeatIntervalMs: number | undefined
  supervisorSleepMs: number | undefined
}

/**
 * Parse the plugin-side fleet-bus startup config from an env source. Throws a
 * single aggregated Error on any invalid value so server.ts can hard-fail
 * (exit 1) rather than silently disable the bus when an operator has already
 * committed to enabling it via `FLEET_BUS_DISABLED=0`. Only the plugin's own
 * knobs live here — the package owns its own env parsing (rate limits, etc.).
 */
export function parseFleetBusStartupConfig(env: NodeJS.ProcessEnv): FleetBusStartupConfig {
  return {
    mode: parseFleetBusMode(env.FLEET_BUS_MODE),
    heartbeatIntervalMs: parseOptionalPositiveInt(
      env.FLEET_BUS_HEARTBEAT_INTERVAL_MS,
      'FLEET_BUS_HEARTBEAT_INTERVAL_MS',
    ),
    supervisorSleepMs: parseOptionalPositiveInt(
      env.FLEET_BUS_SUPERVISOR_SLEEP_MS,
      'FLEET_BUS_SUPERVISOR_SLEEP_MS',
    ),
  }
}

// Re-export the package pieces server.ts needs so the import surface stays
// concentrated in one place.
export { normalizeBotName, loadFleetManifestAllowlist }
