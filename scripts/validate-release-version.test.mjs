import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { validateReleaseVersion } from './validate-release-version.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

async function createReleaseFixture(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'raynard-release-'));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, 'src-tauri'));

  const version = overrides.packageVersion ?? '1.2.0';
  const files = {
    'package.json': JSON.stringify({ name: 'raynard', version }),
    'package-lock.json': JSON.stringify({
      name: 'raynard',
      version: overrides.lockVersion ?? version,
      packages: { '': { name: 'raynard', version: overrides.lockRootVersion ?? version } }
    }),
    'src-tauri/tauri.conf.json': JSON.stringify({
      productName: 'Raynard',
      version: overrides.tauriVersion ?? version
    }),
    'src-tauri/Cargo.toml': `[package]\nname = "raynard"\nversion = "${overrides.cargoVersion ?? version}"\n`,
    'src-tauri/Cargo.lock': `[[package]]\nname = "raynard"\nversion = "${overrides.cargoLockVersion ?? version}"\n`,
    'release-draft.md': overrides.releaseNotes ?? `# Raynard v${version}\n\nRelease notes.\n`
  };

  await Promise.all(
    Object.entries(files).map(([path, contents]) => writeFile(join(directory, path), contents))
  );
  return directory;
}

test('accepts a release when every app version, tag, and release heading agree', async () => {
  const directory = await createReleaseFixture();

  await expect(validateReleaseVersion(directory, 'v1.2.0')).resolves.toEqual({ version: '1.2.0' });
});

test('accepts version consistency checks without a tag or release notes', async () => {
  const directory = await createReleaseFixture();
  await rm(join(directory, 'release-draft.md'));

  await expect(validateReleaseVersion(directory)).resolves.toEqual({ version: '1.2.0' });
});

test.each([
  ['package-lock.json version', { lockVersion: '1.1.0' }],
  ['package-lock.json root version', { lockRootVersion: '1.1.0' }],
  ['Tauri version', { tauriVersion: '1.1.0' }],
  ['Cargo package version', { cargoVersion: '1.1.0' }],
  ['Cargo lock version', { cargoLockVersion: '1.1.0' }]
])('rejects a mismatched %s', async (_label, overrides) => {
  const directory = await createReleaseFixture(overrides);

  await expect(validateReleaseVersion(directory, 'v1.2.0')).rejects.toThrow(/version mismatch/i);
});

test('rejects a tag that does not exactly match the package version', async () => {
  const directory = await createReleaseFixture();

  await expect(validateReleaseVersion(directory, 'v1.3.0')).rejects.toThrow(
    'Release tag v1.3.0 does not match package version 1.2.0'
  );
});

test('rejects tagged releases whose notes are missing or headed for another version', async () => {
  const directory = await createReleaseFixture({
    releaseNotes: '# Raynard v1.1.0\n\nStale notes.\n'
  });

  await expect(validateReleaseVersion(directory, 'v1.2.0')).rejects.toThrow(
    'release-draft.md must start with # Raynard v1.2.0'
  );

  await rm(join(directory, 'release-draft.md'));
  await expect(validateReleaseVersion(directory, 'v1.2.0')).rejects.toThrow(
    'release-draft.md must start with # Raynard v1.2.0'
  );
});
