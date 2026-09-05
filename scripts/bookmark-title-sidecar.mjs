import { completeSimple } from '@mariozechner/pi-ai';
import { createModel } from './main-agent-core.mjs';
import { buildTitlePrompt, readTitleFromReply, normalizeBookmarkTitle } from './bookmark-title-core.mjs';

function readStdin() {
  return new Promise((resolve, reject) => {
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      body += chunk;
    });
    process.stdin.on('end', () => resolve(body));
    process.stdin.on('error', reject);
  });
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/**
 * Generous on purpose, even though a title is a few words.
 *
 * createModel marks every kimi-k2+ as a reasoning model and Moonshot returns
 * reasoning_content unasked; those tokens bill against the output budget. A
 * tight cap was spent entirely on thinking and returned no text at all, which
 * is why every bookmark came back unnamed. The cap is a ceiling, not a spend,
 * so the room costs nothing when the model is brief — and length is enforced by
 * normalizeBookmarkTitle rather than by starving the model.
 *
 * 1024 was tuned against kimi-k2.5. Moonshot decommissioned that model on
 * 2026-08-31 in favor of kimi-k2.6 (see `migrate_deprecated_model_id`), which
 * reasons enough to burn straight through 1024 tokens with no title text
 * left — the exact same failure mode this comment already described, just
 * with a new model. Rather than re-tune one constant against whatever model
 * Moonshot ships next, a request that hits the budget purely on reasoning is
 * retried once at four times the budget before giving up.
 */
const TITLE_TOKEN_BUDGET = 1024;
const TITLE_TOKEN_BUDGET_RETRY = TITLE_TOKEN_BUDGET * 4;

const raw = await readStdin();
const request = JSON.parse(raw || '{}');

async function requestTitle(maxTokens) {
  const model = createModel(request);
  const reply = await completeSimple(model, buildTitlePrompt(request), {
    apiKey: String(request.apiKey || ''),
    maxTokens
  });
  // completeSimple resolves on a provider failure rather than throwing, putting
  // the reason on the reply. Without this an expired key is reported as an
  // unusable title, which sends the reader looking in the wrong place.
  if (reply?.stopReason === 'error' || reply?.errorMessage) {
    throw new Error(String(reply.errorMessage || 'The model provider rejected the request.'));
  }
  return { title: normalizeBookmarkTitle(readTitleFromReply(reply)), stopReason: reply?.stopReason };
}

try {
  let { title, stopReason } = await requestTitle(TITLE_TOKEN_BUDGET);
  if (!title && stopReason === 'length') {
    ({ title, stopReason } = await requestTitle(TITLE_TOKEN_BUDGET_RETRY));
  }
  if (!title) {
    // Distinguish "spent the whole budget before writing any text" from "wrote
    // something unusable". The first is a budget bug and reads as silence
    // otherwise, which is exactly how the reasoning-token problem hid.
    throw new Error(
      stopReason === 'length'
        ? `The model used its entire ${TITLE_TOKEN_BUDGET_RETRY}-token retry budget without returning a title (stopReason=length).`
        : `The model did not return a usable title (stopReason=${stopReason ?? 'unknown'}).`
    );
  }
  emit({ ok: true, title });
} catch (error) {
  emit({ ok: false, error: error && error.message ? error.message : String(error) });
  process.exit(1);
}
