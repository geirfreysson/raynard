import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptsDir, '..');

function runResult(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || projectDir,
    input: options.input,
    encoding: 'utf8',
    env: options.env || { PATH: '/usr/bin:/bin' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

function run(command, args, options = {}) {
  const result = runResult(command, args, options);
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout;
}

function lastJsonLine(stdout) {
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  return JSON.parse(line || '{}');
}

export async function verifyStandaloneMacApp(appPath) {
  const resolvedApp = resolve(appPath);
  const nodePath = join(resolvedApp, 'Contents/MacOS/node');
  const runtimeDir = join(resolvedApp, 'Contents/Resources/agent-runtime');
  const scriptDir = join(runtimeDir, 'scripts');
  const runnerPath = join(scriptDir, 'plugin-tool-runner.mjs');
  const manifest = JSON.parse(await readFile(join(runtimeDir, 'runtime-manifest.json'), 'utf8'));

  assert.equal(manifest.node.target, 'aarch64-apple-darwin');
  assert.equal(run(nodePath, ['--version']).trim(), `v${manifest.node.version}`);
  assert.match(run('file', [nodePath]), /Mach-O 64-bit executable arm64/);

  // Every script the manifest claims to package must be present and parseable,
  // so a sidecar that grows a new local import fails here and not on a user's
  // first chat turn.
  for (const name of manifest.scripts) {
    run(nodePath, ['--check', join(scriptDir, name)]);
  }

  const pluginDir = await mkdtemp(join(tmpdir(), 'raynard-standalone-plugin-'));
  try {
    const mainProbe = runResult(nodePath, [join(scriptDir, 'main-agent-sidecar.mjs')], {
      input: '{}\n'
    });
    assert.equal(mainProbe.status, 1, mainProbe.stderr || mainProbe.stdout);
    assert.match(
      lastJsonLine(mainProbe.stdout).error || mainProbe.stderr,
      /model API key is required/i
    );

    const builderProbe = runResult(nodePath, [join(scriptDir, 'plugin-builder-sidecar.mjs')], {
      cwd: pluginDir,
      input: `${JSON.stringify({ pluginDir })}\n`
    });
    assert.equal(builderProbe.status, 1, builderProbe.stderr || builderProbe.stdout);
    assert.match(
      lastJsonLine(builderProbe.stdout).error || builderProbe.stderr,
      /model API key is required/i
    );

    await writeFile(
      join(pluginDir, 'tools.ts'),
      `import { defineTools } from '@raynard/plugin-sdk';

export const tools = defineTools({
  standalone_echo: {
    description: 'Echo a value for standalone runtime verification.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false
    },
    card: {
      name: { singular: 'echo', plural: 'echoes' },
      layout: [{ component: 'Text', text: '{{value}}' }]
    },
    async execute(args) {
      return {
        text: String(args.value),
        data: { value: String(args.value) },
        references: [{
          referenceId: 'standalone-runtime',
          referenceLabel: 'Standalone runtime',
          referenceMeta: { sourceUrl: 'https://nodejs.org/' }
        }]
      };
    }
  }
});
`
    );

    const listed = lastJsonLine(
      run(nodePath, [runnerPath], {
        cwd: pluginDir,
        input: `${JSON.stringify({ pluginDir, listTools: true })}\n`
      })
    );
    assert.equal(listed.ok, true);
    assert.equal(listed.result.tools[0].name, 'standalone_echo');

    const called = lastJsonLine(
      run(nodePath, [runnerPath], {
        cwd: pluginDir,
        input: `${JSON.stringify({
          pluginDir,
          toolName: 'standalone_echo',
          args: { value: 'packaged runtime works' }
        })}\n`
      })
    );
    assert.equal(called.ok, true);
    assert.equal(called.result.text, 'packaged runtime works');
  } finally {
    await rm(pluginDir, { recursive: true, force: true });
  }

  return { appPath: resolvedApp, nodeVersion: manifest.node.version };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const appPath = process.argv[2];
  if (!appPath) {
    process.stderr.write('Usage: node scripts/verify-standalone-macos.mjs /path/to/Raynard.app\n');
    process.exitCode = 2;
  } else {
    verifyStandaloneMacApp(appPath)
      .then((result) => {
        process.stdout.write(`Standalone macOS bundle verified (${result.nodeVersion}): ${result.appPath}\n`);
      })
      .catch((error) => {
        process.stderr.write(`${error?.stack || error}\n`);
        process.exitCode = 1;
      });
  }
}
