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
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptsDir, '..');
const tauriDir = join(projectDir, 'src-tauri');
const runtimePackageDir = join(scriptsDir, 'standalone-runtime');

export const NODE_RUNTIME = Object.freeze({
  version: '22.21.1'
});

export const NODE_RUNTIMES = Object.freeze({
  'aarch64-apple-darwin': Object.freeze({
    ...NODE_RUNTIME,
    target: 'aarch64-apple-darwin',
    archive: 'node-v22.21.1-darwin-arm64.tar.gz',
    extractedDirectory: 'node-v22.21.1-darwin-arm64',
    executable: 'bin/node',
    sha256: 'c170d6554fba83d41d25a76cdbad85487c077e51fa73519e41ac885aa429d8af',
    binarySha256: '8179f1d4a920be531d81edef7a26df5cc5c9cb11c8b5a28fb336aa030fbfe3df'
  }),
  'x86_64-unknown-linux-gnu': Object.freeze({
    ...NODE_RUNTIME,
    target: 'x86_64-unknown-linux-gnu',
    archive: 'node-v22.21.1-linux-x64.tar.gz',
    extractedDirectory: 'node-v22.21.1-linux-x64',
    executable: 'bin/node',
    sha256: '219a152ea859861d75adea578bdec3dce8143853c13c5187f40c40e77b0143b2',
    binarySha256: '92181daccf61361e7c54d6404a3e2c2307a916d076492e3c0b388e6e5f86a854'
  }),
  'x86_64-pc-windows-msvc': Object.freeze({
    ...NODE_RUNTIME,
    target: 'x86_64-pc-windows-msvc',
    archive: 'node-v22.21.1-win-x64.zip',
    extractedDirectory: 'node-v22.21.1-win-x64',
    executable: 'node.exe',
    sha256: '3c624e9fbe07e3217552ec52a0f84e2bdc2e6ffa7348f3fdfb9fbf8f42e23fcf',
    binarySha256: '471961cb355311c9a9dd8ba417eca8269ead32a2231653084112554cda52e8b3'
  })
});

const HOST_TARGETS = Object.freeze({
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc'
});

export function resolveRuntimeTarget(args = process.argv.slice(2), environment = process.env) {
  const targetFlag = args.indexOf('--target');
  const requested =
    (targetFlag >= 0 ? args[targetFlag + 1] : '') || environment.RAYNARD_RUNTIME_TARGET || '';
  const target = requested || HOST_TARGETS[`${process.platform}-${process.arch}`];
  if (!target || !NODE_RUNTIMES[target]) {
    throw new Error(
      `Unsupported standalone runtime target: ${target || `${process.platform}-${process.arch}`}.`
    );
  }
  return target;
}

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

async function runtimeContentSha256(runtime) {
  const paths = [
    ...RUNTIME_SCRIPTS.map((name) => join(scriptsDir, name)),
    ...(await sourceFilesUnder(join(scriptsDir, 'plugin-sdk'))),
    join(runtimePackageDir, 'package.json'),
    join(runtimePackageDir, 'package-lock.json')
  ].sort();
  const hash = createHash('sha256').update(JSON.stringify(runtime));
  for (const path of paths) {
    hash.update(path.slice(projectDir.length));
    hash.update(await readFile(path));
  }
  return hash.digest('hex');
}

async function downloadNodeArchive(runtime, archivePath) {
  if ((await pathExists(archivePath)) && (await sha256(archivePath)) === runtime.sha256) {
    return;
  }

  const url = `https://nodejs.org/dist/v${runtime.version}/${runtime.archive}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download the embedded Node runtime (${response.status} ${response.statusText}).`);
  }
  const contents = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(contents).digest('hex');
  if (digest !== runtime.sha256) {
    throw new Error(`Embedded Node checksum mismatch: expected ${runtime.sha256}, received ${digest}.`);
  }
  await writeFile(archivePath, contents, { mode: 0o644 });
}

/**
 * Whether this command has to go through a shell to start at all.
 *
 * Node refuses to spawn a `.cmd`/`.bat` directly (the CVE-2024-27980 fix), and
 * on Windows npm *is* `npm.cmd`. Everything else stays shell-free, so the
 * quoting below applies to one narrow path rather than every subprocess.
 */
export function needsShell(command, platform = process.platform) {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

/**
 * Quotes one argument for `cmd.exe`.
 *
 * `spawnSync` does not quote for us once `shell` is set: it joins the command
 * line verbatim, so an unquoted path containing a space arrives as two
 * arguments. Only the runtime's own literal flags and paths go through here.
 */
export function quoteForShell(value) {
  return /[\s"^&|<>()]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function run(command, args, cwd = projectDir) {
  const shell = needsShell(command);
  const result = spawnSync(
    shell ? quoteForShell(command) : command,
    shell ? args.map(quoteForShell) : args,
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell
    }
  );
  if (result.status !== 0) {
    const detail =
      result.error?.message ||
      result.stderr?.trim() ||
      result.stdout?.trim() ||
      `exit code ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
}

async function ensureExtractedNode(runtime, cacheDir, archivePath) {
  const extractedDir = join(cacheDir, runtime.extractedDirectory);
  const nodePath = join(extractedDir, runtime.executable);
  if (await pathExists(nodePath)) return { extractedDir, nodePath };

  run('tar', ['-xf', archivePath, '-C', cacheDir]);
  if (!(await pathExists(nodePath))) {
    throw new Error(`The embedded Node archive did not contain ${nodePath}.`);
  }
  return { extractedDir, nodePath };
}

async function installRuntimeDependencies(runtime) {
  const lockDigest = await sha256(join(runtimePackageDir, 'package-lock.json'));
  const nodeModules = join(runtimePackageDir, 'node_modules');
  const markerPath = join(nodeModules, '.raynard-runtime-key');
  const runtimeKey = `${runtime.target}:${lockDigest}`;
  if (await pathExists(markerPath)) {
    const installedKey = (await readFile(markerPath, 'utf8')).trim();
    if (installedKey === runtimeKey) return nodeModules;
  }

  await rm(nodeModules, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npmCommand, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], runtimePackageDir);
  if (!(await pathExists(nodeModules))) {
    throw new Error('Standalone runtime dependencies were not installed.');
  }
  await writeFile(markerPath, `${runtimeKey}\n`);
  return nodeModules;
}

export async function prepareStandaloneRuntime(target = resolveRuntimeTarget()) {
  const runtime = NODE_RUNTIMES[target];
  if (!runtime) throw new Error(`Unsupported standalone runtime target: ${target}.`);
  const cacheDir = join(tauriDir, '.standalone-runtime-cache');
  const archivePath = join(cacheDir, runtime.archive);
  const binariesDir = join(tauriDir, 'binaries');
  const binaryPath = join(
    binariesDir,
    `node-${runtime.target}${runtime.target.includes('windows') ? '.exe' : ''}`
  );
  const runtimeDir = join(tauriDir, 'runtime/agent-runtime');
  const stagingDir = join(tauriDir, `runtime/.agent-runtime-${process.pid}`);
  const contentSha256 = await runtimeContentSha256(runtime);

  if (
    (await pathExists(binaryPath)) &&
    (await sha256(binaryPath)) === runtime.binarySha256 &&
    (await pathExists(join(runtimeDir, 'runtime-manifest.json')))
  ) {
    const manifest = JSON.parse(await readFile(join(runtimeDir, 'runtime-manifest.json'), 'utf8'));
    if (manifest.contentSha256 === contentSha256) return { binaryPath, runtimeDir };
  }

  await mkdir(cacheDir, { recursive: true });
  await mkdir(binariesDir, { recursive: true });
  await mkdir(dirname(stagingDir), { recursive: true });
  await downloadNodeArchive(runtime, archivePath);
  const { extractedDir, nodePath } = await ensureExtractedNode(runtime, cacheDir, archivePath);
  const nodeModules = await installRuntimeDependencies(runtime);

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
    filter: (source) => !['.DS_Store', '.raynard-runtime-key'].includes(basename(source))
  });
  await copyFile(join(extractedDir, 'LICENSE'), join(stagingDir, 'licenses/Node-LICENSE'));
  await writeFile(
    join(stagingDir, 'runtime-manifest.json'),
    `${JSON.stringify({ node: runtime, contentSha256, scripts: RUNTIME_SCRIPTS }, null, 2)}\n`
  );

  await copyFile(nodePath, binaryPath);
  await chmod(binaryPath, 0o755);
  if ((await sha256(binaryPath)) !== runtime.binarySha256) {
    throw new Error('The extracted Node executable did not match the pinned binary checksum.');
  }
  await rm(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rename(stagingDir, runtimeDir);

  return { binaryPath, runtimeDir };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const target = resolveRuntimeTarget();
  prepareStandaloneRuntime(target)
    .then(({ binaryPath, runtimeDir }) => {
      process.stdout.write(`Prepared ${target} runtime:\n${binaryPath}\n${runtimeDir}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error?.stack || error}\n`);
      process.exitCode = 1;
    });
}
