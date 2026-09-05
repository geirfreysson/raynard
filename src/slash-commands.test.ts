import { describe, expect, it } from 'vitest';

import { SLASH_COMMANDS, filterSlashCommands } from './slash-commands';

describe('filterSlashCommands', () => {
  it('offers every command for a bare slash', () => {
    expect(filterSlashCommands('/').map((entry) => entry.command)).toEqual(
      SLASH_COMMANDS.map((entry) => entry.command)
    );
  });

  it('narrows to one command on a distinguishing prefix', () => {
    expect(filterSlashCommands('/sta').map((entry) => entry.command)).toEqual(['/status']);
    expect(filterSlashCommands('/set').map((entry) => entry.command)).toEqual(['/settings']);
    expect(filterSlashCommands('/mod').map((entry) => entry.command)).toEqual(['/models']);
    expect(filterSlashCommands('/mem').map((entry) => entry.command)).toEqual(['/memory']);
    expect(filterSlashCommands('/ext').map((entry) => entry.command)).toEqual(['/extensions']);
  });

  it('keeps both commands a shared "/m" prefix matches', () => {
    expect(filterSlashCommands('/m').map((entry) => entry.command)).toEqual(['/memory', '/models']);
  });

  it('keeps every command a shared prefix still matches', () => {
    expect(filterSlashCommands('/s').map((entry) => entry.command)).toEqual([
      '/settings',
      '/status'
    ]);
  });

  it('keeps an exactly typed command visible', () => {
    expect(filterSlashCommands('/status').map((entry) => entry.command)).toEqual(['/status']);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(filterSlashCommands('  /STATUS  ').map((entry) => entry.command)).toEqual(['/status']);
  });

  it('returns nothing without a leading slash, so ordinary text never opens the menu', () => {
    expect(filterSlashCommands('')).toEqual([]);
    expect(filterSlashCommands('status')).toEqual([]);
    expect(filterSlashCommands('what is my status')).toEqual([]);
  });

  it('returns nothing for an unknown command', () => {
    expect(filterSlashCommands('/zzz')).toEqual([]);
  });

  it('stops matching once the text runs past the command', () => {
    expect(filterSlashCommands('/status extra')).toEqual([]);
  });

  it('describes every command it offers', () => {
    for (const entry of SLASH_COMMANDS) {
      expect(entry.command.startsWith('/')).toBe(true);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});
