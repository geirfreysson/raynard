import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptsDir, '..');

const PLATFORM_TARGETS = Object.freeze({
  macos: 'aarch64-apple-darwin',
  linux: 'x86_64-unknown-linux-gnu',
  windows: 'x86_64-pc-windows-msvc'
});

function probeEnvironment() {
  const environment = {};
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

function runResult(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || projectDir,
    input: options.input,
    encoding: 'utf8',
    env: options.env || probeEnvironment(),
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

async function findNamedFiles(directory, wanted) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await findNamedFiles(path, wanted)));
    else if (entry.isFile() && wanted.has(entry.name)) found.push(path);
  }
  return found;
}

async function resolveBundlePaths(platform, bundlePath) {
  const bundleRoot = resolve(bundlePath);
  const manifests = await findNamedFiles(bundleRoot, new Set(['runtime-manifest.json']));
  assert.equal(
    manifests.length,
    1,
    `Expected one packaged runtime manifest under ${bundleRoot}, found ${manifests.length}.`
  );
  const runtimeDir = dirname(manifests[0]);
  const nodeName = platform === 'windows' ? 'node.exe' : 'node';
  const directNodePaths = {
    macos: join(bundleRoot, 'Contents', 'MacOS', nodeName),
    linux: join(bundleRoot, 'usr', 'bin', nodeName),
    windows: join(bundleRoot, nodeName)
  };
  let nodePath = directNodePaths[platform];
  const discoveredNodes = await findNamedFiles(bundleRoot, new Set([nodeName]));
  if (!discoveredNodes.includes(nodePath)) {
    assert.equal(
      discoveredNodes.length,
      1,
      `Expected one packaged ${nodeName} under ${bundleRoot}, found ${discoveredNodes.length}.`
    );
    [nodePath] = discoveredNodes;
  }
  return { bundleRoot, nodePath, runtimeDir };
}

export async function verifyStandaloneBundle(platform, bundlePath) {
  const expectedTarget = PLATFORM_TARGETS[platform];
  if (!expectedTarget) throw new Error(`Unsupported bundle platform: ${platform}.`);

  const { bundleRoot, nodePath, runtimeDir } = await resolveBundlePaths(platform, bundlePath);
  const scriptDir = join(runtimeDir, 'scripts');
  const runnerPath = join(scriptDir, 'plugin-tool-runner.mjs');
  const manifest = JSON.parse(await readFile(join(runtimeDir, 'runtime-manifest.json'), 'utf8'));

  assert.equal(manifest.node.target, expectedTarget);
  assert.equal(run(nodePath, ['--version'], { cwd: bundleRoot }).trim(), `v${manifest.node.version}`);
  if (platform !== 'windows') {
    const executableDescription = run('file', [nodePath]);
    assert.match(
      executableDescription,
      platform === 'macos' ? /Mach-O 64-bit executable arm64/ : /ELF 64-bit.*x86-64/
    );
  }

  for (const name of manifest.scripts) {
    run(nodePath, ['--check', join(scriptDir, name)], { cwd: bundleRoot });
  }

  const pluginDir = await mkdtemp(join(tmpdir(), 'raynard-standalone-plugin-'));
  try {
    const mainProbe = runResult(nodePath, [join(scriptDir, 'main-agent-sidecar.mjs')], {
      cwd: bundleRoot,
      input: '{}\n'
    });
    assert.equal(mainProbe.status, 1, mainProbe.stderr || mainProbe.stdout);
    assert.match(lastJsonLine(mainProbe.stdout).error || mainProbe.stderr, /model API key is required/i);

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

  return { bundlePath: bundleRoot, nodeVersion: manifest.node.version, platform };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const [platform, bundlePath] = process.argv.slice(2);
  if (!platform || !bundlePath) {
    process.stderr.write(
      `Usage: node ${basename(process.argv[1])} <macos|linux|windows> /path/to/extracted-bundle\n`
    );
    process.exitCode = 2;
  } else {
    verifyStandaloneBundle(platform, bundlePath)
      .then((result) => {
        process.stdout.write(
          `Standalone ${result.platform} bundle verified (${result.nodeVersion}): ${result.bundlePath}\n`
        );
      })
      .catch((error) => {
        process.stderr.write(`${error?.stack || error}\n`);
        process.exitCode = 1;
      });
  }
}
