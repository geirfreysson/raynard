/**
 * Readable JSON for the citation modal.
 *
 * A reference's payload arrives as whatever the plugin serialized — usually
 * pretty-printed by the SDK, sometimes minified, and sometimes cut mid-structure
 * by the citation payload cap. So the text is re-indented when it parses, and
 * tokenized either way: a truncated payload still highlights, because the
 * tokenizer works line by line rather than needing a valid document.
 */

export type JsonTokenKind = 'key' | 'string' | 'number' | 'atom' | 'plain';

export type JsonToken = {
  text: string;
  kind: JsonTokenKind;
};

// One pass over strings (a key is a string followed by a colon), numbers, and
// the three bare literals. Everything else stays plain punctuation.
const TOKEN_PATTERN =
  /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** Re-indents a payload, or returns it unchanged when it does not parse. */
export function prettyJson(text: string): string {
  const source = String(text ?? '').trim();
  if (!source) return '';
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    return source;
  }
}

/** Splits JSON text into highlightable tokens, in document order. */
export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let index = 0;

  TOKEN_PATTERN.lastIndex = 0;
  let match = TOKEN_PATTERN.exec(text);
  while (match) {
    if (match.index > index) {
      tokens.push({ text: text.slice(index, match.index), kind: 'plain' });
    }
    tokens.push({ text: match[0], kind: kindOf(match[0], text, match.index + match[0].length) });
    index = match.index + match[0].length;
    match = TOKEN_PATTERN.exec(text);
  }

  if (index < text.length) tokens.push({ text: text.slice(index), kind: 'plain' });
  return tokens;
}

function kindOf(token: string, text: string, end: number): JsonTokenKind {
  if (token.startsWith('"')) {
    return /^\s*:/.test(text.slice(end)) ? 'key' : 'string';
  }
  return token === 'true' || token === 'false' || token === 'null' ? 'atom' : 'number';
}

/**
 * Renders JSON into a `<pre>`, highlighted. Builds text nodes rather than
 * markup so a payload can never inject anything into the modal.
 */
export function renderJson(text: string): HTMLPreElement {
  const pre = document.createElement('pre');
  pre.className = 'json-view';

  for (const token of tokenizeJson(prettyJson(text))) {
    if (token.kind === 'plain') {
      pre.appendChild(document.createTextNode(token.text));
      continue;
    }
    const span = document.createElement('span');
    span.className = `json-${token.kind}`;
    span.textContent = token.text;
    pre.appendChild(span);
  }

  return pre;
}
