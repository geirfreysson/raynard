import { describe, expect, it } from 'vitest';
import { runOAuthLogin, startBrandedCallbackServer } from './oauth-login-core.mjs';
import { callbackErrorPage, callbackSuccessPage, FOX_LOGO_SVG } from './oauth-callback-page.mjs';

function recorder() {
  const events = [];
  return { events, emit: (event) => events.push(event) };
}

const CREDENTIAL = {
  access: 'access-token',
  refresh: 'refresh-token',
  expires: 1234,
  accountId: 'acct_1'
};

describe('oauth login core', () => {
  it('reports the authorization URL, then the credential', async () => {
    const { events, emit } = recorder();

    const result = await runOAuthLogin({
      emit,
      readManualCode: () => new Promise(() => {}),
      login: async (options) => {
        options.onAuth({ url: 'https://auth.openai.com/oauth/authorize?x=1' });
        return CREDENTIAL;
      }
    });

    expect(result.ok).toBe(true);
    expect(events.map((event) => event.type)).toEqual(['auth_url', 'done']);
    expect(events[0].url).toBe('https://auth.openai.com/oauth/authorize?x=1');
    expect(events[1].credential).toEqual({
      access: 'access-token',
      refresh: 'refresh-token',
      expires: 1234,
      accountId: 'acct_1'
    });
  });

  it('completes from a pasted code when the callback port is taken', async () => {
    // Codex CLI holds :1455, so pi's local server never receives the redirect
    // and the flow falls through to whatever the user pastes back.
    const { events, emit } = recorder();

    const result = await runOAuthLogin({
      emit,
      readManualCode: async () => '  pasted-code  ',
      login: async (options) => {
        options.onAuth({ url: 'https://auth.openai.com/oauth/authorize' });
        const code = await options.onManualCodeInput();
        expect(code).toBe('pasted-code');
        return CREDENTIAL;
      }
    });

    expect(result.ok).toBe(true);
    expect(events.at(-1).type).toBe('done');
  });

  it('never rejects the manual-code promise, which would abort the browser flow', async () => {
    // Pi treats a rejected onManualCodeInput as the user aborting the login,
    // so a failed stdin read must not cancel a redirect that is still coming.
    const { events, emit } = recorder();
    let manualSettled = false;

    const result = await runOAuthLogin({
      emit,
      readManualCode: async () => {
        throw new Error('stdin closed');
      },
      login: async (options) => {
        options.onManualCodeInput().then(
          () => {
            manualSettled = true;
          },
          () => {
            manualSettled = true;
          }
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        return CREDENTIAL;
      }
    });

    expect(manualSettled).toBe(false);
    expect(result.ok).toBe(true);
    expect(events.at(-1).type).toBe('done');
  });

  it('emits one redacted error when the flow fails', async () => {
    const { events, emit } = recorder();

    const result = await runOAuthLogin({
      emit,
      readManualCode: () => new Promise(() => {}),
      login: async () => {
        throw new Error(
          'token exchange failed (400): {"refresh_token":"rt_012345678901234567890123456789012345678901"}'
        );
      }
    });

    expect(result.ok).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].error).toContain('[redacted]');
    expect(events[0].error).not.toContain('012345678901234567890123456789');
  });

  it('rejects a credential missing the refresh token instead of storing it', async () => {
    const { events, emit } = recorder();

    const result = await runOAuthLogin({
      emit,
      readManualCode: () => new Promise(() => {}),
      login: async () => ({ access: 'access-token', expires: 1234 })
    });

    expect(result.ok).toBe(false);
    expect(events.map((event) => event.type)).toEqual(['error']);
  });

  it('keeps tokens out of every event except the final credential', async () => {
    const { events, emit } = recorder();

    await runOAuthLogin({
      emit,
      readManualCode: () => new Promise(() => {}),
      login: async (options) => {
        options.onAuth({ url: 'https://auth.openai.com/oauth/authorize', instructions: 'Open it' });
        options.onProgress('Waiting for the browser');
        return CREDENTIAL;
      }
    });

    for (const event of events.filter((event) => event.type !== 'done')) {
      expect(JSON.stringify(event)).not.toContain('refresh-token');
      expect(JSON.stringify(event)).not.toContain('access-token');
    }
  });
});

describe('branded callback page', () => {
  it('is the app\'s own page, not pi\'s dark Pi-branded one', () => {
    const html = callbackSuccessPage();

    expect(html).toContain('<!doctype html>');
    expect(html).toMatch(/--page-bg:\s*#ffffff/);
    expect(html).toMatch(/color-scheme:\s*light/);
    // The fox, identified by its brand reds.
    expect(html).toContain('#5F120D');
    expect(html).toContain('#AE2B22');
    // Pi's mark is an 800x800 viewBox drawn in #fff; neither should appear.
    expect(html).not.toContain('viewBox="0 0 800 800"');
    expect(html).not.toMatch(/--page-bg:\s*#09090b/);
  });

  it('keeps the inlined fox identical to the asset the app renders', async () => {
    // The bundle ships scripts/ but no src/, so the logo has to be inlined —
    // which means the copy can silently drift from the real one.
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const asset = await readFile(join(here, '../src/assets/northfox-fox-logo.svg'), 'utf8');

    const normalize = (value) => value.split(/\s+/).join(' ').trim();
    expect(normalize(FOX_LOGO_SVG)).toBe(normalize(asset));
  });

  it('escapes a provider error rather than putting it into the page as markup', () => {
    const html = callbackErrorPage('Refused.', '<img src=x onerror=alert(1)>');

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
  });
});

describe('branded callback server', () => {
  const CALLBACK = { host: '127.0.0.1', port: 1466, path: '/auth/callback' };

  async function get(url) {
    const response = await fetch(url);
    return { status: response.status, body: await response.text() };
  }

  it('serves the branded page and hands back the whole redirect URL', async () => {
    const server = await startBrandedCallbackServer(CALLBACK);
    expect(server.bound).toBe(true);
    try {
      const target = `http://127.0.0.1:${CALLBACK.port}/auth/callback?code=abc123&state=xyz`;
      const { status, body } = await get(target);

      expect(status).toBe(200);
      expect(body).toContain('#5F120D');
      // The full URL, so pi can still verify `state` — not just the code.
      await expect(server.captured).resolves.toBe(target);
    } finally {
      server.close();
    }
  });

  it('does not resolve on a provider error, leaving the paste fallback open', async () => {
    const server = await startBrandedCallbackServer(CALLBACK);
    try {
      const { status, body } = await get(
        `http://127.0.0.1:${CALLBACK.port}/auth/callback?error=access_denied&error_description=User+refused`
      );

      expect(status).toBe(400);
      expect(body).toContain('User refused');

      const settled = await Promise.race([
        server.captured.then(() => 'resolved'),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 30))
      ]);
      expect(settled).toBe('pending');
    } finally {
      server.close();
    }
  });

  it('steps aside when the port is already taken instead of failing the login', async () => {
    // The Codex CLI holding 1455 is the real case this protects.
    const holder = await startBrandedCallbackServer(CALLBACK);
    try {
      const second = await startBrandedCallbackServer(CALLBACK);
      expect(second.bound).toBe(false);
      // Must not throw, and must never resolve — the paste field carries the flow.
      expect(() => second.close()).not.toThrow();
    } finally {
      holder.close();
    }
  });
});
