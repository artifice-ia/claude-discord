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

// Shared turn identity and reply verdict for both Stop hooks.
// Returns: 'discord_no_reply' | 'discord_replied' | 'not_discord'
function discordReplyState(sessionFile, entries) {
  let lastDiscordIdx = -1;

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'user') continue;

    // SKIP TURN COMPANIONS. Reading an image appends a synthetic user entry whose body
    // is a plain string like "[Image: original 1536x2048 ...]". It is type 'user', so the
    // scan below treated it as the latest human turn, found no Discord marker and gave up.
    // THE GUARD AGAINST FAILING TO REPLY AFTER AN IMAGE WAS THEREFORE BLINDED BY IMAGES --
    // the one case it exists for was the one case it could not see.
    //
    // turnCompanion is the safe discriminator. In a 38k-entry transcript 60 entries carry
    // it and none is a Discord message; isMeta is NOT safe, 1513 carry that including the
    // real ones.
    if (e.turnCompanion) continue;

    // SKIP THE RETRY INJECTION. Without this the second Stop of a blocked turn judges the
    // hook's own feedback entry as the newest human turn, returns not_discord, and the
    // fallback that this whole handoff exists to preserve never fires.
    if (isStopHookFeedback(e)) continue;

    const content = e.message?.content;
    if (!content) continue;

    if (Array.isArray(content) && content.every(c => c.type === 'tool_result')) continue;

    const textParts = Array.isArray(content)
      ? content.filter(c => c.type === 'text').map(c => c.text).join('')
      : (typeof content === 'string' ? content : '');

    // A fleet-bus frame carries BOTH the plugin source attribute and source="fleet-bus".
    // Bot-to-bot traffic must not be mistaken for a human Discord trigger.
    if (textParts.includes('source="plugin:artifice-discord:artifice-discord"') && !textParts.includes('source="fleet-bus"')) {
      lastDiscordIdx = i;
      break;
    } else {
      break;
    }
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

module.exports = { discordReplyState, isStopHookFeedback };
