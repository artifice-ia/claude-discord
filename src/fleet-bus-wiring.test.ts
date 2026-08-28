/**
 * Plugin-side tests for Stage 4 wiring.
 *
 * These cover ONLY the Claude-Code-session adapter concerns: injection frame
 * construction (including baton lineage), the text_message reply-discipline
 * hint, audit-log tail reading, rate-limit counting, and mode/config parsing.
 *
 * The wire (transport, ledgers, baton derivation, rate limits, envelope
 * validation) is the fleet-bus package's job and is covered by that
 * package's own test suite. Do not re-test package internals here — those
 * assertions would silently pass without proving anything about the plugin.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendReplyHint,
  buildClaudeCodeReplyHint,
  buildInjectionFrame,
  buildProtocolNeutralReplyHint,
  buildReplyDisciplineHint,
  buildReplyHint,
  classifyRecipientRuntime,
  CountingBucket,
  DEFAULT_CLAUDE_BOTS,
  DEFAULT_CODEX_BOTS,
  parseFleetBusMode,
  parseFleetBusStartupConfig,
  parseFleetPeerRuntimes,
  parseOptionalPositiveInt,
  parsePeerRuntimeSet,
  readAuditTail,
  wrapRateLimiters,
} from './fleet-bus-wiring'
import type { Envelope, FleetBusSessionEvent, TokenBucket } from '@artifice-ia/fleet-bus'

function baseEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    envelope_version: 1,
    id: 'env-abc',
    from: 'ohm',
    to: 'luna',
    kind: 'pr_review_request',
    ts: '2026-08-27T00:00:00.000Z',
    payload: { pr: 42 },
    ...overrides,
  } as Envelope
}

function sessionEvent(overrides: Partial<FleetBusSessionEvent> = {}, envOverrides: Partial<Envelope> = {}): FleetBusSessionEvent {
  return {
    envelope: baseEnvelope(envOverrides),
    reqId: 'req-1234',
    ...overrides,
  }
}

describe('buildInjectionFrame', () => {
  test('includes the core frame meta and payload body', () => {
    const frame = buildInjectionFrame(sessionEvent())
    expect(frame.meta.source).toBe('fleet-bus')
    expect(frame.meta.authenticated).toBe('false')
    expect(frame.meta.from_claim).toBe('ohm')
    expect(frame.meta.kind).toBe('pr_review_request')
    expect(frame.meta.req_id).toBe('req-1234')
    expect(frame.meta.env_id).toBe('env-abc')
    expect(frame.content).toBe('<payload>{&quot;pr&quot;:42}</payload>')
  })

  test('exposes baton lineage as attribute keys when present on the wire', () => {
    const frame = buildInjectionFrame(
      sessionEvent(
        {},
        {
          root_id: 'root-xyz',
          origin: 'chis',
          owner: 'ohm',
          hops: 3,
        },
      ),
    )
    expect(frame.meta.root_id).toBe('root-xyz')
    expect(frame.meta.origin).toBe('chis')
    expect(frame.meta.owner).toBe('ohm')
    expect(frame.meta.hops).toBe('3')
  })

  test('omits baton attributes that were absent from the envelope', () => {
    const frame = buildInjectionFrame(sessionEvent())
    expect('root_id' in frame.meta).toBe(false)
    expect('origin' in frame.meta).toBe(false)
    expect('owner' in frame.meta).toBe(false)
    expect('hops' in frame.meta).toBe(false)
  })

  test('tags unsolicited replies so the model can distinguish them', () => {
    const frame = buildInjectionFrame(sessionEvent({ unsolicited: true }))
    expect(frame.meta.unsolicited).toBe('true')
  })

  test('surfaces late_reply_env_id when set by the package', () => {
    const frame = buildInjectionFrame(sessionEvent({ lateReplyEnvId: 'env-old' }))
    expect(frame.meta.late_reply_env_id).toBe('env-old')
  })

  test('xml-escapes payload body characters that could break out of the tag', () => {
    const frame = buildInjectionFrame(
      sessionEvent({}, { payload: { html: '<script>alert("x")</script>' } }),
    )
    // No raw < or > survives in the body — the frame stays well-formed.
    expect(frame.content).not.toContain('<script>')
    expect(frame.content).toContain('&lt;script&gt;')
  })
})

describe('reply-discipline hint builders (per-runtime variants)', () => {
  test('codex-container hint asks for <BUS>-wrapped prose', () => {
    const hint = buildReplyDisciplineHint('luna')
    expect(hint).toContain("<BUS to='luna' kind='result'>")
    expect(hint).toContain('Do not reply via Discord')
  })

  test('Claude Code hint points at the bus_reply MCP tool, not <BUS>', () => {
    const hint = buildClaudeCodeReplyHint('luna')
    expect(hint).toContain('bus_reply(req_id=')
    expect(hint).toContain('MCP tool call is the reply')
    expect(hint).not.toContain("<BUS to='luna'")
    // Names the sender so the model knows who is waiting.
    expect(hint).toContain('Sender luna')
  })

  test('protocol-neutral hint flags that the plugin cannot enforce extraction', () => {
    const hint = buildProtocolNeutralReplyHint('luna')
    expect(hint).toContain('in_reply_to')
    expect(hint).toContain('cannot enforce reply extraction')
    // Neither of the two hard-wired protocols is prescribed.
    expect(hint).not.toContain("<BUS to='luna'")
    expect(hint).not.toContain('bus_reply(req_id=')
  })
})

describe('classifyRecipientRuntime', () => {
  const codex = new Set(['ohm', 'vec'])
  const claude = new Set(['deet', 'luna'])

  test('recognizes codex-container peers', () => {
    expect(classifyRecipientRuntime('ohm', codex, claude)).toBe('codex-container')
    expect(classifyRecipientRuntime('vec', codex, claude)).toBe('codex-container')
  })

  test('recognizes Claude Code peers', () => {
    expect(classifyRecipientRuntime('deet', codex, claude)).toBe('claude-code')
    expect(classifyRecipientRuntime('luna', codex, claude)).toBe('claude-code')
  })

  test('returns unknown for bots absent from both lists', () => {
    // Mutation witness — proves the default `unknown` branch fires. Prior
    // (broken) behavior would have shipped everyone the <BUS> hint regardless.
    expect(classifyRecipientRuntime('some-new-bot', codex, claude)).toBe('unknown')
  })

  test('returns unknown for names that fail normalizeBotName', () => {
    // Reserved names, non-ASCII, empty, or otherwise invalid identities can't
    // safely be classified — treat as unknown so the neutral hint fires.
    expect(classifyRecipientRuntime('broadcast', codex, claude)).toBe('unknown')
    expect(classifyRecipientRuntime('', codex, claude)).toBe('unknown')
    expect(classifyRecipientRuntime('bad.name', codex, claude)).toBe('unknown')
  })

  test('codex wins ties when a bot appears in both lists', () => {
    // Ambiguous membership: codex takes precedence because <BUS> is what
    // codex-container's extractor actually recognizes; a bus_reply MCP-tool
    // hint would be a no-op for a codex peer.
    const both = new Set(['dual'])
    expect(classifyRecipientRuntime('dual', both, both)).toBe('codex-container')
  })

  test('normalizes case before lookup (canonical form is lowercase)', () => {
    expect(classifyRecipientRuntime('OHM', codex, claude)).toBe('codex-container')
    expect(classifyRecipientRuntime('Luna', codex, claude)).toBe('claude-code')
  })
})

describe('buildReplyHint (adapter-aware dispatcher)', () => {
  const codex = new Set(DEFAULT_CODEX_BOTS)
  const claude = new Set(DEFAULT_CLAUDE_BOTS)

  test('text_message to ohm gets the <BUS> hint', () => {
    const { hint, runtime } = buildReplyHint({
      recipientBot: 'ohm',
      senderBot: 'luna',
      codexBots: codex,
      claudeBots: claude,
    })
    expect(runtime).toBe('codex-container')
    expect(hint).toContain("<BUS to='luna' kind='result'>")
  })

  test('text_message to deet gets the bus_reply hint', () => {
    const { hint, runtime } = buildReplyHint({
      recipientBot: 'deet',
      senderBot: 'luna',
      codexBots: codex,
      claudeBots: claude,
    })
    expect(runtime).toBe('claude-code')
    expect(hint).toContain('bus_reply(req_id=')
    expect(hint).not.toContain("<BUS to='luna'")
  })

  test('text_message to an unknown bot gets the protocol-neutral hint', () => {
    const { hint, runtime } = buildReplyHint({
      recipientBot: 'some-stranger',
      senderBot: 'luna',
      codexBots: codex,
      claudeBots: claude,
    })
    // Mutation witness — proves the default branch actually fires. Losing
    // this branch (e.g. defaulting to <BUS>) would silently route unknown
    // recipients through codex-container extraction they can't perform.
    expect(runtime).toBe('unknown')
    expect(hint).toContain('cannot enforce reply extraction')
    expect(hint).not.toContain("<BUS to='luna'")
    expect(hint).not.toContain('bus_reply(req_id=')
  })
})

describe('appendReplyHint (payload text append)', () => {
  test('appends the hint to a text_message payload without mutating the caller', () => {
    const original = { text: 'please review the PR' }
    const result = appendReplyHint(original, ' [HINT]') as { text: string }
    expect(result.text).toBe('please review the PR [HINT]')
    // Caller's object is intact — mutation would silently break agents that
    // reuse payload templates across multiple sends.
    expect(original.text).toBe('please review the PR')
  })

  test('passes non-object payloads through unchanged', () => {
    expect(appendReplyHint('a raw string', ' [HINT]')).toBe('a raw string')
    expect(appendReplyHint(42, ' [HINT]')).toBe(42)
    expect(appendReplyHint(null, ' [HINT]')).toBe(null)
    expect(appendReplyHint(['not', 'an', 'object'], ' [HINT]')).toEqual(['not', 'an', 'object'])
  })

  test('passes objects without a text field through unchanged', () => {
    const payload = { pr: 42, verdict: 'lgtm' }
    expect(appendReplyHint(payload, ' [HINT]')).toBe(payload)
  })
})

describe('parsePeerRuntimeSet', () => {
  test('undefined or empty raw falls back to defaults', () => {
    const set = parsePeerRuntimeSet(undefined, ['ohm', 'vec'])
    expect([...set].sort()).toEqual(['ohm', 'vec'])
    const set2 = parsePeerRuntimeSet('', ['ohm'])
    expect([...set2]).toEqual(['ohm'])
    const set3 = parsePeerRuntimeSet('   ', ['ohm'])
    expect([...set3]).toEqual(['ohm'])
  })

  test('comma-separated env value replaces defaults entirely', () => {
    // Override wins — operator opts out of the default list on purpose.
    const set = parsePeerRuntimeSet('foo,bar', ['ohm', 'vec'])
    expect([...set].sort()).toEqual(['bar', 'foo'])
    expect(set.has('ohm')).toBe(false)
  })

  test('trims whitespace and drops entries that fail normalizeBotName', () => {
    const set = parsePeerRuntimeSet(' ohm , BAD.NAME , VEC ', ['unused'])
    expect(set.has('ohm')).toBe(true)
    expect(set.has('vec')).toBe(true) // case-normalized
    expect(set.has('BAD.NAME')).toBe(false)
    expect(set.size).toBe(2)
  })
})

describe('parseFleetPeerRuntimes (env → codex/claude sets)', () => {
  test('empty env returns the shipped defaults', () => {
    const { codexBots, claudeBots } = parseFleetPeerRuntimes({})
    expect([...codexBots].sort()).toEqual([...DEFAULT_CODEX_BOTS].map(s => s).sort())
    expect([...claudeBots].sort()).toEqual([...DEFAULT_CLAUDE_BOTS].map(s => s).sort())
    // Sanity: the shipped defaults match the manifest snapshot in the fable
    // arch review. If a new codex bot lands and this test regresses, update
    // DEFAULT_CODEX_BOTS AND vault/infra/fleet-manifest.yaml together.
    expect(codexBots.has('ohm')).toBe(true)
    expect(codexBots.has('vec')).toBe(true)
    expect(claudeBots.has('deet')).toBe(true)
    expect(claudeBots.has('luna')).toBe(true)
  })

  test('FLEET_CODEX_BOTS env override routes a custom bot as codex', () => {
    // Operator adds `custom-bot` as a codex-container peer without a plugin
    // rebuild — buildReplyHint must then dispatch it to the <BUS> hint.
    const { codexBots, claudeBots } = parseFleetPeerRuntimes({ FLEET_CODEX_BOTS: 'custom-bot' })
    expect(codexBots.has('custom-bot')).toBe(true)
    // Explicit override drops the defaults — the previous codex list is gone.
    expect(codexBots.has('ohm')).toBe(false)
    const { hint, runtime } = buildReplyHint({
      recipientBot: 'custom-bot',
      senderBot: 'luna',
      codexBots,
      claudeBots,
    })
    expect(runtime).toBe('codex-container')
    expect(hint).toContain("<BUS to='luna' kind='result'>")
  })

  test('FLEET_CLAUDE_BOTS env override routes a custom bot as claude-code', () => {
    const { codexBots, claudeBots } = parseFleetPeerRuntimes({ FLEET_CLAUDE_BOTS: 'new-familiar' })
    expect(claudeBots.has('new-familiar')).toBe(true)
    expect(claudeBots.has('luna')).toBe(false)
    const { runtime } = buildReplyHint({
      recipientBot: 'new-familiar',
      senderBot: 'ohm',
      codexBots,
      claudeBots,
    })
    expect(runtime).toBe('claude-code')
  })
})

describe('bus_request MCP tool schema (server.ts source-text checks)', () => {
  // Source-text tests — server.ts is a script, not a module, so the schema
  // isn't independently importable. Grepping the source is the lightest
  // regression guard: any accidental reintroduction of `in_reply_to_env_id`
  // as a schema property or handler branch fails this test loudly.
  const serverSource = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf8')

  test('does not advertise in_reply_to_env_id as an MCP schema property', () => {
    // Ohm PR #23 round-2 P1 (Option B): removed to close the false-success
    // contract violation. Reply→request lineage flows through bus_reply
    // instead. If Option A ever lands (package receive-ledger accessor),
    // reintroduce the property AND its handler wiring together.
    expect(serverSource).not.toContain('in_reply_to_env_id')
    expect(serverSource).not.toContain('inReplyToEnvId')
  })

  test('bus_request handler routes text_message via buildReplyHint (adapter-aware)', () => {
    // Guards against a silent regression to the old codex-only path where
    // every text_message got the <BUS> hint regardless of recipient runtime.
    expect(serverSource).toContain('buildReplyHint({')
    expect(serverSource).toContain('appendReplyHint(payload, hint)')
    // The old symbol must not creep back — it took a senderBot arg only and
    // hardcoded the <BUS> path.
    expect(serverSource).not.toContain('appendReplyDisciplineHint(')
  })
})

describe('CountingBucket', () => {
  class StubBucket implements TokenBucket {
    constructor(private readonly answers: boolean[]) {}
    allow(_key: string): boolean {
      return this.answers.shift() ?? false
    }
  }

  test('records allow/deny counts and per-key denials', () => {
    const bucket = new CountingBucket(new StubBucket([true, false, false, true, false]))
    bucket.allow('ohm')
    bucket.allow('ohm')
    bucket.allow('vec')
    bucket.allow('vec')
    bucket.allow('vec')
    const snap = bucket.snapshot()
    expect(snap.allowed).toBe(2)
    expect(snap.denied).toBe(3)
    // Top-denials sorted by count desc — vec (2) before ohm (1).
    expect(snap.top_denials[0]).toEqual({ key: 'vec', count: 2 })
    expect(snap.top_denials[1]).toEqual({ key: 'ohm', count: 1 })
  })

  test('wrapRateLimiters wraps every field with CountingBucket', () => {
    const inner = {
      perFrom: new StubBucket([true]),
      perSubject: new StubBucket([true]),
      perSessionInject: new StubBucket([true]),
    }
    const wrapped = wrapRateLimiters(inner)
    wrapped.perFrom.allow('luna')
    wrapped.perSubject.allow('fleet.luna.request')
    wrapped.perSessionInject.allow('session')
    expect(wrapped.perFrom.snapshot().allowed).toBe(1)
    expect(wrapped.perSubject.snapshot().allowed).toBe(1)
    expect(wrapped.perSessionInject.snapshot().allowed).toBe(1)
  })
})

describe('audit-log tail', () => {
  test('returns oldest-to-newest, skips malformed lines, respects limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-bus-audit-'))
    const path = join(dir, 'log.jsonl')
    const good = (i: number) => JSON.stringify({ ts: `2026-08-27T00:00:0${i}Z`, dir: 'in', envelope_id: `env-${i}` })
    writeFileSync(
      path,
      [good(0), good(1), 'not json', good(2), good(3), good(4), good(5)].join('\n') + '\n',
    )
    const tail = readAuditTail(path, 3)
    expect(tail.length).toBe(3)
    expect(tail[0]?.envelope_id).toBe('env-3')
    expect(tail[1]?.envelope_id).toBe('env-4')
    expect(tail[2]?.envelope_id).toBe('env-5')
  })

  test('returns an empty array when the log file is missing', () => {
    expect(readAuditTail('/nonexistent/path/definitely-not-here.jsonl', 10)).toEqual([])
  })

  test('drops the first partial line when scan window starts mid-file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-bus-audit-'))
    const path = join(dir, 'log.jsonl')
    // A single "envelope_id: 0" line pads the head; the scan starts INSIDE it
    // (maxScanBytes tiny) so it must be dropped or JSON.parse rejects a
    // truncated string and the reader silently loses the whole tail.
    const pad = JSON.stringify({ ts: '2026-08-27T00:00:00Z', dir: 'in', envelope_id: '0'.repeat(200) })
    const later = JSON.stringify({ ts: '2026-08-27T00:00:01Z', dir: 'in', envelope_id: 'later' })
    writeFileSync(path, `${pad}\n${later}\n`)
    const tail = readAuditTail(path, 10, 100)
    expect(tail.length).toBe(1)
    expect(tail[0]?.envelope_id).toBe('later')
  })
})

describe('config parsing', () => {
  test('parseFleetBusMode defaults to primary and accepts publish-only', () => {
    expect(parseFleetBusMode(undefined)).toBe('primary')
    expect(parseFleetBusMode('')).toBe('primary')
    expect(parseFleetBusMode('primary')).toBe('primary')
    expect(parseFleetBusMode('publish-only')).toBe('publish-only')
  })

  test('parseFleetBusMode rejects unknown modes', () => {
    expect(() => parseFleetBusMode('subscribe-only')).toThrow('FLEET_BUS_MODE')
    expect(() => parseFleetBusMode('primary+publish')).toThrow('FLEET_BUS_MODE')
  })

  test('parseOptionalPositiveInt returns undefined for unset values', () => {
    expect(parseOptionalPositiveInt(undefined, 'X')).toBeUndefined()
    expect(parseOptionalPositiveInt('', 'X')).toBeUndefined()
  })

  test('parseOptionalPositiveInt rejects non-positive or non-numeric strings', () => {
    expect(parseOptionalPositiveInt('30000', 'FLEET_BUS_HEARTBEAT_INTERVAL_MS')).toBe(30000)
    expect(() => parseOptionalPositiveInt('0', 'X')).toThrow('X')
    expect(() => parseOptionalPositiveInt('-5', 'X')).toThrow('X')
    expect(() => parseOptionalPositiveInt('nan', 'X')).toThrow('X')
  })

  test('parseOptionalPositiveInt rejects partially-parseable strings (Number.parseInt trap)', () => {
    // These are the specific inputs Number.parseInt would silently accept —
    // e.g. `parseInt('30sec', 10)` returns 30, hiding the operator typo.
    // Strict regex must catch them all before parseInt sees them.
    expect(() => parseOptionalPositiveInt('30sec', 'FLEET_BUS_HEARTBEAT_INTERVAL_MS'))
      .toThrow('FLEET_BUS_HEARTBEAT_INTERVAL_MS')
    expect(() => parseOptionalPositiveInt('30 ', 'X')).toThrow('X')
    expect(() => parseOptionalPositiveInt(' 30', 'X')).toThrow('X')
    expect(() => parseOptionalPositiveInt('3.14', 'X')).toThrow('X')
    expect(() => parseOptionalPositiveInt('30ms', 'X')).toThrow('X')
    expect(() => parseOptionalPositiveInt('0x1e', 'X')).toThrow('X')
    expect(() => parseOptionalPositiveInt('1e3', 'X')).toThrow('X')
  })

  test('parseOptionalPositiveInt error message names the variable and quotes the raw input', () => {
    // Operators debugging a systemd unit want to see BOTH the env var name
    // and what they actually set — a bare "parse error" would send them
    // grepping through code.
    let caught: Error | null = null
    try {
      parseOptionalPositiveInt('30sec', 'FLEET_BUS_HEARTBEAT_INTERVAL_MS')
    } catch (err) {
      caught = err as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain('FLEET_BUS_HEARTBEAT_INTERVAL_MS')
    expect(caught!.message).toContain("'30sec'")
  })
})

describe('parseFleetBusStartupConfig', () => {
  test('returns defaults when no fleet-bus knobs are set', () => {
    const cfg = parseFleetBusStartupConfig({})
    expect(cfg.mode).toBe('primary')
    expect(cfg.heartbeatIntervalMs).toBeUndefined()
    expect(cfg.supervisorSleepMs).toBeUndefined()
  })

  test('passes valid overrides through', () => {
    const cfg = parseFleetBusStartupConfig({
      FLEET_BUS_MODE: 'publish-only',
      FLEET_BUS_HEARTBEAT_INTERVAL_MS: '15000',
      FLEET_BUS_SUPERVISOR_SLEEP_MS: '500',
    })
    expect(cfg.mode).toBe('publish-only')
    expect(cfg.heartbeatIntervalMs).toBe(15000)
    expect(cfg.supervisorSleepMs).toBe(500)
  })

  test('throws (server.ts hard-exits) when FLEET_BUS_MODE is garbage', () => {
    // Mutation witness for P1: prior behavior silently reset mode to
    // 'primary' and let the bus come up on a config the operator didn't ask
    // for. server.ts now converts this throw into process.exit(1).
    expect(() => parseFleetBusStartupConfig({ FLEET_BUS_MODE: 'derp' })).toThrow('FLEET_BUS_MODE')
  })

  test('throws when FLEET_BUS_HEARTBEAT_INTERVAL_MS is partially parseable', () => {
    // The Codex P2 case — '30sec' silently became 30ms under Number.parseInt,
    // then propagated as a truthy override into the fleet-bus config. Must throw.
    expect(() => parseFleetBusStartupConfig({ FLEET_BUS_HEARTBEAT_INTERVAL_MS: '30sec' }))
      .toThrow('FLEET_BUS_HEARTBEAT_INTERVAL_MS')
  })

  test('throws when FLEET_BUS_SUPERVISOR_SLEEP_MS is partially parseable', () => {
    // Class-widening: the same trap on the supervisor-sleep knob.
    expect(() => parseFleetBusStartupConfig({ FLEET_BUS_SUPERVISOR_SLEEP_MS: '2000ms' }))
      .toThrow('FLEET_BUS_SUPERVISOR_SLEEP_MS')
  })

  test('empty-string overrides still count as unset (no throw)', () => {
    // Distinct from `'0'` or `'30sec'` — empty means the operator explicitly
    // cleared the var (e.g. a systemd override clearing an inherited value).
    // Treating it as an error would break the "unset via empty" contract.
    const cfg = parseFleetBusStartupConfig({
      FLEET_BUS_MODE: '',
      FLEET_BUS_HEARTBEAT_INTERVAL_MS: '',
      FLEET_BUS_SUPERVISOR_SLEEP_MS: '',
    })
    expect(cfg.mode).toBe('primary')
    expect(cfg.heartbeatIntervalMs).toBeUndefined()
    expect(cfg.supervisorSleepMs).toBeUndefined()
  })
})
