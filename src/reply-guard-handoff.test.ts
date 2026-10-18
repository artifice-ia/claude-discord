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
const trigger = { type: 'user', message: { content: '<channel source="plugin:artifice-discord:artifice-discord" chat_id="123">hello</channel>' } }
const closing = { type: 'assistant', message: { usage: { input_tokens: 100 }, content: [{ type: 'text', text: 'answer' }] } }
const reply = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__plugin_artifice-discord_artifice-discord__reply', input: { text: 'answer', chat_id: '123' } }] } }
function writeSession(file: string, entries: unknown[]) {
  writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n'))
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
  writeSession(session, [trigger, closing])
  writeFileSync(join(dir, 'persona.md'), `---\nname: "${name}"\ndiscord_channel: "123"\n---\n`)
  writeFileSync(join(dir, 'discord-token'), 'fixture-only')
  preload = join(dir, 'preload.cjs')
  writeFileSync(preload, `
const fs = require('fs')
const { EventEmitter } = require('events')
require('https').request = (options, cb) => {
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
  for (const suffix of ['ctx.json', 'ctx.txt', 'missed-discord-reply.flag', 'reply-guard-blocked.json']) {
    rmSync(`/tmp/${name}-${suffix}`, { force: true })
  }
})
const forward = 'discord-stop-forward.js'
const guard = 'stop-context-tracker.js'

test('first pass stands down, guard blocks once, second pass forwards exactly once', () => {
  expect(run(forward).requests).toEqual([])
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
  const marker = JSON.parse(readFileSync(`/tmp/${name}-reply-guard-blocked.json`, 'utf8'))
  expect(marker.key).toBe(`${session}:0`)
  expect(run(forward, { transcript_path: session, stop_hook_active: true }).requests).toEqual(['/api/v10/channels/123/messages'].map(p => 'HTTPS ' + p))
  expect(run(guard, { transcript_path: session, stop_hook_active: true }).stdout).toBe('')
})

test('real reply on re-prompt suppresses fallback, even with trailing text', () => {
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
  writeSession(session, [trigger, closing, reply, closing])
  expect(run(forward, { transcript_path: session, stop_hook_active: true }).requests).toEqual([])
  expect(run(guard).stdout).toBe('')
})

test('disabled guard preserves first-pass forwarding', () => {
  expect(run(forward, { transcript_path: session }, true).requests).toHaveLength(1)
  expect(run(guard, { transcript_path: session }, true).stdout).toBe('')
})

test('payload A wins over newer unanswered B; fallback cannot block', () => {
  writeSession(session, [trigger, reply, closing])
  const b = join(dir, 'projects', 'b.jsonl')
  writeSession(b, [trigger, closing])
  utimesSync(session, 1, 1)
  utimesSync(b, 2, 2)
  expect(run(guard).stdout).toBe('')
  expect(run(guard, {}).stdout).toBe('')
  expect(JSON.parse(run(guard, { transcript_path: b }).stdout).decision).toBe('block')
})

test('an unrelated marker cannot authorize forwarding a different turn', () => {
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
  writeSession(session, [trigger, closing, trigger, closing])
  expect(run(forward).requests).toEqual([])
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
})

test('image turn companion preserves shared key and second-pass fallback', () => {
  writeSession(session, [trigger, { type: 'user', turnCompanion: true, message: { content: '[Image: original]' } }, closing])
  expect(run(forward).requests).toEqual([])
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
  expect(run(forward, { transcript_path: session, stop_hook_active: true }).requests).toHaveLength(1)
})

test('missing payload transcript does not substitute another session', () => {
  expect(run(guard, { transcript_path: join(dir, 'missing.jsonl') }).stdout).toBe('')
})
