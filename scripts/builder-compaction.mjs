/**
 * Context compaction for long builder turns.
 *
 * The builder runs a bare Pi `Agent`, not pi-coding-agent's session, so it
 * inherits none of that package's context management: a long build simply grew
 * its transcript until the provider refused or the turn ended mid-file. This
 * ports the essentials — summarize the old prefix, keep the recent turns
 * verbatim, and carry forward which files were read and changed.
 *
 * Everything here is pure. The sidecar owns the model call and the I/O.
 */

/** Matches pi-coding-agent's defaults; see compaction/compaction.ts. */
export const DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000
};

const CHARS_PER_TOKEN = 4;

function messageText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      if (block.type === 'text') return String(block.text || '');
      if (block.type === 'toolCall') {
        return `${block.name || ''} ${JSON.stringify(block.arguments || {})}`;
      }
      return '';
    })
    .join('\n');
}

export function estimateMessageTokens(message) {
  return Math.ceil(messageText(message).length / CHARS_PER_TOKEN);
}

/**
 * Tokens currently in context.
 *
 * The provider's own count is authoritative when it reported one; otherwise
 * fall back to a size estimate. Assuming zero would mean never compacting,
 * which is exactly the failure this module exists to prevent.
 */
export function estimateContextTokens(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const total = Number(list[i]?.usage?.totalTokens);
    if (Number.isFinite(total) && total > 0) return total;
  }
  return list.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

export function shouldCompact(contextTokens, contextWindow, settings = DEFAULT_COMPACTION_SETTINGS) {
  if (!settings || !settings.enabled) return false;
  const window = Number(contextWindow) || 0;
  if (!window) return false;
  return contextTokens > window - settings.reserveTokens;
}

/**
 * First index to KEEP, chosen so roughly `keepRecentTokens` survive.
 *
 * A tool result must stay with the tool call that produced it, so a cut never
 * lands on one — an orphaned result is rejected by every provider.
 */
export function findCutIndex(messages, keepRecentTokens) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= 1) return 0;

  let kept = 0;
  let cut = list.length;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    kept += estimateMessageTokens(list[i]);
    if (kept > keepRecentTokens) break;
    cut = i;
  }
  if (cut >= list.length) cut = list.length - 1;

  // Walk forward off any tool result, then back to the assistant turn that
  // owns the first kept result if we landed inside a call/result pair.
  while (cut < list.length && list[cut]?.role === 'toolResult') cut += 1;
  if (cut >= list.length) return 0;
  return cut;
}

/** Files the agent read, and files it created or changed. */
export function collectFileOperations(messages) {
  const read = new Set();
  const modified = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || block.type !== 'toolCall') continue;
      const path = block.arguments && typeof block.arguments.path === 'string' ? block.arguments.path : '';
      if (!path) continue;
      const name = String(block.name || '').toLowerCase();
      if (name === 'read') read.add(path);
      else if (name === 'write' || name === 'edit' || name === 'multiedit') modified.add(path);
    }
  }
  // A file that was written is no longer interesting as "read".
  for (const path of modified) read.delete(path);
  return { read, modified };
}

export function formatFileOperations(fileOps) {
  const read = fileOps && fileOps.read ? [...fileOps.read] : [];
  const modified = fileOps && fileOps.modified ? [...fileOps.modified] : [];
  const sections = [];
  if (read.length) sections.push(`Files already read:\n${read.map((p) => `- ${p}`).join('\n')}`);
  if (modified.length) {
    sections.push(`Files already created or changed:\n${modified.map((p) => `- ${p}`).join('\n')}`);
  }
  return sections.join('\n\n');
}

/**
 * Replace everything before `cutIndex` with one user message carrying the
 * summary and the file lists. The recent turns are passed through untouched.
 */
export function applyCompaction({ messages, cutIndex, summary, fileOps }) {
  const list = Array.isArray(messages) ? messages : [];
  if (!cutIndex || cutIndex <= 0 || cutIndex >= list.length) return list;

  const files = fileOps ? formatFileOperations(fileOps) : '';
  const parts = [
    'Earlier turns of this build were summarized to stay within the context window. This is what happened before the messages that follow.',
    String(summary || '').trim()
  ];
  if (files) parts.push(files);
  parts.push(
    'Continue from this state. Do not redo work listed as already done — read a file if you need its current contents.'
  );

  return [{ role: 'user', content: parts.filter(Boolean).join('\n\n') }, ...list.slice(cutIndex)];
}

/**
 * Stateful compactor for one agent run.
 *
 * Pi applies `transformContext` per stream call and does NOT write the result
 * back, so a naive implementation re-summarizes on every tool round once the
 * context is large — an extra model call each time. The transcript is
 * append-only within a run, so a compaction stays valid as messages arrive:
 * cache it and only summarize again when the tail has grown past the budget.
 *
 * `summarize(droppedMessages)` returns the summary text, or '' to skip. A
 * failed summary must leave the transcript untouched rather than lose the turn.
 */
export function createContextCompactor({
  contextWindow,
  settings = DEFAULT_COMPACTION_SETTINGS,
  summarize,
  onStatus
} = {}) {
  // { cutIndex, message } — cutIndex indexes the ORIGINAL message list.
  let cached = null;
  let running = false;

  const view = (messages) =>
    cached && cached.cutIndex < messages.length
      ? [cached.message, ...messages.slice(cached.cutIndex)]
      : messages;

  return async function compact(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const current = view(list);
    if (running) return current;

    const tokens = estimateContextTokens(current);
    if (!shouldCompact(tokens, contextWindow, settings)) return current;

    const cut = findCutIndex(current, settings.keepRecentTokens);
    if (cut <= 0) return current;

    running = true;
    try {
      onStatus?.(`compacting_context:${tokens}_tokens`);
      const dropped = current.slice(0, cut);
      // Compaction is a safeguard, not the work. If summarizing fails, carry on
      // with the full transcript and let the provider decide.
      let summary = '';
      try {
        summary = String((await summarize?.(dropped)) || '').trim();
      } catch (error) {
        onStatus?.(`compaction_failed:${error?.message || 'unknown'}`);
        return current;
      }
      if (!summary) return current;

      const compacted = applyCompaction({
        messages: current,
        cutIndex: cut,
        summary,
        fileOps: collectFileOperations(dropped)
      });
      // Translate the cut back onto the original list so the cache survives the
      // messages appended after this call. `current[0]` is the previous summary
      // when one exists, hence the offset.
      const absolute = cached ? cached.cutIndex + cut - 1 : cut;
      cached = { cutIndex: absolute, message: compacted[0] };
      onStatus?.(`compacted_context:${current.length}_to_${compacted.length}_messages`);
      return compacted;
    } finally {
      running = false;
    }
  };
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are summarizing the earlier part of a coding session so it can be dropped from context.

Report only what the next turn needs to continue: what was being built, which files exist and what each now contains, which tests pass or fail, decisions already made, and what remains unfinished. Be specific about names, paths, and signatures.

Do not continue the session, do not answer anything in it, and do not write code. Output only the summary.`;

/** The transcript slice to summarize, rendered for the summarizer. */
export function serializeForSummary(messages, maxToolResultChars = 2000) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => {
      if (message?.role === 'toolResult') {
        const text = messageText({ content: message.content });
        const clipped =
          text.length > maxToolResultChars
            ? `${text.slice(0, maxToolResultChars)}… (truncated)`
            : text;
        return `[tool result: ${message.toolName || 'tool'}]\n${clipped}`;
      }
      const role = message?.role === 'assistant' ? 'Assistant' : 'User';
      return `${role}: ${messageText(message)}`;
    })
    .filter((line) => line.trim())
    .join('\n\n');
}
