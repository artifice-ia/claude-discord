# Changelog

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
