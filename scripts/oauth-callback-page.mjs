/**
 * The page the browser lands on after a provider sign-in redirect.
 *
 * Pi ships its own version of this page — dark, with the Pi mark — and the
 * OAuth flow inside `@mariozechner/pi-ai` imports it directly with no way to
 * override it. Since this is the one screen of the sign-in the user actually
 * looks at, it is worth owning: this app serves its own callback page and hands
 * the captured code back to pi through its manual-code channel.
 *
 * The fox is inlined rather than read from `src/assets`, because the signed
 * standalone bundle ships `scripts/` and a Node runtime but no `src/`. A test
 * asserts this copy still matches the asset it was taken from, so the two
 * cannot drift apart unnoticed.
 */

export const FOX_LOGO_SVG = `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="198.000000pt" height="180.000000pt" viewBox="0 0 198.000000 180.000000" preserveAspectRatio="xMidYMid meet"> <g transform="translate(0.000000,180.000000) scale(0.100000,-0.100000)" fill="#5F120D" stroke="none"> <path d="M1745 854 c-22 -19 -69 -49 -105 -67 -65 -32 -65 -32 -320 -32 -232 -1 -263 -3 -340 -24 -169 -44 -337 -147 -432 -263 -37 -46 -37 -46 -6 -93 74 -111 259 -225 424 -259 31 -7 31 -7 22 46 -17 89 -5 176 32 246 74 140 213 219 459 262 138 24 237 86 289 179 13 22 22 41 20 41 -2 -1 -21 -16 -43 -36z"/> </g> <g transform="translate(0.000000,180.000000) scale(0.100000,-0.100000)" fill="#AE2B22" stroke="none"> <path d="M894 1607 c-50 -45 -132 -127 -183 -182 -51 -54 -109 -110 -129 -124 -71 -48 -123 -95 -171 -155 -165 -208 -206 -478 -104 -688 35 -73 35 -73 49 -11 13 66 63 170 95 199 18 16 18 15 12 -33 -3 -32 0 -68 11 -104 27 -91 29 -92 86 -27 103 116 251 204 420 249 78 21 107 23 340 24 287 0 296 2 406 85 28 21 54 37 56 34 3 -2 5 2 5 10 0 9 -30 25 -76 41 -98 35 -182 79 -215 114 -18 18 -32 51 -42 92 -18 76 -37 98 -129 151 -38 23 -71 42 -73 43 -1 1 5 46 13 101 15 101 20 194 9 194 -9 0 -113 -82 -189 -150 -70 -62 -70 -62 -79 79 -4 78 -11 141 -15 141 -3 -1 -47 -38 -97 -83z m421 -467 c23 -21 38 -77 25 -85 -14 -8 -110 22 -131 41 -12 10 -30 32 -42 48 -21 29 -21 29 53 23 55 -5 78 -11 95 -27z"/> <path d="M1458 663 c7 -3 16 -2 19 1 4 3 -2 6 -13 5 -11 0 -14 -3 -6 -6z"/> <path d="M981 194 c0 -11 3 -14 6 -6 3 7 2 16 -1 19 -3 4 -6 -2 -5 -13z"/> </g> </svg>`;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * One callback page.
 *
 * `detail` is optional and shown in a monospace block — it carries a provider
 * error verbatim, so it is escaped like everything else here.
 */
export function renderCallbackPage({ title, heading, message, detail } = {}) {
  const safeDetail = detail ? escapeHtml(detail) : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --text: #1f1f1f;
      --text-muted: #5e5e5e;
      --page-bg: #ffffff;
      --font-sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
    }
    * { box-sizing: border-box; }
    /* The app's own surfaces are light; the redirect should not flash dark. */
    html { color-scheme: light; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 560px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .logo {
      width: 88px;
      height: 80px;
      margin-bottom: 24px;
    }
    .logo svg { width: 100%; height: 100%; display: block; }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 650;
    }
    p {
      margin: 0;
      font-size: 15px;
      line-height: 1.7;
      color: var(--text-muted);
    }
    .detail {
      margin-top: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-muted);
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <div class="logo" aria-hidden="true">${FOX_LOGO_SVG}</div>
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(message)}</p>
    ${safeDetail ? `<div class="detail">${safeDetail}</div>` : ''}
  </main>
</body>
</html>`;
}

export function callbackSuccessPage() {
  return renderCallbackPage({
    title: 'Signed in to Raynard',
    heading: 'You are signed in',
    message: 'Raynard has your credentials. You can close this tab and go back to the app.'
  });
}

export function callbackErrorPage(message, detail) {
  return renderCallbackPage({
    title: 'Sign-in failed',
    heading: 'Sign-in failed',
    message: message || 'The sign-in could not be completed.',
    detail
  });
}
