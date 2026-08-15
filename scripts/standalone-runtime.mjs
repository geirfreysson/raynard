import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptsDir, '..');
const tauriDir = join(projectDir, 'src-tauri');
const runtimePackageDir = join(scriptsDir, 'standalone-runtime');

export const NODE_RUNTIME = Object.freeze({
  version: '22.21.1',
  target: 'aarch64-apple-darwin',
  archive: 'node-v22.21.1-darwin-arm64.tar.gz',
  sha256: 'c170d6554fba83d41d25a76cdbad85487c077e51fa73519e41ac885aa429d8af',
  binarySha256: '8179f1d4a920be531d81edef7a26df5cc5c9cb11c8b5a28fb336aa030fbfe3df'
});

export const RUNTIME_SCRIPTS = [
  'builder-compaction.mjs',
  'main-agent-core.mjs',
  'main-agent-sidecar.mjs',
  'oauth-callback-page.mjs',
  'oauth-login-core.mjs',
  'oauth-login-sidecar.mjs',
  'plugin-builder-core.mjs',
  'plugin-builder-sidecar.mjs',
  'plugin-tool-runner.mjs'
];

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  const contents = await readFile(path);
  return createHash('sha256').update(contents).digest('hex');
}

async function sourceFilesUnder(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await sourceFilesUnder(path)));
    else if (entry.isFile()) output.push(path);
  }
  return output.sort();
}

async function runtimeContentSha256() {
  const paths = [
    ...RUNTIME_SCRIPTS.map((name) => join(scriptsDir, name)),
    ...(await sourceFilesUnder(join(scriptsDir, 'plugin-sdk'))),
    join(runtimePackageDir, 'package.json'),
    join(runtimePackageDir, 'package-lock.json')
  ].sort();
  const hash = createHash('sha256').update(JSON.stringify(NODE_RUNTIME));
  for (const path of paths) {
    hash.update(path.slice(projectDir.length));
    hash.update(await readFile(path));
  }
  return hash.digest('hex');
}

async function downloadNodeArchive(archivePath) {
  if ((await pathExists(archivePath)) && (await sha256(archivePath)) === NODE_RUNTIME.sha256) {
    return;
  }

  const url = `https://nodejs.org/dist/v${NODE_RUNTIME.version}/${NODE_RUNTIME.archive}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download the embedded Node runtime (${response.status} ${response.statusText}).`);
  }
  const contents = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(contents).digest('hex');
  if (digest !== NODE_RUNTIME.sha256) {
    throw new Error(`Embedded Node checksum mismatch: expected ${NODE_RUNTIME.sha256}, received ${digest}.`);
  }
  await writeFile(archivePath, contents, { mode: 0o644 });
}

function run(command, args, cwd = projectDir) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
}

async function ensureExtractedNode(cacheDir, archivePath) {
  const extractedDir = join(cacheDir, `node-v${NODE_RUNTIME.version}-darwin-arm64`);
  const nodePath = join(extractedDir, 'bin/node');
  if (await pathExists(nodePath)) return { extractedDir, nodePath };

  run('tar', ['-xzf', archivePath, '-C', cacheDir]);
  if (!(await pathExists(nodePath))) {
    throw new Error(`The embedded Node archive did not contain ${nodePath}.`);
  }
  return { extractedDir, nodePath };
}

async function installRuntimeDependencies() {
  const lockDigest = await sha256(join(runtimePackageDir, 'package-lock.json'));
  const nodeModules = join(runtimePackageDir, 'node_modules');
  const markerPath = join(nodeModules, '.raynard-lock-sha256');
  if (await pathExists(markerPath)) {
    const installedDigest = (await readFile(markerPath, 'utf8')).trim();
    if (installedDigest === lockDigest) return nodeModules;
  }

  await rm(nodeModules, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], runtimePackageDir);
  if (!(await pathExists(nodeModules))) {
    throw new Error('Standalone runtime dependencies were not installed.');
  }
  await writeFile(markerPath, `${lockDigest}\n`);
  return nodeModules;
}

export async function prepareStandaloneRuntime() {
  const cacheDir = join(tauriDir, '.standalone-runtime-cache');
  const archivePath = join(cacheDir, NODE_RUNTIME.archive);
  const binariesDir = join(tauriDir, 'binaries');
  const binaryPath = join(binariesDir, `node-${NODE_RUNTIME.target}`);
  const runtimeDir = join(tauriDir, 'runtime/agent-runtime');
  const stagingDir = join(tauriDir, `runtime/.agent-runtime-${process.pid}`);
  const contentSha256 = await runtimeContentSha256();

  if (
    (await pathExists(binaryPath)) &&
    (await sha256(binaryPath)) === NODE_RUNTIME.binarySha256 &&
    (await pathExists(join(runtimeDir, 'runtime-manifest.json')))
  ) {
    const manifest = JSON.parse(await readFile(join(runtimeDir, 'runtime-manifest.json'), 'utf8'));
    if (manifest.contentSha256 === contentSha256) return { binaryPath, runtimeDir };
  }

  await mkdir(cacheDir, { recursive: true });
  await mkdir(binariesDir, { recursive: true });
  await mkdir(dirname(stagingDir), { recursive: true });
  await downloadNodeArchive(archivePath);
  const { extractedDir, nodePath } = await ensureExtractedNode(cacheDir, archivePath);
  const nodeModules = await installRuntimeDependencies();

  await rm(stagingDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await mkdir(join(stagingDir, 'scripts'), { recursive: true });
  await mkdir(join(stagingDir, 'licenses'), { recursive: true });

  for (const name of RUNTIME_SCRIPTS) {
    await copyFile(join(scriptsDir, name), join(stagingDir, 'scripts', name));
  }
  await cp(join(scriptsDir, 'plugin-sdk'), join(stagingDir, 'scripts/plugin-sdk'), {
    recursive: true,
    dereference: true
  });
  await cp(nodeModules, join(stagingDir, 'node_modules'), {
    recursive: true,
    dereference: true,
    filter: (source) =>
      !source.endsWith('/.DS_Store') && !source.endsWith('/.raynard-lock-sha256')
  });
  await copyFile(join(extractedDir, 'LICENSE'), join(stagingDir, 'licenses/Node-LICENSE'));
  await writeFile(
    join(stagingDir, 'runtime-manifest.json'),
    `${JSON.stringify({ node: NODE_RUNTIME, contentSha256, scripts: RUNTIME_SCRIPTS }, null, 2)}\n`
  );

  await copyFile(nodePath, binaryPath);
  await chmod(binaryPath, 0o755);
  if ((await sha256(binaryPath)) !== NODE_RUNTIME.binarySha256) {
    throw new Error('The extracted Node executable did not match the pinned binary checksum.');
  }
  await rm(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rename(stagingDir, runtimeDir);

  return { binaryPath, runtimeDir };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  prepareStandaloneRuntime()
    .then(({ binaryPath, runtimeDir }) => {
      process.stdout.write(`Prepared Apple Silicon runtime:\n${binaryPath}\n${runtimeDir}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error?.stack || error}\n`);
      process.exitCode = 1;
    });
}
