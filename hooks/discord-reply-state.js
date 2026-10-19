// discord-reply-state.js
//
// THREE-OUTCOME CLASSIFICATION CONTRACT
// ======================================
// Every user entry is classified as exactly one of:
//
//   'harness'  — identified as harness-injected. TWO TIERS of evidence:
//
//     structural  — a flag the harness sets that a human cannot replicate by typing:
//                   turnCompanion, isCompactSummary, isVisibleInTranscriptOnly, isMeta
//                   (for specific tags), promptSource (task-notification), scheduledTaskId
//                   (command-message from /loop), tool_result arrays, bus-frame tag attrs.
//
//     textual     — tag matched only in content text; a human can paste the same bytes.
//                   Examples: <bash-input>, <command-name>, <local-command-stdout>.
//                   The census confirmed these tags appear in harness output. It does NOT
//                   prove they cannot appear in human input. (Ohm's correction, 2026-10-19)
//
//   'human'    — positively identified as a genuine human turn.
//                Discord channel message (plugin source, not a bus frame).
//                Plain-text terminal input (non-empty, no XML opener).
//
//   'unknown'  — cannot be classified. Has content, not in the harness list, not plain,
//                not Discord. Example: <task>Analyze my private doc.</task>.
//                ARBITRARY XML IS NOT PROOF OF HARNESS ORIGIN.
//
// TWO CONSUMERS, TWO DEFAULTS
// ===========================
//   Guard:      skips harness (both tiers) and unknown — blocking is cheap, self-limiting.
//   Forwarder:  skips structural-harness only. Treats textual-harness as unknown and
//               REFUSES to post. A text-only match cannot prove origin when delivery
//               crosses a boundary: wrong blocks are harmless, wrong forwards are not.
//
// CONSEQUENCE: the forwarder fires less often than before. Turns where Fernando ran
// a `!` bash command (<bash-input> is textual), invoked a slash command whose entries
// have no structural flag (<command-name>, <local-command-stdout>), or typed any other
// harness-looking text will not forward. This is the correct conservative behaviour.
// In a normal turn the only entries between Fernando's message and the closing text are
// tool_result arrays (structural), so the forwarder fires cleanly.
//
// See scripts/classify-census.cjs to verify distribution over a real transcript.
// The census confirms COVERAGE (these tags appear in harness output). It does not
// confirm EXCLUSIVITY (they cannot appear in human input).
//
// This asymmetry is the point. Do not collapse it back to two outcomes or one tier.

// Stop hook feedback — structural evidence: isMeta is set by the harness.
// NOTE: isMeta alone is NOT a discriminator — real Discord channel entries also carry
// isMeta:true at runtime (verified session 34e5b924, 2026-10-19). All three conditions
// are required.
function isStopHookFeedback(entry) {
  if (!entry || entry.isMeta !== true) return false;
  const content = entry.message?.content;
  return typeof content === 'string' && content.startsWith('Stop hook feedback:');
}

// Fleet-bus frames — structural evidence: both plugin source AND fleet-bus appear as
// attributes in the opening <channel> tag. Matched within tag attributes to avoid
// false positives from Fernando quoting bus-frame syntax in a message body.
function isBusFrame(entry) {
  if (!entry || entry.type !== 'user') return false;
  const content = entry.message?.content;
  const text = typeof content === 'string' ? content
    : (Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('') : '');
  const tagAttrs = text.match(/<channel\s([^>]*)>/)?.[1] ?? '';
  return tagAttrs.includes('source="plugin:artifice-discord:artifice-discord"') && tagAttrs.includes('source="fleet-bus"');
}

// Classify a user entry and return the evidence tier that produced the classification.
//
// Returns: { class: 'harness'|'human'|'unknown', evidence: 'structural'|'textual' }
//
// The evidence field matters to the FORWARDER: structural-harness entries are safe to
// skip; textual-harness entries are added to unknownEntries and treated like 'unknown'.
function classifyEntry(entry) {
  if (!entry || entry.type !== 'user') {
    return { class: 'unknown', evidence: 'structural' };
  }

  // === STRUCTURAL HARNESS: flags the harness sets, not user-authored ===

  if (entry.turnCompanion) return { class: 'harness', evidence: 'structural' };
  if (entry.isCompactSummary) return { class: 'harness', evidence: 'structural' };
  if (entry.isVisibleInTranscriptOnly) return { class: 'harness', evidence: 'structural' };
  if (isStopHookFeedback(entry)) return { class: 'harness', evidence: 'structural' };
  if (isBusFrame(entry)) return { class: 'harness', evidence: 'structural' };

  const content = entry.message?.content;

  // Tool call results — harness-internal, structural.
  if (Array.isArray(content) && content.length > 0 && content.every(c => c && c.type === 'tool_result')) {
    return { class: 'harness', evidence: 'structural' };
  }

  const text = typeof content === 'string' ? content
    : (Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('') : '');

  // Named injection tags WITH structural backing:
  //   <local-command-caveat>: runtime sets isMeta:true (not set on human terminal input)
  if (text.startsWith('<local-command-caveat>') && entry.isMeta === true) {
    return { class: 'harness', evidence: 'structural' };
  }
  //   <task-notification>: runtime sets promptSource === 'system'. Terminal-typed human
  //   input has promptSource === 'typed' — never 'system'. Discord messages with
  //   promptSource 'system' are caught above by the plugin-source check.
  if (text.startsWith('<task-notification>') && entry.promptSource === 'system') {
    return { class: 'harness', evidence: 'structural' };
  }
  //   <command-message> from /loop: runtime sets scheduledTaskId
  if (text.startsWith('<command-message>') && entry.scheduledTaskId) {
    return { class: 'harness', evidence: 'structural' };
  }

  if (!text.trim()) return { class: 'unknown', evidence: 'structural' };

  // === POSITIVE HUMAN ===

  // Discord channel message (bus frames already caught above).
  if (text.includes('source="plugin:artifice-discord:artifice-discord"')) {
    return { class: 'human', evidence: 'structural' };
  }
  // Plain-text terminal input — does not open with an XML tag.
  if (!/^<[a-z]/i.test(text.trimStart())) {
    return { class: 'human', evidence: 'structural' };
  }

  // === TEXTUAL HARNESS: tag matched in content, no structural backing ===
  // Census confirms these tags appear in harness output.
  // Does NOT prove they cannot appear in human input (Ohm's correction).
  // Guard: skips these. Forwarder: adds to unknownEntries and refuses to post.
  const TEXTUAL_HARNESS_TAGS = [
    '<bash-input>', '<bash-stdout>', '<bash-stderr>',
    '<command-name>', '<command-message>',
    '<local-command-caveat>', '<local-command-stdout>',
    '<task-notification>',
  ];
  for (const tag of TEXTUAL_HARNESS_TAGS) {
    if (text.startsWith(tag)) return { class: 'harness', evidence: 'textual' };
  }

  // === UNKNOWN ===
  // Has text, XML-opening, not in any harness list, not Discord, not plain text.
  return { class: 'unknown', evidence: 'textual' };
}

// Convenience wrappers — maintained for backward-compatible call sites.
function isGenuineHumanTurn(entry) {
  return classifyEntry(entry).class === 'human';
}
function isHarnessEntry(entry) {
  return classifyEntry(entry).class === 'harness';
}

// Shared turn identity, reply verdict, and boundary evidence for both Stop hooks.
//
// Returns:
//   status         — 'discord_no_reply' | 'discord_replied' | 'not_discord'
//   key            — `${sessionFile}:${triggerIdx}` or null
//   triggerIdx     — index of Discord trigger entry, or -1
//   unknownEntries — indices of user entries in (triggerIdx, end] that are either
//                    'unknown' class OR 'harness' with 'textual' evidence.
//                    The guard ignores this field; the forwarder refuses when it is
//                    non-empty (Ohm's delivery-boundary property).
function discordReplyState(sessionFile, entries) {
  let lastDiscordIdx = -1;
  const unknownEntries = [];

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'user') continue;

    const { class: cls, evidence } = classifyEntry(e);

    if (cls === 'harness') {
      // Guard skips all harness. Forwarder must refuse on textual-harness —
      // add to unknownEntries so the forwarder can apply its stricter rule.
      if (evidence === 'textual') unknownEntries.push(i);
      continue;
    }

    if (cls === 'unknown') {
      unknownEntries.push(i);
      continue;
    }

    // cls === 'human' — most recent genuine human turn. Stop here.
    const c = e.message?.content;
    const t = Array.isArray(c)
      ? c.filter(x => x.type === 'text').map(x => x.text).join('')
      : (typeof c === 'string' ? c : '');

    if (t.includes('source="plugin:artifice-discord:artifice-discord"')) {
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
    const c = e.message?.content;
    if (!Array.isArray(c)) continue;
    if (c.some(x => x.type === 'tool_use' && x.name && x.name.includes('discord') && x.name.includes('reply'))) {
      return { status: 'discord_replied', key, triggerIdx: lastDiscordIdx, unknownEntries };
    }
  }

  return { status: 'discord_no_reply', key, triggerIdx: lastDiscordIdx, unknownEntries };
}

module.exports = { discordReplyState, classifyEntry, isGenuineHumanTurn, isStopHookFeedback, isBusFrame, isHarnessEntry };
