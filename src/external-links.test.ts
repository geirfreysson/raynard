import { describe, expect, it } from 'vitest';
import { resolveExternalUrl } from './external-links';

describe('resolveExternalUrl', () => {
  it('accepts http and https links', () => {
    expect(resolveExternalUrl('https://data360api.worldbank.org/data360/data?REF_AREA=GBR')).toBe(
      'https://data360api.worldbank.org/data360/data?REF_AREA=GBR'
    );
    expect(resolveExternalUrl('http://example.com/page#anchor')).toBe(
      'http://example.com/page#anchor'
    );
    expect(resolveExternalUrl('  https://example.com/spaced  ')).toBe('https://example.com/spaced');
  });

  it('rejects schemes the platform opener must never receive', () => {
    expect(resolveExternalUrl('javascript:alert(1)')).toBeNull();
    expect(resolveExternalUrl('file:///etc/passwd')).toBeNull();
    expect(resolveExternalUrl('data:text/html,<script>')).toBeNull();
  });

  it('rejects non-absolute, empty, and flag-shaped values', () => {
    expect(resolveExternalUrl('/relative/path')).toBeNull();
    expect(resolveExternalUrl('#section')).toBeNull();
    expect(resolveExternalUrl('')).toBeNull();
    expect(resolveExternalUrl('   ')).toBeNull();
    expect(resolveExternalUrl(null)).toBeNull();
    expect(resolveExternalUrl(undefined)).toBeNull();
    expect(resolveExternalUrl('-flag')).toBeNull();
  });

  it('rejects embedded whitespace instead of splitting it into opener arguments', () => {
    expect(resolveExternalUrl('https://example.com/a b')).toBeNull();
    expect(resolveExternalUrl('https://example.com --background')).toBeNull();
  });
});
