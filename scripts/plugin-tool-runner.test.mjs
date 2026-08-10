import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const runnerPath = join(scriptsDir, 'plugin-tool-runner.mjs');
const pluginDir = join(scriptsDir, 'fixtures', 'reference-plugin');
const brokenPluginDir = join(scriptsDir, 'fixtures', 'broken-plugin');
const compactPluginDir = join(scriptsDir, 'fixtures', 'compact-plugin');
const cachePluginDir = join(scriptsDir, 'fixtures', 'cache-plugin');
const credentialPluginDir = join(scriptsDir, 'fixtures', 'credential-plugin');

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

function runToolAsync(payload, dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [runnerPath], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => {
      const line = stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).at(-1);
      try {
        resolve({ status, payload: JSON.parse(line || '{}'), stderr });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify({ pluginDir: dir, ...payload }));
  });
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

  it('loads a compact tools.ts-only plugin through the shared SDK', () => {
    const listed = runTool({ listTools: true }, compactPluginDir);
    expect(listed.status).toBe(0);
    expect(listed.payload.result.tools).toEqual([
      expect.objectContaining({
        name: 'compact_lookup',
        callable: true,
        card: expect.objectContaining({
          name: { singular: 'record', plural: 'records' }
        })
      })
    ]);

    const called = runTool({ toolName: 'compact_lookup', args: { id: 7 } }, compactPluginDir);
    expect(called.status).toBe(0);
    expect(called.payload.result.text).toBe('Record 7');
    expect(called.payload.result.data).toEqual({ id: 7, label: 'Record 7' });
    expect(called.payload.result.references).toHaveLength(1);
  });

  it('rejects a registry that does not satisfy the SDK contract', () => {
    const listed = runTool({ listTools: true }, brokenPluginDir);
    expect(listed.status).toBe(1);
    expect(listed.payload.ok).toBe(false);
    expect(listed.payload.error).toMatch(/singular and plural|card/i);

    const called = runTool({ toolName: 'lookupExample', args: { id: 42 } }, brokenPluginDir);
    expect(called.status).toBe(1);
    expect(called.payload.ok).toBe(false);
    expect(called.payload.error).toMatch(/singular and plural|card/i);
  });

  it('reuses an endpoint response across separate runner processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raynard-runner-cache-'));
    const copiedPluginDir = join(root, basename(cachePluginDir));
    const dataDir = join(root, '.plugin-data', basename(cachePluginDir));
    await cp(cachePluginDir, copiedPluginDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, 'cache-settings.json'),
      JSON.stringify({ enabled: true, ttlHours: 24 }),
      'utf8'
    );

    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ value: 'cached response' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/records?limit=5`;

    try {
      const first = await runToolAsync({ toolName: 'cached_lookup', args: { url } }, copiedPluginDir);
      expect(first.status).toBe(0);
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

      const second = await runToolAsync({ toolName: 'cached_lookup', args: { url } }, copiedPluginDir);
      expect(second.status).toBe(0);
      expect(second.payload.result.data).toEqual({ value: 'cached response' });
      expect(calls).toBe(1);
    } finally {
      if (server.listening) server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  describe('credentials', () => {
    async function withServer(handler, run) {
      const server = createServer(handler);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        return await run(`http://127.0.0.1:${server.address().port}/records`);
      } finally {
        if (server.listening) {
          await new Promise((resolve) => server.close(resolve));
        }
      }
    }

    it('passes host-supplied credentials through to the tool', async () => {
      await withServer(
        (_request, response) => {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ value: 'authorized' }));
        },
        async (url) => {
          const called = await runToolAsync(
            {
              toolName: 'credential_lookup',
              args: { url },
              credentials: { FIXTURE_API_KEY: 'fixture-secret-value' }
            },
            credentialPluginDir
          );

          expect(called.status).toBe(0);
          expect(called.payload.ok).toBe(true);
          expect(called.payload.result.text).toContain('fixture-secret-value');
        }
      );
    });

    it('reports a structured credential request instead of a bare failure', () => {
      const called = runTool(
        { toolName: 'credential_lookup', args: { url: 'http://127.0.0.1:1/records' } },
        credentialPluginDir
      );

      expect(called.status).toBe(1);
      expect(called.payload.ok).toBe(false);
      expect(called.payload.credentialRequest).toEqual({
        key: 'FIXTURE_API_KEY',
        label: 'Fixture API key'
      });
      expect(called.payload.error).toMatch(/FIXTURE_API_KEY/);
    });

    it('discovers tools without credentials so the builder never needs a key', () => {
      const listed = runTool({ listTools: true }, credentialPluginDir);

      expect(listed.status).toBe(0);
      expect(listed.payload.ok).toBe(true);
      expect(listed.payload.result.tools).toEqual([
        expect.objectContaining({ name: 'credential_lookup', callable: true })
      ]);
    });

    it('keeps a query-parameter credential out of the failure it reports', async () => {
      await withServer(
        (_request, response) => {
          response.statusCode = 500;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ message: 'rejected key fixture-secret-value' }));
        },
        async (url) => {
          const called = await runToolAsync(
            {
              toolName: 'credential_lookup',
              args: { url },
              credentials: { FIXTURE_API_KEY: 'fixture-secret-value' }
            },
            credentialPluginDir
          );

          expect(called.status).toBe(1);
          expect(called.payload.ok).toBe(false);
          // The key is in both the request URL and the upstream error body.
          expect(JSON.stringify(called.payload)).not.toContain('fixture-secret-value');
          expect(called.payload.error).toContain('***');
        }
      );
    });
  });
});
