#!/usr/bin/env node
// discord-preply-forward.js — PreToolUse hook (reply tool only)
// Before the reply tool fires, forward any assistant text in the current turn
// that hasn't been sent to Discord yet. Catches preamble text that would
// otherwise be visible only in the terminal. State is tracked per-session so
// multiple reply calls in a turn don't double-send.

const { readFileSync, writeFileSync } = require('fs')
const { request } = require('https')
const { join } = require('path')
const { homedir, tmpdir } = require('os')

const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const tokenFile = join(claudeDir, 'discord-token')

const REPLY_TOOL = 'mcp__plugin_artifice-discord_artifice-discord__reply'

function textOf(content) {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content.filter(b => b && b.type === 'text').map(b => b.text).join('\n').trim()
  }
  return ''
}

function isToolResult(content) {
  return Array.isArray(content) && content.length > 0 &&
    content.every(b => b && b.type === 'tool_result')
}

let raw = ''
process.stdin.on('data', c => { raw += c })
process.stdin.on('end', async () => {
  let payload = {}
  try { payload = JSON.parse(raw) } catch { process.exit(0) }

  const { session_id, transcript_path, tool_name, tool_input } = payload
  if (tool_name !== REPLY_TOOL) process.exit(0)

  // If the reply is being sent with non-empty text, trust that as the intended
  // message and skip forwarding any main-loop preamble. Prevents double-sends
  // when the agent writes the full response as text before calling reply with
  // the same content. The stop-forward hook still catches the "forgot to
  // reply" case at end-of-turn.
  const replyText = tool_input && typeof tool_input.text === 'string' ? tool_input.text.trim() : ''
  if (replyText.length > 0) process.exit(0)

  const channel = tool_input && tool_input.chat_id
  if (!channel || !transcript_path || !session_id) process.exit(0)

  // Per-session state: which transcript entries have already been forwarded.
  const stateFile = join(tmpdir(), `discord-preforward-${session_id}.json`)
  let state = { forwarded_up_to: -1 }
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')) } catch {}

  let entries
  try {
    entries = readFileSync(transcript_path, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch { process.exit(0) }

  // Find the start of the current turn: the last non-tool-result user entry.
  // Everything after this index belongs to the current assistant turn.
  let turnStart = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.type === 'user') {
      const content = e.message && e.message.content
      if (!isToolResult(content)) { turnStart = i; break }
    }
  }
  if (turnStart === -1) process.exit(0)

  // Collect assistant text entries in this turn that haven't been forwarded yet.
  // Transcript indices are monotonically increasing, so forwarded_up_to from a
  // previous turn will never shadow entries from the current one.
  const toForward = []
  for (let i = turnStart + 1; i < entries.length; i++) {
    if (i <= state.forwarded_up_to) continue
    const e = entries[i]
    if (e.type !== 'assistant') continue
    const content = e.message && e.message.content
    const t = textOf(content)
    if (t) toForward.push({ index: i, text: t })
  }

  if (toForward.length === 0) process.exit(0)

  let token = ''
  try { token = readFileSync(tokenFile, 'utf8').trim() } catch {}
  if (!token) process.exit(0)

  // Persist state before sending — avoids double-send if we crash mid-request.
  const maxIndex = Math.max(...toForward.map(x => x.index))
  state.forwarded_up_to = maxIndex
  try { writeFileSync(stateFile, JSON.stringify(state)) } catch {}

  // Italicize per line after chunking so each Discord message is self-contained.
  // Wrapping the full blob before chunking splits the _.._ pair across messages → literal underscores.
  function wrapItalics(text) {
    return text.split('\n').map(line => {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('```')) return line
      return '_' + line.replace(/([_*`~|\\])/g, '\\$1') + '_'
    }).join('\n')
  }

  const allText = toForward.map(x => x.text).join('\n\n')

  const chunks = []
  let rest = allText
  while (rest.length > 1960) {
    let cut = rest.lastIndexOf('\n', 1960)
    if (cut < 1000) cut = 1960
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)

  const italicChunks = chunks.map(wrapItalics)

  await new Promise(resolve => {
    function post(idx) {
      if (idx >= italicChunks.length) { resolve(); return }
      const body = JSON.stringify({ content: italicChunks[idx] })
      const req = request({
        hostname: 'discord.com',
        path: `/api/v10/channels/${channel}/messages`,
        method: 'POST',
        headers: {
          'Authorization': `Bot ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, res => {
        res.on('data', () => {})
        res.on('end', () => post(idx + 1))
      })
      req.on('error', () => resolve())
      req.write(body)
      req.end()
    }
    post(0)
    setTimeout(resolve, 5000)
  })

  process.exit(0)
})
