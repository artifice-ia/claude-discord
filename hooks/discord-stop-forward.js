#!/usr/bin/env node
// discord-stop-forward.js — Stop hook
// Safety net for Discord-bridged bots: when a turn was triggered by a Discord
// message but ended WITHOUT calling the reply tool, the agent's closing text
// only reached the terminal — invisible to the user. This forwards that text
// to the originating Discord channel so no response silently vanishes.
//
// Fires on Stop. Does nothing (exit 0) when: the turn already called reply, the
// trigger wasn't a Discord message, or there's no closing text. Never blocks.
//
// Race note: Stop fires before the final text entry is flushed to the transcript.
// We wait 300ms before reading so the write completes first.

const { readFileSync } = require('fs')
const { request } = require('https')
const { join } = require('path')
const { homedir } = require('os')

const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const personaPath = join(claudeDir, 'persona.md')
const tokenFile = join(claudeDir, 'discord-token')

const REPLY_TOOL = 'mcp__plugin_artifice-discord_artifice-discord__reply'
const DISCORD_SOURCE = 'source="plugin:artifice-discord:artifice-discord"'

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

  // We never block, so a re-prompt loop can't form — but bail anyway if flagged.
  if (payload.stop_hook_active) process.exit(0)

  const transcriptPath = payload.transcript_path
  if (!transcriptPath) process.exit(0)

  // Stop fires before the final text entry flushes to the transcript — wait for it.
  await new Promise(r => setTimeout(r, 300))

  let entries
  try {
    entries = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch { process.exit(0) }
  if (entries.length === 0) process.exit(0)

  // Walk backwards to find the most recent assistant entry that is EITHER a
  // text block or a reply call — whichever the turn ended on. Text blocks only
  // ever reach the terminal; the reply tool is the only path to Discord. So:
  //   - turn ended on text  → it leaked, forward it
  //   - turn ended on reply → covered, do nothing
  // Earlier text (pre-reply preamble, mid-turn narration) is intentionally
  // ignored — only the closing statement matters. This catches trailing text
  // emitted AFTER a reply, which is the common slip.
  let leakedText = ''
  let decided = false
  let triggerContent = null

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    const content = e.message && e.message.content
    if (e.type === 'assistant' && !decided) {
      if (hasReplyCall(content)) {
        decided = true // ended on (or covered by) a reply — nothing leaked
      } else {
        const t = textOf(content)
        if (t) { leakedText = t; decided = true }
        // thinking / tool_use(Bash) entries carry no text — keep walking
      }
    } else if (e.type === 'user') {
      if (isToolResult(content)) continue
      triggerContent = textOf(content)
      break
    }
  }

  if (!leakedText) process.exit(0)
  if (!triggerContent || !triggerContent.includes(DISCORD_SOURCE)) process.exit(0)

  let persona = {}
  try { persona = readFrontmatter(readFileSync(personaPath, 'utf8')) } catch {}
  const chatMatch = triggerContent.match(/chat_id="(\d+)"/)
  // Always forward to the persona's configured channel, not the trigger
  // channel — trigger may be a fan-out channel.
  const channel = persona.discord_channel || (chatMatch && chatMatch[1]) || ''
  if (!channel) process.exit(0)

  let token = ''
  try { token = readFileSync(tokenFile, 'utf8').trim() } catch {}
  if (!token) process.exit(0)

  // Discord hard-caps messages at 2000 chars — chunk on newline boundaries.
  const chunks = []
  let rest = leakedText
  while (rest.length > 2000) {
    let cut = rest.lastIndexOf('\n', 2000)
    if (cut < 1000) cut = 2000
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)

  function post(idx) {
    if (idx >= chunks.length) { process.exit(0); return }
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
    req.on('error', () => process.exit(0))
    req.write(body)
    req.end()
  }
  post(0)

  setTimeout(() => process.exit(0), 5000)
})
