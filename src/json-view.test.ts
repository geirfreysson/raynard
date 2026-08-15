// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { prettyJson, renderJson, tokenizeJson } from './json-view';

describe('prettyJson', () => {
  it('re-indents a minified payload', () => {
    expect(prettyJson('{"count":4,"value":[1]}')).toBe(
      '{\n  "count": 4,\n  "value": [\n    1\n  ]\n}'
    );
  });

  it('leaves a payload the cap cut mid-structure alone', () => {
    const truncated = '{\n  "count": 4,\n  "value": [\n    { "REF_AREA": "IS';
    expect(prettyJson(truncated)).toBe(truncated);
  });

  it('is empty for an empty payload', () => {
    expect(prettyJson('   ')).toBe('');
  });
});

describe('tokenizeJson', () => {
  const kinds = (text: string) =>
    tokenizeJson(text)
      .filter((token) => token.kind !== 'plain')
      .map((token) => `${token.kind}:${token.text}`);

  it('separates keys from string values', () => {
    expect(kinds('{"REF_AREA": "ISL"}')).toEqual(['key:"REF_AREA"', 'string:"ISL"']);
  });

  it('marks numbers and bare literals', () => {
    expect(kinds('{"a": 66944, "b": -1.5e3, "c": true, "d": null}')).toEqual([
      'key:"a"',
      'number:66944',
      'key:"b"',
      'number:-1.5e3',
      'key:"c"',
      'atom:true',
      'key:"d"',
      'atom:null'
    ]);
  });

  it('does not split a string containing an escaped quote', () => {
    expect(kinds('{"q": "say \\"hi\\" now"}')).toEqual(['key:"q"', 'string:"say \\"hi\\" now"']);
  });

  it('keeps a colon inside a string value from making it a key', () => {
    expect(kinds('{"url": "https://x/y?a=1"}')).toEqual(['key:"url"', 'string:"https://x/y?a=1"']);
  });

  it('round-trips every character of the input', () => {
    const source = '{\n  "a": [1, true, null],\n  "b": "x"\n}';
    expect(tokenizeJson(source).map((token) => token.text).join('')).toBe(source);
  });
});

describe('renderJson', () => {
  it('highlights without letting a payload inject markup', () => {
    const pre = renderJson('{"html": "<img src=x onerror=alert(1)>"}');

    expect(pre.querySelector('img')).toBeNull();
    expect(pre.querySelector('.json-key')?.textContent).toBe('"html"');
    expect(pre.querySelector('.json-string')?.textContent).toBe('"<img src=x onerror=alert(1)>"');
    expect(pre.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
