import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const hooks = join(import.meta.dir, '..', 'hooks')
let dir: string
let name: string
let preload: string
let session: string
// Synthetic only: replace the filename per case when a real runtime capture arrives.
function loadFixture(fixture: string, file = session) {
  writeFileSync(file, readFileSync(join(import.meta.dir, 'fixtures', 'reply-guard', fixture + '.jsonl')))
}
function run(hook: string, payload: unknown = { transcript_path: session }, disabled = false) {
  const result = spawnSync('node', ['--require', preload, join(hooks, hook)], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: dir, DISCORD_REPLY_GUARD: disabled ? 'off' : '' },
  })
  // All silence assertions include proof that the actual Node hook completed.
  expect(result.signal).toBeNull()
  expect(result.status).toBe(0)
  return { stdout: result.stdout, requests: result.stderr.split('\n').filter(l => l.startsWith('HTTPS ')) }
}
beforeEach(() => {
  expect(spawnSync('node', ['--version']).status).toBe(0)
  dir = mkdtempSync(join(tmpdir(), 'reply-handoff-'))
  name = dir.split('/').pop()!
  mkdirSync(join(dir, 'projects'))
  session = join(dir, 'projects', 'a.jsonl')
  loadFixture('unanswered')
  writeFileSync(join(dir, 'persona.md'), `---\nname: "${name}"\ndiscord_channel: "123"\n---\n`)
  writeFileSync(join(dir, 'discord-token'), 'fixture-only')
  preload = join(dir, 'preload.cjs')
  writeFileSync(preload, `
const fs = require('fs')
const { EventEmitter } = require('events')
require('https').request = (options, cb) => {
  if (process.env.DISCORD_REPLY_GUARD !== 'off') {
    // Assert persistence ordering, not merely eventual state after the process exits.
    const state = JSON.parse(fs.readFileSync('/tmp/${name}-reply-guard-forwarded.json', 'utf8'))
    if (!state.key) throw new Error('POST before durable fallback claim')
  }
  console.error('HTTPS ' + options.path)
  const res = new EventEmitter()
  res.statusCode = 200
  res.resume = () => {}
  setImmediate(() => { cb(res); res.emit('end') })
  return { on() { return this }, write() {}, end() {}, setTimeout() {}, destroy() {} }
}
for (const method of ['readFileSync', 'writeFileSync']) {
  const original = fs[method]
  fs[method] = function(path, ...args) {
    console.error(method + ' ' + path)
    return original.call(fs, path, ...args)
  }
}
`)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const suffix of ['ctx.json', 'ctx.txt', 'missed-discord-reply.flag', 'reply-guard-blocked.json', 'reply-guard-forwarded.json', 'reply-guard-forwarded.json.lock']) {
    rmSync(`/tmp/${name}-${suffix}`, { force: true })
  }
})
const forward = 'discord-stop-forward.js'
const guard = 'stop-context-tracker.js'

for (const order of ['guard-first', 'forward-first']) {
  test(`first Stop never posts in ${order} completion order`, () => {
    const payload = { transcript_path: session, stop_hook_active: false }
    if (order === 'forward-first') expect(run(forward, payload).requests).toEqual([])
    const blocked = run(guard, payload)
    expect(JSON.parse(blocked.stdout).decision).toBe('block')
    expect(blocked.requests).toEqual([])
    if (order === 'guard-first') expect(run(forward, payload).requests).toEqual([])
    // Missing, false, and truthy non-boolean values are not an actual retry.
    for (const active of [undefined, false, 'true', 1]) {
      expect(run(forward, { transcript_path: session, stop_hook_active: active }).requests).toEqual([])
    }
  })
}

test('repeated second-pass Stops post exactly once and never re-block', () => {
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
  const marker = JSON.parse(readFileSync(`/tmp/${name}-reply-guard-blocked.json`, 'utf8'))
  expect(marker.key).toBe(`${session}:0`)
  loadFixture('retry-unanswered')
  const payload = { transcript_path: session, stop_hook_active: true }
  const requests = []
  for (let i = 0; i < 3; i++) {
    requests.push(...run(forward, payload).requests)
    expect(run(guard, payload).stdout).toBe('')
  }
  expect(requests).toEqual(['HTTPS /api/v10/channels/123/messages'])
  expect(JSON.parse(readFileSync(`/tmp/${name}-reply-guard-forwarded.json`, 'utf8')).key).toBe(marker.key)
})

test('retry signal without the matching marker cannot send', () => {
  expect(run(forward, { transcript_path: session, stop_hook_active: true }).requests).toEqual([])
})

test('non-Discord terminal turn never blocks (ported shell case)', () => {
  loadFixture('terminal')
  expect(run(guard).stdout).toBe('')
  expect(run(forward, { transcript_path: session, stop_hook_active: true }).requests).toEqual([])
})

test('real reply on re-prompt suppresses fallback, even with trailing text', () => {
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
  loadFixture('retry-replied')
  expect(run(forward, { transcript_path: session, stop_hook_active: true }).requests).toEqual([])
  expect(run(guard).stdout).toBe('')
})

test('disabled guard preserves first-pass forwarding', () => {
  expect(run(forward, { transcript_path: session }, true).requests).toHaveLength(1)
  expect(run(guard, { transcript_path: session }, true).stdout).toBe('')
})

test('payload A wins over newer unanswered B; fallback cannot block', () => {
  loadFixture('replied')
  const b = join(dir, 'projects', 'b.jsonl')
  loadFixture('unanswered', b)
  utimesSync(session, 1, 1)
  utimesSync(b, 2, 2)
  expect(run(guard).stdout).toBe('')
  expect(run(guard, {}).stdout).toBe('')
  expect(JSON.parse(run(guard, { transcript_path: b }).stdout).decision).toBe('block')
})

test('an unrelated marker cannot authorize forwarding a different turn', () => {
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
  loadFixture('new-turn')
  expect(run(forward, { transcript_path: session, stop_hook_active: true }).requests).toEqual([])
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
})

test('image turn companion preserves shared key and second-pass fallback', () => {
  loadFixture('image')
  expect(run(forward).requests).toEqual([])
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
  expect(run(forward, { transcript_path: session, stop_hook_active: true }).requests).toHaveLength(1)
})

test('missing payload transcript does not substitute another session', () => {
  expect(run(guard, { transcript_path: join(dir, 'missing.jsonl') }).stdout).toBe('')
})

test('a later turn can claim its own fallback without inheriting earlier delivery', () => {
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
  const payload = { transcript_path: session, stop_hook_active: true }
  expect(run(forward, payload).requests).toHaveLength(1)
  loadFixture('new-turn')
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
  expect(run(forward, payload).requests).toHaveLength(1)
  expect(run(forward, payload).requests).toEqual([])
})
