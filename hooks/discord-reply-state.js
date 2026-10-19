// A blocking Stop hook's reason is appended by Claude Code as a `user` entry, so a
// backward scan for the human turn finds IT and not the human. Captured on 2.1.303:
//
//   {"type":"user","message":{"role":"user","content":"Stop hook feedback:\n<reason>"},
//    "isMeta":true,"userType":"external","entrypoint":"sdk-cli"}
//
// No turnCompanion, so the companion skip above does not cover it. The match below is
// deliberately narrow: isMeta alone is NOT a discriminator, as the comment in the scan
// records, so all three conditions are required.
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
// Matching within the tag attributes only avoids that false skip.
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

// Positive identification of harness-injected entries the backward scan should skip.
//
// The scan uses this as a SKIP predicate, not a STOP predicate. Three entry types have
// already blinded it: images (turnCompanion), bus frames (isBusFrame), and compaction
// entries (isCompactSummary + local-command XML patterns). Each time the scan broke on
// a newly-injected type, the fix enumerated it. Inverting the test — skip KNOWN harness
// entries, stop ONLY on genuine human turns — means an unrecognised harness type skips
// past silently rather than terminating the scan with not_discord.
//
// Genuine human turns are what fall through this function: Discord channel messages, and
// direct CLI input that carries no harness XML wrapper.
function isHarnessEntry(entry) {
  if (!entry || entry.type !== 'user') return false;

  // Structural flags — checked without parsing content.
  if (entry.turnCompanion) return true;
  if (entry.isCompactSummary) return true;          // injected by /compact and auto-compaction

  // Functional predicates for entries without a dedicated structural flag.
  if (isStopHookFeedback(entry)) return true;
  if (isBusFrame(entry)) return true;

  const content = entry.message?.content;
  if (!content) return true;                        // empty content is never a genuine turn

  // Tool-result arrays are the harness handing tool output back to the model.
  if (Array.isArray(content) && content.every(c => c.type === 'tool_result')) return true;

  // Local-command entries injected by the CLI for slash-command output.
  // All three parts of a local command share this XML-tag pattern (captured from
  // /plugin and /reload-plugins runs in session 34e5b924, 2026-09-29):
  //   <local-command-caveat>Caveat: …</local-command-caveat>
  //   <command-name>/compact</command-name> …
  //   <local-command-stdout>Compacted …</local-command-stdout>
  const text = typeof content === 'string' ? content : '';
  if (text.startsWith('<local-command-caveat>')) return true;
  if (text.startsWith('<command-name>')) return true;
  if (text.startsWith('<local-command-stdout>')) return true;

  return false;
}

// Shared turn identity and reply verdict for both Stop hooks.
// Returns: 'discord_no_reply' | 'discord_replied' | 'not_discord'
function discordReplyState(sessionFile, entries) {
  let lastDiscordIdx = -1;

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'user') continue;

    // Skip every entry the harness injects. The scan stops ONLY on genuine human
    // turns (Discord messages or direct CLI input). See isHarnessEntry above.
    if (isHarnessEntry(e)) continue;

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
