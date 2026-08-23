import { describe, expect, it } from 'vitest';
import {
  calendarFieldsFor,
  ordinal,
  relativeRunLabel,
  runStatusLabel,
  scheduleSentence,
  scheduleShorthand,
  taskStatus
} from './scheduled-task-view';

describe('scheduleSentence', () => {
  it('describes a daily schedule', () => {
    expect(scheduleSentence({ frequency: 'daily', time: '08:00', timeZone: 'Europe/London' })).toBe(
      'Every day at 08:00'
    );
  });

  it('names the weekday of a weekly schedule', () => {
    expect(
      scheduleSentence({ frequency: 'weekly', time: '09:30', timeZone: 'UTC', dayOfWeek: 3 })
    ).toBe('Every Wednesday at 09:30');
  });

  it('uses an ordinal day for a monthly schedule', () => {
    expect(
      scheduleSentence({ frequency: 'monthly', time: '07:15', timeZone: 'UTC', dayOfMonth: 22 })
    ).toBe('Every month on the 22nd at 07:15');
  });

  it('explains that a quarterly schedule repeats from its anchor month', () => {
    expect(
      scheduleSentence({
        frequency: 'quarterly',
        time: '06:00',
        timeZone: 'UTC',
        dayOfMonth: 1,
        monthOfYear: 2
      })
    ).toBe('Every 3 months from February, on the 1st at 06:00');
  });

  it('describes a yearly schedule as a date', () => {
    expect(
      scheduleSentence({
        frequency: 'yearly',
        time: '12:00',
        timeZone: 'UTC',
        dayOfMonth: 3,
        monthOfYear: 12
      })
    ).toBe('Every year on 3rd December at 12:00');
  });
});

describe('scheduleShorthand', () => {
  it('stays short for the sidebar', () => {
    expect(scheduleShorthand({ frequency: 'daily', time: '08:00', timeZone: 'UTC' })).toBe('Daily · 08:00');
    expect(
      scheduleShorthand({ frequency: 'weekly', time: '08:00', timeZone: 'UTC', dayOfWeek: 7 })
    ).toBe('Sun · 08:00');
  });
});

describe('calendarFieldsFor', () => {
  it('shows only the fields the backend validates', () => {
    expect(calendarFieldsFor('daily')).toEqual({ weekday: false, day: false, month: false });
    expect(calendarFieldsFor('weekly')).toEqual({ weekday: true, day: false, month: false });
    expect(calendarFieldsFor('monthly')).toEqual({ weekday: false, day: true, month: false });
    expect(calendarFieldsFor('quarterly')).toEqual({ weekday: false, day: true, month: true });
    expect(calendarFieldsFor('yearly')).toEqual({ weekday: false, day: true, month: true });
  });
});

describe('taskStatus', () => {
  it('reports a running execution before pause state', () => {
    expect(taskStatus({ enabled: false, activeExecutionId: 'exec-1' })).toEqual({
      tone: 'running',
      label: 'Running now'
    });
  });

  it('separates paused from active', () => {
    expect(taskStatus({ enabled: false })).toEqual({ tone: 'paused', label: 'Paused' });
    expect(taskStatus({ enabled: true })).toEqual({ tone: 'active', label: 'Active' });
  });
});

describe('relativeRunLabel', () => {
  const now = Date.parse('2026-08-23T22:00:00.000Z');

  it('counts forward to the next run', () => {
    expect(relativeRunLabel('2026-08-24T07:00:00.000Z', now)).toBe('in 9 hours');
    expect(relativeRunLabel('2026-08-23T23:00:00.000Z', now)).toBe('in 1 hour');
    expect(relativeRunLabel('2026-08-26T22:00:00.000Z', now)).toBe('in 3 days');
  });

  it('counts back for a past run', () => {
    expect(relativeRunLabel('2026-08-23T20:00:00.000Z', now)).toBe('2 hours ago');
    expect(relativeRunLabel('2026-08-23T21:59:50.000Z', now)).toBe('just now');
  });

  it('is empty for an unparsable timestamp', () => {
    expect(relativeRunLabel('not-a-date', now)).toBe('');
  });
});

describe('runStatusLabel', () => {
  it('maps persisted statuses to a tone', () => {
    expect(runStatusLabel('completed')).toEqual({ label: 'Completed', tone: 'ok' });
    expect(runStatusLabel('error')).toEqual({ label: 'Failed', tone: 'error' });
    expect(runStatusLabel('interrupted')).toEqual({ label: 'Interrupted', tone: 'error' });
    expect(runStatusLabel(undefined)).toEqual({ label: 'Unknown', tone: 'muted' });
  });
});

describe('ordinal', () => {
  it('handles the teens', () => {
    expect([1, 2, 3, 11, 12, 13, 21, 31].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '11th',
      '12th',
      '13th',
      '21st',
      '31st'
    ]);
  });
});
