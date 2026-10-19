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
//                   Only, isMeta (for stop-hook feedback + local-command-caveat),
//                   tool_result arrays.
//
//     textual     — tag matched only in content text. A user can paste the same bytes.
//                   Census confirms coverage; does NOT confirm exclusivity.
//
//   'human'    — positively identified as a genuine human turn.
//                Carries optional `channel: 'discord'` sub-field when the turn
//                was a channel plugin injection (see below). WITHOUT that sub-field,
//                the entry is a terminal turn, regardless of text content.
//
//   'unknown'  — cannot be classified. Not harness, not plain, not Discord.
//
// ORIGIN-FIRST DESIGN
// ===================
// `entry.origin.kind` is set by the Claude Code runtime, not user-authored text.
// A user cannot forge `origin.kind` by pasting. All text inspection of channel tags
// runs as a sub-discriminator INSIDE the origin.kind==='channel' branch only.
//
//   origin.kind === 'channel'           → channel plugin injection.
//                                          fleet-bus text → { class:'harness', evidence:'structural' }
//                                          else           → { class:'human',   evidence:'structural', channel:'discord' }
//   origin.kind === 'task-notification' → { class:'harness', evidence:'structural' }
//   origin.kind === 'human'             → { class:'human',   evidence:'structural' }   ← NO channel field
//   turnOrigin  === 'human'             → { class:'human',   evidence:'structural' }   ← NO channel field
//   promptSource === 'typed'            → { class:'human',   evidence:'structural' }   ← NO channel field
//   turnOrigin  === 'scheduled'         → { class:'harness', evidence:'structural' }
//
// CHANNEL SUB-FIELD SEMANTICS
// ===========================
// `channel: 'discord'` means: the harness proved this entry came from a channel
// plugin, and the text identifies it as a Discord message (not fleet-bus).
//
// Entries classified human WITHOUT `channel` are TERMINAL input, regardless of what
// their text says. A paste that contains the plugin source string but was typed in
// the terminal carries origin.kind==='human' — the runtime proved that. It must never
// become the Discord trigger.
//
// MISSING origin KEY IS NOT EVIDENCE
// ====================================
// Entries without `origin` are handled conservatively:
//   <channel> text with plugin source AND no fleet-bus → { class:'human', evidence:'textual', channel:'discord' }
//   <channel> text with fleet-bus                      → { class:'harness', evidence:'textual' }
//   Other known harness tags                           → { class:'harness', evidence:'textual' }
//   Plain text                                         → { class:'human',   evidence:'structural' }
//   Unknown XML                                        → { class:'unknown' }
//
// TWO CONSUMERS, TWO DEFAULTS
// ===========================
//   Guard:     triggers on any discord_no_reply status. Skips all harness + unknown.
//              Non-Discord human entries → continue scanning backwards.
//
//   Forwarder: refuses when unknownEntries is non-empty. Structural-harness and
//              structural Discord are safe. Everything else is refused.
//
// SCAN CONTRACT
// =============
// discordReplyState scans entries backwards looking for a Discord trigger:
//   - harness (textual) → unknownEntries, continue
//   - harness (structural) → skip, continue
//   - unknown → unknownEntries, continue
//   - human, channel='discord' (structural) → trigger; break
//   - human, channel='discord' (textual)    → trigger; unknownEntries (old transcript); break
//   - human, no channel → unknownEntries, continue   ← PROVEN TERMINAL: never a trigger
//
// Proven-human terminal input is never the Discord trigger, regardless of text content.
// This closes the variant where a pasted plugin-source string in a terminal entry
// becomes the trigger via a text fallback in the scan.
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

// Stop hook feedback — caught before origin checks to avoid isMeta confusion.
// Discord entries also carry isMeta:true but have origin.kind==='channel' (handled first).
function isStopHookFeedback(entry) {
  if (!entry || entry.isMeta !== true) return false;
  const content = entry.message?.content;
  return typeof content === 'string' && content.startsWith('Stop hook feedback:');
}

// Classify a user entry.
// Returns { class: 'harness'|'human'|'unknown', evidence: 'structural'|'textual', channel?: 'discord' }
//
// `channel: 'discord'` means the entry was proven to be a channel plugin injection
// that is a Discord message. WITHOUT this field, a 'human' entry is terminal input.
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
  // `origin.kind` is set by Claude Code — not user-authored text.
  // Text inspection of channel content runs ONLY inside the origin.kind==='channel' branch.
  const originKind = entry.origin?.kind;

  if (originKind === 'channel') {
    // Provenance proven by origin.kind. Text is a sub-discriminator only.
    const tagAttrs = text.match(/<channel\s([^>]*)>/)?.[1] ?? '';
    if (tagAttrs.includes('source="fleet-bus"')) {
      return { class: 'harness', evidence: 'structural' };
    }
    return { class: 'human', evidence: 'structural', channel: 'discord' };
  }

  if (originKind === 'task-notification') {
    return { class: 'harness', evidence: 'structural' };
  }

  // Proven terminal input. NO channel field — never a Discord trigger regardless of text.
  if (originKind === 'human' || entry.promptSource === 'typed' || entry.turnOrigin === 'human') {
    return { class: 'human', evidence: 'structural' };
  }

  // /loop scheduled turns.
  if (entry.turnOrigin === 'scheduled') {
    return { class: 'harness', evidence: 'structural' };
  }

  // === STRUCTURAL: older harness flags (entries predating origin field) ===
  if (entry.turnCompanion) return { class: 'harness', evidence: 'structural' };
  if (entry.isCompactSummary) return { class: 'harness', evidence: 'structural' };
  if (entry.isVisibleInTranscriptOnly) return { class: 'harness', evidence: 'structural' };
  // <local-command-caveat> carries isMeta:true (harness-set). Terminal-typed entries
  // never have isMeta:true. Discord entries with isMeta are caught above by origin.kind.
  if (entry.isMeta === true && text.startsWith('<local-command-caveat>')) {
    return { class: 'harness', evidence: 'structural' };
  }

  if (!text.trim()) return { class: 'unknown', evidence: 'structural' };

  // === POSITIVE HUMAN: plain-text terminal input (no origin required) ===
  if (!/^<[a-z]/i.test(text.trimStart())) {
    return { class: 'human', evidence: 'structural' };
  }

  // === <channel> TAGS WITHOUT origin (old transcripts or text-only evidence) ===
  // Without origin.kind, text inspection is the only option — textual evidence.
  if (text.startsWith('<channel')) {
    const tagAttrs = text.match(/<channel\s([^>]*)>/)?.[1] ?? '';
    if (tagAttrs.includes('source="fleet-bus"')) {
      return { class: 'harness', evidence: 'textual' };
    }
    if (tagAttrs.includes('source="plugin:artifice-discord:artifice-discord"')) {
      return { class: 'human', evidence: 'textual', channel: 'discord' };
    }
    return { class: 'unknown', evidence: 'textual' };
  }

  // === TEXTUAL HARNESS: known injection tags without origin proof ===
  // Census confirms these appear in harness output (coverage ≠ exclusivity).
  const TEXTUAL_HARNESS_TAGS = [
    '<bash-input>', '<bash-stdout>', '<bash-stderr>',
    '<command-name>', '<command-message>',
    '<local-command-caveat>', '<local-command-stdout>',
    '<task-notification>',
  ];
  for (const tag of TEXTUAL_HARNESS_TAGS) {
    if (text.startsWith(tag)) return { class: 'harness', evidence: 'textual' };
  }

  return { class: 'unknown', evidence: 'textual' };
}

// Convenience wrappers for backward-compatible call sites.
function isGenuineHumanTurn(entry) {
  return classifyEntry(entry).class === 'human';
}
function isHarnessEntry(entry) {
  return classifyEntry(entry).class === 'harness';
}

// Legacy: kept for external call sites. isBusFrame logic is now internal to classifyEntry
// inside the origin.kind==='channel' branch.
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
//   unknownEntries — indices of user entries in the scan window that the forwarder
//                    cannot safely skip: unknown class, textual-harness, textual Discord
//                    triggers, and proven-terminal human entries (no channel field).
//                    Forwarder refuses to post when this is non-empty.
//
// SCAN CONTRACT (no text-based provenance re-derivation):
//   The trigger is found ONLY when r.channel === 'discord'. A proven-terminal human entry
//   (origin.kind='human', promptSource='typed', or turnOrigin='human') adds to unknownEntries
//   and the scan CONTINUES backwards looking for an older Discord message. This prevents a
//   paste containing the plugin source string from becoming the trigger via a text fallback.
function discordReplyState(sessionFile, entries) {
  let lastDiscordIdx = -1;
  const unknownEntries = [];

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'user') continue;

    const r = classifyEntry(e);

    if (r.class === 'harness') {
      if (r.evidence === 'textual') unknownEntries.push(i);
      continue;
    }

    if (r.class === 'unknown') {
      unknownEntries.push(i);
      continue;
    }

    // r.class === 'human'
    if (r.channel === 'discord') {
      // Found the Discord trigger. Old-transcript entries with textual evidence go into
      // unknownEntries so the forwarder refuses delivery it cannot prove is safe.
      lastDiscordIdx = i;
      if (r.evidence === 'textual') unknownEntries.push(i);
      break;
    }

    // Proven human terminal input — NOT a Discord trigger regardless of text content.
    // Add to unknownEntries and continue scanning backwards for an older Discord message.
    unknownEntries.push(i);
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
