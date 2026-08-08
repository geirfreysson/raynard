type PluginPromptSource = {
  samplePrompts?: unknown;
};

function normalizePrompts(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((prompt) => String(prompt).trim()).filter(Boolean))];
}

export function selectSplashPrompts(
  plugins: PluginPromptSource[],
  fallback: readonly string[]
) {
  const pluginPrompts = plugins
    .map((plugin) => normalizePrompts(plugin.samplePrompts))
    .filter((prompts) => prompts.length === 3);
  const selected: string[] = [];

  for (let promptIndex = 0; promptIndex < 3; promptIndex += 1) {
    for (const prompts of pluginPrompts) {
      const prompt = prompts[promptIndex];
      if (!selected.includes(prompt)) selected.push(prompt);
      if (selected.length === 3) return selected;
    }
  }

  return [...fallback];
}
