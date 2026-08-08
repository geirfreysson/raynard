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
  for (const plugin of plugins) {
    const prompts = normalizePrompts(plugin.samplePrompts);
    if (prompts.length === 3) return prompts;
  }
  return [...fallback];
}
