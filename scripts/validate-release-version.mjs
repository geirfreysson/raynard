import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function readTomlPackageVersion(contents, path) {
  const packageStart = contents.search(/^\[package\]\s*$/m);
  if (packageStart < 0) throw new Error(`Could not find the package section in ${path}`);
  const afterHeading = contents.slice(packageStart).replace(/^\[package\]\s*$/m, '');
  const nextSection = afterHeading.search(/^\[/m);
  const packageSection = nextSection < 0 ? afterHeading : afterHeading.slice(0, nextSection);
  const version = packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) throw new Error(`Could not read the package version from ${path}`);
  return version;
}

function readCargoLockVersion(contents) {
  for (const packageBlock of contents.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = packageBlock.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1];
    if (name !== 'raynard') continue;
    const version = packageBlock.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
    if (version) return version;
  }
  throw new Error('Could not read the raynard package version from src-tauri/Cargo.lock');
}

async function readJson(rootDirectory, path) {
  return JSON.parse(await readFile(resolve(rootDirectory, path), 'utf8'));
}

export async function validateReleaseVersion(rootDirectory, releaseTag = '') {
  const [packageJson, packageLock, tauriConfig, cargoToml, cargoLock] = await Promise.all([
    readJson(rootDirectory, 'package.json'),
    readJson(rootDirectory, 'package-lock.json'),
    readJson(rootDirectory, 'src-tauri/tauri.conf.json'),
    readFile(resolve(rootDirectory, 'src-tauri/Cargo.toml'), 'utf8'),
    readFile(resolve(rootDirectory, 'src-tauri/Cargo.lock'), 'utf8')
  ]);
  const version = packageJson.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`package.json contains an invalid release version: ${String(version)}`);
  }

  const versions = new Map([
    ['package-lock.json version', packageLock.version],
    ['package-lock.json root version', packageLock.packages?.['']?.version],
    ['src-tauri/tauri.conf.json version', tauriConfig.version],
    ['src-tauri/Cargo.toml version', readTomlPackageVersion(cargoToml, 'src-tauri/Cargo.toml')],
    ['src-tauri/Cargo.lock version', readCargoLockVersion(cargoLock)]
  ]);
  const mismatches = [...versions].filter(([, candidate]) => candidate !== version);
  if (mismatches.length > 0) {
    const details = mismatches
      .map(([source, candidate]) => `${source} is ${String(candidate)}`)
      .join('; ');
    throw new Error(`Release version mismatch: package.json is ${version}; ${details}`);
  }

  const normalizedTag = releaseTag.trim();
  if (normalizedTag) {
    const expectedTag = `v${version}`;
    if (normalizedTag !== expectedTag) {
      throw new Error(`Release tag ${normalizedTag} does not match package version ${version}`);
    }

    const expectedHeading = `# Raynard ${expectedTag}`;
    let releaseNotes = '';
    try {
      releaseNotes = await readFile(resolve(rootDirectory, 'release-draft.md'), 'utf8');
    } catch {
      // The consistent error below tells the release operator how to repair a
      // missing file as well as a stale heading.
    }
    if (releaseNotes.trimStart().split(/\r?\n/, 1)[0] !== expectedHeading) {
      throw new Error(`release-draft.md must start with ${expectedHeading}`);
    }
  }

  return { version };
}

const isCommandLine =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCommandLine) {
  try {
    const result = await validateReleaseVersion(process.cwd(), process.argv[2] ?? '');
    console.log(`Release metadata is consistent at ${result.version}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
