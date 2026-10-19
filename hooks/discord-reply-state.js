// discord-reply-state.js
//
// THREE-OUTCOME CLASSIFICATION CONTRACT
// ======================================
// Every user entry is classified as exactly one of:
//
//   'harness'  — identified as harness-injected. TWO TIERS of evidence:
//
//     structural  — a runtime field the harness sets that a user cannot forge by
//                   typing. Primary: `origin.kind` (see Origin-First Design below).
//                   Secondary: turnCompanion, isCompactSummary, isVisibleInTranscript-
//                   Only, isMeta (for stop-hook feedback), tool_result arrays.
//
//     textual     — tag matched only in content text. A user can paste the same bytes.
//                   Examples: <bash-input>, <command-name>. Census confirms coverage;
//                   does NOT confirm exclusivity. (Ohm's correction, 2026-10-19)
//
//   'human'    — positively identified as a genuine human turn.
//                Channel injection with origin.kind==='channel' and no fleet-bus flag.
//                Or: promptSource==='typed', turnOrigin==='human', origin.kind==='human'.
//                Or: plain-text terminal input (no XML opener, no origin required).
//
//   'unknown'  — cannot be classified. Has content, not in the harness list, not plain,
//                not Discord. ARBITRARY XML IS NOT PROOF OF HARNESS ORIGIN.
//
// ORIGIN-FIRST DESIGN
// ===================
// `entry.origin.kind` is set by the Claude Code runtime, not by user-authored text.
// A user cannot paste text that forges `origin.kind`. This is the primary provenance
// evidence. ALL text parsing of channel tags now runs INSIDE an origin.kind==='channel'
// guard — text is a sub-discriminator within proven provenance, never the provenance
// itself.
//
//   origin.kind === 'channel'          → channel plugin injection. Sub-discriminate:
//                                          fleet-bus tag attrs → harness (structural)
//                                          otherwise           → human (structural)
//   origin.kind === 'task-notification' → harness (structural). Stronger than promptSource.
//   origin.kind === 'human'             → human (structural)
//   turnOrigin  === 'human'             → human (structural; also catches typed entries)
//   promptSource === 'typed'            → human (structural)
//   turnOrigin  === 'scheduled'         → harness (structural; /loop entries)
//
// MISSING origin KEY IS NOT EVIDENCE: 773/898 entries in real transcripts have none —
// the field postdates them and tool_result entries never carry it. Missing origin falls
// through to structural flags (turnCompanion, etc.) then the textual tier. Conservative.
//
// TWO CONSUMERS, TWO DEFAULTS
// ===========================
//   Guard:      skips harness (both tiers) and unknown. Blocking is cheap.
//   Forwarder:  skips structural-harness only. Textual-harness → unknownEntries →
//               refuses to post. Wrong blocks are loud and harmless; wrong forwards
//               cross an irreversible delivery boundary.
//
// The forwarder fires less often than before: turns where <command-name>, <bash-input>,
// or other textual-only harness tags appear without structural backing will not forward.
// In a normal turn the only entries between Fernando's message and the closing text are
// tool_result arrays (structural), so the forwarder fires cleanly in the common case.
//
// CAVEAT: origin is set by Claude Code, so this inherits whatever that runtime
// guarantees. It is a much stronger class of evidence than user-typed text.
//
// See scripts/classify-census.cjs to verify distribution over a real transcript.

function getEntryText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(c => c && c.type === 'text').map(c => c.text).join('');
  return '';
}

// Stop hook feedback — caught before origin checks so `isMeta` cannot be confused
// with Discord entries (which also carry isMeta:true but have origin.kind==='channel').
// All three conditions are required: isMeta + user type + text prefix.
function isStopHookFeedback(entry) {
  if (!entry || entry.isMeta !== true) return false;
  const content = entry.message?.content;
  return typeof content === 'string' && content.startsWith('Stop hook feedback:');
}

// Classify a user entry. Returns { class: 'harness'|'human'|'unknown', evidence: 'structural'|'textual' }.
//
// The evidence tier matters to the FORWARDER: structural-harness → safe to skip;
// textual-harness → added to unknownEntries → forwarder refuses to post.
function classifyEntry(entry) {
  if (!entry || entry.type !== 'user') {
    return { class: 'unknown', evidence: 'structural' };
  }

  const content = entry.message?.content;
  const text = getEntryText(content);

  // === STRUCTURAL: tool_result arrays — harness-internal, never carry origin ===
  if (Array.isArray(content) && content.length > 0 && content.every(c => c && c.type === 'tool_result')) {
    return { class: 'harness', evidence: 'structural' };
  }

  // === STRUCTURAL: stop hook feedback — check before origin to avoid isMeta confusion ===
  if (isStopHookFeedback(entry)) return { class: 'harness', evidence: 'structural' };

  // === STRUCTURAL: runtime origin flags (primary provenance evidence) ===
  //
  // `origin.kind` is set by the Claude Code runtime — not user-authored text.
  // A pasted channel tag cannot forge this field. All text-based channel inspection
  // runs as a sub-discriminator INSIDE the origin.kind==='channel' branch only.
  const originKind = entry.origin?.kind;

  if (originKind === 'channel') {
    // Provenance proven: this entry came through a channel plugin injection.
    // NOW use text to distinguish fleet-bus from a real Discord message.
    const tagAttrs = text.match(/<channel\s([^>]*)>/)?.[1] ?? '';
    if (tagAttrs.includes('source="fleet-bus"')) {
      return { class: 'harness', evidence: 'structural' }; // fleet-bus frame
    }
    return { class: 'human', evidence: 'structural' }; // Discord from Fernando (or other channel plugin)
  }

  if (originKind === 'task-notification') {
    return { class: 'harness', evidence: 'structural' };
  }

  // Human origin indicators — any one is sufficient.
  if (originKind === 'human' || entry.promptSource === 'typed' || entry.turnOrigin === 'human') {
    return { class: 'human', evidence: 'structural' };
  }

  // /loop scheduled turns — runtime sets turnOrigin='scheduled', no origin key.
  if (entry.turnOrigin === 'scheduled') {
    return { class: 'harness', evidence: 'structural' };
  }

  // === STRUCTURAL: older harness flags (entries predating origin field) ===
  if (entry.turnCompanion) return { class: 'harness', evidence: 'structural' };
  if (entry.isCompactSummary) return { class: 'harness', evidence: 'structural' };
  if (entry.isVisibleInTranscriptOnly) return { class: 'harness', evidence: 'structural' };
  // <local-command-caveat> has no origin but carries isMeta:true (harness-set).
  // Terminal-typed entries never have isMeta:true. Discord entries with isMeta:true are
  // caught above by origin.kind==='channel'. Safe combination.
  if (entry.isMeta === true && text.startsWith('<local-command-caveat>')) {
    return { class: 'harness', evidence: 'structural' };
  }

  if (!text.trim()) return { class: 'unknown', evidence: 'structural' };

  // === POSITIVE HUMAN: plain-text terminal input (no origin required) ===
  // Non-XML opener means typed text, not a harness injection. Structural because
  // the harness injects only XML-tagged content; plain text is always terminal input.
  if (!/^<[a-z]/i.test(text.trimStart())) {
    return { class: 'human', evidence: 'structural' };
  }

  // === TEXTUAL HARNESS: known injection tags without origin proof ===
  // These tags appear in real harness output (coverage confirmed by census).
  // Without origin.kind, we cannot prove they did not come from a human paste.
  // Guard: skips these. Forwarder: refuses (unknownEntries).
  const TEXTUAL_HARNESS_TAGS = [
    '<bash-input>', '<bash-stdout>', '<bash-stderr>',
    '<command-name>', '<command-message>',
    '<local-command-caveat>', '<local-command-stdout>',
    '<task-notification>',
    '<channel',  // pasted channel tag without origin.kind proof
  ];
  for (const tag of TEXTUAL_HARNESS_TAGS) {
    if (text.startsWith(tag)) return { class: 'harness', evidence: 'textual' };
  }

  // === UNKNOWN ===
  return { class: 'unknown', evidence: 'textual' };
}

// Convenience wrappers for backward-compatible call sites.
function isGenuineHumanTurn(entry) {
  return classifyEntry(entry).class === 'human';
}
function isHarnessEntry(entry) {
  return classifyEntry(entry).class === 'harness';
}

// Legacy: kept for external call sites but no longer used internally.
// isBusFrame is now a sub-discriminator inside classifyEntry's origin.kind==='channel' branch.
function isBusFrame(entry) {
  if (!entry || entry.type !== 'user') return false;
  const content = entry.message?.content;
  const text = getEntryText(content);
  const tagAttrs = text.match(/<channel\s([^>]*)>/)?.[1] ?? '';
  return tagAttrs.includes('source="plugin:artifice-discord:artifice-discord"') && tagAttrs.includes('source="fleet-bus"');
}

// Shared turn identity, reply verdict, and boundary evidence for both Stop hooks.
//
// Returns:
//   status         — 'discord_no_reply' | 'discord_replied' | 'not_discord'
//   key            — `${sessionFile}:${triggerIdx}` or null
//   triggerIdx     — index of Discord trigger entry, or -1
//   unknownEntries — indices of user entries in (triggerIdx, end] that are either
//                    'unknown' class OR 'harness' with 'textual' evidence.
//                    Guard ignores this; forwarder refuses when non-empty.
function discordReplyState(sessionFile, entries) {
  let lastDiscordIdx = -1;
  const unknownEntries = [];

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'user') continue;

    const { class: cls, evidence } = classifyEntry(e);

    if (cls === 'harness') {
      // Forwarder must refuse on textual-harness — add to unknownEntries.
      // Guard skips all harness regardless.
      if (evidence === 'textual') unknownEntries.push(i);
      continue;
    }

    if (cls === 'unknown') {
      unknownEntries.push(i);
      continue;
    }

    // cls === 'human' — most recent genuine human turn. Stop here.
    // Origin-proven channel entries are Discord; plain-text are terminal.
    const c = e.message?.content;
    const t = Array.isArray(c)
      ? c.filter(x => x.type === 'text').map(x => x.text).join('')
      : (typeof c === 'string' ? c : '');

    if (e.origin?.kind === 'channel' || t.includes('source="plugin:artifice-discord:artifice-discord"')) {
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
