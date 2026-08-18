import { describe, expect, it, vi } from 'vitest';
import { createCoalescedSaveQueue } from './chat-persistence';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('createCoalescedSaveQueue', () => {
  it('allows one save per key and replaces queued snapshots with the newest one', async () => {
    const first = deferred<string>();
    const latest = deferred<string>();
    const save = vi
      .fn<(payload: string) => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise);
    const queue = createCoalescedSaveQueue(save);

    const a = queue.enqueue('chat-1', 'a');
    const b = queue.enqueue('chat-1', 'b');
    const c = queue.enqueue('chat-1', 'c');

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenNthCalledWith(1, 'a');

    first.resolve('saved-a');
    await expect(a).resolves.toBe('saved-a');
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenNthCalledWith(2, 'c');

    latest.resolve('saved-c');
    await expect(b).resolves.toBe('saved-c');
    await expect(c).resolves.toBe('saved-c');
  });

  it('does not make unrelated chats wait for each other', () => {
    const save = vi.fn(async (payload: string) => payload);
    const queue = createCoalescedSaveQueue(save);

    void queue.enqueue('chat-1', 'one');
    void queue.enqueue('chat-2', 'two');

    expect(save).toHaveBeenCalledTimes(2);
  });
});
