#!/usr/bin/env node
// discord-postreply-preamble.js — PostToolUse hook (reply tool)
// After the reply tool fires, check for assistant text in the current turn
// that wasn't included in the reply. Edit the sent Discord message to prepend
// the preamble — one message, preamble on top, reply below a divider.
//
// Why PostToolUse and not PreToolUse: text entries are written to the JSONL
// transcript when the tool fires, not when the text is generated. PreToolUse
// fires before that write, so the transcript never has the preamble yet.
// PostToolUse fires after, making the entries available for reading.

const { readFileSync, writeFileSync } = require('fs')
const { request } = require('https')
const { join } = require('path')
const { homedir, tmpdir } = require('os')

const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const tokenFile = join(claudeDir, 'discord-token')
const personaPath = join(claudeDir, 'persona.md')

const REPLY_TOOL = 'mcp__plugin_artifice-discord_artifice-discord__reply'

function readFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const result = {}
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+):\s*"?([^"]*)"?\s*$/)
    if (m) result[m[1]] = m[2].trim()
  }
  return result
}

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

function hasReplyCall(content) {
  return Array.isArray(content) && content.some(b => b && b.type === 'tool_use' && b.name === REPLY_TOOL)
}

let raw = ''
process.stdin.on('data', c => { raw += c })
process.stdin.on('end', async () => {
  let payload = {}
  try { payload = JSON.parse(raw) } catch { process.exit(0) }

  const { session_id, transcript_path, tool_name, tool_input } = payload
  if (!transcript_path || !session_id) process.exit(0)

  const isReplyTool = tool_name === REPLY_TOOL
  const channel = tool_input && tool_input.chat_id
  const replyText = (tool_input && tool_input.text) || ''

  let persona = {}
  try { persona = readFrontmatter(require('fs').readFileSync(personaPath, 'utf8')) } catch {}
  const personaChannel = persona.discord_channel || ''

  // For the reply tool, we need the message ID to edit-in the preamble.
  let messageId = null
  if (isReplyTool) {
    const toolResp = payload.tool_response ?? payload.tool_result ?? ''
    const respStr = typeof toolResp === 'string' ? toolResp : JSON.stringify(toolResp)
    const msgIdMatch = respStr.match(/id[:\s"]+(\d{17,20})/)
    messageId = msgIdMatch && msgIdMatch[1]
    if (!messageId || !channel) process.exit(0)
  } else {
    // Non-reply tools: send preamble to persona channel if there is one.
    if (!personaChannel) process.exit(0)
  }

  // Per-session state — tracks which transcript entries have been prepended
  // so multiple reply calls in one turn don't double-forward.
  const stateFile = join(tmpdir(), `discord-postreply-${session_id}.json`)
  let state = { forwarded_up_to: -1 }
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')) } catch {}

  let entries
  try {
    entries = readFileSync(transcript_path, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch { process.exit(0) }

  // Find the current turn start: last non-tool-result user entry.
  let turnStart = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.type === 'user') {
      const content = e.message && e.message.content
      if (!isToolResult(content)) { turnStart = i; break }
    }
  }
  if (turnStart === -1) process.exit(0)

  // For reply tool: only collect text entries that appeared BEFORE the reply call.
  // For other tools: collect all new text entries up to now.
  let upperBound = entries.length
  if (isReplyTool) {
    let replyIndex = -1
    for (let i = entries.length - 1; i > turnStart; i--) {
      const e = entries[i]
      const content = e.message && e.message.content
      if (e.type === 'assistant' && hasReplyCall(content)) { replyIndex = i; break }
    }
    if (replyIndex === -1) process.exit(0)
    upperBound = replyIndex
  }

  // Collect text entries that haven't been forwarded yet.
  const toForward = []
  for (let i = turnStart + 1; i < upperBound; i++) {
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

  // Persist state before the network call to guard against double-send on crash.
  const maxIndex = Math.max(...toForward.map(x => x.index))
  state.forwarded_up_to = maxIndex
  try { writeFileSync(stateFile, JSON.stringify(state)) } catch {}

  const preamble = '_' + toForward.map(x => x.text).join('\n\n') + '_'

  const isFernandoChannel = personaChannel && channel === personaChannel

  await new Promise(resolve => {
    let body, path, method

    if (isReplyTool && isFernandoChannel) {
      // Patch reply message to prepend preamble — one message, preamble on top.
      const newContent = `${preamble}\n\n---\n\n${replyText}`
      const editContent = newContent.length > 2000 ? newContent.slice(0, 1997) + '...' : newContent
      body = JSON.stringify({ content: editContent })
      path = `/api/v10/channels/${channel}/messages/${messageId}`
      method = 'PATCH'
    } else {
      // Non-reply tool or fleet channel: send preamble as a standalone italic message
      // to persona channel so it appears immediately when the tool fires.
      const sendContent = preamble.length > 2000 ? preamble.slice(0, 1997) + '...' : preamble
      if (!personaChannel) { resolve(); return }
      body = JSON.stringify({ content: sendContent })
      path = `/api/v10/channels/${personaChannel}/messages`
      method = 'POST'
    }

    const req = request({
      hostname: 'discord.com',
      path,
      method,
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      res.on('data', () => {})
      res.on('end', () => resolve())
    })
    req.on('error', () => resolve())
    req.write(body)
    req.end()
    setTimeout(resolve, 5000)
  })

  process.exit(0)
})
