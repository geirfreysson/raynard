/**
 * Signs the user into a model provider over OAuth and hands the credential
 * back to the host.
 *
 * This lives in its own process because pi's login flow binds a local HTTP
 * server for the OAuth redirect — it cannot run in the webview or in Rust.
 *
 * Protocol, newline-delimited JSON both ways:
 *   in   {"provider":"openai-codex"}                 first line, required
 *   in   {"type":"manual_code","code":"..."}         later, optional
 *   out  {"type":"auth_url","url":"..."}
 *   out  {"type":"progress","message":"..."}
 *   out  {"type":"done","credential":{...}}
 *   out  {"type":"error","error":"..."}
 *
 * Unlike the agent sidecars this keeps reading stdin after the request, so a
 * hand-pasted code can arrive mid-flow. Cancellation is the host killing us.
 */
import { createInterface } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { OAUTH_PROVIDERS, runOAuthLogin, startBrandedCallbackServer } from './oauth-login-core.mjs';

function emit(event) {
  output.write(`${JSON.stringify(event)}\n`);
}

const reader = createInterface({ input, terminal: false });
let resolveRequest;
const requestPromise = new Promise((resolve) => {
  resolveRequest = resolve;
});
const pendingCodes = [];
let awaitingCode = null;

reader.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (resolveRequest) {
    const resolve = resolveRequest;
    resolveRequest = null;
    resolve(message);
    return;
  }
  if (message?.type === 'manual_code') {
    const code = String(message.code || '').trim();
    if (!code) return;
    if (awaitingCode) {
      const resolve = awaitingCode;
      awaitingCode = null;
      resolve(code);
    } else {
      pendingCodes.push(code);
    }
  }
});

/** Resolves with the next pasted code; stays pending forever if none arrives. */
function readManualCode() {
  if (pendingCodes.length) return Promise.resolve(pendingCodes.shift());
  return new Promise((resolve) => {
    awaitingCode = resolve;
  });
}

const request = await requestPromise;
const providerId = String(request?.provider || '').trim();
const provider = OAUTH_PROVIDERS[providerId];

if (!provider) {
  emit({ type: 'error', error: `No OAuth sign-in is available for ${providerId || 'this provider'}.` });
  process.exit(1);
}

let login;
try {
  login = await provider.loadLogin();
} catch (error) {
  emit({
    type: 'error',
    error: `Could not load the ${provider.name} sign-in flow: ${error instanceof Error ? error.message : String(error)}`
  });
  process.exit(1);
}

// Claim the redirect port before pi can, so the browser lands on our page
// rather than pi's. Must happen before the login starts. If the port is already
// held, nothing is intercepted and the flow behaves exactly as it did before.
const callback = provider.callback
  ? await startBrandedCallbackServer(provider.callback)
  : { bound: false, captured: new Promise(() => {}), close: () => {} };

/**
 * The next authorization input, from whichever source produces one first.
 *
 * The branded callback hands over the full redirect URL; the paste field hands
 * over whatever the user typed. Pi accepts either and validates `state` itself.
 */
const readAuthorizationInput = () => Promise.race([callback.captured, readManualCode()]);

let result;
try {
  result = await runOAuthLogin({ login, emit, readManualCode: readAuthorizationInput });
} finally {
  callback.close();
}
process.exit(result.ok ? 0 : 1);
