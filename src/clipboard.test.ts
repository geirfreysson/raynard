// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeClipboard } from './clipboard';

type ClipboardStub = {
  write?: (items: unknown[]) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
};

function stubClipboard(clipboard: ClipboardStub | undefined, withItemCtor = true) {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: clipboard
  });
  const scope = globalThis as { ClipboardItem?: unknown };
  if (withItemCtor) {
    scope.ClipboardItem = class {
      items: Record<string, Blob | Promise<Blob>>;
      constructor(items: Record<string, Blob | Promise<Blob>>) {
        this.items = items;
      }
    };
  } else {
    delete scope.ClipboardItem;
  }
}

async function blobText(value: Blob | Promise<Blob> | undefined): Promise<string> {
  return (await value!).text();
}

afterEach(() => {
  stubClipboard(undefined, false);
  vi.restoreAllMocks();
});

describe('writeClipboard', () => {
  it('writes text and image flavors as one clipboard item', async () => {
    const written: { items: Record<string, Blob | Promise<Blob>> }[] = [];
    stubClipboard({
      write: async (items) => {
        written.push(...(items as { items: Record<string, Blob | Promise<Blob>> }[]));
      }
    });

    const png = new Blob(['png-bytes'], { type: 'image/png' });
    const copied = await writeClipboard({ text: '| a |', image: async () => png });

    expect(copied).toBe(true);
    expect(written).toHaveLength(1);
    expect(Object.keys(written[0].items).sort()).toEqual(['image/png', 'text/plain']);
    expect(await blobText(written[0].items['text/plain'])).toBe('| a |');
    expect(await blobText(written[0].items['image/png'])).toBe('png-bytes');
  });

  it('omits the image flavor when the payload has none', async () => {
    const written: { items: Record<string, Blob> }[] = [];
    stubClipboard({
      write: async (items) => {
        written.push(...(items as { items: Record<string, Blob> }[]));
      }
    });

    await writeClipboard({ text: 'plain' });

    expect(Object.keys(written[0].items)).toEqual(['text/plain']);
  });

  it('hands the image promise over unresolved so the gesture window survives', async () => {
    let resolveImage: (blob: Blob) => void = () => {};
    const pending = new Promise<Blob>((resolve) => {
      resolveImage = resolve;
    });
    let sawPending = false;
    stubClipboard({
      write: async (items) => {
        const item = (items as { items: Record<string, unknown> }[])[0];
        sawPending = item.items['image/png'] instanceof Promise;
        resolveImage(new Blob(['late'], { type: 'image/png' }));
      }
    });

    await writeClipboard({ text: 'x', image: () => pending });

    expect(sawPending).toBe(true);
  });

  it('falls back to writeText when the rich write fails', async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard({
      write: async () => {
        throw new Error('NotAllowedError');
      },
      writeText
    });

    const copied = await writeClipboard({ text: 'fallback', image: async () => new Blob([]) });

    expect(copied).toBe(true);
    expect(writeText).toHaveBeenCalledWith('fallback');
  });

  it('falls back to writeText when ClipboardItem is unavailable', async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard({ write: async () => {}, writeText }, false);

    await writeClipboard({ text: 'no-item-ctor' });

    expect(writeText).toHaveBeenCalledWith('no-item-ctor');
  });

  it('falls back to execCommand when there is no clipboard API at all', async () => {
    stubClipboard(undefined, false);
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });

    const copied = await writeClipboard({ text: 'legacy' });

    expect(copied).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    // The staging textarea must not survive the copy.
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('reports failure when every tier fails', async () => {
    stubClipboard({
      write: async () => {
        throw new Error('nope');
      },
      writeText: async () => {
        throw new Error('nope');
      }
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => false
    });

    expect(await writeClipboard({ text: 'unreachable' })).toBe(false);
  });

  it('does not reject when the image producer fails', async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard({
      write: async (items) => {
        await (items as { items: Record<string, Promise<Blob>> }[])[0].items['image/png'];
      },
      writeText
    });

    const copied = await writeClipboard({
      text: 'text-still-works',
      image: async () => {
        throw new Error('canvas failed');
      }
    });

    expect(copied).toBe(true);
    expect(writeText).toHaveBeenCalledWith('text-still-works');
  });
});
