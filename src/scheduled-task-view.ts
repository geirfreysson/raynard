// Presentation helpers for the scheduled-task screen. These are pure so the
// wording of a schedule, its status, and its run history can be tested without
// a DOM or a live task store.

export type TaskScheduleShape = {
  frequency: string;
  time: string;
  timeZone: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
  monthOfYear?: number;
};

export type TaskStatusTone = 'running' | 'paused' | 'active';

export type RunTone = 'ok' | 'error' | 'muted';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
];

export function ordinal(day: number) {
  const value = Math.trunc(day);
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

export function frequencyLabel(frequency: string) {
  if (!frequency) return '';
  return frequency[0].toUpperCase() + frequency.slice(1);
}

// Which calendar inputs a frequency actually uses. The Rust validator requires
// exactly these fields, so the form must show exactly these fields.
export function calendarFieldsFor(frequency: string) {
  return {
    weekday: frequency === 'weekly',
    day: ['monthly', 'quarterly', 'yearly'].includes(frequency),
    month: ['quarterly', 'yearly'].includes(frequency)
  };
}

export function scheduleSentence(schedule: TaskScheduleShape) {
  const at = schedule.time ? ` at ${schedule.time}` : '';
  switch (schedule.frequency) {
    case 'daily':
      return `Every day${at}`;
    case 'weekly':
      return `Every ${WEEKDAYS[(schedule.dayOfWeek || 1) - 1] ?? 'Monday'}${at}`;
    case 'monthly':
      return `Every month on the ${ordinal(schedule.dayOfMonth || 1)}${at}`;
    case 'quarterly':
      return `Every 3 months from ${MONTHS[(schedule.monthOfYear || 1) - 1] ?? 'January'}, on the ${ordinal(
        schedule.dayOfMonth || 1
      )}${at}`;
    case 'yearly':
      return `Every year on ${ordinal(schedule.dayOfMonth || 1)} ${
        MONTHS[(schedule.monthOfYear || 1) - 1] ?? 'January'
      }${at}`;
    default:
      return `${frequencyLabel(schedule.frequency)}${at}`;
  }
}

// The compact form used by the sidebar row, where width is scarce.
export function scheduleShorthand(schedule: TaskScheduleShape) {
  const time = schedule.time || '';
  switch (schedule.frequency) {
    case 'weekly':
      return `${(WEEKDAYS[(schedule.dayOfWeek || 1) - 1] ?? 'Monday').slice(0, 3)} · ${time}`;
    case 'monthly':
      return `Day ${schedule.dayOfMonth || 1} · ${time}`;
    case 'quarterly':
    case 'yearly':
      return `${ordinal(schedule.dayOfMonth || 1)} ${(MONTHS[(schedule.monthOfYear || 1) - 1] ?? 'January').slice(
        0,
        3
      )} · ${time}`;
    default:
      return `${frequencyLabel(schedule.frequency)} · ${time}`;
  }
}

export function taskStatus(task: { enabled: boolean; activeExecutionId?: string }): {
  tone: TaskStatusTone;
  label: string;
} {
  if (task.activeExecutionId) return { tone: 'running', label: 'Running now' };
  if (!task.enabled) return { tone: 'paused', label: 'Paused' };
  return { tone: 'active', label: 'Active' };
}

export function relativeRunLabel(value: string, now: number) {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '';
  const diff = time - now;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (abs < minute) return diff >= 0 ? 'in under a minute' : 'just now';
  const [amount, unit] =
    abs < hour
      ? [Math.round(abs / minute), 'minute']
      : abs < day
        ? [Math.round(abs / hour), 'hour']
        : [Math.round(abs / day), 'day'];
  const noun = amount === 1 ? unit : `${unit}s`;
  return diff >= 0 ? `in ${amount} ${noun}` : `${amount} ${noun} ago`;
}

export function runStatusLabel(status: string | undefined): { label: string; tone: RunTone } {
  switch (status) {
    case 'completed':
      return { label: 'Completed', tone: 'ok' };
    case 'error':
      return { label: 'Failed', tone: 'error' };
    case 'interrupted':
      return { label: 'Interrupted', tone: 'error' };
    case 'running':
      return { label: 'Running', tone: 'muted' };
    default:
      return { label: status ? frequencyLabel(status) : 'Unknown', tone: 'muted' };
  }
}
