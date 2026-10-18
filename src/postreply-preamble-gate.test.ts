/**
 * The forwarding boundary between `discord-postreply-preamble.js` (gated off
 * by default as of 0.10.1) and `discord-stop-forward.js` (always on).
 *
 * Three things here can regress silently and none of them is visible from
 * inside the running plugin:
 *
 *  - The gate. `DISCORD_POSTREPLY_PREAMBLE` guards a hook that POSTs to
 *    Discord. A guard placed below any read, or compared loosely enough that
 *    `"0"` and `"true"` fall through, re-enables automatic forwarding for
 *    every bot on the next release. Asserting the hook "does nothing" by
 *    watching its exit code proves nothing: it exits 0 on every path it has.
 *    So these tests assert the ABSENCE of the side effects instead — no
 *    `persona.md` read, no state file write, no HTTPS request — and pair each
 *    with a positive control that reaches the POST, because a test that only
 *    ever sees silence cannot tell a working gate from a broken harness.
 *
 *  - The opt-in. `=1` must still restore the original path, or the retained
 *    code is unreachable and the hook is deleted in all but name.
 *
 *  - The coverage gap. `discord-stop-forward.js` decides on the LAST assistant
 *    entry: a reply call means "covered", and it never inspects that call's
 *    text. A turn that narrates mid-turn and then calls reply with empty text
 *    is therefore forwarded by neither hook once the gate holds. That is the
 *    accepted consequence of turning the preamble off, not an oversight, and
 *    it is pinned here so a future reader finds the boundary stated rather
 *    than inferring parity that does not exist.
 *
 * The hooks are plain CJS scripts that talk to Discord over HTTPS, so they run
 * as real subprocesses under a preload that replaces `https.request` with a
 * recorder and traces `fs` access. Nothing reaches the network, and the token
 * and channel are fixtures.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = join(import.meta.dir, '..')
const PREAMBLE_HOOK = join(ROOT, 'hooks', 'discord-postreply-preamble.js')
const STOP_HOOK = join(ROOT, 'hooks', 'discord-stop-forward.js')

const REPLY_TOOL = 'mcp__plugin_artifice-discord_artifice-discord__reply'
const PERSONA_CHANNEL = '999000111222333444'
const TRIGGER_CHANNEL = '111222333444555666'

let fixtures: string
let preload: string

/**
 * Records every HTTPS attempt and every file read as a line on stderr, then
 * lets the hook's own control flow continue. `request` returns an object that
 * satisfies the callers' use of it (`on`/`write`/`end`) and drives the
 * response callback to completion so the hook resolves instead of waiting out
 * its 5s timeout.
 */
const PRELOAD_SOURCE = `
const https = require('https')
const fs = require('fs')
const { EventEmitter } = require('events')

https.request = function (options, callback) {
  console.error('HTTPS ' + options.method + ' ' + options.path)
  const res = new EventEmitter()
  if (callback) setImmediate(() => { callback(res); res.emit('end') })
  return { on() { return this }, write() { return this }, end() { return this } }
}

const readFileSync = fs.readFileSync
fs.readFileSync = function (path, ...rest) {
  console.error('READ ' + String(path))
  return readFileSync.call(fs, path, ...rest)
}

const writeFileSync = fs.writeFileSync
fs.writeFileSync = function (path, ...rest) {
  console.error('WRITE ' + String(path))
  return writeFileSync.call(fs, path, ...rest)
}
`

/** One transcript entry per line, as Claude Code writes them. */
function transcript(name: string, entries: unknown[]): string {
  const path = join(fixtures, `${name}.jsonl`)
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return path
}

const discordTrigger = `<channel source="plugin:artifice-discord:artifice-discord" chat_id="${TRIGGER_CHANNEL}" user="someone">do the thing</channel>`

function userEntry(text: string) {
  return { type: 'user', message: { content: text } }
}

function assistantText(text: string) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } }
}

function assistantReply(text: string) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: REPLY_TOOL, input: { chat_id: TRIGGER_CHANNEL, text } }] },
  }
}

interface Run {
  reads: string[]
  writes: string[]
  requests: string[]
  status: number | null
}

function runHook(hook: string, payload: unknown, env: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, ['--require', preload, hook], {
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
  const lines = (result.stderr ?? '').split('\n')
  return {
    reads: lines.filter(l => l.startsWith('READ ')).map(l => l.slice(5)),
    writes: lines.filter(l => l.startsWith('WRITE ')).map(l => l.slice(6)),
    requests: lines.filter(l => l.startsWith('HTTPS ')).map(l => l.slice(6)),
    status: result.status,
  }
}

/** Reads of the hook's own source are noise; reads of plugin state are not. */
function stateReads(run: Run): string[] {
  return run.reads.filter(p => !p.endsWith('.js'))
}

beforeAll(() => {
  fixtures = mkdtempSync(join(tmpdir(), 'preamble-gate-'))
  mkdirSync(fixtures, { recursive: true })
  preload = join(fixtures, 'preload.cjs')
  writeFileSync(preload, PRELOAD_SOURCE)
  writeFileSync(join(fixtures, 'persona.md'), `---\nname: "test-bot"\ndiscord_channel: "${PERSONA_CHANNEL}"\n---\n\nA fixture persona.\n`)
  writeFileSync(join(fixtures, 'discord-token'), 'fixture-token-not-a-credential\n')
})

afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true })
})

describe('discord-postreply-preamble gate', () => {
  /**
   * The reply-tool branch: mid-turn text, then a reply call carrying no text
   * of its own. This is the shape the hook existed to cover — and the shape
   * the positive control below proves it still covers when opted in.
   */
  function replyToolPayload(session: string) {
    return {
      session_id: session,
      transcript_path: transcript(session, [
        userEntry(discordTrigger),
        assistantText('mid-turn narration that never reached Discord'),
        assistantReply(''),
      ]),
      tool_name: REPLY_TOOL,
      tool_input: { chat_id: TRIGGER_CHANNEL, text: '' },
    }
  }

  /** The standalone branch: any non-reply tool, forwarded to persona channel. */
  function bashPayload(session: string) {
    return {
      session_id: session,
      transcript_path: transcript(session, [
        userEntry(discordTrigger),
        assistantText('narration emitted while a tool was running'),
      ]),
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    }
  }

  for (const [label, env] of [
    ['unset', {}],
    ['"0"', { DISCORD_POSTREPLY_PREAMBLE: '0' }],
    ['"true"', { DISCORD_POSTREPLY_PREAMBLE: 'true' }],
    ['empty', { DISCORD_POSTREPLY_PREAMBLE: '' }],
  ] as [string, Record<string, string>][]) {
    test(`reply-tool branch does nothing when the flag is ${label}`, () => {
      const run = runHook(PREAMBLE_HOOK, replyToolPayload(`reply-off-${label.replace(/\W/g, '')}`), env)
      expect(run.requests).toEqual([])
      expect(stateReads(run)).toEqual([])
      expect(run.writes).toEqual([])
      expect(run.status).toBe(0)
    })

    test(`standalone branch does nothing when the flag is ${label}`, () => {
      const run = runHook(PREAMBLE_HOOK, bashPayload(`bash-off-${label.replace(/\W/g, '')}`), env)
      expect(run.requests).toEqual([])
      expect(stateReads(run)).toEqual([])
      expect(run.writes).toEqual([])
      expect(run.status).toBe(0)
    })
  }

  /**
   * Both reply-tool cases land on the persona channel, by two different code
   * paths: a reply into the persona channel is the "primary channel" branch,
   * and a reply into any other channel falls through to the standalone branch,
   * which addresses the persona channel too. The hook never posts a preamble
   * into a non-primary channel, so the trigger channel is asserted absent.
   */
  test('reply-tool branch posts to the persona channel when opted in', () => {
    const run = runHook(PREAMBLE_HOOK, replyToolPayload('reply-on'), { DISCORD_POSTREPLY_PREAMBLE: '1' })
    expect(run.requests).toEqual([`POST /api/v10/channels/${PERSONA_CHANNEL}/messages`])
    expect(run.status).toBe(0)
  })

  test('reply-tool branch on the primary channel posts there when opted in', () => {
    const session = 'reply-on-primary'
    const run = runHook(PREAMBLE_HOOK, {
      session_id: session,
      transcript_path: transcript(session, [
        userEntry(discordTrigger),
        assistantText('mid-turn narration that never reached Discord'),
        assistantReply(''),
      ]),
      tool_name: REPLY_TOOL,
      tool_input: { chat_id: PERSONA_CHANNEL, text: '' },
    }, { DISCORD_POSTREPLY_PREAMBLE: '1' })
    expect(run.requests).toEqual([`POST /api/v10/channels/${PERSONA_CHANNEL}/messages`])
    expect(run.status).toBe(0)
  })

  test('standalone branch posts to the persona channel when opted in', () => {
    const run = runHook(PREAMBLE_HOOK, bashPayload('bash-on'), { DISCORD_POSTREPLY_PREAMBLE: '1' })
    expect(run.requests).toEqual([`POST /api/v10/channels/${PERSONA_CHANNEL}/messages`])
    expect(run.status).toBe(0)
  })

  test('a reply carrying its own text is never duplicated, opted in or not', () => {
    const payload = {
      session_id: 'reply-with-text',
      transcript_path: transcript('reply-with-text', [
        userEntry(discordTrigger),
        assistantText('narration'),
        assistantReply('the real answer'),
      ]),
      tool_name: REPLY_TOOL,
      tool_input: { chat_id: TRIGGER_CHANNEL, text: 'the real answer' },
    }
    expect(runHook(PREAMBLE_HOOK, payload, { DISCORD_POSTREPLY_PREAMBLE: '1' }).requests).toEqual([])
    expect(runHook(PREAMBLE_HOOK, payload).requests).toEqual([])
  })
})

describe('discord-stop-forward is not a replacement for the preamble hook', () => {
  /**
   * The gap Ohm's review named, pinned so it cannot be mistaken for parity.
   * Stop decides on the last assistant entry; a reply call means "covered",
   * whatever its text. With the preamble gate holding, the mid-turn prose in
   * this transcript reaches nobody.
   */
  test('mid-turn text followed by an empty-text reply reaches neither hook', () => {
    const entries = [
      userEntry(discordTrigger),
      assistantText('mid-turn narration that never reached Discord'),
      assistantReply(''),
    ]
    const stop = runHook(STOP_HOOK, {
      transcript_path: transcript('stop-covered', entries),
    })
    expect(stop.requests).toEqual([])

    const preamble = runHook(PREAMBLE_HOOK, {
      session_id: 'stop-covered-preamble',
      transcript_path: transcript('stop-covered-preamble', entries),
      tool_name: REPLY_TOOL,
      tool_input: { chat_id: TRIGGER_CHANNEL, text: '' },
    })
    expect(preamble.requests).toEqual([])
  })

  test('closing text with no reply call still reaches the channel', () => {
    const run = runHook(STOP_HOOK, {
      transcript_path: transcript('stop-leaked', [
        userEntry(discordTrigger),
        assistantText('closing text the agent forgot to send'),
      ]),
    })
    expect(run.requests).toEqual([`POST /api/v10/channels/${PERSONA_CHANNEL}/messages`])
  })
})
