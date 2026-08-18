type SaveWaiter<TResult> = {
  resolve: (value: TResult) => void;
  reject: (reason?: unknown) => void;
};

type SaveState<TPayload, TResult> = {
  active: boolean;
  pending?: TPayload;
  pendingWaiters: SaveWaiter<TResult>[];
};

/**
 * Serializes saves per key and retains only the newest snapshot queued while a
 * write is active. Every caller still settles when the snapshot that superseded
 * it has been written, so awaited final saves remain a durability boundary.
 */
export function createCoalescedSaveQueue<TPayload, TResult>(
  save: (payload: TPayload) => Promise<TResult>
) {
  const states = new Map<string, SaveState<TPayload, TResult>>();

  const run = (
    key: string,
    state: SaveState<TPayload, TResult>,
    payload: TPayload,
    waiters: SaveWaiter<TResult>[]
  ) => {
    state.active = true;
    let operation: Promise<TResult>;
    try {
      operation = Promise.resolve(save(payload));
    } catch (error) {
      operation = Promise.reject(error);
    }
    void operation
      .then(
        (result) => waiters.forEach((waiter) => waiter.resolve(result)),
        (error) => waiters.forEach((waiter) => waiter.reject(error))
      )
      .finally(() => {
        if (state.pending !== undefined) {
          const next = state.pending;
          const nextWaiters = state.pendingWaiters;
          state.pending = undefined;
          state.pendingWaiters = [];
          run(key, state, next, nextWaiters);
        } else {
          state.active = false;
          states.delete(key);
        }
      });
  };

  return {
    enqueue(key: string, payload: TPayload): Promise<TResult> {
      return new Promise<TResult>((resolve, reject) => {
        const waiter = { resolve, reject };
        let state = states.get(key);
        if (!state) {
          state = { active: false, pendingWaiters: [] };
          states.set(key, state);
        }
        if (state.active) {
          state.pending = payload;
          state.pendingWaiters.push(waiter);
          return;
        }
        run(key, state, payload, [waiter]);
      });
    }
  };
}
