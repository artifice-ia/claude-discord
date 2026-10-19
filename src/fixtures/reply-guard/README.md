Transcript fixtures for the reply-guard handoff. Each case loads one JSONL file through
loadFixture, so replacing a case means changing one filename.

`retry-unanswered` and `retry-replied` carry a REAL injected retry entry, captured from
Claude Code 2.1.303 on 2026-10-18: an isolated CLAUDE_CONFIG_DIR, a Stop hook that blocks
exactly once, one `claude -p` prompt. The capture showed the block reason arrives as a
`user` entry with `isMeta: true`, a plain-string body beginning `Stop hook feedback:`, and
NO `turnCompanion` field, and that the following Stop carries `stop_hook_active: true`. Only
the reason text is edited, to the guard's own wording.

The `discord-then-compact`, `retry-discord-then-compact`, and `compact-only` fixtures use
real entry structures captured from Kat's own transcripts (session 34e5b924, 2026-09-29 for
the local-command entries; session 239e14bd for the isCompactSummary entry). The local-command
entries are from /plugin and /reload-plugins runs — structurally identical to /compact. The
isCompactSummary field is real and verified present on the actual compact summary entries.
Only the command name (changed to /compact) and stdout text (changed to Compacted...) differ.

The remaining cases are synthetic. The `image` case ports the prior shell regression shape.
