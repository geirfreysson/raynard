import { describe, expect, it } from 'vitest';
import { continueBuildRequest, nextBuildRequestStep } from './build-request-flow';

const request = {
  name: 'hacker-news',
  description: 'Build Hacker News API tools.',
  sourceUrls: ['https://github.com/HackerNews/API'],
  reason: 'The capability is not installed.'
};

describe('build request mode flow', () => {
  it('requires a mode switch when a build request originates in Explore', () => {
    expect(nextBuildRequestStep('explore')).toBe('offer-switch');
  });

  it('offers confirmation when already in Build', () => {
    expect(nextBuildRequestStep('build')).toBe('confirm-write');
  });

  it('carries the exact pending request into Build after switching', () => {
    expect(continueBuildRequest(request)).toEqual({
      mode: 'build',
      step: 'confirm-write',
      request
    });
  });
});
