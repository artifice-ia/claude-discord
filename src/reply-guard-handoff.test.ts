import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const hooks = join(import.meta.dir, '..', 'hooks')
let dir: string
let name: string
let preload: string
let session: string
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
    // Assert the claim is DURABLE before the POST, not merely present after the process
    // exits. Claims are one file per turn, so a run that legitimately delivers two turns
    // leaves two: the count belongs to the test body, the ordering belongs here.
    const claims = fs.readdirSync('/tmp').filter(f => f.startsWith('${name}-reply-guard-forwarded-'))
    const keyed = claims.filter(f => { try { return !!JSON.parse(fs.readFileSync('/tmp/' + f, 'utf8')).key } catch { return false } })
    if (keyed.length === 0) throw new Error('POST before durable fallback claim')
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
  for (const suffix of ['ctx.json', 'ctx.txt', 'missed-discord-reply.flag', 'reply-guard-blocked.json']) {
    rmSync(`/tmp/${name}-${suffix}`, { force: true })
  }
  for (const file of readdirSync('/tmp')) {
    if (file.startsWith(`${name}-reply-guard-forwarded-`)) rmSync(join('/tmp', file), { force: true })
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
  // One claim file per turn, named by a hash of the key, so find it by its body.
  const claims = readdirSync('/tmp')
    .filter(f => f.startsWith(`${name}-reply-guard-forwarded-`))
    .map(f => JSON.parse(readFileSync(join('/tmp', f), 'utf8')).key)
  expect(claims).toEqual([marker.key])
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

// THE RETRY ENTRY IS THE WHOLE HANDOFF. Claude Code appends a blocking hook's reason as a
// `user` entry carrying isMeta and a "Stop hook feedback:" body, with no turnCompanion
// field. Both backward scans used to stop there, judge the turn as "not Discord", and
// exit — so the fallback these two hooks hand off to could never fire, while every test
// built on a synthetic retry transcript passed. The fixtures below carry the captured
// entry; see src/fixtures/reply-guard/README.md for its provenance.
test('a retry Stop carrying the real injected entry forwards exactly once', () => {
  const first = { transcript_path: session, stop_hook_active: false }
  expect(JSON.parse(run(guard, first).stdout).decision).toBe('block')
  const blockedKey = JSON.parse(readFileSync(`/tmp/${name}-reply-guard-blocked.json`, 'utf8')).key

  loadFixture('retry-unanswered')
  const retry = { transcript_path: session, stop_hook_active: true }
  expect(run(forward, retry).requests).toEqual(['HTTPS /api/v10/channels/123/messages'])

  // The key must survive the appended entries, or the marker comparison silently fails
  // open on one side and closed on the other.
  run(guard, retry)
  expect(JSON.parse(readFileSync(`/tmp/${name}-reply-guard-blocked.json`, 'utf8')).key).toBe(blockedKey)

  // Repeated retry Stops are one delivery, not one per Stop.
  expect(run(forward, retry).requests).toEqual([])
  expect(run(forward, retry).requests).toEqual([])
})

test('a retry Stop whose turn did get a reply forwards nothing', () => {
  const first = { transcript_path: session, stop_hook_active: false }
  run(guard, first)
  loadFixture('retry-replied')
  expect(run(forward, { transcript_path: session, stop_hook_active: true }).requests).toEqual([])
})

// A leftover claim from a process that died mid-send must not disable the fallback for
// every LATER turn. The claim is per-turn, so a stale one can only ever suppress its own.
test('a claim left by an earlier turn does not suppress a different turn', () => {
  const first = { transcript_path: session, stop_hook_active: false }
  run(guard, first)
  loadFixture('retry-unanswered')
  const retry = { transcript_path: session, stop_hook_active: true }
  expect(run(forward, retry).requests).toEqual(['HTTPS /api/v10/channels/123/messages'])

  // A second turn: new transcript path, so a new key, with its own guard block.
  const second = join(dir, 'projects', 'b.jsonl')
  loadFixture('unanswered', second)
  const secondFirst = { transcript_path: second, stop_hook_active: false }
  expect(JSON.parse(run(guard, secondFirst).stdout).decision).toBe('block')
  loadFixture('retry-unanswered', second)
  expect(run(forward, { transcript_path: second, stop_hook_active: true }).requests)
    .toEqual(['HTTPS /api/v10/channels/123/messages'])
})

// BUS-FRAME EXCLUSION. A fleet-bus frame carries BOTH source="plugin:artifice-discord:..."
// AND source="fleet-bus". Both trigger scans must skip it with `continue`, not `break`.
// Breaking on it stops the scan at the bus frame: the verdict is not_discord, the guard
// does not block, and the forwarder does not forward — Fernando gets silence on every
// turn where a bus frame lands after his message, which is nearly always.
// Fixtures carry the real frame opening from a live bus exchange on 2026-10-18.

test('bus-only transcript: guard does not block and forwarder does not post', () => {
  loadFixture('bus-frame')
  expect(run(guard).stdout).toBe('')
  expect(run(forward, { transcript_path: session, stop_hook_active: true }).requests).toEqual([])
})

// THE TEST THAT DISTINGUISHES CONTINUE FROM BREAK. A transcript with Fernando's genuine
// Discord message, then assistant prose, then a bus frame appended last. Under `break`
// the scan stops at the bus frame, judges not_discord, and the guard never fires —
// Fernando gets silence. Under `continue` the scan skips the bus frame and finds his
// message underneath, the guard blocks, and the forwarder posts on retry.
test('Discord+bus: guard blocks on Fernando message, forwarder posts on retry', () => {
  loadFixture('discord-then-bus')
  const first = { transcript_path: session, stop_hook_active: false }
  expect(JSON.parse(run(guard, first).stdout).decision).toBe('block')
  loadFixture('retry-discord-then-bus')
  expect(run(forward, { transcript_path: session, stop_hook_active: true }).requests)
    .toEqual(['HTTPS /api/v10/channels/123/messages'])
})

// Guard must NOT block when Fernando's Discord message was already answered and a bus
// frame arrived after, ending the turn. Bus frame is the newest user entry; without
// the continue skip the guard would treat it as the trigger, find no reply after it,
// and block — producing a false forward on a turn Fernando already got a reply for.
test('Discord answered then bus frame: guard never blocks, forwarder never posts', () => {
  loadFixture('replied-then-bus')
  expect(run(guard).stdout).toBe('')
  expect(run(forward, { transcript_path: session, stop_hook_active: true }).requests).toEqual([])
})

// Positive control: genuine Discord frame (no bus frame) still blocks and forwards.
// The skip must not be over-broad.
test('genuine Discord frame still blocks and forwards (exclusion is not over-broad)', () => {
  loadFixture('unanswered')
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
  loadFixture('retry-unanswered')
  expect(run(forward, { transcript_path: session, stop_hook_active: true }).requests)
    .toEqual(['HTTPS /api/v10/channels/123/messages'])
})

// COMPACTION-ENTRY EXCLUSION. When Fernando sends a Discord message and then /compact runs
// (or auto-compaction triggers), the harness injects up to four user entries between his
// message and the end of the transcript:
//   isCompactSummary:true  — "This session is being continued…"
//   <local-command-caveat> — CLI preamble (isMeta:true)
//   <command-name>/compact — slash-command record
//   <local-command-stdout> — "Compacted. Context window…"
//
// The old scan broke on the first of these it encountered (no explicit skip), returned
// not_discord, and the guard never blocked — Fernando's message went unanswered.
//
// The new scan uses isHarnessEntry() to identify all four and continue past them.
// isCompactSummary is a structural flag; the three local-command types are matched by
// XML tag prefix on the content string.
//
// Fixtures built from real entry structures in Kat's transcripts — see
// src/fixtures/reply-guard/README.md for provenance.

// TEST 1 — Discord message below compact entries: guard must block.
// Under the old scan this returned not_discord; under the fix it finds Fernando's message.
test('Discord+compact: guard blocks on message below compaction entries', () => {
  loadFixture('discord-then-compact')
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
})

// TEST 2 — Same transcript, reply added after compact entries: guard must NOT block.
// Verifies the fix does not over-count; a replied turn stays replied even with compaction.
test('Discord answered, compact entries appended: guard does not block', () => {
  // Reuse discord-then-bus-replied shape: Discord msg → assistant reply → compact entries.
  // Build it inline since no separate fixture is needed.
  const replied = join(dir, 'projects', 'compact-replied.jsonl')
  const base = readFileSync(join(import.meta.dir, 'fixtures', 'reply-guard', 'discord-then-compact.jsonl'), 'utf8')
  // Prepend a reply before the compact entries by reconstructing: Discord + reply + compacts.
  const discord = base.split('\n')[0]
  const compacts = base.split('\n').slice(1).join('\n')
  const replyEntry = JSON.stringify({
    type: 'assistant',
    message: { usage: { input_tokens: 100 }, content: [{ type: 'tool_use', id: 'x', name: 'mcp__plugin_artifice-discord_artifice-discord__reply', input: {} }] }
  })
  writeFileSync(replied, [discord, replyEntry, compacts].join('\n'))
  expect(run(guard, { transcript_path: replied }).stdout).toBe('')
})

// TEST 3 — Compact entries only, no Discord message: must return not_discord.
// Proves the inversion did not make the scan walk all the way to transcript start and
// find something stale — an all-harness transcript correctly reports no Discord trigger.
test('compact-only transcript: guard does not block, forwarder does not post', () => {
  loadFixture('compact-only')
  expect(run(guard).stdout).toBe('')
  expect(run(forward, { transcript_path: session, stop_hook_active: true }).requests).toEqual([])
})

// Compact retry: guard blocks; forwarder REFUSES on retry (textual harness in window).
//
// The /compact command sequence injects <command-name> and <local-command-stdout> entries.
// These have no structural backing — <command-name> carries only entrypoint/isSidechain/
// userType, the same fields any human terminal entry would have. The forwarder cannot
// distinguish a real /compact injection from Fernando typing <command-name>…</command-name>
// to pivot the forwarder's scan. textual-harness → unknownEntries → forwarder refuses.
//
// The guard is unaffected: it skips textual-harness the same as structural-harness.
// Fernando still gets a block; the forwarder just doesn't post the post-compact answer
// on retry. This is the correct conservative behaviour ("fire less often").
test('Discord+compact: guard blocks; forwarder refuses on retry (textual harness in window)', () => {
  loadFixture('discord-then-compact')
  const first = { transcript_path: session, stop_hook_active: false }
  expect(JSON.parse(run(guard, first).stdout).decision).toBe('block')
  loadFixture('retry-discord-then-compact')
  expect(run(forward, { transcript_path: session, stop_hook_active: true }).requests).toEqual([])
})

// TEST 6 — Unknown future harness entry: guard must still block.
//
// This is THE test that proves the inversion is real. A fabricated
// `<future-harness-thing>` entry appears between Fernando's Discord message and
// the end of the transcript. Under the OLD enumerated-skip design this breaks
// with not_discord — the unknown tag is not in the skip list. Under isGenuineHumanTurn
// it falls through the XML-tag-opener catch (starts with <tag…, no plugin source)
// and returns false → scan continues past it → finds Fernando's message → blocks.
//
// Mutation path: making isGenuineHumanTurn return true unconditionally causes this
// test to fail — the scan stops at the unknown entry, treats it as a genuine human
// turn, finds no Discord source in it, and returns not_discord.
//
// NOTE: under the three-outcome classifier this test still passes: <future-harness-thing>
// is 'unknown', the guard skips unknown, finds Discord below, and blocks.
test('unknown future harness entry between Discord msg and end: guard still blocks', () => {
  loadFixture('discord-then-unknown-harness')
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
})

// TEST 7 — Genuine terminal turn above a Discord message: must return not_discord.
//
// A plain-text terminal input (no XML opener, no harness flags) sits MORE RECENTLY than
// a Discord message. The scan must stop at it, confirm it is human but not Discord, and
// return not_discord.
test('genuine terminal turn above Discord message: guard does not block', () => {
  loadFixture('terminal-over-discord')
  expect(run(guard).stdout).toBe('')
  expect(run(forward, { transcript_path: session, stop_hook_active: true }).requests).toEqual([])
})

// TEST 8 — Ohm's canary case (guard off): unknown entry blocks forwarding.
//
// Scenario: Fernando gets a Discord reply. He then types a private terminal task using
// XML syntax: <task>Analyze my private local document; answer only here.</task>.
// Claude answers with CANARY-PRIVATE-ANALYSIS. Stop hook fires. Guard is OFF.
//
// Under the open-ended XML regex (pre-three-outcome): <task>…</task> was classified as
// harness → scan skipped it → found Discord trigger below → POSTED canary to Discord.
// Wrong forward. Crossed a delivery boundary.
//
// Under the three-outcome classifier: <task>…</task> is 'unknown' (XML opener, not in
// the named harness list). unknownEntries.length > 0 → forwarder exits without posting.
//
// Mutation: making the forwarder treat 'unknown' as 'harness' (skipping it instead of
// gating on it) causes this test to fail — it posts CANARY-PRIVATE-ANALYSIS to Discord.
test('Ohm canary: guard-off forwarder refuses when unknown entry sits before trigger', () => {
  loadFixture('canary-with-unknown')
  expect(run(forward, { transcript_path: session }, true).requests).toEqual([])
})

// TEST 9 — bash-input entries: guard still blocks; forwarder REFUSES (textual harness).
//
// <bash-input>/<bash-stdout>/<bash-stderr> entries have no structural backing —
// they carry only entrypoint/isSidechain/userType, the same fields a human terminal
// entry would have. classifyEntry returns textual-harness → unknownEntries → forwarder
// refuses. This is CORRECT: if Fernando ran `!` bash commands during a Discord-triggered
// turn, the leaked text may include bash output Fernando didn't intend for Discord.
//
// The guard still blocks (it skips textual-harness the same as structural-harness).
test('bash passthrough entries in window: guard blocks, forwarder refuses (textual harness)', () => {
  loadFixture('discord-then-bash-input')
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
  expect(run(forward, { transcript_path: session }, true).requests).toEqual([])
})

// TEST 10 — task-notification with structural backing: forwarder still posts.
//
// <task-notification> from Claude Code carries promptSource (structural flag).
// classifyEntry returns structural-harness → not in unknownEntries → forwarder posts.
// Fixture updated to include promptSource (from real transcript, session 34e5b924).
test('task-notification with promptSource: forwarder still posts (structural harness)', () => {
  loadFixture('discord-then-task-notification')
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
  expect(run(forward, { transcript_path: session }, true).requests)
    .toEqual(['HTTPS /api/v10/channels/123/messages'])
})

// TEST 11 — command-message with structural backing: forwarder still posts.
//
// <command-message> from /loop carries scheduledTaskId (structural flag).
// classifyEntry returns structural-harness → not in unknownEntries → forwarder posts.
// Fixture updated to include scheduledTaskId (from real transcript, session 239e14bd).
test('command-message with scheduledTaskId: forwarder still posts (structural harness)', () => {
  loadFixture('discord-then-command-message')
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
  expect(run(forward, { transcript_path: session }, true).requests)
    .toEqual(['HTTPS /api/v10/channels/123/messages'])
})

// TESTS 12-14 — Ohm's three canary cases (Ohm's P1 on PR #53 review).
//
// A human can paste harness-looking text to trick the forwarder into treating their
// private terminal answer as a Discord continuation. Verified by Ohm with the Node
// forwarder, HTTPS recorder, and DISCORD_REPLY_GUARD=off. Canary captured in POST body.
//
// Three cases, one for each tag family that has NO structural backing:
//   12. <bash-stdout>private data</bash-stdout>\nanalyze privately
//   13. <task-notification> without promptSource
//   14. <command-message> without scheduledTaskId
//
// classifyEntry → textual-harness → unknownEntries → forwarder refuses. ✓
//
// Mutation record: making the forwarder accept textual evidence (treat textual-harness
// as structural-harness, skip it instead of gating) causes all three to fail — each
// posts its CANARY-*-LEAK to Discord when it should not.
test('Ohm canary (bash-stdout, no structural): guard blocks, forwarder refuses (guard-off)', () => {
  loadFixture('canary-textual-bash')
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
  expect(run(forward, { transcript_path: session }, true).requests).toEqual([])
})
test('Ohm canary (task-notification, no promptSource): guard blocks, forwarder refuses (guard-off)', () => {
  loadFixture('canary-textual-task')
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
  expect(run(forward, { transcript_path: session }, true).requests).toEqual([])
})
test('Ohm canary (command-message, no scheduledTaskId): guard blocks, forwarder refuses (guard-off)', () => {
  loadFixture('canary-textual-command')
  expect(JSON.parse(run(guard).stdout).decision).toBe('block')
  expect(run(forward, { transcript_path: session }, true).requests).toEqual([])
})
