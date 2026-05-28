#!/usr/bin/env node
// discord-commands.js — UserPromptSubmit hook
// Intercepts Discord messages that are dot-commands (e.g. .compact, .clear).
// Uses dot prefix instead of slash to avoid Discord's native slash command
// interaction system, which has a 3s ack deadline our hook can't guarantee.
// Executes the equivalent Claude Code command via tmux send-keys, then blocks
// the message from reaching Claude (exit code 2).
//
// Supported commands:
//   .compact        — compact context (same as typing /compact in terminal)
//   .clear          — clear conversation (same as typing /clear in terminal)
//   .model <name>   — switch model (sonnet / opus / haiku)
//
// Requires: bot is running in a tmux session named after persona `name` field.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const personaPath = path.join(claudeDir, 'persona.md');

const SUPPORTED_COMMANDS = ['.compact', '.clear', '.model'];

const MODEL_MAP = {
  'sonnet': 'claude-sonnet-4-6',
  'opus':   'claude-opus-4-7',
  'haiku':  'claude-haiku-4-5-20251001',
};

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

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(input); } catch { process.stdout.write('{}'); process.exit(0); return; }

  const prompt = (payload.prompt || payload.message || '').trim();

  // Only act on Discord messages
  if (!prompt.includes('source="plugin:artifice-discord:artifice-discord"')) {
    process.stdout.write('{}');
    process.exit(0);
    return;
  }

  // Extract the actual message text from the channel tag
  const msgMatch = prompt.match(/<channel[^>]*>([\s\S]*?)<\/channel>/);
  const msgText = msgMatch ? msgMatch[1].trim() : prompt;

  // Check if it's a supported slash command
  const command = SUPPORTED_COMMANDS.find(cmd => msgText === cmd || msgText.startsWith(cmd + ' '));
  if (!command) {
    process.stdout.write('{}');
    process.exit(0);
    return;
  }

  // Read persona for bot name + discord channel
  let persona = {};
  try { persona = readFrontmatter(fs.readFileSync(personaPath, 'utf8')); } catch {}

  const BOT_NAME = persona.name || 'bot';
  const DISCORD_CHANNEL = persona.discord_channel || '';
  const tokenFile = path.join(claudeDir, 'discord-token');
  let DISCORD_TOKEN = '';
  try { DISCORD_TOKEN = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}

  // Resolve .model arg → full model ID
  let claudeCommand;
  let ackMsg = `⚙️ \`${command}\` received — executing...`;
  let doneMsg = `✓ \`${command}\` done.`;

  if (command === '.model') {
    const arg = msgText.slice('.model'.length).trim().toLowerCase();
    const modelId = MODEL_MAP[arg];
    if (!modelId) {
      const valid = Object.keys(MODEL_MAP).join(', ');
      if (DISCORD_TOKEN && DISCORD_CHANNEL) {
        const body = JSON.stringify({ content: `❌ Unknown model \`${arg || '(none)'}\`. Valid options: ${valid}` });
        try {
          execSync(`curl -s -X POST https://discord.com/api/v10/channels/${DISCORD_CHANNEL}/messages \
            -H "Authorization: Bot ${DISCORD_TOKEN}" \
            -H "Content-Type: application/json" \
            -d '${body.replace(/'/g, "'\\''")}'`, { timeout: 5000 });
        } catch {}
      }
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '' } }));
      process.exit(2);
      return;
    }
    claudeCommand = `/model ${modelId}`;
    ackMsg = `⚙️ Switching to \`${modelId}\`...`;
    doneMsg = `✓ Now running \`${modelId}\`.`;
  } else {
    const CLAUDE_COMMAND_MAP = { '.compact': '/compact', '.clear': '/clear' };
    claudeCommand = CLAUDE_COMMAND_MAP[command] || command;
  }

  // Send acknowledgement to Discord
  if (DISCORD_TOKEN && DISCORD_CHANNEL) {
    const body = JSON.stringify({ content: ackMsg });
    try {
      execSync(`curl -s -X POST https://discord.com/api/v10/channels/${DISCORD_CHANNEL}/messages \
        -H "Authorization: Bot ${DISCORD_TOKEN}" \
        -H "Content-Type: application/json" \
        -d '${body.replace(/'/g, "'\\''")}'`, { timeout: 5000 });
    } catch {}
  }

  // Spawn detached process: trigger the Claude Code command, then send a completion ping to Discord.
  // The completion curl fires after a fixed delay (15s) — enough for compact/clear/model to finish.
  // Delay ensures current hook/message processing has fully exited first.
  const tmuxSession = BOT_NAME;
  const doneCurl = (DISCORD_TOKEN && DISCORD_CHANNEL)
    ? `sleep 15 && curl -s -X POST https://discord.com/api/v10/channels/${DISCORD_CHANNEL}/messages -H "Authorization: Bot ${DISCORD_TOKEN}" -H "Content-Type: application/json" -d '${JSON.stringify({ content: doneMsg }).replace(/'/g, "'\\''")}'`
    : '';
  const shellCmd = doneCurl
    ? `sleep 1 && tmux send-keys -t "${tmuxSession}" '${claudeCommand}' Enter && ${doneCurl}`
    : `sleep 1 && tmux send-keys -t "${tmuxSession}" '${claudeCommand}' Enter`;
  const child = spawn('sh', ['-c', shellCmd], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Block the message from reaching Claude (exit code 2)
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: ''
    }
  }));
  process.exit(2);
});
