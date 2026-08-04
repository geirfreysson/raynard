export type BuilderToolStatus = 'pending' | 'streaming' | 'complete' | 'error';

export type BuilderToolActivity = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: BuilderToolStatus;
  output: string;
  isError: boolean;
};

export type BuilderToolEvent =
  | {
      type: 'start';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'update';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      partialResult: unknown;
    }
  | {
      type: 'end';
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };

export function formatBuilderToolOutput(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;

  if (typeof value === 'object' && 'content' in value) {
    const content = (value as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (block): block is { type: 'text'; text: string } =>
            Boolean(
              block &&
                typeof block === 'object' &&
                'type' in block &&
                block.type === 'text' &&
                'text' in block &&
                typeof block.text === 'string'
            )
        )
        .map((block) => block.text)
        .join('\n');
      if (text) return text;
    }
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export type TimelineReconcileOp =
  | { action: 'reuse'; index: number; toolCallId: string }
  | { action: 'insert'; index: number; toolCallId: string };

// Decide how to reconcile the currently rendered timeline cards (identified by
// their tool call ids, in order) against the desired activities — WITHOUT
// tearing anything down. A card whose id already sits at its target index is
// reused (patched in place); anything else is inserted. Cards beyond
// `removeCount`'s complement are trimmed. Keeping this pure makes the "never
// rebuild an existing card" guarantee testable without a DOM.
export function planBuilderTimeline(
  existingIds: string[],
  activities: Pick<BuilderToolActivity, 'toolCallId'>[]
): { ops: TimelineReconcileOp[]; length: number } {
  const ops: TimelineReconcileOp[] = activities.map((activity, index) =>
    existingIds[index] === activity.toolCallId
      ? { action: 'reuse', index, toolCallId: activity.toolCallId }
      : { action: 'insert', index, toolCallId: activity.toolCallId }
  );
  return { ops, length: activities.length };
}

export function applyBuilderToolEvent(
  activities: BuilderToolActivity[],
  event: BuilderToolEvent
): BuilderToolActivity[] {
  const existingIndex = activities.findIndex((activity) => activity.toolCallId === event.toolCallId);
  const existing = existingIndex >= 0 ? activities[existingIndex] : undefined;
  let next: BuilderToolActivity;

  if (event.type === 'start') {
    next = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      status: 'pending',
      output: '',
      isError: false
    };
  } else if (event.type === 'update') {
    next = {
      toolCallId: event.toolCallId,
      toolName: event.toolName || existing?.toolName || 'tool',
      args: event.args,
      status: 'streaming',
      output: formatBuilderToolOutput(event.partialResult),
      isError: false
    };
  } else {
    next = {
      toolCallId: event.toolCallId,
      toolName: event.toolName || existing?.toolName || 'tool',
      args: existing?.args || {},
      status: event.isError ? 'error' : 'complete',
      output: formatBuilderToolOutput(event.result),
      isError: event.isError
    };
  }

  if (existingIndex < 0) return [...activities, next];
  return activities.map((activity, index) => (index === existingIndex ? next : activity));
}
