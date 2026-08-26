import { describe, expect, it } from 'vitest';

import {
  parseScreenshotSizeArgs,
  SCREENSHOT_SIZE_PRESETS
} from './resize-screenshot-window.mjs';

describe('parseScreenshotSizeArgs', () => {
  it('uses the 16:10 showcase preset by default for its named command', () => {
    expect(parseScreenshotSizeArgs(['showcase'])).toEqual({
      processName: 'Raynard',
      preset: 'showcase',
      ...SCREENSHOT_SIZE_PRESETS.showcase
    });
  });

  it('uses the minimum-height 16:9 hero preset', () => {
    expect(parseScreenshotSizeArgs(['hero'])).toMatchObject({
      width: 960,
      height: 540,
      ratio: '16:9'
    });
  });

  it('accepts a custom size and process name', () => {
    expect(parseScreenshotSizeArgs(['1200x750', '--process', 'Raynard Dev'])).toEqual({
      processName: 'Raynard Dev',
      preset: 'custom',
      width: 1200,
      height: 750,
      ratio: null
    });
  });

  it('rejects missing and malformed sizes', () => {
    expect(() => parseScreenshotSizeArgs([])).toThrow(/choose one size/i);
    expect(() => parseScreenshotSizeArgs(['wide'])).toThrow(/unknown screenshot size/i);
    expect(() => parseScreenshotSizeArgs(['0x600'])).toThrow(/width must be a positive integer/i);
  });
});
