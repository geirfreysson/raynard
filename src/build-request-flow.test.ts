import { describe, expect, it } from 'vitest';
import {
  automaticModeForUserTurn,
  confirmedPluginWriteMode,
  modeSwitchStatus,
  nextBuildRequestStep,
  pluginWriteConfirmationCopy
} from './build-request-flow';

const request = {
  name: 'hacker-news',
  description: 'Build Hacker News API tools.',
  sourceUrls: ['https://github.com/HackerNews/API'],
  reason: 'The capability is not installed.'
};

describe('build request mode flow', () => {
  it('offers write confirmation while remaining in Explore', () => {
    expect(nextBuildRequestStep('explore')).toBe('confirm-write');
  });

  it('offers confirmation when already in Build', () => {
    expect(nextBuildRequestStep('build')).toBe('confirm-write');
  });

  it('uses Explore for ordinary user turns', () => {
    expect(automaticModeForUserTurn()).toBe('explore');
  });

  it('enters Build only for a confirmed plugin write', () => {
    expect(confirmedPluginWriteMode()).toBe('build');
  });

  it('describes actual mode changes and omits no-op transitions', () => {
    expect(modeSwitchStatus('build', 'explore')).toBe('Switched to Explore mode');
    expect(modeSwitchStatus('explore', 'build')).toBe('Switched to Build mode');
    expect(modeSwitchStatus('explore', 'explore')).toBeUndefined();
  });

  it('uses plugin-writing language instead of workspace internals', () => {
    expect(pluginWriteConfirmationCopy(request.name)).toEqual({
      title: 'Write plugin: hacker-news',
      description:
        'This will switch to Build mode and let the coding agent create or update this plugin.',
      confirmLabel: 'Write plugin',
      progress: 'Preparing hacker-news for the coding agent...'
    });
  });
});
