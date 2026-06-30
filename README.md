# artifice-discord

Two-way Discord channel for Claude Code. A fork of Anthropic's official `discord` plugin, rebranded to own the full inbound+outbound pipe for the Artifice fleet — and the foundation for live tool-usage streaming (see [PLAN.md](./PLAN.md)).

When the bot receives a message, the MCP server forwards it to Claude and provides tools to reply, react, edit, fetch history, and download attachments.

> **Fork note:** upstream is `anthropics/claude-plugins-official` (`external_plugins/discord`). This repo gutted the monorepo down to just that plugin and rebranded it: plugin name, MCP server name, and skill namespace are all `artifice-discord`. State still lives under `~/.claude/channels/discord/` so it inherits the existing channel allowlist. Pull upstream fixes by cherry-picking from the `upstream` remote.

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.
- Voice mode requires an OpenAI API key (`OPENAI_API_KEY`) for Whisper (STT) and tts-1 (TTS).

## Quick Setup
> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a Discord application and bot.**

Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Give it a name.

Navigate to **Bot** in the sidebar. Give your bot a username.

Scroll down to **Privileged Gateway Intents** and enable **Message Content Intent** — without this the bot receives messages with empty content.

**2. Generate a bot token.**

Still on the **Bot** page, scroll up to **Token** and press **Reset Token**. Copy the token — it's only shown once. Hold onto it for step 5.

**3. Invite the bot to a server.**

Discord won't let you DM a bot unless you share a server with it.

Navigate to **OAuth2** → **URL Generator**. Select the `bot` scope. Under **Bot Permissions**, enable:

- View Channels
- Send Messages
- Send Messages in Threads
- Read Message History
- Attach Files
- Add Reactions
- Connect
- Speak
- Use Voice Activity

Integration type: **Guild Install**. Copy the **Generated URL**, open it, and add the bot to any server you're in.

> For DM-only use you technically need zero permissions — but enabling them now saves a trip back when you want guild channels later.

**4. Install the plugin.**

This is a local fork, not a marketplace plugin. Point Claude Code at this checkout as a local plugin / marketplace, then `/reload-plugins`. (Exact wiring is finalized at cutover — see [PLAN.md](./PLAN.md) Phase 3.)

> **Do not run this alongside the official `discord` plugin.** Both open a Discord gateway connection; on the same bot token they fight for the same shard and knock each other offline. The cutover is atomic: this plugin on, the official plugin off, same restart.

**5. Give the server the token.**

```
/artifice-discord:configure MTIz...
```

Writes `DISCORD_BOT_TOKEN=...` to `~/.claude/channels/discord/.env`. You can also write that file by hand, or set the variable in your shell environment — shell takes precedence.

Voice features also read these environment variables:

- `DISCORD_VOICE_USER_ID` — required for voice features; set it to the Discord user ID the bot should listen to in voice channels.
- `DISCORD_VOICE_USER_NAME` — optional display name for voice transcripts; defaults to `User`.

> To run multiple bots on one machine (different tokens, separate allowlists), point `DISCORD_STATE_DIR` at a different directory per instance.

**6. Relaunch with the channel flag.**

The server won't connect without this — exit your session and start a new one:

```sh
claude --channels plugin:artifice-discord
```

**7. Pair.**

With Claude Code running from the previous step, DM your bot on Discord — it replies with a pairing code. If the bot doesn't respond, make sure your session is running with `--channels`. In your Claude Code session:

```
/artifice-discord:access pair <code>
```

Your next DM reaches the assistant.

**8. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/artifice-discord:access policy allowlist` directly.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, guild channels, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are Discord **snowflakes** (numeric — enable Developer Mode, right-click → Copy ID). Default policy is `pairing`. Guild channels are opt-in per channel ID.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a channel. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments — max 10 files, 25MB each. Auto-chunks; files attach to the first chunk. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to any message by ID. Unicode emoji work directly; custom emoji need `<:name:id>` form. |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Only works on the bot's own messages. |
| `fetch_messages` | Pull recent history from a channel (oldest-first). Capped at 100 per call. Each line includes the message ID so the model can `reply_to` it; messages with attachments are marked `+Natt`. Discord's search API isn't exposed to bots, so this is the only lookback. |
| `download_attachment` | Download all attachments from a specific message by ID to `~/.claude/channels/discord/inbox/`. Returns file paths + metadata. Use when `fetch_messages` shows a message has attachments. |

Inbound messages trigger a typing indicator automatically — Discord shows
"botname is typing…" while the assistant works on a response.

## Voice mode

Voice mode lets the configured user speak in a Discord voice channel and have the assistant hear (STT) and optionally speak back (TTS).

Configuration:

```sh
export OPENAI_API_KEY=sk-...
export DISCORD_VOICE_USER_ID=123456789012345678
# Optional:
export DISCORD_VOICE_USER_NAME="User"
```

STT uses OpenAI Whisper (`whisper-1`). TTS uses OpenAI `tts-1`.

Usage:

- Join the voice channel the configured user is currently in: `/voice join`
- Leave voice: `/voice leave`
- Switch voice mode: `/voice mode <full|listen>`
  - `listen` (default) — transcribes speech, replies in text only
  - `full` — transcribes speech and speaks replies back via TTS

Notes:

- The bot does not hardcode a channel ID; it looks up the configured user's current voice channel when `/voice join` runs.
- Voice mode requires `DISCORD_VOICE_USER_ID`; set it to the Discord user ID the bot should listen to in voice channels.
- The bot buffers the configured user's Discord Opus packets while PTT is active, ignores taps under 300ms, transcribes on PTT release, and auto-leaves after 10 minutes of inactivity.
- TTS voice defaults to `onyx`; set `tts_voice:` in `~/.claude/persona.md` to override (valid values: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`).
- Voice mode resets to the default (`listen`) on each new `/voice join`.

## Attachments

Attachments are **not** auto-downloaded. The `<channel>` notification lists
each attachment's name, type, and size — the assistant calls
`download_attachment(chat_id, message_id)` when it actually wants the file.
Downloads land in `~/.claude/channels/discord/inbox/`.

Same path for attachments on historical messages found via `fetch_messages`
(messages with attachments are marked `+Natt`).
