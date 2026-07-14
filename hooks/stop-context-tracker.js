#!/usr/bin/env node
// stop-context-tracker.js — fires on Stop event.
// 1. Calculates real context usage from session JSONL.
// 2. Writes /tmp/<name>-ctx.json + /tmp/<name>-ctx.txt for statusLine.
// 3. At 70%+ context: sets /tmp/<name>-memory-save.flag.
// 4. Checks if last Discord message got a reply — sets missed-reply flag if not.
// Bot name and Discord channel are read from ~/.claude/persona.md frontmatter.
// Discord bot token is read from ~/.claude/discord-token (never hardcoded).

const fs = require('fs');
const https = require('https');
const path = require('path');
const os = require('os');

// Fallback if the model is unknown. Real limit is looked up per-model at run
// time from the last assistant entry's `message.model`.
const CONTEXT_LIMIT_FALLBACK = 200_000;
const MEMORY_SAVE_THRESHOLD = 0.70;

// Model → context-window size (tokens). Update when new models ship.
// Missing → CONTEXT_LIMIT_FALLBACK. Deet was reporting 386%+ before this
// map existed because the hardcoded 200k didn't match Opus 4.7's 1M window.
const MODEL_CONTEXT_WINDOWS = {
  "claude-opus-4-7":        1_000_000,
  "claude-opus-4-8":        1_000_000,
  "claude-opus-4-6":        1_000_000,
  "claude-opus-4-5":        200_000,
  "claude-sonnet-5":        1_000_000,
  "claude-sonnet-4-6":      1_000_000,
  "claude-haiku-4-5":       200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-fable-5":         1_000_000,
};

// Claude Code caps context at 200K for any model when this env var is set.
// See https://code.claude.com/docs/en/model-config — `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`
// treats Sonnet 5 sessions as having a 200K window, and by extension applies to
// any other 1M-native model the user runs.
const CAPPED_LIMIT = 200_000;
function is1MDisabled() {
  return process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1';
}

function windowForModel(modelId) {
  if (!modelId) return CONTEXT_LIMIT_FALLBACK;
  const disabled = is1MDisabled();
  let raw = MODEL_CONTEXT_WINDOWS[modelId];
  if (raw === undefined) {
    // Prefix match: `claude-opus-4-7-20260415` → `claude-opus-4-7`
    for (const [prefix, window] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
      if (modelId.startsWith(prefix)) { raw = window; break; }
    }
  }
  if (raw === undefined) return disabled ? CAPPED_LIMIT : CONTEXT_LIMIT_FALLBACK;
  return disabled && raw > CAPPED_LIMIT ? CAPPED_LIMIT : raw;
}

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const personaPath = path.join(claudeDir, 'persona.md');
const tokenFile = path.join(claudeDir, 'discord-token');

function readFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+):\s*"?([^"]*)"?\s*$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

let persona = {};
try { persona = readFrontmatter(fs.readFileSync(personaPath, 'utf8')); } catch {}

const BOT_NAME = persona.name || 'bot';
const DISCORD_CHANNEL = persona.discord_channel || '';
let DISCORD_TOKEN = '';
try { DISCORD_TOKEN = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}

const CTX_JSON = `/tmp/${BOT_NAME}-ctx.json`;
const CTX_TXT = `/tmp/${BOT_NAME}-ctx.txt`;
const MEM_FLAG = `/tmp/${BOT_NAME}-memory-save.flag`;
const DISCORD_SENT_FLAG = `/tmp/${BOT_NAME}-memory-discord-sent.flag`;
const MISSED_REPLY_FLAG = `/tmp/${BOT_NAME}-missed-discord-reply.flag`;

function findRecentSession() {
  const projectsDir = path.join(claudeDir, 'projects');
  let best = null;
  const stack = [];
  try {
    for (const e of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      stack.push(path.join(projectsDir, e.name));
    }
  } catch { return null; }

  while (stack.length) {
    const p = stack.pop();
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      try {
        for (const child of fs.readdirSync(p)) stack.push(path.join(p, child));
      } catch {}
    } else if (p.endsWith('.jsonl') && (!best || st.mtimeMs > best.mtime)) {
      best = { file: p, mtime: st.mtimeMs };
    }
  }
  return best ? best.file : null;
}

function parseSession(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return null; }

  const entries = [];
  let lastInputTokens = 0;
  let lastModel = null;
  let totalOutputTokens = 0;
  let turns = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    entries.push(entry);
    if (entry.type !== 'assistant' || !entry.message?.usage) continue;
    const u = entry.message.usage;
    lastInputTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    lastModel = entry.message.model || lastModel;
    totalOutputTokens += (u.output_tokens || 0);
    turns++;
  }

  return { lastInputTokens, lastModel, totalOutputTokens, turns, entries };
}

// Returns: 'discord_no_reply' | 'discord_replied' | 'not_discord'
function checkDiscordReply(entries) {
  let lastDiscordIdx = -1;

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'user') continue;
    const content = e.message?.content;
    if (!content) continue;

    if (Array.isArray(content) && content.every(c => c.type === 'tool_result')) continue;

    const textParts = Array.isArray(content)
      ? content.filter(c => c.type === 'text').map(c => c.text).join('')
      : (typeof content === 'string' ? content : '');

    if (textParts.includes('source="plugin:artifice-discord:artifice-discord"')) {
      lastDiscordIdx = i;
      break;
    } else {
      break;
    }
  }

  if (lastDiscordIdx === -1) return 'not_discord';

  for (let i = lastDiscordIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== 'assistant') continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    const hasReply = content.some(
      c => c.type === 'tool_use' && c.name && c.name.includes('discord') && c.name.includes('reply')
    );
    if (hasReply) return 'discord_replied';
  }

  return 'discord_no_reply';
}

// Returns HTTP status code, or null on network error/timeout.
function postToDiscord(channelId, message) {
  if (!DISCORD_TOKEN || !channelId) return Promise.resolve(null);
  const body = JSON.stringify({ content: message });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages`,
      method: 'POST',
      headers: {
        'Authorization': `Bot ${DISCORD_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

let input = '';
process.stdin.resume();
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  const sessionFile = findRecentSession();
  if (!sessionFile) { process.exit(0); return; }

  const parsed = parseSession(sessionFile);
  if (!parsed || parsed.turns === 0) { process.exit(0); return; }

  const { lastInputTokens, lastModel, totalOutputTokens, turns, entries } = parsed;
  const contextLimit = windowForModel(lastModel);
  const pct = Math.round((lastInputTokens / contextLimit) * 100);
  const inputK = Math.round(lastInputTokens / 1000);
  const limitK = Math.round(contextLimit / 1000);

  const data = {
    pct,
    inputTokens: lastInputTokens,
    outputTokens: totalOutputTokens,
    limit: contextLimit,
    model: lastModel,
    turns
  };
  const text = `ctx ${pct}% | ${inputK}k/${limitK}k in | ${totalOutputTokens.toLocaleString()} out`;

  try {
    fs.writeFileSync(CTX_JSON, JSON.stringify(data));
    fs.writeFileSync(CTX_TXT, text);
  } catch {}

  // At 70%+: always write memory alarm flag. Discord notification uses separate dedup flag.
  if (lastInputTokens / contextLimit >= MEMORY_SAVE_THRESHOLD) {
    try {
      fs.writeFileSync(MEM_FLAG, JSON.stringify({ pct, inputTokens: lastInputTokens, ts: Date.now() }));
    } catch {}

    if (!fs.existsSync(DISCORD_SENT_FLAG)) {
      const msg = `⚠️ Context at ${pct}% (${inputK}k/${limitK}k). Memory save alarm set — I'll write session summary to scroll + graph on next message.`;
      const status = await postToDiscord(DISCORD_CHANNEL, msg);
      if (status !== null && status >= 200 && status < 300) {
        try { fs.writeFileSync(DISCORD_SENT_FLAG, JSON.stringify({ pct, ts: Date.now() })); } catch {}
      }
    }
  }

  // Discord reply check
  const replyStatus = checkDiscordReply(entries);
  if (replyStatus === 'discord_no_reply') {
    try { fs.writeFileSync(MISSED_REPLY_FLAG, JSON.stringify({ ts: Date.now() })); } catch {}
  } else if (replyStatus === 'discord_replied') {
    try { fs.unlinkSync(MISSED_REPLY_FLAG); } catch {}
  }

  process.exit(0);
});
