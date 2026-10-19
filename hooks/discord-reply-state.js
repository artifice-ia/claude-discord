// discord-reply-state.js
//
// THREE-OUTCOME CLASSIFICATION CONTRACT
// ======================================
// Every user entry is classified as exactly one of:
//
//   'harness'  — positively identified as harness-injected. Safe to skip in any context.
//               Structural flags: turnCompanion, isCompactSummary, isVisibleInTranscriptOnly.
//               Functional: isStopHookFeedback, isBusFrame.
//               Content-structural: tool_result arrays (Claude Code tool call returns).
//               Named local-command tags: <local-command-caveat>, <command-name>,
//               <local-command-stdout>. Explicit list — NOT open-ended XML matching.
//
//   'human'    — positively identified as a genuine human turn.
//               Discord channel message (has plugin source, not a bus frame).
//               Plain-text terminal input (non-empty, does NOT open with an XML tag).
//
//   'unknown'  — cannot be classified. Has content, not in the harness list, not plain,
//               not Discord. Example: <task>Analyze my private doc.</task>.
//               ARBITRARY XML IS NOT PROOF OF HARNESS ORIGIN.
//
// Two consumers, two defaults:
//   Guard:      may SKIP unknown — blocking is cheap, self-limiting, and loud.
//   Forwarder:  must REFUSE on unknown — delivery crosses a boundary; wrong blocks are
//               harmless, wrong forwards are not. An unknown between trigger and end
//               means the forwarder cannot confirm what text belongs to the Discord turn.
//
// This asymmetry is the point. Do not collapse it back to two outcomes.

// A blocking Stop hook's reason is appended by Claude Code as a `user` entry, so a
// backward scan for the human turn finds IT and not the human. Captured on 2.1.303:
//
//   {"type":"user","message":{"role":"user","content":"Stop hook feedback:\n<reason>"},
//    "isMeta":true,"userType":"external","entrypoint":"sdk-cli"}
//
// The match below is deliberately narrow: isMeta alone is NOT a discriminator — real
// Discord channel entries also carry isMeta:true at runtime (verified session 34e5b924,
// 2026-10-19; confirmed by Deet: 1513 entries in his own transcript carry isMeta
// including Fernando's genuine messages). All three conditions are required.
function isStopHookFeedback(entry) {
  if (!entry || entry.isMeta !== true) return false;
  const content = entry.message?.content;
  return typeof content === 'string' && content.startsWith('Stop hook feedback:');
}

// A fleet-bus frame carries BOTH source="plugin:artifice-discord:artifice-discord" AND
// source="fleet-bus" as ATTRIBUTES of the opening <channel> tag. It is noise to skip,
// not a trigger and not a terminator: breaking on it blocks the scan from finding
// Fernando's genuine message underneath.
//
// NOTE: we match within the tag attributes, not the full text. A raw text search would
// misfire if Fernando quotes bus-frame attribute syntax in a Discord message. Matching
// within the tag attributes only avoids that false positive.
function isBusFrame(entry) {
  if (!entry || entry.type !== 'user') return false;
  const content = entry.message?.content;
  const text = typeof content === 'string' ? content
    : (Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('') : '');
  const tagAttrs = text.match(/<channel\s([^>]*)>/)?.[1] ?? '';
  return tagAttrs.includes('source="plugin:artifice-discord:artifice-discord"') && tagAttrs.includes('source="fleet-bus"');
}

// Classify a user entry as 'harness', 'human', or 'unknown'.
// See the module contract at the top of this file.
function classifyEntry(entry) {
  if (!entry || entry.type !== 'user') return 'unknown';

  // === POSITIVE HARNESS: structural flags ===
  if (entry.turnCompanion) return 'harness';
  if (entry.isCompactSummary) return 'harness';
  if (entry.isVisibleInTranscriptOnly) return 'harness';
  if (isStopHookFeedback(entry)) return 'harness';
  if (isBusFrame(entry)) return 'harness';

  const content = entry.message?.content;

  // === POSITIVE HARNESS: tool call results ===
  // These are harness-internal — Claude Code injects a user entry for each tool_use result.
  // They carry no human-authored text; classifying them as unknown would trigger the
  // forwarder's boundary gate on ordinary tool-use turns.
  if (Array.isArray(content) && content.length > 0 && content.every(c => c && c.type === 'tool_result')) {
    return 'harness';
  }

  const text = typeof content === 'string' ? content
    : (Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('') : '');

  // === POSITIVE HARNESS: named local-command injection tags ===
  // Explicit list — three tags only. Arbitrary XML is not proof of harness origin.
  if (text.startsWith('<local-command-caveat>')) return 'harness';
  if (text.startsWith('<command-name>')) return 'harness';
  if (text.startsWith('<local-command-stdout>')) return 'harness';

  if (!text.trim()) return 'unknown';

  // === POSITIVE HUMAN: Discord channel message ===
  // (bus frames already caught above; this is Fernando's genuine message)
  if (text.includes('source="plugin:artifice-discord:artifice-discord"')) return 'human';

  // === POSITIVE HUMAN: plain-text terminal input ===
  // Does NOT open with an XML tag — we can confirm it's human-generated, not a
  // harness or an ambiguous XML-wrapped task.
  if (!/^<[a-z]/i.test(text.trimStart())) return 'human';

  // === UNKNOWN ===
  // Has text, not in the harness list, not plain, not Discord. Could be
  // <task>Analyze my private doc; answer only here.</task> or any other
  // XML-opened message from Fernando. We cannot classify — do not risk
  // delivery boundary crossing.
  return 'unknown';
}

// Convenience: true when the entry is positively identified as a genuine human turn.
// Used in the guard's scan; exportable for callers that need a boolean.
function isGenuineHumanTurn(entry) {
  return classifyEntry(entry) === 'human';
}

// Convenience negation — keeps callers that read "skip harness" naturally.
// isGenuineHumanTurn and classifyEntry are the authority; this is derived.
function isHarnessEntry(entry) {
  return classifyEntry(entry) === 'harness';
}

// Shared turn identity, reply verdict, and boundary evidence for both Stop hooks.
//
// Returns:
//   status      — 'discord_no_reply' | 'discord_replied' | 'not_discord'
//   key         — `${sessionFile}:${triggerIdx}` (opaque, used for claim files)
//   triggerIdx  — array index of the Discord trigger entry, or -1
//   unknownEntries — indices of unknown user entries found between trigger and the
//                    end of the transcript (i.e., after trigger in sequence, encountered
//                    before trigger in the backward scan). The forwarder uses this to
//                    refuse delivery when ANY unknown entry sits in that window.
//                    Always an array; empty when there are none.
function discordReplyState(sessionFile, entries) {
  let lastDiscordIdx = -1;
  const unknownEntries = [];

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'user') continue;

    const cls = classifyEntry(e);

    if (cls === 'harness') continue;

    if (cls === 'unknown') {
      // Guard behavior: skip unknown (blocking is cheap and self-limiting).
      // Track the index so the forwarder can apply its stricter rule.
      unknownEntries.push(i);
      continue;
    }

    // cls === 'human' — this is the most recent genuine human turn. Stop here.
    const content = e.message?.content;
    const text = Array.isArray(content)
      ? content.filter(c => c.type === 'text').map(c => c.text).join('')
      : (typeof content === 'string' ? content : '');

    if (text.includes('source="plugin:artifice-discord:artifice-discord"')) {
      lastDiscordIdx = i;
    }
    break;
  }

  if (lastDiscordIdx === -1) {
    return { status: 'not_discord', key: null, triggerIdx: -1, unknownEntries };
  }
  const key = `${sessionFile}:${lastDiscordIdx}`;

  for (let i = lastDiscordIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== 'assistant') continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    const hasReply = content.some(
      c => c.type === 'tool_use' && c.name && c.name.includes('discord') && c.name.includes('reply')
    );
    if (hasReply) {
      return { status: 'discord_replied', key, triggerIdx: lastDiscordIdx, unknownEntries };
    }
  }

  return { status: 'discord_no_reply', key, triggerIdx: lastDiscordIdx, unknownEntries };
}

module.exports = { discordReplyState, classifyEntry, isGenuineHumanTurn, isStopHookFeedback, isBusFrame, isHarnessEntry };
