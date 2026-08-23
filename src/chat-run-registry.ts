export type ChatRunKind = 'agent' | 'builder' | 'scheduled';

export type QueuedRunMessage = {
  text: string;
  delivery: 'steer' | 'followUp';
};

export type ChatRun<TMeta, TMessage> = {
  id: string;
  chatId: string;
  kind: ChatRunKind;
  streamId: string;
  pluginDir?: string;
  meta: TMeta;
  messages: TMessage[];
  viewRevision: number;
  /**
   * Messages typed while this run was working, still waiting for the agent to
   * pick them up. It lives on the run rather than in a renderer variable so
   * navigating away from a busy chat and back does not lose them.
   */
  queued: QueuedRunMessage[];
};

export class ChatRunRegistry<TMeta, TMessage> {
  private readonly runs = new Map<string, ChatRun<TMeta, TMessage>>();
  private sequence = 0;

  get size() {
    return this.runs.size;
  }

  has(chatId: string) {
    return this.runs.has(chatId);
  }

  get(chatId: string) {
    return this.runs.get(chatId);
  }

  values() {
    return [...this.runs.values()];
  }

  begin(
    chatId: string,
    kind: ChatRunKind,
    meta: TMeta,
    messages: TMessage[],
    viewRevision: number
  ): ChatRun<TMeta, TMessage> | undefined {
    if (this.runs.has(chatId)) return undefined;
    const run: ChatRun<TMeta, TMessage> = {
      id: `${chatId}:${++this.sequence}`,
      chatId,
      kind,
      streamId: '',
      meta,
      messages,
      viewRevision,
      queued: []
    };
    this.runs.set(chatId, run);
    return run;
  }

  setStreamId(chatId: string, runId: string, streamId: string) {
    const run = this.runs.get(chatId);
    if (!run || run.id !== runId) return false;
    run.streamId = streamId;
    return true;
  }

  setPluginDir(chatId: string, runId: string, pluginDir: string) {
    const run = this.runs.get(chatId);
    if (!run || run.id !== runId) return false;
    run.pluginDir = pluginDir;
    return true;
  }

  enqueue(chatId: string, runId: string, message: QueuedRunMessage) {
    const run = this.runs.get(chatId);
    if (!run || run.id !== runId) return false;
    run.queued.push(message);
    return true;
  }

  /**
   * Removes the first entry matching `text`.
   *
   * The sidecar recognizes a delivered message by its text too, so matching the
   * same way keeps the two mirrors in step when the same text is queued twice.
   */
  dequeueText(chatId: string, runId: string, text: string) {
    const run = this.runs.get(chatId);
    if (!run || run.id !== runId) return false;
    const index = run.queued.findIndex((entry) => entry.text === text);
    if (index === -1) return false;
    run.queued.splice(index, 1);
    return true;
  }

  /** Drains the queue, for handing undelivered text back to the composer. */
  takeQueued(chatId: string, runId: string): QueuedRunMessage[] {
    const run = this.runs.get(chatId);
    if (!run || run.id !== runId) return [];
    return run.queued.splice(0);
  }

  finish(chatId: string, runId: string) {
    const run = this.runs.get(chatId);
    if (!run || run.id !== runId) return false;
    this.runs.delete(chatId);
    return true;
  }
}
