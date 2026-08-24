import { describe, expect, it } from 'vitest';
import {
  extensionDetailSectionOrder,
  extensionKeyAction,
  extensionKeyHint,
  extensionKeyStatus,
  extensionManifestMetadata,
  extensionSourceLabel,
  extensionToolParameters,
  extensionToolSummary
} from './extension-detail-view';

const credential = (key: string, configured: boolean) => ({ key, configured });

describe('extensionKeyAction', () => {
  it('offers to add the one missing key', () => {
    expect(extensionKeyAction([credential('API_KEY', false)])).toEqual({
      kind: 'add',
      label: 'Add API key',
      keys: ['API_KEY']
    });
  });

  it('collects only the missing keys when some are already stored', () => {
    const action = extensionKeyAction([
      credential('API_KEY', true),
      credential('API_SECRET', false)
    ]);
    expect(action).toEqual({ kind: 'add', label: 'Add API key', keys: ['API_SECRET'] });
  });

  it('offers replacement once every key is stored', () => {
    expect(extensionKeyAction([credential('API_KEY', true), credential('API_SECRET', true)])).toEqual({
      kind: 'replace',
      label: 'Replace API keys',
      keys: ['API_KEY', 'API_SECRET']
    });
  });

  it('has nothing to offer without credentials or before install', () => {
    expect(extensionKeyAction([])).toBeNull();
    expect(extensionKeyAction([credential('API_KEY', false)], { readOnly: true })).toBeNull();
  });
});

describe('extensionKeyStatus', () => {
  it('names the missing key on an installed extension', () => {
    expect(extensionKeyStatus([credential('API_KEY', false)])).toEqual({
      text: 'API key needed',
      configured: false
    });
  });

  it('confirms a stored key', () => {
    expect(extensionKeyStatus([credential('API_KEY', true)])).toEqual({
      text: 'API key added',
      configured: true
    });
  });

  it('stays generic for an extension that is not installed yet', () => {
    expect(extensionKeyStatus([], { readOnly: true, requiresKey: true })).toEqual({
      text: 'Requires key',
      configured: false
    });
  });

  it('says nothing when no key is involved', () => {
    expect(extensionKeyStatus([])).toBeNull();
    expect(extensionKeyStatus([], { readOnly: true })).toBeNull();
  });
});

describe('extensionKeyHint', () => {
  it('prompts only while a key is missing', () => {
    expect(extensionKeyHint([credential('API_KEY', false)])).toBe(
      'Add this key before this extension can run its tools.'
    );
    expect(extensionKeyHint([credential('A', false), credential('B', false)])).toBe(
      'Add these keys before this extension can run its tools.'
    );
    expect(extensionKeyHint([credential('API_KEY', true)])).toBeNull();
  });
});

describe('extensionDetailSectionOrder', () => {
  it('leads with the manifest, then setup, and ends with source', () => {
    expect(extensionDetailSectionOrder({ hasCredentials: true, hasReadme: true })).toEqual([
      'manifest',
      'setup',
      'tools',
      'cards',
      'readme',
      'source'
    ]);
  });

  it('omits sections with nothing to show', () => {
    expect(extensionDetailSectionOrder({ hasCredentials: false, hasReadme: false })).toEqual([
      'manifest',
      'tools',
      'cards',
      'source'
    ]);
  });
});

describe('extensionManifestMetadata', () => {
  it('reads a generated plugin manifest', () => {
    expect(
      extensionManifestMetadata({
        category: 'Economics',
        tags: ['world-bank', 'indicators'],
        icon: 'book-open',
        author: 'Geir Freysson',
        homepage: 'https://example.org',
        sdkVersion: 1,
        sourceUrls: ['https://api.example.org/docs'],
        samplePrompts: ['ignored']
      })
    ).toEqual({
      category: 'Economics',
      author: 'Geir Freysson',
      homepage: 'https://example.org',
      license: '',
      icon: 'book-open',
      sdkVersion: '1',
      tags: ['world-bank', 'indicators'],
      sources: ['https://api.example.org/docs']
    });
  });

  it('falls back to nested catalog metadata', () => {
    const metadata = extensionManifestMetadata({
      catalogMetadata: { category: 'Social', tags: ['x-api'], icon: 'message-square' },
      sourceUrls: ['https://developer.x.com']
    });
    expect(metadata.category).toBe('Social');
    expect(metadata.tags).toEqual(['x-api']);
    expect(metadata.sources).toEqual(['https://developer.x.com']);
  });

  it('accepts object sources and survives a manifest it cannot read', () => {
    expect(extensionManifestMetadata({ sources: [{ url: 'https://a.example' }] }).sources).toEqual([
      'https://a.example'
    ]);
    expect(extensionManifestMetadata(null).tags).toEqual([]);
  });
});

describe('extensionToolParameters', () => {
  it('flattens properties with type, requiredness, and enum values', () => {
    expect(
      extensionToolParameters({
        type: 'object',
        properties: {
          endpoint: { type: 'string', description: 'Which endpoint to browse.' },
          level: { type: 'integer', enum: [1, 2], default: 1 },
          tags: { type: 'array', items: { type: 'string' } }
        },
        required: ['endpoint']
      })
    ).toEqual([
      { name: 'endpoint', type: 'string', required: true, description: 'Which endpoint to browse.' },
      { name: 'level', type: 'integer', required: false, description: 'One of: 1, 2. Default: 1.' },
      { name: 'tags', type: 'string[]', required: false, description: '' }
    ]);
  });

  it('reports no rows for a tool that takes no arguments', () => {
    expect(extensionToolParameters({ type: 'object', properties: {} })).toEqual([]);
    expect(extensionToolParameters(undefined)).toEqual([]);
  });
});

describe('extensionToolSummary', () => {
  it('keeps the first sentence of a long model-facing description', () => {
    expect(
      extensionToolSummary('Lists the top stories. Follow up with hn_get_item for one story.')
    ).toBe('Lists the top stories.');
  });

  it('truncates a first sentence that is itself a paragraph', () => {
    const summary = extensionToolSummary(`${'word '.repeat(60)}end.`);
    expect(summary.length).toBeLessThanOrEqual(140);
    expect(summary.endsWith('...')).toBe(true);
  });

  it('handles a description with no sentence break or no text', () => {
    expect(extensionToolSummary('Fetches one spell')).toBe('Fetches one spell');
    expect(extensionToolSummary('   ')).toBe('');
  });
});

describe('extensionSourceLabel', () => {
  it('shortens a deep documentation URL to host and last segment', () => {
    expect(
      extensionSourceLabel(
        'https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-getting-started'
      )
    ).toBe('ec.europa.eu/.../api-getting-started');
  });

  it('keeps a shallow URL close to what was written', () => {
    expect(extensionSourceLabel('https://github.com/HackerNews/API')).toBe('github.com/.../API');
    expect(extensionSourceLabel('https://sdmx.oecd.org/public')).toBe('sdmx.oecd.org/public');
    expect(extensionSourceLabel('https://www.example.org/')).toBe('example.org');
  });

  it('returns anything it cannot parse unchanged', () => {
    expect(extensionSourceLabel('not a url')).toBe('not a url');
  });
});
