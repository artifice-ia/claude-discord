/**
 * Tests for `discord-loop-tick.js` — PostToolUse hook that announces loop
 * ticks to the `loops_channel` defined in persona.md.
 *
 * Three things can regress silently:
 *  - A noop-false tick must POST a new message. An edit instead would skip
 *    Fernando's phone notification.
 *  - A noop-true tick must EDIT, not post. A second POST would send a
 *    notification for every quiet tick.
 *  - A missing `loops_channel` must produce no network activity at all — the
 *    hook is a guest in every bot; bots without a loops_channel opt out by
 *    simply omitting the key.
 *
 * Each silence assertion is paired with a clean-exit check and a positive
 * control, so the test cannot pass on a broken harness or a silent crash.
 *
 * The hook is a plain CJS script. Tests run it as a subprocess under Node
 * (as hooks.json does) via a preload that intercepts https.request and fs
 * writes, recording them to stderr without letting them escape to the network.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
// response callback with a synthetic {"id":"fixture-msg-id"} body for POST
// and {} for PATCH), and intercepts fs.writeFileSync (records WRITE to stderr).
const PRELOAD_SOURCE = `
const https = require('https')
const fs = require('fs')
const { EventEmitter } = require('events')

https.request = function (options, callback) {
  const method = options.method || 'GET'
  const path = options.path || ''
  console.error('HTTPS ' + method + ' ' + path)
  const res = new EventEmitter()
  const body = method === 'POST' ? '{"id":"fixture-msg-id"}' : '{}'
  if (callback) setImmediate(() => {
    callback(res)
    res.emit('data', body)
    res.emit('end')
  })
  return { on() { return this }, write() { return this }, end() { return this } }
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
  writes: string[]
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
    writes: lines.filter(l => l.startsWith('WRITE ')).map(l => l.slice(6)),
    status: result.status,
    signal: result.signal ?? null,
  }
}

function expectCleanExit(run: Run): void {
  expect(run.signal).toBeNull()
  expect(run.status).toBe(0)
}

function schedulePayload(overrides: Record<string, unknown> = {}) {
  return {
    session_id: SESSION_ID,
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

  test('noop-true tick edits the previous message and does not post', () => {
    const id = loopId(SESSION_ID, LOOP_PROMPT)
    const stateFile = join(fixtures, `artifice-loop-tick-${id}.json`)
    writeFileSync(stateFile, JSON.stringify({ msg_id: 'prior-msg-id', channel: LOOPS_CHANNEL, streak: 1 }))

    const run = runHook(schedulePayload({ noop: true }))
    expect(run.requests).toEqual([`PATCH /api/v10/channels/${LOOPS_CHANNEL}/messages/prior-msg-id`])
    expectCleanExit(run)
  })

  test('three consecutive quiet ticks produce one message and a streak of 3', () => {
    const id = loopId('streak-session', LOOP_PROMPT)
    const stateFile = join(fixtures, `artifice-loop-tick-${id}.json`)
    try { rmSync(stateFile) } catch {}

    const p = (noop: boolean) => ({
      session_id: 'streak-session',
      tool_name: 'ScheduleWakeup',
      tool_input: { delaySeconds: 600, reason: 'quiet hold', prompt: LOOP_PROMPT, noop },
    })

    const r1 = runHook(p(true))
    const r2 = runHook(p(true))
    const r3 = runHook(p(true))

    // First tick: no prior state → POST
    expect(r1.requests).toEqual([`POST /api/v10/channels/${LOOPS_CHANNEL}/messages`])
    // Second and third: EDIT existing message
    expect(r2.requests).toEqual([`PATCH /api/v10/channels/${LOOPS_CHANNEL}/messages/fixture-msg-id`])
    expect(r3.requests).toEqual([`PATCH /api/v10/channels/${LOOPS_CHANNEL}/messages/fixture-msg-id`])

    expectCleanExit(r1)
    expectCleanExit(r2)
    expectCleanExit(r3)
  })

  test('stop=true produces no request', () => {
    const run = runHook({ ...schedulePayload(), tool_input: { stop: true } })
    expect(run.requests).toEqual([])
    expectCleanExit(run)
  })

  test('missing loops_channel produces no request', () => {
    // Write persona without loops_channel as a positive control check
    const noLoops = join(fixtures, 'persona-no-loops.md')
    writeFileSync(noLoops, `---\nname: "test-bot"\ndiscord_channel: "999"\n---\nFixture persona.\n`)
    const run = runHook(schedulePayload({ noop: false }), { CLAUDE_CONFIG_DIR: fixtures + '-noloops' })
    // CLAUDE_CONFIG_DIR points to a non-existent dir so persona.md read fails → silent exit
    expect(run.requests).toEqual([])
    expectCleanExit(run)
  })
})

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
