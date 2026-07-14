# Changelog

## 0.2.8 - 2026-07-14
- `stop-context-tracker.js`: resolve context window per model instead of assuming 200K. Maps Opus 4.6/4.7/4.8, Sonnet 4.6/5, and Fable 5 to their real 1M windows; Opus 4.5, Haiku 4.5, and unknown models fall back to 200K. Honors `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` and clamps 1M to 200K when `ANTHROPIC_BASE_URL` is set (gateway can't advertise 1M unless the `sonnet[1m]` alias is picked). Fixes the >100% ctx numbers Deet was reporting on Opus 4.7.

## 0.2.7 - 2026-07-03
- Pin @discordjs/builders to 1.14.1 to work around a crash caused by the @sapphire/shapeshift@4.0.0 nativeEnum regression on discord.js 14.25.x
- Sync .claude-plugin/plugin.json version with package.json

## 0.2.6 - 2026-07-03
- Update the opus model mapping to claude-opus-4-8

## 0.2.5 - 2026-07-02
- Skip post-reply preamble forwarding immediately when the reply tool is sending non-empty text, preventing duplicate sends
- Remove unregistered orphan hook `hooks/discord-preply-forward.js`
- Update the `sonnet` model mapping to `claude-sonnet-5`
- Reword README upstream attribution to say the plugin is based on `anthropics/claude-plugins-official` without fork framing

## 0.2.4 - 2026-07-02
- Add fable model support in /model command

## 0.2.3 - 2026-06-30
- Correct author/owner attribution
- Drop internal keyword; add SEO-relevant keywords (claude-code, agent, ai)
- README opening rewritten to lead with user benefit
- Trim Fork note callout
- Add "What's different from the official plugin" section
- Add CHANGELOG.md
- Add version + license badges
- Fix package.json formatting

## 0.2.2 - 2026-06-30
- Polish public-facing descriptions in marketplace.json and plugin.json (drop internal references)

## 0.2.1 - 2026-06-30
- Minor cleanup of internal references in comments, variable names, and state file paths
- Replace PLAN.md (internal dev tracker) with CONTRIBUTING.md (public standing rules)

## 0.2.0 - 2026-06-30
- Genericize hardcoded Discord user ID — DISCORD_VOICE_USER_ID env var now required
- Template user-visible voice strings against new DISCORD_VOICE_USER_NAME env var
- voiceUserName() helper trims/validates env input; falls back to "The configured user" if empty or >50 chars
- Slash command descriptions stay under Discord's 100-char limit

## 0.1.0 - 2026-05-28
- Initial fork of anthropics/claude-plugins-official discord plugin
