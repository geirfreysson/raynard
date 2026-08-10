import { describe, expect, it } from 'vitest';
import {
  allCredentialsConfigured,
  credentialPromptCopy,
  decodeCredentialRequest,
  missingCredentialKeys,
  retryPromptFor
} from './credential-request-flow';

const request = {
  pluginId: 'open-weather',
  pluginName: 'Open Weather',
  credentials: [
    {
      key: 'OPENWEATHER_API_KEY',
      label: 'OpenWeather API key',
      description: 'Free tier.',
      signupUrl: 'https://openweathermap.org/api'
    }
  ]
};

describe('credential request flow', () => {
  describe('decodeCredentialRequest', () => {
    it('decodes a well-formed request', () => {
      expect(decodeCredentialRequest(request)).toEqual(request);
    });

    it('rejects payloads that cannot render a prompt', () => {
      expect(decodeCredentialRequest(null)).toBeNull();
      expect(decodeCredentialRequest('nope')).toBeNull();
      expect(decodeCredentialRequest({ pluginId: 'x', credentials: [] })).toBeNull();
      expect(decodeCredentialRequest({ credentials: request.credentials })).toBeNull();
      expect(decodeCredentialRequest({ pluginId: 'x', credentials: [{ key: '' }] })).toBeNull();
    });

    it('drops a sign-up value that is not a usable link', () => {
      const decoded = decodeCredentialRequest({
        pluginId: 'x',
        credentials: [{ key: 'A_KEY', label: 'A key', signupUrl: 'javascript:alert(1)' }]
      });

      expect(decoded?.credentials[0].signupUrl).toBe('');
    });

    it('falls back to the key and id when labels are absent, and dedupes', () => {
      const decoded = decodeCredentialRequest({
        pluginId: 'open-weather',
        credentials: [{ key: 'A_KEY' }, { key: 'A_KEY' }]
      });

      expect(decoded).toEqual({
        pluginId: 'open-weather',
        pluginName: 'open-weather',
        credentials: [{ key: 'A_KEY', label: 'A_KEY', description: '', signupUrl: '' }]
      });
    });
  });

  describe('credentialPromptCopy', () => {
    it('names the plugin and the key so the text stands alone in history', () => {
      const copy = credentialPromptCopy(request);
      expect(copy.title).toBe('Open Weather needs OpenWeather API key');
      expect(copy.addLabel).toBe('Add key');
    });

    it('pluralizes for multiple credentials', () => {
      const copy = credentialPromptCopy({
        ...request,
        credentials: [
          request.credentials[0],
          { key: 'SECOND_KEY', label: 'Second key', signupUrl: '' }
        ]
      });

      expect(copy.title).toBe('Open Weather needs OpenWeather API key and Second key');
      expect(copy.addLabel).toBe('Add keys');
    });
  });

  describe('configured state', () => {
    it('is derived from the live plugin, not from anything persisted', () => {
      expect(allCredentialsConfigured(request, null)).toBe(false);
      expect(
        allCredentialsConfigured(request, {
          credentials: [{ key: 'OPENWEATHER_API_KEY', configured: true }]
        })
      ).toBe(true);
      expect(
        allCredentialsConfigured(request, {
          credentials: [{ key: 'OPENWEATHER_API_KEY', configured: false }]
        })
      ).toBe(false);
    });

    it('reports only the keys still missing', () => {
      const twoKeys = {
        ...request,
        credentials: [request.credentials[0], { key: 'SECOND_KEY', label: 'Second key' }]
      };

      expect(
        missingCredentialKeys(twoKeys, {
          credentials: [{ key: 'OPENWEATHER_API_KEY', configured: true }]
        })
      ).toEqual(['SECOND_KEY']);
    });
  });

  describe('retryPromptFor', () => {
    it('finds the question the card belongs to', () => {
      const messages = [
        { role: 'user', text: 'An older question' },
        { role: 'assistant', text: 'An older answer' },
        { role: 'user', text: "What's the weather in Reykjavik?" },
        { role: 'assistant', text: 'Open Weather needs an API key' }
      ];

      expect(retryPromptFor(messages, 3)).toBe("What's the weather in Reykjavik?");
    });

    it('skips mode-status lines, which are not real user turns', () => {
      const messages = [
        { role: 'user', text: 'The real question' },
        { role: 'user', text: 'Switched to Build mode', modeStatus: true },
        { role: 'assistant', text: 'Needs a key' }
      ];

      expect(retryPromptFor(messages, 2)).toBe('The real question');
    });

    it('returns empty when there is nothing to retry', () => {
      expect(retryPromptFor([], 0)).toBe('');
      expect(retryPromptFor([{ role: 'assistant', text: 'Only an answer' }], 1)).toBe('');
    });

    it('searches from the end when the record is not in the list', () => {
      const messages = [{ role: 'user', text: 'The question' }];
      expect(retryPromptFor(messages, -1)).toBe('The question');
    });
  });
});
