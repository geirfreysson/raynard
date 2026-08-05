import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const runnerPath = join(scriptsDir, 'plugin-tool-runner.mjs');
const pluginDir = join(scriptsDir, 'fixtures', 'reference-plugin');
const brokenPluginDir = join(scriptsDir, 'fixtures', 'broken-plugin');

function runTool(payload, dir = pluginDir) {
  const result = spawnSync('node', [runnerPath], {
    cwd: dir,
    input: JSON.stringify({ pluginDir: dir, ...payload }),
    encoding: 'utf8'
  });
  const line = result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  return { status: result.status, payload: JSON.parse(line || '{}') };
}

describe('plugin tool runner integration', () => {
  it('discovers generated tool schemas at runtime', () => {
    const result = runTool({ listTools: true });

    expect(result.status).toBe(0);
    expect(result.payload.result.tools).toEqual([
      expect.objectContaining({
        name: 'lookupExample',
        description: expect.stringContaining('example API'),
        callable: true,
        card: expect.objectContaining({
          name: { singular: 'example', plural: 'examples' },
          title: '{{name}} (#{{id}})',
          layout: [{ component: 'KeyValue', pairs: [{ label: 'Name', field: 'name' }] }]
        })
      })
    ]);
  });

  it('returns non-empty text, references, and card data from a generated tool', () => {
    const result = runTool({ toolName: 'lookupExample', args: { id: 42 } });

    expect(result.status).toBe(0);
    expect(result.payload.result.text).toContain('Example 42');
    expect(result.payload.result.references[0].url).toBe('https://api.example.com/items/42');
    expect(result.payload.result.data).toEqual({ id: 42, name: 'Example 42' });
  });

  it('marks a tool without an execute method as not callable and refuses to run it', () => {
    const listed = runTool({ listTools: true }, brokenPluginDir);
    expect(listed.status).toBe(0);
    expect(listed.payload.result.tools).toEqual([
      expect.objectContaining({ name: 'lookupExample', callable: false })
    ]);

    const called = runTool({ toolName: 'lookupExample', args: { id: 42 } }, brokenPluginDir);
    expect(called.payload.ok).toBe(false);
    expect(called.payload.error).toContain('Tool not found');
  });
});
