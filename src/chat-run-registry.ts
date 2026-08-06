export type ChatRunKind = 'agent' | 'builder';

export type ChatRun<TMeta, TMessage> = {
  id: string;
  chatId: string;
  kind: ChatRunKind;
  streamId: string;
  pluginDir?: string;
  meta: TMeta;
  messages: TMessage[];
  viewRevision: number;
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
      viewRevision
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

  finish(chatId: string, runId: string) {
    const run = this.runs.get(chatId);
    if (!run || run.id !== runId) return false;
    this.runs.delete(chatId);
    return true;
  }
}
