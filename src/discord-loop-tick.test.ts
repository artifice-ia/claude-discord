/**
 * Tests for `discord-loop-tick.js` — PostToolUse hook that announces loop
 * ticks to the `loops_channel` defined in persona.md.
 *
 * Three things can regress silently:
 *  - A noop-false tick must POST a new message. An edit instead would skip
 *    Fernando's phone notification.
 *  - A noop-true tick must EDIT a prior quiet message, but must NOT overwrite
 *    a message that reported a real event. P1's test is the critical one: it
 *    was the assertion missing from the initial suite.
 *  - A missing `loops_channel` must produce no network activity at all.
 *
 * Each silence assertion is paired with a clean-exit check and a positive
 * control, so the test cannot pass on a broken harness or a silent crash.
 *
 * The hook is CJS with `require.main === module` guarding the stdin handler,
 * so `ownerTime` can be required and tested as a pure function (P3).
 * The subprocess tests cover all process-level behaviour (P1, P2, P4).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = join(import.meta.dir, '..')
const HOOK = join(ROOT, 'hooks', 'discord-loop-tick.js')

const LOOPS_CHANNEL = '123456789012345678'
const SESSION_ID = 'test-session-abc'
const LOOP_PROMPT = '<<autonomous-loop-dynamic>>'

function loopId(sessionId: string, prompt: string): string {
  return createHash('sha256').update(`${sessionId}:${prompt}`).digest('hex').slice(0, 12)
}

// Preload: intercepts https.request (records method+path to stderr, drives
// response callback with a synthetic body), captures request body on req.end(),
// and intercepts fs.writeFileSync (records WRITE to stderr).
// Set _DISCORD_STATUS in env to control the synthetic response status code.
const PRELOAD_SOURCE = `
const https = require('https')
const fs = require('fs')
const { EventEmitter } = require('events')

https.request = function (options, callback) {
  const method = options.method || 'GET'
  const path = options.path || ''
  const statusCode = Number(process.env._DISCORD_STATUS || 200)
  console.error('HTTPS ' + method + ' ' + path)
  const res = new EventEmitter()
  Object.assign(res, { statusCode })
  const responseBody = statusCode >= 400 ? '{"code":50001}' : (method === 'POST' ? '{"id":"fixture-msg-id"}' : '{}')
  const bodyChunks = []
  return {
    on() { return this },
    write(data) { bodyChunks.push(String(data)); return this },
    end() {
      console.error('BODY ' + bodyChunks.join(''))
      if (callback) setImmediate(() => { callback(res); res.emit('data', responseBody); res.emit('end') })
    }
  }
}

const _writeFileSync = fs.writeFileSync
fs.writeFileSync = function (path, ...rest) {
  console.error('WRITE ' + String(path))
  return _writeFileSync.call(fs, path, ...rest)
}
`

let fixtures: string
let preload: string
let node: string

function resolveNode(): string {
  const probe = spawnSync('node', ['--version'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    throw new Error('these tests run the hook under Node, as hooks.json does, and `node` is not on PATH')
  }
  return 'node'
}

interface Run {
  requests: string[]
  bodies: string[]
  writes: string[]
  logs: string[]
  status: number | null
  signal: string | null
}

function runHook(payload: unknown, env: Record<string, string> = {}): Run {
  const result = spawnSync(node, ['--require', preload, HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      CLAUDE_CONFIG_DIR: fixtures,
      TMPDIR: fixtures,
      ...env,
    },
    timeout: 20000,
  })
  const lines = (result.stderr ?? '').split('\n').filter(Boolean)
  return {
    requests: lines.filter(l => l.startsWith('HTTPS ')).map(l => l.slice(6)),
    bodies: lines.filter(l => l.startsWith('BODY ')).map(l => l.slice(5)),
    writes: lines.filter(l => l.startsWith('WRITE ')).map(l => l.slice(6)),
    logs: lines.filter(l => l.startsWith('loop-tick:')),
    status: result.status,
    signal: result.signal ?? null,
  }
}

function expectCleanExit(run: Run): void {
  expect(run.signal).toBeNull()
  expect(run.status).toBe(0)
}

function schedulePayload(overrides: Record<string, unknown> = {}, sessionId = SESSION_ID) {
  return {
    session_id: sessionId,
    tool_name: 'ScheduleWakeup',
    tool_input: {
      delaySeconds: 1200,
      reason: 'watching CI run',
      prompt: LOOP_PROMPT,
      noop: false,
      ...overrides,
    },
  }
}

beforeAll(() => {
  node = resolveNode()
  fixtures = mkdtempSync(join(tmpdir(), 'loop-tick-'))
  mkdirSync(fixtures, { recursive: true })
  preload = join(fixtures, 'preload.cjs')
  writeFileSync(preload, PRELOAD_SOURCE)
  writeFileSync(
    join(fixtures, 'persona.md'),
    `---\nname: "test-bot"\ndiscord_channel: "999"\nloops_channel: "${LOOPS_CHANNEL}"\n---\n\nFixture persona.\n`,
  )
  writeFileSync(join(fixtures, 'discord-token'), 'fixture-token-not-a-credential\n')
})

afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true })
})

// ─── ownerTime (pure function, no subprocess) ─────────────────────────────

describe('ownerTime — DST boundary (pure function)', () => {
  const cjsRequire = createRequire(import.meta.url)
  const { ownerTime } = cjsRequire(HOOK) as { ownerTime: (d: Date) => string }

  test('CDT (October) and CST (November) render an hour apart at the same UTC time', () => {
    // America/Chicago uses CDT (UTC-5) through Oct 31, then CST (UTC-6) from Nov 1.
    // At 2026-10-15 04:00 UTC: CDT → 23:00. At 2026-11-15 04:00 UTC: CST → 22:00.
    // If the offset were hard-coded, both would render the same wrong time.
    const oct = new Date('2026-10-15T04:00:00Z')
    const nov = new Date('2026-11-15T04:00:00Z')
    expect(ownerTime(oct)).not.toEqual(ownerTime(nov))
  })

  test('formats as HH:MM in 24-hour time', () => {
    // 2026-10-15 04:00 UTC → CDT 23:00
    const d = new Date('2026-10-15T04:00:00Z')
    expect(ownerTime(d)).toMatch(/^\d{2}:\d{2}$/)
  })
})

// ─── ScheduleWakeup — subprocess tests ────────────────────────────────────

describe('discord-loop-tick — ScheduleWakeup', () => {
  test('noop-false tick posts a new message', () => {
    const run = runHook(schedulePayload({ noop: false }))
    expect(run.requests).toEqual([`POST /api/v10/channels/${LOOPS_CHANNEL}/messages`])
    expectCleanExit(run)
  })

  test('noop-false tick saves state', () => {
    const run = runHook(schedulePayload({ noop: false }))
    const id = loopId(SESSION_ID, LOOP_PROMPT)
    expect(run.writes.some(w => w.includes(`artifice-loop-tick-${id}`))).toBe(true)
    expectCleanExit(run)
  })

  // P1: the critical assertion that was missing from the initial suite.
  // A noop tick must NOT overwrite a message that reported a real event.
  test('noop-true tick after a real event POSTs a new message instead of overwriting', () => {
    const sess = 'p1-session'
    const id = loopId(sess, LOOP_PROMPT)
    try { rmSync(join(fixtures, `artifice-loop-tick-${id}.json`)) } catch {}

    const p = (noop: boolean) => schedulePayload({ noop, reason: 'p1 test' }, sess)

    const r1 = runHook(p(false))
    expect(r1.requests).toEqual([`POST /api/v10/channels/${LOOPS_CHANNEL}/messages`])
    expectCleanExit(r1)

    // After a real event, state.is_quiet === false.
    // The quiet tick must not PATCH that message — it must POST a new one.
    const r2 = runHook(p(true))
    expect(r2.requests).toEqual([`POST /api/v10/channels/${LOOPS_CHANNEL}/messages`])
    expectCleanExit(r2)
  })

  // P2: first quiet tick after a real event must show 'quiet x1', not 'quiet x2'.
  test('first quiet after a real event shows quiet x1, not quiet x2', () => {
    const sess = 'p2-session'
    const id = loopId(sess, LOOP_PROMPT)
    try { rmSync(join(fixtures, `artifice-loop-tick-${id}.json`)) } catch {}

    runHook(schedulePayload({ noop: false }, sess))
    const r = runHook(schedulePayload({ noop: true }, sess))

    const body = r.bodies[0] ? JSON.parse(r.bodies[0]) as { content?: string } : null
    expect(body?.content).toContain('quiet x1')
    expect(body?.content).not.toContain('quiet x2')
    expectCleanExit(r)
  })

  test('noop-true tick edits the previous quiet message and does not post', () => {
    const sess = 'edit-session'
    const id = loopId(sess, LOOP_PROMPT)
    // Pre-write a state that represents a prior quiet tick
    writeFileSync(
      join(fixtures, `artifice-loop-tick-${id}.json`),
      JSON.stringify({ msg_id: 'prior-quiet-msg', channel: LOOPS_CHANNEL, streak: 1, is_quiet: true }),
    )

    const run = runHook(schedulePayload({ noop: true }, sess))
    expect(run.requests).toEqual([`PATCH /api/v10/channels/${LOOPS_CHANNEL}/messages/prior-quiet-msg`])
    expectCleanExit(run)
  })

  test('three consecutive quiet ticks produce one message and a streak of 3', () => {
    const sess = 'streak-session'
    const id = loopId(sess, LOOP_PROMPT)
    try { rmSync(join(fixtures, `artifice-loop-tick-${id}.json`)) } catch {}

    const p = (noop: boolean) => schedulePayload({ noop, delaySeconds: 600, reason: 'quiet hold' }, sess)

    const r1 = runHook(p(true))  // no prior state → POST
    const r2 = runHook(p(true))  // prior is_quiet=true → PATCH
    const r3 = runHook(p(true))  // prior is_quiet=true → PATCH

    expect(r1.requests).toEqual([`POST /api/v10/channels/${LOOPS_CHANNEL}/messages`])
    expect(r2.requests).toEqual([`PATCH /api/v10/channels/${LOOPS_CHANNEL}/messages/fixture-msg-id`])
    expect(r3.requests).toEqual([`PATCH /api/v10/channels/${LOOPS_CHANNEL}/messages/fixture-msg-id`])

    const body3 = r3.bodies[0] ? JSON.parse(r3.bodies[0]) as { content?: string } : null
    expect(body3?.content).toContain('quiet x3')

    expectCleanExit(r1)
    expectCleanExit(r2)
    expectCleanExit(r3)
  })

  test('stop=true produces no request', () => {
    const run = runHook({ tool_name: 'ScheduleWakeup', tool_input: { stop: true } })
    expect(run.requests).toEqual([])
    expectCleanExit(run)
  })

  test('missing loops_channel produces no request', () => {
    // CLAUDE_CONFIG_DIR points to a non-existent dir — persona.md read fails → silent exit
    const run = runHook(schedulePayload({ noop: false }), { CLAUDE_CONFIG_DIR: fixtures + '-absent' })
    expect(run.requests).toEqual([])
    expectCleanExit(run)
  })

  // P4: a non-2xx Discord response must be logged to stderr.
  test('non-2xx Discord response logs the status code', () => {
    const run = runHook(schedulePayload({ noop: false }), { _DISCORD_STATUS: '403' })
    expect(run.logs.some(l => l.includes('403'))).toBe(true)
    expectCleanExit(run)
  })
})

// ─── Non-scheduling tools ─────────────────────────────────────────────────

describe('discord-loop-tick — non-scheduling tools', () => {
  test('Bash call produces no request', () => {
    const run = runHook({ tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(run.requests).toEqual([])
    expectCleanExit(run)
  })

  test('Read call produces no request', () => {
    const run = runHook({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } })
    expect(run.requests).toEqual([])
    expectCleanExit(run)
  })
})

// ─── CronCreate ───────────────────────────────────────────────────────────

describe('discord-loop-tick — CronCreate', () => {
  test('CronCreate posts a single announcement', () => {
    const run = runHook({
      tool_name: 'CronCreate',
      tool_input: {
        schedule: '0 8 * * *',
        prompt: 'Morning briefing\nSecond line ignored',
      },
    })
    expect(run.requests).toEqual([`POST /api/v10/channels/${LOOPS_CHANNEL}/messages`])
    expectCleanExit(run)
  })
})
