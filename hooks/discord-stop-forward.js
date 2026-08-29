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

// Strip prompt-scaffolding blocks the model may have hallucinated back into
// its text output. `<system-reminder>...</system-reminder>` and `<channel
// source="plugin:artifice-discord:..." ...>...</channel>` are Claude Code
// injection wrappers — they belong to the transcript view, not to a
// user-facing Discord reply. If the model echoes them (which it sometimes
// does when producing forced-visible output on empty turns), we don't want
// that leaking to the user's DM. Returns cleaned text; caller decides
// whether the residue is worth forwarding.
//
// Two-pass filter: paired-tag strips first (catches well-formed multi-line
// blocks), then line-start strips (catches stray unpaired tags and role
// markers, e.g. the "tools not used" nudge Claude Code injects as
// `Human: <system-reminder>...` into a response buffer when the previous
// turn ended on a tool call with no trailing prose). Logs to stderr on
// every match so operators can trace what fired without leaking the
// stripped text itself into logs.
function stripPromptScaffolding(text) {
  if (!text) return ''
  let cleaned = text

  // Paired-block strips — non-greedy so distinct blocks don't merge.
  const pairedFilters = [
    ['system_reminder_block', /<system-reminder\b[\s\S]*?<\/system-reminder>/g],
    ['channel_block', /<channel\s+source="[^"]*"[\s\S]*?<\/channel>/g],
  ]
  for (const [name, re] of pairedFilters) {
    const before = cleaned
    cleaned = cleaned.replace(re, '')
    if (cleaned !== before) {
      console.error(`[discord-stop-forward] filter fired: ${name}`)
    }
  }

  // Taint-remainder pass — any UNPAIRED wrapper opener that survived the
  // paired-block strip means the transcript was truncated mid-scaffold and
  // the closing tag never landed. The body between the opener and end-of-
  // text is scaffolding, not response content. Preserve everything BEFORE
  // the earliest surviving opener, discard opener + everything after.
  // Ohm PR #28 P1: without this the previous pass only stripped the opener
  // physical line and the multi-line body still reached Discord.
  // Openers matched anywhere in text (not just line-start): a role prefix
  // like `Human: <system-reminder>` puts the opener mid-line, and treating
  // the wrapper as line-start-only lets human_line drop the physical line
  // and leave the multi-line body behind.
  const openerPatterns = [
    ['system_reminder_open_taint', /<system-reminder\b/i],
    ['channel_open_taint', /<channel\s+source=/i],
    ['user_prompt_submit_hook_open_taint', /<user-prompt-submit-hook\b/i],
  ]
  let earliestIdx = -1
  let earliestName = null
  for (const [name, re] of openerPatterns) {
    const m = re.exec(cleaned)
    if (m && (earliestIdx === -1 || m.index < earliestIdx)) {
      earliestIdx = m.index
      earliestName = name
    }
  }
  if (earliestIdx !== -1) {
    // Rewind to start of the physical line — preserves legit prose ONLY when
    // the opener is on its own line; if the opener is inlined after content
    // like `Human: <system-reminder>`, that whole line was scaffolding anyway
    // (line-start-strip would have removed it next). Truncating at line-start
    // keeps behavior consistent for both cases.
    let lineStart = cleaned.lastIndexOf('\n', earliestIdx - 1)
    lineStart = lineStart === -1 ? 0 : lineStart + 1
    cleaned = cleaned.slice(0, lineStart)
    console.error(`[discord-stop-forward] filter fired: ${earliestName}`)
  }

  // Line-start strips — role prefixes on their own lines that aren't wrapped
  // in scaffold tags (`Human:`, `Assistant:`, lone `User:`). Case-insensitive,
  // leading whitespace allowed. Whole line drops (marker + any content after
  // it). Runs AFTER the taint-remainder pass so it only sees text that
  // survived scaffold truncation.
  const lineFilters = [
    ['human_line', /^\s*Human:.*$/gim],
    ['assistant_line', /^\s*Assistant:.*$/gim],
    ['user_line', /^\s*User:\s*$/gim],
  ]
  for (const [name, re] of lineFilters) {
    const before = cleaned
    cleaned = cleaned.replace(re, '')
    if (cleaned !== before) {
      console.error(`[discord-stop-forward] filter fired: ${name}`)
    }
  }

  return cleaned.replace(/\n{3,}/g, '\n\n').trim()
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

  // Sanitize before forwarding: drop any echoed prompt-scaffolding tags
  // (Claude Code's `<system-reminder>` and this plugin's `<channel>` wrapper).
  // If nothing meaningful remains, don't forward the noise.
  leakedText = stripPromptScaffolding(leakedText)
  if (!leakedText) process.exit(0)

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
