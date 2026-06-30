# Contributing to artifice-discord

## Version bumps for runtime plugin changes

Every PR that changes runtime plugin code MUST include a version bump in both
`package.json` and `.claude-plugin/plugin.json`. Claude Code `/plugin update`
compares plugin version strings (NOT git SHAs) to decide whether to re-
materialize the plugin cache. Without a bump, users running `/plugin update`
get a silent no-op.

- Minor bump (`0.X.0`) for new features or breaking changes.
- Patch bump (`0.X.Y`) for pure fixes / docs / non-runtime changes.

## After a plugin update

Claude Code v2.1.196+ marks updated MCP servers as "needs auth" and refuses to
spawn them on next startup until approved. After running `/plugin update`,
either:

- Type `/mcp` in the Claude Code TUI to approve, OR
- Run `claude mcp login artifice-discord` from a bash terminal.

## Required env vars

Set these in `~/.claude/channels/discord/.env`:

- `DISCORD_BOT_TOKEN` (required) — your Discord bot's token
- `DISCORD_GUILD_ID` (required) — the Discord server ID
- `DISCORD_VOICE_USER_ID` (required if using voice) — Discord user ID the
  voice bot listens to
- `DISCORD_VOICE_USER_NAME` (optional) — display name for voice user, used in
  slash command descriptions and transcript metadata. Defaults to "The
  configured user". Trimmed; falls back to default if >50 chars.
- `OPENAI_API_KEY` (required if using voice) — for Whisper STT + TTS
