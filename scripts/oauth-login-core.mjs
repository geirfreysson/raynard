/**
 * Provider OAuth login, expressed as one testable function.
 *
 * The flow itself lives in `@mariozechner/pi-ai/oauth` and is Node-only: it
 * binds a local HTTP server for the redirect. This wrapper is the part worth
 * testing on its own — the event protocol the host sees, and the manual-code
 * fallback that carries the flow when the callback port is already taken.
 */

import { createServer } from 'node:http';
import { callbackErrorPage, callbackSuccessPage } from './oauth-callback-page.mjs';

/** Providers this app can sign into, and the login function behind each. */
export const OAUTH_PROVIDERS = {
  'openai-codex': {
    name: 'OpenAI (ChatGPT Plus/Pro)',
    loadLogin: async () => (await import('@mariozechner/pi-ai/oauth')).loginOpenAICodex,
    // Fixed by the provider's registered redirect URI, so it cannot be moved to
    // a free port if something else is holding it.
    callback: { host: '127.0.0.1', port: 1455, path: '/auth/callback' }
  }
};

/**
 * Serve the redirect ourselves so the user lands on our page, not pi's.
 *
 * Pi binds this same port and answers with its own dark, Pi-branded page, which
 * it imports directly — there is no option to replace it. Taking the port first
 * is what makes the page ours. Pi notices the port is busy, gives up on its own
 * server, and falls back to waiting for a hand-pasted code; feeding it the full
 * redirect URL through that channel completes the login exactly as before, with
 * pi still checking the `state` parameter itself.
 *
 * Returns `{ bound: false }` when the port is already taken — usually the Codex
 * CLI. Nothing is intercepted in that case and the flow behaves as it did
 * before this existed.
 */
export async function startBrandedCallbackServer({ host, port, path }) {
  let settle;
  const captured = new Promise((resolve) => {
    settle = resolve;
  });

  const server = createServer((request, response) => {
    const sendPage = (status, html) => {
      response.statusCode = status;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      // The page is the whole point of this server, so never leave the browser
      // on a bare error even when the request makes no sense.
      response.end(html);
    };
    try {
      const url = new URL(request.url || '', `http://${host}:${port}`);
      if (url.pathname !== path) {
        sendPage(404, callbackErrorPage('That address is not part of the sign-in.'));
        return;
      }
      const providerError = url.searchParams.get('error');
      if (providerError) {
        sendPage(
          400,
          callbackErrorPage(
            'The provider refused the sign-in.',
            url.searchParams.get('error_description') || providerError
          )
        );
        // Let the login keep waiting: the user may still paste a code by hand.
        return;
      }
      if (!url.searchParams.get('code')) {
        sendPage(400, callbackErrorPage('The provider did not send an authorization code.'));
        return;
      }
      sendPage(200, callbackSuccessPage());
      // The whole URL, not just the code: pi parses it and checks `state`.
      settle(url.toString());
    } catch (error) {
      sendPage(500, callbackErrorPage('Could not read the sign-in response.'));
    }
  });

  return new Promise((resolve) => {
    server.once('error', () => {
      resolve({ bound: false, captured: new Promise(() => {}), close: () => {} });
    });
    server.listen(port, host, () => {
      resolve({
        bound: true,
        captured,
        close: () => {
          try {
            server.close();
          } catch {
            // Already closing; the process is ending either way.
          }
        }
      });
    });
  });
}

/**
 * Runs one login and reports it as a stream of events.
 *
 * `readManualCode` returns a promise for a code the user pasted by hand. Pi
 * races it against the browser redirect, and treats a *rejection* as the user
 * aborting the whole login — so this never rejects. A cancelled login is a
 * killed process, not a rejected promise.
 */
export async function runOAuthLogin({ login, emit, readManualCode, originator = 'raynard' }) {
  const waitForManualCode = () =>
    Promise.resolve(readManualCode()).then(
      (code) => String(code || '').trim(),
      () => new Promise(() => {})
    );

  try {
    const credential = await login({
      originator,
      onAuth: (info) => {
        emit({ type: 'auth_url', url: String(info?.url || '') });
        if (info?.instructions) {
          emit({ type: 'progress', message: String(info.instructions) });
        }
      },
      onProgress: (message) => emit({ type: 'progress', message: String(message || '') }),
      onManualCodeInput: waitForManualCode,
      onPrompt: waitForManualCode
    });

    const normalized = normalizeCredential(credential);
    if (!normalized) {
      emit({ type: 'error', error: 'Sign-in did not return usable credentials.' });
      return { ok: false };
    }
    emit({ type: 'done', credential: normalized });
    return { ok: true, credential: normalized };
  } catch (error) {
    emit({ type: 'error', error: describeLoginError(error) });
    return { ok: false };
  }
}

function normalizeCredential(credential) {
  const access = String(credential?.access || '').trim();
  const refresh = String(credential?.refresh || '').trim();
  const expires = Number(credential?.expires);
  if (!access || !refresh || !Number.isFinite(expires)) return null;
  return {
    access,
    refresh,
    expires: Math.round(expires),
    accountId: credential?.accountId ? String(credential.accountId) : null
  };
}

/**
 * Keeps the surfaced message free of anything token-shaped. Provider errors
 * quote the failing token exchange, and this message reaches both the UI and
 * the app log.
 */
function describeLoginError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  const cleaned = message.replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]').trim();
  return cleaned || 'Sign-in failed.';
}
