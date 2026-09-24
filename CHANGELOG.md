# Changelog

## 0.8.2

- Bump `@artifice-ia/fleet-bus` to `bazfer/yugo2#5f609e8`, deploying **yugo #26
  Release 1**: the dedup-store `INSERT` now names its columns explicitly instead
  of binding positionally, in both the TypeScript and Python ports.

  This is forward-compatibility groundwork with **no behavioural change today**.
  Release 2 adds `DEFAULT`ed columns to `envelope_dedup_v2`, and an
  unnamed-column `INSERT` fails against a wider table *regardless of DEFAULT*
  (`table envelope_dedup_v2 has 7 columns but 6 values were supplied`). So the
  named form has to reach every accessor before the columns exist, which is only
  possible as its own release.

  Verified against the live six-column stores: the named columns match on disk
  exactly — same names, same order, same count. No migration, no existing row
  reinterpreted.

  **Known coverage gap, recorded deliberately:** the yugo suite passes with this
  change reverted, because every test uses a six-column table where positional
  and named `INSERT` behave identically. Neither repo's CI distinguishes the two
  forms. A test with teeth requires a *wider* table — create the v2 table,
  `ALTER TABLE ... ADD COLUMN`, then claim — and that arrives with Release 2.

## 0.8.1

- Bump manifests to 0.8.1; correct the `Uint8Array` comment.

## 0.8.0

- **Validate every tool handler's arguments at runtime, not just `bus_reply`**
  (`src/args-validation.ts`, issue #39). The MCP low-level SDK validates only the
  generic `tools/call` envelope — the `inputSchema` advertised in `tools/list` is
  documentation, not enforcement — so handlers previously received whatever the
  caller sent.

  **This narrows accepted input on several call sites.** Values the earlier
  release silently tolerated now return a tool error naming the offending key:
  `reply_to: null` and `files: null` (previously coerced to "absent"), a
  stringified `limit` such as `"50"` (previously coerced by `Math.min`), and
  stringified `wait` / `force` / `timeout_ms` on `bus_request` (previously
  ignored, taking the default). Each of these was already invalid against the
  published `inputSchema`; the validation makes the declared contract real.

  These throws are caught and converted to `{isError: true}` tool results — the
  process does not die and the caller can retry. If a bot goes unexpectedly quiet
  after upgrading, check stderr for `must be a string when provided` first.

- Add a `bun test` + `tsc --noEmit` CI workflow, a `tsconfig.json` and dev
  dependencies (issue #37). The repo previously had no typecheck at all.
- Pin `bus_reply`'s `req_id` / `payload` / `kind` guards with tests (issue #38).

## 0.7.4

- Propagate the fleet-bus reply authority token: `publishReply` takes a
  per-attempt `replyToken` as **required-and-nullable** (`string | null`) rather
  than optional. An optional parameter whose omission disables the feature
  compiles clean at every unmigrated call site and then fails every reply at
  runtime.
- Pin `@artifice-ia/fleet-bus` to Expand only (`37b01fd`).

## 0.7.3

- Add `claude-opus-5` to the context-window map.

## 0.7.2

- Point `@artifice-ia/fleet-bus` at `bazfer/yugo2` (`3ee65d1`). Same package, same
  version (0.2.0), same exports — the merged repo now carries the TypeScript
  contract at its root alongside the Python implementation. No source changes.
- The move was forced by bun: it cannot install a git dependency from a
  subdirectory (oven-sh/bun#15506 open, PR #33251 unmerged), so the package must
  live at a repo root. Merging in place would have broken this plugin's
  dependency, which is why yugo2 is a new repo rather than a rewritten one.

## 0.7.0 - 2026-08-27
- Wire `@artifice-ia/fleet-bus@0.2.0` (`bazfer/fleet-bus` at 71c2c6c) — Stage 4 adapter work per `~/vault/projects/fleet/bus/adapter-designs/CLAUDE-CODE-SESSION-ADAPTER-DESIGN.md` (v3).
- Replace stub `FleetBus.connect()` with the package's supervisor loop (`bus.run()` / `bus.stop()`); reconnects across NATS blips (SPEC §1.7).
- Add four MCP tools for bus-side reasoning: `bus_request`, `bus_reply`, `bus_status`, `bus_history`.
- Injection frame now surfaces baton lineage (`root_id`, `origin`, `owner`, `hops`), `unsolicited="true"` on ledger-unmatched `.result`, and `late_reply_env_id` on evicted-request replies. Payload body uses the package's 8KB cap + XML escape.
- New env knobs: `FLEET_BUS_MODE` (`primary` / `publish-only`), `FLEET_BUS_HEARTBEAT_INTERVAL_MS`, `FLEET_BUS_SUPERVISOR_SLEEP_MS`, plus the package's `FLEET_BUS_RATE_*` overrides.
- `bus_request` default-appends an adapter-aware reply-discipline hint on `kind: 'text_message'` — routed by recipient runtime. Codex-container peers get the `<BUS to='<self>' kind='result'>` extract hint; Claude Code peers get a `bus_reply` MCP-tool hint; unknown recipients get a protocol-neutral hint. Peer sets are env-overridable via `FLEET_CODEX_BOTS` and `FLEET_CLAUDE_BOTS` (comma-separated). Disable with `payload_wrap_hint: false`.
- Removed the `in_reply_to_env_id` bus_request parameter (Ohm PR #23 round-2 P1, Option B). The handler previously accepted it and logged to stderr while still originating a fresh request — a false-success contract violation. Request→reply lineage now flows exclusively through `bus_reply(req_id, ...)`. Follow-up issue tracks Option A (package receive-ledger accessor for wire-id lookup).
- `bus_status.state` reports `'connected'` only after the wrapped `connectFn` resolves a live NATS connection — prior behavior flipped to `'connected'` eagerly right after `start()` returned, so health checks saw green during a full outage (Ohm PR #23 round-3 blocker, closed issue #24). Initial state renamed `connecting` → `starting`.
- `parseOptionalPositiveInt` now rejects interval values above INT32_MAX (2,147,483,647 ms — Node's setTimeout ceiling). Above the ceiling, Node silently coerces the delay to 1ms, so `FLEET_BUS_HEARTBEAT_INTERVAL_MS=99999999999` would heartbeat 1000×/sec instead of ~once/year. Class check on the parser — every current and future `FLEET_BUS_*_MS` env inherits it (Ohm PR #23 round-3 blocker, closed issue #25).
- Version bump 0.5.0 → 0.7.0 (subsumes the deferred #22 refactor which swapped local Stage 1+2 for the packaged import).

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
