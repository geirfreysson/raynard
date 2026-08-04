import type { AgentBuildRequest } from './agent-runtime';

export type AppMode = 'explore' | 'build';
export type BuildRequestStep = 'offer-switch' | 'confirm-write';

export function nextBuildRequestStep(mode: AppMode): BuildRequestStep {
  return mode === 'build' ? 'confirm-write' : 'offer-switch';
}

export function continueBuildRequest(request: AgentBuildRequest) {
  return {
    mode: 'build' as const,
    step: 'confirm-write' as const,
    request
  };
}
