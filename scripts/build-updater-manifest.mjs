// Composes the `latest.json` that Tauri's updater reads from GitHub Releases.
//
// Each platform builds on its own runner, so each build job writes one
// `updater-<platform>.json` fragment naming its signature and the versioned
// asset URL. This merges them. Nothing else in the release can tell that a
// platform is missing — a half-populated manifest silently strands whichever
// platform fell out — so every check here is fatal rather than a warning.
//
// Signatures are inlined in the manifest, so the `.sig` fragments are cleaned
// up afterwards instead of shipping as release assets.

import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every platform the release is expected to cover.
 *
 * Keys are Tauri's `$OS-$ARCH` target strings, matched against the runtime's
 * own target when an installed app checks for an update.
 */
export const REQUIRED_PLATFORMS = ['darwin-aarch64', 'linux-x86_64', 'windows-x86_64'];

const FRAGMENT_PATTERN = /^updater-(.+)\.json$/;

/** Where the tagged release assets live. */
export const RELEASE_ASSET_BASE = 'https://github.com/geirfreysson/raynard/releases/download';

/**
 * Finds the one signature Tauri produced under `directory`.
 *
 * The `.sig` filenames are Tauri's, not ours, and they have changed shape
 * across plugin versions, so they are discovered rather than hard-coded. Zero
 * matches means `createUpdaterArtifacts` did not run; more than one means the
 * bundle directory holds artifacts from an earlier build and picking either
 * would be a guess. Both are fatal.
 */
export async function findSignature(directory, entries) {
  const signatures = entries.filter((name) => name.endsWith('.sig'));
  if (signatures.length === 0) {
    throw new Error(
      `No .sig file in ${directory}; check that createUpdaterArtifacts is enabled and ` +
        'TAURI_SIGNING_PRIVATE_KEY was set for the build.'
    );
  }
  if (signatures.length > 1) {
    throw new Error(`Expected one .sig in ${directory}, found: ${signatures.join(', ')}`);
  }
  return signatures[0];
}

/**
 * Writes one platform's `updater-<target>.json` into the staging directory.
 *
 * `assetName` is the name the file will carry as a release asset, which is not
 * always what Tauri called it on disk.
 */
export async function stageUpdaterFragment({
  target,
  bundleDirectory,
  assetName,
  version,
  outputDirectory
}) {
  const entries = await readdir(bundleDirectory);
  const signatureName = await findSignature(bundleDirectory, entries);
  const signature = (await readFile(resolve(bundleDirectory, signatureName), 'utf8')).trim();
  if (!signature) {
    throw new Error(`${signatureName} is empty`);
  }

  const fragment = {
    [target]: { signature, url: `${RELEASE_ASSET_BASE}/v${version}/${assetName}` }
  };
  await writeFile(
    resolve(outputDirectory, `updater-${target}.json`),
    `${JSON.stringify(fragment, null, 2)}\n`,
    'utf8'
  );
  return fragment;
}

/** The first line of `release-draft.md` is the heading, not a note. */
export function releaseNotesBody(releaseNotes) {
  return String(releaseNotes || '')
    .replace(/^\s*#[^\n]*\n?/, '')
    .trim();
}

/**
 * Builds the manifest object from already-parsed fragments.
 *
 * Separated from the filesystem so the merge rules are testable directly.
 */
export function buildManifest({ version, fragments, notes = '', pubDate }) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${String(version)}`);
  }

  const platforms = {};
  for (const fragment of fragments) {
    for (const [target, entry] of Object.entries(fragment)) {
      if (platforms[target]) {
        throw new Error(`Two fragments both describe ${target}`);
      }
      const signature = typeof entry?.signature === 'string' ? entry.signature.trim() : '';
      const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
      if (!signature) {
        throw new Error(`The ${target} fragment carries no signature`);
      }
      if (!/^https:\/\/\S+$/.test(url)) {
        throw new Error(`The ${target} fragment has no usable download URL: ${url || '(empty)'}`);
      }
      // A floating alias would keep resolving to whatever ships next, which
      // would no longer match the signature recorded beside it here.
      if (url.includes('/releases/latest/download/')) {
        throw new Error(
          `The ${target} URL points at the "latest" alias; it must name the tagged asset: ${url}`
        );
      }
      if (!url.includes(`/download/v${version}/`)) {
        throw new Error(`The ${target} URL is not from the v${version} release: ${url}`);
      }
      platforms[target] = { signature, url };
    }
  }

  const missing = REQUIRED_PLATFORMS.filter((target) => !platforms[target]);
  if (missing.length > 0) {
    throw new Error(`latest.json is missing ${missing.join(', ')}`);
  }

  return {
    version,
    notes: releaseNotesBody(notes),
    pub_date: pubDate || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    platforms
  };
}

/**
 * Reads the fragments in `assetDirectory`, writes `latest.json` beside them,
 * and removes the fragments and any `.sig` files.
 */
export async function writeUpdaterManifest(assetDirectory, { version, notes = '', pubDate } = {}) {
  const entries = await readdir(assetDirectory);
  const fragmentNames = entries.filter((name) => FRAGMENT_PATTERN.test(name));
  if (fragmentNames.length === 0) {
    throw new Error(`No updater-*.json fragments were staged in ${assetDirectory}`);
  }

  const fragments = [];
  for (const name of fragmentNames) {
    const path = resolve(assetDirectory, name);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      throw new Error(`${name} is not readable JSON: ${error.message}`);
    }
    fragments.push(parsed);
  }

  const manifest = buildManifest({ version, fragments, notes, pubDate });
  await writeFile(
    resolve(assetDirectory, 'latest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );

  for (const name of [...fragmentNames, ...entries.filter((name) => name.endsWith('.sig'))]) {
    await rm(resolve(assetDirectory, name), { force: true });
  }

  return manifest;
}

async function readVersion() {
  return JSON.parse(await readFile(resolve(process.cwd(), 'package.json'), 'utf8')).version;
}

/** `fragment <target> <bundle-dir> <asset-name> [staging-dir]` */
async function runFragmentCommand(argv) {
  const [target, bundleDirectory, assetName, outputDirectory = 'release-assets'] = argv;
  if (!target || !bundleDirectory || !assetName) {
    throw new Error('Usage: build-updater-manifest.mjs fragment <target> <bundle-dir> <asset-name>');
  }
  const staging = resolve(process.cwd(), outputDirectory);
  await stat(staging);
  const fragment = await stageUpdaterFragment({
    target,
    bundleDirectory: resolve(process.cwd(), bundleDirectory),
    assetName,
    version: await readVersion(),
    outputDirectory: staging
  });
  console.log(`Staged ${target} -> ${fragment[target].url}`);
}

const isCommandLine =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCommandLine) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'fragment') {
    try {
      await runFragmentCommand(rest);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } else {
  const assetDirectory = resolve(process.cwd(), (command === 'merge' ? rest[0] : command) ?? 'release-assets');
  try {
    const [packageJson, releaseNotes] = await Promise.all([
      readFile(resolve(process.cwd(), 'package.json'), 'utf8'),
      readFile(resolve(process.cwd(), 'release-draft.md'), 'utf8').catch(() => '')
    ]);
    const manifest = await writeUpdaterManifest(assetDirectory, {
      version: JSON.parse(packageJson).version,
      notes: releaseNotes
    });
    console.log(
      `latest.json describes ${manifest.version} for ${Object.keys(manifest.platforms).join(', ')}.`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  }
}
