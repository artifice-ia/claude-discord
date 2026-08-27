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
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendReplyDisciplineHint,
  buildInjectionFrame,
  buildReplyDisciplineHint,
  CountingBucket,
  parseFleetBusMode,
  parseFleetBusStartupConfig,
  parseOptionalPositiveInt,
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

describe('reply-discipline hint (bus_request text_message)', () => {
  test('hint references the sender bot and requests a wrapped reply', () => {
    const hint = buildReplyDisciplineHint('luna')
    expect(hint).toContain("<BUS to='luna' kind='result'>")
    expect(hint).toContain('Do not reply via Discord')
  })

  test('appends to text_message payloads without mutating the caller object', () => {
    const original = { text: 'please review the PR' }
    const result = appendReplyDisciplineHint(original, 'luna') as { text: string }
    expect(result.text.startsWith('please review the PR')).toBe(true)
    expect(result.text.includes("<BUS to='luna'")).toBe(true)
    // Caller's object is intact — mutation would silently break agents that
    // reuse payload templates across multiple sends.
    expect(original.text).toBe('please review the PR')
  })

  test('passes non-object payloads through unchanged', () => {
    expect(appendReplyDisciplineHint('a raw string', 'luna')).toBe('a raw string')
    expect(appendReplyDisciplineHint(42, 'luna')).toBe(42)
    expect(appendReplyDisciplineHint(null, 'luna')).toBe(null)
  })

  test('passes objects without a text field through unchanged', () => {
    const payload = { pr: 42, verdict: 'lgtm' }
    expect(appendReplyDisciplineHint(payload, 'luna')).toBe(payload)
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
