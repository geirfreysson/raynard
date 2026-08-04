import { describe, expect, it } from 'vitest';
import { deriveCapabilityName, detectCapabilityRequest } from './plugin-capabilities';

describe('detectCapabilityRequest', () => {
  it('detects requests that should create a plugin workspace', () => {
    const result = detectCapabilityRequest('Add support for the SEC API so the agent can read filings');

    expect(result.requested).toBe(true);
    expect(result.name).toBe('sec');
    expect(result.description).toBe('Add support for the SEC API so the agent can read filings');
  });

  it('detects API explorer requests and captures source documentation URLs', () => {
    const result = detectCapabilityRequest(
      'i want you to build an explorer for the hacker news api, explained here: https://github.com/HackerNews/API'
    );

    expect(result.requested).toBe(true);
    expect(result.name).toBe('hacker-news');
    expect(result.sourceUrls).toEqual(['https://github.com/HackerNews/API']);
  });

  it('does not classify ordinary chat as a capability request', () => {
    const result = detectCapabilityRequest('Summarize the last answer in two bullets');

    expect(result.requested).toBe(false);
  });
});

describe('deriveCapabilityName', () => {
  it('falls back to a stable generated name when the prompt has no useful nouns', () => {
    expect(deriveCapabilityName('build a plugin')).toBe('generated-capability');
  });
});
