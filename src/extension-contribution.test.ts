import { describe, expect, it } from 'vitest';
import { contributionDefaults, parseContributionTags } from './extension-contribution';

describe('extension contribution metadata', () => {
  it('uses the extension slug and first secure source as safe defaults', () => {
    expect(
      contributionDefaults(
        { name: 'City Transit', directory: '/tmp/generated-plugins/city-transit' },
        { sourceUrls: ['http://unsafe.example', 'https://transport.example/api'] }
      )
    ).toEqual({
      category: 'Data',
      tags: ['city-transit', 'api'],
      icon: 'database',
      author: '',
      homepage: 'https://transport.example/api'
    });
  });

  it('prefills builder-authored catalog metadata without letting it supply identity fields', () => {
    expect(
      contributionDefaults(
        { name: 'City Transit', directory: '/tmp/generated-plugins/city-transit' },
        {
          sourceUrls: ['https://transport.example/api'],
          catalogMetadata: {
            category: 'Maps',
            tags: ['transit', 'routes', 'city', 'api'],
            icon: 'message-square',
            author: 'Model Guess',
            homepage: 'https://wrong.example'
          }
        }
      )
    ).toEqual({
      category: 'Maps',
      tags: ['transit', 'routes', 'city', 'api'],
      icon: 'message-square',
      author: '',
      homepage: 'https://transport.example/api'
    });
  });

  it('falls back when builder-authored catalog metadata is incomplete', () => {
    expect(
      contributionDefaults(
        { name: 'City Transit', directory: '/tmp/generated-plugins/city-transit' },
        { catalogMetadata: { category: 'Maps', tags: [], icon: 'map' } }
      )
    ).toMatchObject({ category: 'Data', tags: ['city-transit', 'api'], icon: 'database' });
  });

  it('parses comma-separated tags without blanks or exact duplicates', () => {
    expect(parseContributionTags(' europe, statistics, europe, ,api ')).toEqual([
      'europe',
      'statistics',
      'api'
    ]);
  });
});
