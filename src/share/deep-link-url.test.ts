import { describe, expect, it } from 'vitest';

import { parseShareDeepLink } from './deep-link-url';

describe('parseShareDeepLink', () => {
  it('reads the canonical form', () => {
    expect(parseShareDeepLink('raynard://share/AbC-_123', 'raynard')).toBe('AbC-_123');
  });

  it('accepts a scheme the OS lowercased', () => {
    expect(parseShareDeepLink('Raynard://Share/AbC', 'raynard')).toBe('AbC');
  });

  it('tolerates a trailing slash', () => {
    expect(parseShareDeepLink('raynard://share/AbC/', 'raynard')).toBe('AbC');
  });

  it('rejects another scheme', () => {
    expect(parseShareDeepLink('https://raynard.ai/s#AbC', 'raynard')).toBeNull();
  });

  it('rejects another host', () => {
    expect(parseShareDeepLink('raynard://open/AbC', 'raynard')).toBeNull();
  });

  it('rejects an empty payload', () => {
    expect(parseShareDeepLink('raynard://share/', 'raynard')).toBeNull();
  });

  it('rejects characters outside base64url', () => {
    expect(parseShareDeepLink('raynard://share/AbC+def=', 'raynard')).toBeNull();
    expect(parseShareDeepLink('raynard://share/AbC?x=1', 'raynard')).toBeNull();
    expect(parseShareDeepLink('raynard://share/../../etc/passwd', 'raynard')).toBeNull();
  });

  it('rejects an unbounded payload', () => {
    expect(parseShareDeepLink(`raynard://share/${'A'.repeat(70_000)}`, 'raynard')).toBeNull();
  });

  it('never throws on junk', () => {
    for (const value of ['', '   ', 'raynard://', 'raynard:', '://share/x']) {
      expect(() => parseShareDeepLink(value, 'raynard')).not.toThrow();
      expect(parseShareDeepLink(value, 'raynard')).toBeNull();
    }
  });
});
