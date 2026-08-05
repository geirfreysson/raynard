export type AppMode = 'explore' | 'build';
export type BuildRequestStep = 'confirm-write';

export function nextBuildRequestStep(_mode: AppMode): BuildRequestStep {
  return 'confirm-write';
}

export function automaticModeForUserTurn(): AppMode {
  return 'explore';
}

export function confirmedPluginWriteMode(): AppMode {
  return 'build';
}

export function modeSwitchStatus(from: AppMode, to: AppMode): string | undefined {
  if (from === to) return undefined;
  return `Switched to ${to === 'build' ? 'Build' : 'Explore'} mode`;
}

export function pluginWriteConfirmationCopy(name: string) {
  return {
    title: `Write plugin: ${name}`,
    description:
      'This will switch to Build mode and let the coding agent create or update this plugin.',
    confirmLabel: 'Write plugin',
    progress: `Preparing ${name} for the coding agent...`
  };
}
