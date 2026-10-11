#!/usr/bin/env bash
# Does the Stop hook REFUSE to end a turn with an unanswered Discord message?
#
# The check it guards has existed since the hook was written and did nothing, because its
# only action was writing a flag no code reads. These cases assert the consequence, not
# the detection.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/../hooks/stop-context-tracker.js"
PASS=0; FAIL=0
ok()  { printf '  pass  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; rm -f /tmp/hooktest-reply-guard-blocked.json /tmp/hooktest-missed-discord-reply.flag' EXIT
mkdir -p "$WORK/projects/p"
printf 'name: hooktest\n' > "$WORK/persona.md"
printf -- '---\nname: hooktest\n---\n' > "$WORK/persona.md"

DISCORD_MSG='<channel source=\"plugin:artifice-discord:artifice-discord\" chat_id=\"1\">hi</channel>'

write_session() {
  : > "$WORK/projects/p/s.jsonl"
  for line in "$@"; do printf '%s\n' "$line" >> "$WORK/projects/p/s.jsonl"; done
}

run() { echo '{}' | CLAUDE_CONFIG_DIR="$WORK" node "$HOOK" 2>/dev/null; }

# --- unanswered: must block ---
rm -f /tmp/hooktest-reply-guard-blocked.json
write_session \
  "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"$DISCORD_MSG\"}]}}" \
  '{"type":"assistant","message":{"content":[{"type":"text","text":"answer written, never sent"}],"usage":{"input_tokens":10}}}'
OUT=$(run)
if printf '%s' "$OUT" | grep -q '"decision":"block"'; then
  ok "it BLOCKS when a Discord message went unanswered"
else
  bad "it did not block (output: ${OUT:0:80})"
fi

# --- answered: must stay silent ---
rm -f /tmp/hooktest-reply-guard-blocked.json
write_session \
  "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"$DISCORD_MSG\"}]}}" \
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__plugin_artifice-discord_artifice-discord__reply"}],"usage":{"input_tokens":10}}}'
OUT=$(run)
if printf '%s' "$OUT" | grep -q '"decision":"block"'; then
  bad "it blocked a turn that DID reply"
else
  ok "it stays silent when the reply tool was called"
fi

# --- not from Discord: must stay silent ---
rm -f /tmp/hooktest-reply-guard-blocked.json
write_session \
  '{"type":"user","message":{"content":[{"type":"text","text":"typed in the terminal"}]}}' \
  '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":10}}}'
OUT=$(run)
if printf '%s' "$OUT" | grep -q '"decision":"block"'; then
  bad "it blocked a turn that did not come from Discord"
else
  ok "it stays silent on a non-Discord turn"
fi

# --- THE LOOP GUARD: it must not block the same message twice ---
rm -f /tmp/hooktest-reply-guard-blocked.json
write_session \
  "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"$DISCORD_MSG\"}]}}" \
  '{"type":"assistant","message":{"content":[{"type":"text","text":"still not sent"}],"usage":{"input_tokens":10}}}'
run >/dev/null
OUT=$(run)
if printf '%s' "$OUT" | grep -q '"decision":"block"'; then
  bad "it blocked the SAME message twice -- a bot that cannot send would be trapped"
else
  ok "it blocks once per message, so an unsendable reply cannot trap the turn"
fi

# --- the opt-out must work ---
rm -f /tmp/hooktest-reply-guard-blocked.json
write_session \
  "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"$DISCORD_MSG\"}]}}" \
  '{"type":"assistant","message":{"content":[{"type":"text","text":"unsent"}],"usage":{"input_tokens":10}}}'
OUT=$(echo '{}' | DISCORD_REPLY_GUARD=off CLAUDE_CONFIG_DIR="$WORK" node "$HOOK" 2>/dev/null)
if printf '%s' "$OUT" | grep -q '"decision":"block"'; then
  bad "DISCORD_REPLY_GUARD=off did not disable it"
else
  ok "DISCORD_REPLY_GUARD=off disables the block"
fi

# ---- THE CASE THE GUARD EXISTED FOR AND COULD NOT SEE ----
# Reading an image appends a synthetic user entry: type 'user', plain string body,
# turnCompanion true. The backwards scan stopped on it, found no Discord marker and
# concluded the turn was not from Discord -- so the guard against failing to reply after
# an IMAGE was blinded by IMAGES. Reproduced from a real transcript, 2026-10-11.
rm -f /tmp/hooktest-reply-guard-blocked.json
: > "$WORK/projects/p/s.jsonl"
{
  printf '{"type":"user","message":{"content":"%s"}}\n' "$DISCORD_MSG"
  printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}],"usage":{"input_tokens":10}}}\n'
  printf '{"type":"user","message":{"content":[{"type":"tool_result"}]}}\n'
  printf '{"type":"user","isMeta":true,"turnCompanion":true,"message":{"content":"[Image: original 1536x2048, displayed at 1500x2000.]"}}\n'
  printf '{"type":"assistant","message":{"content":[{"type":"text","text":"analysis written, never sent"}],"usage":{"input_tokens":10}}}\n'
} >> "$WORK/projects/p/s.jsonl"
OUT=$(run)
if printf '%s' "$OUT" | grep -q '"decision":"block"'; then
  ok "it blocks after an IMAGE read, despite the turnCompanion entry in between"
else
  bad "an image turnCompanion entry still blinds the guard -- the original bug"
fi

printf '\n  %d pass, %d fail\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
