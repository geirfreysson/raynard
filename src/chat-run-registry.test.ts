import { describe, expect, it } from 'vitest';
import { ChatRunRegistry } from './chat-run-registry';

describe('ChatRunRegistry', () => {
  it('allows different chats to run concurrently but rejects a second run in one chat', () => {
    const registry = new ChatRunRegistry<object, string>();
    expect(registry.begin('chat-a', 'builder', {}, ['a'], 1)).toBeDefined();
    expect(registry.begin('chat-b', 'builder', {}, ['b'], 1)).toBeDefined();
    expect(registry.begin('chat-a', 'agent', {}, ['again'], 1)).toBeUndefined();
    expect(registry.size).toBe(2);
  });

  it('keeps stream ids and live snapshots owned by their chat', () => {
    const registry = new ChatRunRegistry<{ name: string }, string>();
    const a = registry.begin('chat-a', 'builder', { name: 'A' }, ['working'], 3)!;
    const b = registry.begin('chat-b', 'agent', { name: 'B' }, ['thinking'], 4)!;
    registry.setStreamId('chat-a', a.id, 'stream-a');
    registry.setStreamId('chat-b', b.id, 'stream-b');
    registry.setPluginDir('chat-a', a.id, '/plugins/a');

    expect(registry.get('chat-a')?.streamId).toBe('stream-a');
    expect(registry.get('chat-a')?.messages).toEqual(['working']);
    expect(registry.get('chat-a')?.pluginDir).toBe('/plugins/a');
    expect(registry.get('chat-b')?.streamId).toBe('stream-b');
    expect(registry.values().map((run) => run.chatId)).toEqual(['chat-a', 'chat-b']);
  });

  it('queues steering messages against the run that owns the chat', () => {
    const registry = new ChatRunRegistry<object, string>();
    const run = registry.begin('chat-a', 'agent', {}, [], 1)!;
    expect(run.queued).toEqual([]);
    expect(registry.enqueue('chat-a', run.id, { text: 'narrow it', delivery: 'steer' })).toBe(true);
    expect(registry.enqueue('chat-a', run.id, { text: 'then chart it', delivery: 'followUp' })).toBe(
      true
    );
    // A finished turn must not be able to queue against the run that replaced it.
    expect(registry.enqueue('chat-a', 'stale-run', { text: 'ignored', delivery: 'steer' })).toBe(
      false
    );
    expect(registry.get('chat-a')?.queued.map((entry) => entry.text)).toEqual([
      'narrow it',
      'then chart it'
    ]);
  });

  it('removes a queued message by its text, one match at a time', () => {
    const registry = new ChatRunRegistry<object, string>();
    const run = registry.begin('chat-a', 'agent', {}, [], 1)!;
    registry.enqueue('chat-a', run.id, { text: 'again', delivery: 'steer' });
    registry.enqueue('chat-a', run.id, { text: 'again', delivery: 'steer' });

    expect(registry.dequeueText('chat-a', run.id, 'again')).toBe(true);
    expect(registry.get('chat-a')?.queued).toHaveLength(1);
    expect(registry.dequeueText('chat-a', run.id, 'never queued')).toBe(false);
  });

  it('drains the queue so undelivered text can go back to the composer', () => {
    const registry = new ChatRunRegistry<object, string>();
    const run = registry.begin('chat-a', 'agent', {}, [], 1)!;
    registry.enqueue('chat-a', run.id, { text: 'first', delivery: 'steer' });
    registry.enqueue('chat-a', run.id, { text: 'second', delivery: 'followUp' });

    expect(registry.takeQueued('chat-a', 'stale-run')).toEqual([]);
    expect(registry.takeQueued('chat-a', run.id).map((entry) => entry.text)).toEqual([
      'first',
      'second'
    ]);
    expect(registry.get('chat-a')?.queued).toEqual([]);
  });

  it('only lets the owning run clear its chat slot', () => {
    const registry = new ChatRunRegistry<object, string>();
    const run = registry.begin('chat-a', 'builder', {}, [], 1)!;
    expect(registry.finish('chat-a', 'stale-run')).toBe(false);
    expect(registry.has('chat-a')).toBe(true);
    expect(registry.finish('chat-a', run.id)).toBe(true);
    expect(registry.has('chat-a')).toBe(false);
  });
});
