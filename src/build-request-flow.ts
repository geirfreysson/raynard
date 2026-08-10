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

export type BuildRequestAuth = {
  required: boolean;
  signupUrl?: string;
  credentialLabel?: string;
};

export function pluginWriteConfirmationCopy(name: string, auth?: BuildRequestAuth) {
  // Surfacing the key requirement here, rather than after the build, lets the
  // user register while the coding agent works.
  const credentialLabel = auth?.required ? auth.credentialLabel?.trim() || 'an API key' : '';
  const signupUrl = auth?.required ? auth.signupUrl?.trim() || '' : '';
  return {
    title: `Write plugin: ${name}`,
    description:
      'This will switch to Build mode and let the coding agent create or update this plugin.',
    confirmLabel: 'Write plugin',
    progress: `Preparing ${name} for the coding agent...`,
    authNotice: credentialLabel
      ? `This API needs ${credentialLabel}. Sign up for one now — you can add it as soon as the plugin is built.`
      : '',
    signupUrl: /^https?:\/\//i.test(signupUrl) ? signupUrl : '',
    signupLabel: 'Get an API key'
  };
}
