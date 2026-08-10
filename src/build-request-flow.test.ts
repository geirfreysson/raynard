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
      progress: 'Preparing hacker-news for the coding agent...',
      authNotice: '',
      signupUrl: '',
      signupLabel: 'Get an API key'
    });
  });

  it('tells the user to sign up for a key while the plugin is being written', () => {
    const copy = pluginWriteConfirmationCopy('open-weather', {
      required: true,
      credentialLabel: 'OpenWeather API key',
      signupUrl: 'https://openweathermap.org/api'
    });

    expect(copy.authNotice).toContain('OpenWeather API key');
    expect(copy.authNotice).toMatch(/sign up/i);
    expect(copy.signupUrl).toBe('https://openweathermap.org/api');
  });

  it('still names the requirement when the agent gives no sign-up page', () => {
    const copy = pluginWriteConfirmationCopy('open-weather', { required: true });

    expect(copy.authNotice).toContain('an API key');
    expect(copy.signupUrl).toBe('');
  });

  it('ignores a sign-up value that is not a usable link', () => {
    const copy = pluginWriteConfirmationCopy('open-weather', {
      required: true,
      signupUrl: 'javascript:alert(1)'
    });

    expect(copy.signupUrl).toBe('');
  });

  it('says nothing about keys when the API does not need one', () => {
    expect(pluginWriteConfirmationCopy('hacker-news', { required: false }).authNotice).toBe('');
  });
});
