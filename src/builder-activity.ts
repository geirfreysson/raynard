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

/**
 * What the builder actually said to the user during this round.
 *
 * Held in the timeline for the same reason reasoning is: each stretch of prose
 * was written between specific tool calls. Concatenated into one block at the
 * bottom, consecutive rounds run together into a wall of text with no sentence
 * breaks — "…run full node --test.Scaffold confirmed."
 */
export type BuilderOutputActivity = {
  kind: 'output';
  toolCallId: string;
  text: string;
};

/** A host-side milestone: running tests, validation passed, a resumed pass. */
export type BuilderStatusActivity = {
  kind: 'status';
  toolCallId: string;
  status: string;
};

export type BuilderActivity =
  | BuilderToolActivity
  | BuilderReasoningActivity
  | BuilderOutputActivity
  | BuilderStatusActivity;

type StreamedKind = 'reasoning' | 'output';

export function isReasoningActivity(
  activity: BuilderActivity
): activity is BuilderReasoningActivity {
  return (activity as BuilderReasoningActivity).kind === 'reasoning';
}

export function isOutputActivity(activity: BuilderActivity): activity is BuilderOutputActivity {
  return (activity as BuilderOutputActivity).kind === 'output';
}

export function isStatusActivity(activity: BuilderActivity): activity is BuilderStatusActivity {
  return (activity as BuilderStatusActivity).kind === 'status';
}

/** Tool entries recorded before `kind` existed have no discriminator at all. */
export function isToolActivity(activity: BuilderActivity): activity is BuilderToolActivity {
  const kind = (activity as { kind?: string }).kind;
  return kind === undefined || kind === 'tool';
}

/**
 * Append streamed text of one kind to the timeline.
 *
 * Deltas extend the trailing entry when it is the same kind; anything in
 * between — a tool call, a status line, or a switch between reasoning and
 * output — closes it, so the next stretch starts its own block.
 */
function appendStreamedSegment(
  activities: BuilderActivity[],
  kind: StreamedKind,
  delta: string
): BuilderActivity[] {
  if (!delta) return activities;
  const lastIndex = activities.length - 1;
  const last = activities[lastIndex];
  if (last && (last as { kind?: string }).kind === kind) {
    const extended = { ...(last as BuilderReasoningActivity | BuilderOutputActivity) };
    extended.text += delta;
    return activities.map((activity, index) => (index === lastIndex ? extended : activity));
  }
  return [
    ...activities,
    { kind, toolCallId: `${kind}-${activities.length}`, text: delta } as BuilderActivity
  ];
}

export function applyBuilderThinkingDelta(
  activities: BuilderActivity[],
  delta: string
): BuilderActivity[] {
  return appendStreamedSegment(activities, 'reasoning', delta);
}

export function applyBuilderOutputDelta(
  activities: BuilderActivity[],
  delta: string
): BuilderActivity[] {
  return appendStreamedSegment(activities, 'output', delta);
}

/** A discrete milestone. A repeat of the preceding one is collapsed. */
export function applyBuilderStatusEvent(
  activities: BuilderActivity[],
  status: string
): BuilderActivity[] {
  const value = String(status || '').trim();
  if (!value) return activities;
  const last = activities[activities.length - 1];
  if (last && isStatusActivity(last) && last.status === value) return activities;
  return [
    ...activities,
    { kind: 'status', toolCallId: `status-${activities.length}`, status: value }
  ];
}

const STATUS_LABELS: Record<string, string> = {
  builder_started: 'Starting the coding agent',
  resuming_unfinished_build: 'Resuming an unfinished build',
  validation_failed_retrying: 'Validation failed — retrying',
  edit_no_changes_retrying: 'No changes were made — retrying',
  running_tests: 'Running tests',
  validation_passed: 'Validation passed'
};

/**
 * Turn a sidecar status slug into a readable line.
 *
 * The sidecar emits compact, colon-delimited slugs (`running_tests:a.test.ts`,
 * `validation_passed:2_tests:5_tools`). Unknown slugs are humanized rather than
 * hidden, so a status added later still says something.
 */
export function builderStatusLabel(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  const [head, ...rest] = value.split(':');
  const detail = rest.join(':').trim();
  const label = STATUS_LABELS[head] || humanizeStatusToken(head);

  if (head === 'running_tests' && detail) {
    return `${label} — ${detail.split(',').map((part) => part.trim()).filter(Boolean).join(', ')}`;
  }
  if (head === 'validation_passed' && detail) {
    const counts = detail
      .split(':')
      .map((part) => part.trim().replace(/_/g, ' '))
      .filter(Boolean);
    return counts.length ? `${label} — ${counts.join(', ')}` : label;
  }
  return detail ? `${label} — ${detail.replace(/_/g, ' ')}` : label;
}

function humanizeStatusToken(token: string): string {
  const words = token.replace(/[_-]+/g, ' ').trim();
  if (!words) return '';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The reasoning text, in order — used to keep the persisted `thinking` field.
 * Deliberately reasoning-only: host status lines and the builder's own prose
 * are separate kinds and must not leak into what is stored as the model's
 * thinking.
 */
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
    (activity) => isToolActivity(activity) && activity.toolCallId === event.toolCallId
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
