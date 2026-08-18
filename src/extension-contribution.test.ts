import { describe, expect, it } from 'vitest';
import { contributionDefaults, parseContributionTags } from './extension-contribution';

describe('extension contribution metadata', () => {
  it('uses the extension slug and first secure source as safe defaults', () => {
    expect(
      contributionDefaults(
        { name: 'Eurostat', directory: '/tmp/generated-plugins/eurostat' },
        { sourceUrls: ['http://unsafe.example', 'https://ec.europa.eu/eurostat'] }
      )
    ).toEqual({
      category: 'Data',
      tags: ['eurostat', 'api'],
      icon: 'database',
      author: '',
      homepage: 'https://ec.europa.eu/eurostat'
    });
  });

  it('parses comma-separated tags without blanks or exact duplicates', () => {
    expect(parseContributionTags(' europe, statistics, europe, ,api ')).toEqual([
      'europe',
      'statistics',
      'api'
    ]);
  });
});
