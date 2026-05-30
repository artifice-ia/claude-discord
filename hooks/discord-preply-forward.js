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

  // If the preamble text is essentially the same as the reply being sent, skip
  // forwarding — the reply tool will deliver it. This prevents double-sends when
  // the full response is written as text before calling reply with the same content.
  const replyText = (tool_input && typeof tool_input.text === 'string') ? tool_input.text.trim() : ''
  if (replyText) {
    const allPreamble = toForward.map(x => x.text).join('\n\n').trim()
    const normalize = s => s.replace(/\s+/g, ' ').toLowerCase()
    const np = normalize(allPreamble)
    const nr = normalize(replyText)
    // If preamble is contained in the reply or vice versa (>80% overlap), it's a duplicate.
    const shorter = np.length < nr.length ? np : nr
    const longer = np.length < nr.length ? nr : np
    if (shorter.length > 0 && longer.includes(shorter.slice(0, Math.floor(shorter.length * 0.8)))) {
      const maxIndex = Math.max(...toForward.map(x => x.index))
      state.forwarded_up_to = maxIndex
      try { writeFileSync(stateFile, JSON.stringify(state)) } catch {}
      process.exit(0)
    }
  }

  let token = ''
  try { token = readFileSync(tokenFile, 'utf8').trim() } catch {}
  if (!token) process.exit(0)

  // Persist state before sending — avoids double-send if we crash mid-request.
  const maxIndex = Math.max(...toForward.map(x => x.index))
  state.forwarded_up_to = maxIndex
  try { writeFileSync(stateFile, JSON.stringify(state)) } catch {}

  // Wrap in italics so internal thinking is visually distinct from the reply.
  const allText = '_' + toForward.map(x => x.text).join('\n\n') + '_'

  const chunks = []
  let rest = allText
  while (rest.length > 2000) {
    let cut = rest.lastIndexOf('\n', 2000)
    if (cut < 1000) cut = 2000
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)

  await new Promise(resolve => {
    function post(idx) {
      if (idx >= chunks.length) { resolve(); return }
      const body = JSON.stringify({ content: chunks[idx] })
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
