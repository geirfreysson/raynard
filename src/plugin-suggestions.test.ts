import { describe, expect, it } from 'vitest';
import { selectSplashPrompts } from './plugin-suggestions';

describe('selectSplashPrompts', () => {
  const fallback = ['Fallback one', 'Fallback two', 'Fallback three'];

  it('round-robins prompts across plugins before repeating one', () => {
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
      'Older prompt one',
      'Show me the current top three Hacker News stories.'
    ]);
  });

  it('uses all three prompts from a sole valid plugin', () => {
    expect(
      selectSplashPrompts(
        [{
          samplePrompts: [
            'Plugin prompt one',
            'Plugin prompt two',
            'Plugin prompt three'
          ]
        }],
        fallback
      )
    ).toEqual(['Plugin prompt one', 'Plugin prompt two', 'Plugin prompt three']);
  });

  it('falls back when the plugins cannot supply three usable prompts', () => {
    expect(
      selectSplashPrompts(
        [{ samplePrompts: ['Only one'] }, { samplePrompts: ['', '   '] }],
        fallback
      )
    ).toEqual(fallback);
  });
});
