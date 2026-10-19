// A blocking Stop hook's reason is appended by Claude Code as a `user` entry, so a
// backward scan for the human turn finds IT and not the human. Captured on 2.1.303:
//
//   {"type":"user","message":{"role":"user","content":"Stop hook feedback:\n<reason>"},
//    "isMeta":true,"userType":"external","entrypoint":"sdk-cli"}
//
// No turnCompanion, so the companion skip alone does not cover it. The match below is
// deliberately narrow: isMeta alone is NOT a discriminator — real Discord channel entries
// also carry isMeta:true at runtime (verified in session 34e5b924, 2026-10-19), so
// all three conditions are required.
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
// NOTE: we match the opening <channel> tag's attribute string, not the full text.
// A raw text search would misfire if Fernando quotes bus-frame attribute syntax in a
// Discord message — "<channel ...fleet-bus...>his words</channel>" includes both strings.
// Matching within the tag attributes only avoids that false positive.
//
// NOTE: turnOrigin === 'peer' is NOT a discriminator. All channel-injected entries carry
// it, including Fernando's own Discord messages. The attribute check is the correct signal.
function isBusFrame(entry) {
  if (!entry || entry.type !== 'user') return false;
  const content = entry.message?.content;
  const text = typeof content === 'string' ? content
    : (Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('') : '');
  const tagAttrs = text.match(/<channel\s([^>]*)>/)?.[1] ?? '';
  return tagAttrs.includes('source="plugin:artifice-discord:artifice-discord"') && tagAttrs.includes('source="fleet-bus"');
}

// Positive identification of a genuine human turn — the predicate the backward scan
// stops on. The scan continues past everything else.
//
// THREE INSTANCES OF THE SAME CLASS broke this scan (images → turnCompanion fix; bus
// frames → isBusFrame fix; compaction entries → isCompactSummary fix). Each time an
// enumerated skip list grew by one and the NEXT harness entry type blinded it again.
// The root cause: the default was "stop on unknowns." This function inverts that: return
// true ONLY when an entry is positively identified as a genuine human turn; the scan
// continues past everything else, including entry types we haven't seen yet.
//
// Two failure modes, not symmetric:
//   skip-too-much → scan reaches an older Discord message → one duplicate block,
//                   self-limiting, operator sees a message twice at worst
//   skip-too-little → Fernando's message is lost silently with no alarm
// The default belongs on the loud side.
//
// NOTE on isMeta: NOT used as an exclusion. Real Discord channel entries carry
// isMeta:true at runtime (verified session 34e5b924, 2026-10-19). Using it as a
// blanket exclusion would silently drop Fernando's messages.
function isGenuineHumanTurn(entry) {
  if (!entry || entry.type !== 'user') return false;

  // Structural flags the harness sets on injected entries — checked without parsing.
  if (entry.turnCompanion) return false;          // image placeholder entry
  if (entry.isCompactSummary) return false;        // /compact and auto-compaction summary
  if (entry.isVisibleInTranscriptOnly) return false; // harness-only metadata

  // Functional predicates for injected entries without a dedicated structural flag.
  if (isStopHookFeedback(entry)) return false;
  if (isBusFrame(entry)) return false;

  const content = entry.message?.content;
  const text = typeof content === 'string' ? content
    : (Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('') : '');

  if (!text.trim()) return false;

  // Generic harness-wrapper catch. The harness injects entries whose content opens
  // with an XML-ish tag (<local-command-caveat>, <command-name>, <local-command-stdout>,
  // and any future type). A genuine Discord message also opens with a <channel> tag,
  // but carries source="plugin:artifice-discord:artifice-discord" — the exception below
  // lets it through. Everything else that starts <tag… without that attribute is harness.
  if (/^<[a-z][a-z0-9-]*[\s>]/i.test(text.trimStart())
      && !text.includes('source="plugin:artifice-discord:artifice-discord"')) {
    return false;
  }

  return true;
}

// Convenience negation — used in discord-stop-forward.js where "skip harness" reads
// more naturally than "skip non-genuine". Must be defined as the negation; isGenuineHumanTurn
// is the authority.
function isHarnessEntry(entry) {
  return !isGenuineHumanTurn(entry);
}

// Shared turn identity and reply verdict for both Stop hooks.
// Returns: 'discord_no_reply' | 'discord_replied' | 'not_discord'
function discordReplyState(sessionFile, entries) {
  let lastDiscordIdx = -1;

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'user') continue;

    // Skip everything the harness injects. Stop ONLY on genuine human turns.
    // See isGenuineHumanTurn for the inversion rationale.
    if (!isGenuineHumanTurn(e)) continue;

    const content = e.message?.content;
    const textParts = Array.isArray(content)
      ? content.filter(c => c.type === 'text').map(c => c.text).join('')
      : (typeof content === 'string' ? content : '');

    if (textParts.includes('source="plugin:artifice-discord:artifice-discord"')) {
      lastDiscordIdx = i;
    }
    break;
  }

  if (lastDiscordIdx === -1) return { status: 'not_discord', key: null };
  const key = `${sessionFile}:${lastDiscordIdx}`;

  for (let i = lastDiscordIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== 'assistant') continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    const hasReply = content.some(
      c => c.type === 'tool_use' && c.name && c.name.includes('discord') && c.name.includes('reply')
    );
    if (hasReply) return { status: 'discord_replied', key };
  }

  return { status: 'discord_no_reply', key };
}

module.exports = { discordReplyState, isStopHookFeedback, isBusFrame, isHarnessEntry };
