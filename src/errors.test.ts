import { describe, expect, it } from 'vitest';
import { getErrorMessage } from './errors';

describe('getErrorMessage', () => {
  it('keeps Tauri string rejections visible', () => {
    expect(getErrorMessage('missing required key stream_id')).toBe('missing required key stream_id');
  });

  it('keeps Error messages visible', () => {
    expect(getErrorMessage(new Error('Model API key is not configured.'))).toBe(
      'Model API key is not configured.'
    );
  });

  it('falls back for empty or unknown errors', () => {
    expect(getErrorMessage('')).toBe('Something went wrong.');
    expect(getErrorMessage(null)).toBe('Something went wrong.');
  });
});
