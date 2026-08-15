// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wrapCopyable } from './copy-affordance';
import { writeClipboard } from './clipboard';

vi.mock('./clipboard', () => ({ writeClipboard: vi.fn(async () => true) }));

const writeClipboardMock = vi.mocked(writeClipboard);

function clickCopy(wrapper: HTMLElement): Promise<void> {
  wrapper.querySelector<HTMLButtonElement>('.copyable-copy')!.click();
  // Let the click handler's awaits settle before assertions.
  return Promise.resolve().then(() => Promise.resolve());
}

function label(wrapper: HTMLElement): string {
  return wrapper.querySelector('.copyable-copy-label')!.textContent ?? '';
}

beforeEach(() => {
  vi.useFakeTimers();
  writeClipboardMock.mockReset();
  writeClipboardMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('wrapCopyable', () => {
  it('wraps the block and adds a labelled button beside it', () => {
    const table = document.createElement('table');
    const wrapper = wrapCopyable(table, 'Copy table', () => ({ text: '| a |' }));

    expect(wrapper.className).toBe('copyable');
    expect(wrapper.firstElementChild).toBe(table);
    expect(label(wrapper)).toBe('Copy table');
    expect(wrapper.querySelector('.copyable-copy svg')).not.toBeNull();
  });

  it('builds the payload only when the button is clicked', async () => {
    const payload = vi.fn(() => ({ text: '| a |' }));
    const wrapper = wrapCopyable(document.createElement('table'), 'Copy table', payload);

    expect(payload).not.toHaveBeenCalled();

    await clickCopy(wrapper);

    expect(payload).toHaveBeenCalledTimes(1);
    expect(writeClipboardMock).toHaveBeenCalledWith({ text: '| a |' });
  });

  it('confirms a copy and reverts the label', async () => {
    const wrapper = wrapCopyable(document.createElement('table'), 'Copy table', () => ({
      text: 'x'
    }));

    await clickCopy(wrapper);

    const button = wrapper.querySelector('.copyable-copy')!;
    expect(label(wrapper)).toBe('Copied');
    expect(button.classList.contains('done')).toBe(true);

    vi.advanceTimersByTime(1400);

    expect(label(wrapper)).toBe('Copy table');
    expect(button.classList.contains('done')).toBe(false);
  });

  it('reports a failed write', async () => {
    writeClipboardMock.mockResolvedValue(false);
    const wrapper = wrapCopyable(document.createElement('table'), 'Copy table', () => ({
      text: 'x'
    }));

    await clickCopy(wrapper);

    expect(label(wrapper)).toBe('Copy failed');
    expect(wrapper.querySelector('.copyable-copy')!.classList.contains('err')).toBe(true);
  });

  it('reports failure when the payload factory throws', async () => {
    const wrapper = wrapCopyable(document.createElement('div'), 'Copy chart', () => {
      throw new Error('rasterize failed');
    });

    await clickCopy(wrapper);

    expect(label(wrapper)).toBe('Copy failed');
    expect(writeClipboardMock).not.toHaveBeenCalled();
  });

  it('ignores a second click while a copy is in flight', async () => {
    let release: (ok: boolean) => void = () => {};
    writeClipboardMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        release = resolve;
      })
    );
    const payload = vi.fn(() => ({ text: 'x' }));
    const wrapper = wrapCopyable(document.createElement('table'), 'Copy table', payload);

    await clickCopy(wrapper);
    await clickCopy(wrapper);

    expect(payload).toHaveBeenCalledTimes(1);
    release(true);
  });
});
