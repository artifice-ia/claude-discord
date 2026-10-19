#!/usr/bin/env node
// discord-loop-tick.js — PostToolUse hook
// Announces loop ticks to persona.loops_channel when ScheduleWakeup or CronCreate fires.

const { createHash } = require('crypto')
const { readFileSync, writeFileSync } = require('fs')
const { request } = require('https')
const { join } = require('path')
const { homedir } = require('os')

const SCHEDULING_TOOLS = new Set(['ScheduleWakeup', 'CronCreate'])

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

const _ownerFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function ownerTime(date) {
  return _ownerFmt.format(date)
}

function relativeTime(ms) {
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `in ${mins}m`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem === 0 ? `in ${hrs}h` : `in ${hrs}h${rem}m`
}

// Loop ID: stable within a session for the same loop prompt.
// session_id is included so a session restart starts fresh state rather than
// inheriting a stale quiet streak from a previous run of the same loop.
function loopId(sessionId, prompt) {
  return createHash('sha256').update(`${sessionId}:${prompt}`).digest('hex').slice(0, 12)
}

function stateFilePath(id) {
  const tmp = process.env.TMPDIR || '/tmp'
  return join(tmp, `artifice-loop-tick-${id}.json`)
}

function readState(id) {
  try { return JSON.parse(readFileSync(stateFilePath(id), 'utf8')) } catch { return null }
}

function saveState(id, state) {
  try { writeFileSync(stateFilePath(id), JSON.stringify(state)) } catch {}
}

function discordRequest(method, path, token, body, cb) {
  const bodyStr = JSON.stringify(body)
  const req = request({
    hostname: 'discord.com',
    path,
    method,
    headers: {
      'Authorization': `Bot ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    },
  }, res => {
    let data = ''
    res.on('data', chunk => { data += chunk })
    res.on('end', () => {
      if (res.statusCode && res.statusCode >= 400) {
        process.stderr.write(`loop-tick: ${method} ${path} returned ${res.statusCode}\n`)
      }
      cb(null, data)
    })
  })
  req.on('error', err => cb(err, null))
  req.write(bodyStr)
  req.end()
}

if (require.main === module) {
  let raw = ''
  process.stdin.on('data', chunk => { raw += chunk })
  process.stdin.on('end', () => {
    let payload = {}
    try { payload = JSON.parse(raw) } catch { process.exit(0) }

    const tool = payload.tool_name || ''
    if (!SCHEDULING_TOOLS.has(tool)) process.exit(0)

    const inp = payload.tool_input || {}

    if (inp.stop === true) process.exit(0)

    const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    let persona = {}
    try { persona = readFrontmatter(readFileSync(join(claudeDir, 'persona.md'), 'utf8')) } catch {}

    const channel = persona.loops_channel || ''
    if (!channel) process.exit(0)

    let token = ''
    try { token = readFileSync(join(claudeDir, 'discord-token'), 'utf8').trim() } catch {}
    if (!token) process.exit(0)

    const now = new Date()
    const allowedMentions = { parse: [] }

    if (tool === 'CronCreate') {
      const cronExpr = inp.schedule || inp.cron_expression || inp.cron || ''
      const firstLine = (inp.prompt || '').split('\n')[0].slice(0, 100)
      const content = [`📅 cron registered`, `schedule: \`${cronExpr}\``, firstLine].filter(Boolean).join('\n')
      discordRequest('POST', `/api/v10/channels/${channel}/messages`, token,
        { content, allowed_mentions: allowedMentions },
        () => process.exit(0))
      setTimeout(() => process.exit(0), 5000)
      return
    }

    // ScheduleWakeup
    const sessionId = payload.session_id || ''
    const prompt = inp.prompt || ''
    const reason = (inp.reason || '').slice(0, 200)
    const noop = inp.noop === true
    const delaySeconds = Number(inp.delaySeconds) || 0
    const nextDate = new Date(now.getTime() + delaySeconds * 1000)
    const nextStr = `${ownerTime(nextDate)} (${relativeTime(delaySeconds * 1000)})`

    const id = loopId(sessionId, prompt)
    const state = readState(id)

    // Only edit if the previous message was itself a quiet tick. A noop tick must
    // not overwrite a message that reported a real event — that would destroy the
    // channel record of what happened.
    if (noop && state && state.msg_id && state.is_quiet === true) {
      const streak = state.streak + 1
      const content = `⏰ loop tick — quiet x${streak}\ndid: ${reason}\nnext: ${nextStr}`
      discordRequest('PATCH', `/api/v10/channels/${channel}/messages/${state.msg_id}`, token,
        { content, allowed_mentions: allowedMentions },
        () => {
          saveState(id, { msg_id: state.msg_id, channel, streak, is_quiet: true })
          process.exit(0)
        })
    } else {
      const streak = noop ? 1 : 0
      const content = noop
        ? `⏰ loop tick — quiet x1\ndid: ${reason}\nnext: ${nextStr}`
        : `⏰ loop tick\ndid: ${reason}\nnext: ${nextStr}`
      discordRequest('POST', `/api/v10/channels/${channel}/messages`, token,
        { content, allowed_mentions: allowedMentions },
        (err, data) => {
          try {
            const json = JSON.parse(data)
            if (json.id) saveState(id, { msg_id: json.id, channel, streak, is_quiet: noop })
          } catch {}
          process.exit(0)
        })
    }

    setTimeout(() => process.exit(0), 5000)
  })
}

module.exports = { ownerTime }
