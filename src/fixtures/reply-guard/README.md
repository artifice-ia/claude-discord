Transcript fixtures for the reply-guard handoff. Each case loads one JSONL file through
loadFixture, so replacing a case means changing one filename.

`retry-unanswered` and `retry-replied` carry a REAL injected retry entry, captured from
Claude Code 2.1.303 on 2026-10-18: an isolated CLAUDE_CONFIG_DIR, a Stop hook that blocks
exactly once, one `claude -p` prompt. The capture showed the block reason arrives as a
`user` entry with `isMeta: true`, a plain-string body beginning `Stop hook feedback:`, and
NO `turnCompanion` field, and that the following Stop carries `stop_hook_active: true`. Only
the reason text is edited, to the guard's own wording.

The remaining cases are synthetic. The `image` case ports the prior shell regression shape.
