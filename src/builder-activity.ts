export type BuilderToolStatus = 'pending' | 'streaming' | 'complete' | 'error';

export type BuilderToolActivity = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: BuilderToolStatus;
  output: string;
  isError: boolean;
  /** Absent on tool entries written before reasoning joined the timeline. */
  kind?: 'tool';
};

/**
 * A stretch of model reasoning, held in the same list as the tool calls so the
 * timeline reads in the order things actually happened: reasoning, the call it
 * led to, its output, the reasoning about that output. One collected block at
 * the top could not show which thought produced which call.
 */
export type BuilderReasoningActivity = {
  kind: 'reasoning';
  toolCallId: string;
  text: string;
};

export type BuilderActivity = BuilderToolActivity | BuilderReasoningActivity;

export function isReasoningActivity(
  activity: BuilderActivity
): activity is BuilderReasoningActivity {
  return (activity as BuilderReasoningActivity).kind === 'reasoning';
}

/**
 * Append reasoning text to the timeline.
 *
 * Deltas extend the trailing reasoning entry; anything else in between (a tool
 * call) closes it, so the next thought starts its own block.
 */
export function applyBuilderThinkingDelta(
  activities: BuilderActivity[],
  delta: string
): BuilderActivity[] {
  if (!delta) return activities;
  const last = activities[activities.length - 1];
  if (last && isReasoningActivity(last)) {
    return activities.map((activity, index) =>
      index === activities.length - 1
        ? { ...last, text: last.text + delta }
        : activity
    );
  }
  return [
    ...activities,
    { kind: 'reasoning', toolCallId: `reasoning-${activities.length}`, text: delta }
  ];
}

/** The reasoning text, in order — used to keep the persisted `thinking` field. */
export function collectBuilderReasoning(activities: BuilderActivity[]): string {
  return activities
    .filter(isReasoningActivity)
    .map((activity) => activity.text)
    .join('\n\n')
    .trim();
}

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
  activities: BuilderActivity[],
  event: BuilderToolEvent
): BuilderActivity[] {
  const existingIndex = activities.findIndex(
    (activity) => !isReasoningActivity(activity) && activity.toolCallId === event.toolCallId
  );
  const existing =
    existingIndex >= 0 ? (activities[existingIndex] as BuilderToolActivity) : undefined;
  let next: BuilderToolActivity;

  if (event.type === 'start') {
    next = {
      kind: 'tool',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      status: 'pending',
      output: '',
      isError: false
    };
  } else if (event.type === 'update') {
    next = {
      kind: 'tool',
      toolCallId: event.toolCallId,
      toolName: event.toolName || existing?.toolName || 'tool',
      args: event.args,
      status: 'streaming',
      output: formatBuilderToolOutput(event.partialResult),
      isError: false
    };
  } else {
    next = {
      kind: 'tool',
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
