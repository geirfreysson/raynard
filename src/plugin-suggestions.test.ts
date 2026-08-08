import { describe, expect, it } from 'vitest';
import { selectSplashPrompts } from './plugin-suggestions';

describe('selectSplashPrompts', () => {
  const fallback = ['Fallback one', 'Fallback two', 'Fallback three'];

  it('uses the newest plugin prompts for the empty-chat splash', () => {
    expect(
      selectSplashPrompts(
        [
          {
            samplePrompts: [
              'Who wrote the highest-scoring Hacker News story today?',
              'Show me the current top three Hacker News stories.',
              'What has the most comments on Hacker News right now?'
            ]
          },
          {
            samplePrompts: ['Older prompt one', 'Older prompt two', 'Older prompt three']
          }
        ],
        fallback
      )
    ).toEqual([
      'Who wrote the highest-scoring Hacker News story today?',
      'Show me the current top three Hacker News stories.',
      'What has the most comments on Hacker News right now?'
    ]);
  });

  it('falls back when no plugin has three usable prompts', () => {
    expect(
      selectSplashPrompts(
        [{ samplePrompts: ['Only one'] }, { samplePrompts: ['', '   '] }],
        fallback
      )
    ).toEqual(fallback);
  });
});
