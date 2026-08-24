import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildManifest,
  findSignature,
  releaseNotesBody,
  REQUIRED_PLATFORMS,
  stageUpdaterFragment,
  writeUpdaterManifest
} from './build-updater-manifest.mjs';

const VERSION = '0.5.0';

function assetUrl(name, version = VERSION) {
  return `https://github.com/geirfreysson/raynard/releases/download/v${version}/${name}`;
}

function fragmentsFor(version = VERSION) {
  return [
    {
      'darwin-aarch64': {
        signature: 'mac-signature',
        url: assetUrl(`Raynard-${version}-mac-arm64.app.tar.gz`, version)
      }
    },
    {
      'linux-x86_64': {
        signature: 'linux-signature',
        url: assetUrl(`Raynard-${version}-linux-x86_64.AppImage`, version)
      }
    },
    {
      'windows-x86_64': {
        signature: 'windows-signature',
        url: assetUrl(`Raynard-${version}-windows-x64-setup.exe`, version)
      }
    }
  ];
}

async function stage(fragments) {
  const directory = await mkdtemp(join(tmpdir(), 'raynard-manifest-'));
  for (const [index, fragment] of fragments.entries()) {
    await writeFile(
      resolve(directory, `updater-${index}.json`),
      JSON.stringify(fragment),
      'utf8'
    );
  }
  return directory;
}

describe('releaseNotesBody', () => {
  it('drops the "# Raynard v0.5.0" heading the release notes must start with', () => {
    expect(releaseNotesBody('# Raynard v0.5.0\n\nAdds in-app updates.\n')).toBe(
      'Adds in-app updates.'
    );
  });

  it('survives empty notes', () => {
    expect(releaseNotesBody('')).toBe('');
    expect(releaseNotesBody(undefined)).toBe('');
  });
});

describe('buildManifest', () => {
  it('merges one fragment per platform into the shape the updater reads', () => {
    const manifest = buildManifest({
      version: VERSION,
      fragments: fragmentsFor(),
      notes: '# Raynard v0.5.0\n\nAdds in-app updates.\n'
    });

    expect(manifest.version).toBe(VERSION);
    expect(manifest.notes).toBe('Adds in-app updates.');
    expect(Object.keys(manifest.platforms).sort()).toEqual([...REQUIRED_PLATFORMS].sort());
    expect(manifest.platforms['darwin-aarch64'].signature).toBe('mac-signature');
    expect(manifest.platforms['darwin-aarch64'].url).toContain('.app.tar.gz');
  });

  it('stamps an RFC 3339 pub_date', () => {
    const manifest = buildManifest({ version: VERSION, fragments: fragmentsFor() });
    expect(manifest.pub_date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Number.isNaN(Date.parse(manifest.pub_date))).toBe(false);
  });

  it('refuses a manifest that is missing a platform', () => {
    const fragments = fragmentsFor().slice(0, 2);
    expect(() => buildManifest({ version: VERSION, fragments })).toThrow(/windows-x86_64/);
  });

  it('refuses an empty signature, which mocked builds would not otherwise catch', () => {
    const fragments = fragmentsFor();
    fragments[0]['darwin-aarch64'].signature = '   ';
    expect(() => buildManifest({ version: VERSION, fragments })).toThrow(/no signature/);
  });

  it('refuses a missing or non-https URL', () => {
    const fragments = fragmentsFor();
    fragments[1]['linux-x86_64'].url = '';
    expect(() => buildManifest({ version: VERSION, fragments })).toThrow(/download URL/);
  });

  it('refuses the floating "latest" alias, which would outlive its signature', () => {
    const fragments = fragmentsFor();
    fragments[0]['darwin-aarch64'].url =
      'https://github.com/geirfreysson/raynard/releases/latest/download/Raynard-mac-arm64.app.tar.gz';
    expect(() => buildManifest({ version: VERSION, fragments })).toThrow(/latest/);
  });

  it('refuses an asset carried over from a different release', () => {
    const fragments = fragmentsFor();
    fragments[2]['windows-x86_64'].url = assetUrl('Raynard-0.4.0-windows-x64-setup.exe', '0.4.0');
    expect(() => buildManifest({ version: VERSION, fragments })).toThrow(/not from the v0.5.0/);
  });

  it('refuses two fragments claiming the same platform', () => {
    const fragments = [...fragmentsFor(), fragmentsFor()[0]];
    expect(() => buildManifest({ version: VERSION, fragments })).toThrow(/both describe/);
  });

  it('refuses a version that is not semver', () => {
    expect(() => buildManifest({ version: 'v0.5.0', fragments: fragmentsFor() })).toThrow(
      /Invalid release version/
    );
  });

  it('accepts a prerelease version', () => {
    const manifest = buildManifest({
      version: '0.5.0-rc.1',
      fragments: fragmentsFor('0.5.0-rc.1')
    });
    expect(manifest.version).toBe('0.5.0-rc.1');
  });
});

describe('writeUpdaterManifest', () => {
  it('writes latest.json and clears the fragments and signatures behind it', async () => {
    const directory = await stage(fragmentsFor());
    await writeFile(resolve(directory, 'Raynard-0.5.0-mac-arm64.app.tar.gz.sig'), 'sig', 'utf8');
    await writeFile(resolve(directory, 'Raynard-0.5.0-mac-arm64.dmg'), 'dmg', 'utf8');

    await writeUpdaterManifest(directory, { version: VERSION, notes: '# Raynard v0.5.0\n\nHi.\n' });

    const remaining = await readdir(directory);
    expect(remaining).toContain('latest.json');
    expect(remaining).toContain('Raynard-0.5.0-mac-arm64.dmg');
    expect(remaining.some((name) => name.endsWith('.sig'))).toBe(false);
    expect(remaining.some((name) => name.startsWith('updater-'))).toBe(false);

    const manifest = JSON.parse(await readFile(resolve(directory, 'latest.json'), 'utf8'));
    expect(manifest.platforms['linux-x86_64'].signature).toBe('linux-signature');
    expect(manifest.notes).toBe('Hi.');
  });

  it('fails when no build job staged a fragment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'raynard-manifest-'));
    await expect(writeUpdaterManifest(directory, { version: VERSION })).rejects.toThrow(
      /No updater-\*\.json fragments/
    );
  });

  it('fails on an unreadable fragment rather than silently dropping a platform', async () => {
    const directory = await stage(fragmentsFor());
    await writeFile(resolve(directory, 'updater-broken.json'), '{not json', 'utf8');
    await expect(writeUpdaterManifest(directory, { version: VERSION })).rejects.toThrow(
      /not readable JSON/
    );
  });

  it('leaves no latest.json behind when a platform is missing', async () => {
    const directory = await stage(fragmentsFor().slice(0, 1));
    await expect(writeUpdaterManifest(directory, { version: VERSION })).rejects.toThrow();
    expect(await readdir(directory)).not.toContain('latest.json');
  });
});

describe('findSignature', () => {
  it('picks the one signature Tauri wrote', async () => {
    const found = await findSignature('/bundle', ['Raynard.app.tar.gz', 'Raynard.app.tar.gz.sig']);
    expect(found).toBe('Raynard.app.tar.gz.sig');
  });

  it('fails loudly when the build produced none', async () => {
    await expect(findSignature('/bundle', ['Raynard.app.tar.gz'])).rejects.toThrow(
      /createUpdaterArtifacts/
    );
  });

  it('refuses to guess between leftovers from an earlier build', async () => {
    await expect(findSignature('/bundle', ['a.sig', 'b.sig'])).rejects.toThrow(/found: a.sig, b.sig/);
  });
});

describe('stageUpdaterFragment', () => {
  it('writes the tagged URL and the signature the build produced', async () => {
    const bundle = await mkdtemp(join(tmpdir(), 'raynard-bundle-'));
    const staging = await mkdtemp(join(tmpdir(), 'raynard-staging-'));
    await writeFile(resolve(bundle, 'Raynard.app.tar.gz'), 'payload', 'utf8');
    await writeFile(resolve(bundle, 'Raynard.app.tar.gz.sig'), '  signed-bytes\n', 'utf8');

    const fragment = await stageUpdaterFragment({
      target: 'darwin-aarch64',
      bundleDirectory: bundle,
      assetName: `Raynard-${VERSION}-mac-arm64.app.tar.gz`,
      version: VERSION,
      outputDirectory: staging
    });

    expect(fragment['darwin-aarch64'].signature).toBe('signed-bytes');
    expect(fragment['darwin-aarch64'].url).toBe(
      `https://github.com/geirfreysson/raynard/releases/download/v${VERSION}/Raynard-${VERSION}-mac-arm64.app.tar.gz`
    );

    const written = JSON.parse(
      await readFile(resolve(staging, 'updater-darwin-aarch64.json'), 'utf8')
    );
    expect(written).toEqual(fragment);
  });

  it('produces fragments the merge step accepts', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'raynard-staging-'));
    const assets = {
      'darwin-aarch64': `Raynard-${VERSION}-mac-arm64.app.tar.gz`,
      'linux-x86_64': `Raynard-${VERSION}-linux-x86_64.AppImage`,
      'windows-x86_64': `Raynard-${VERSION}-windows-x64-setup.exe`
    };
    for (const [target, assetName] of Object.entries(assets)) {
      const bundle = await mkdtemp(join(tmpdir(), 'raynard-bundle-'));
      await writeFile(resolve(bundle, `${assetName}.sig`), `${target}-signature`, 'utf8');
      await stageUpdaterFragment({
        target,
        bundleDirectory: bundle,
        assetName,
        version: VERSION,
        outputDirectory: staging
      });
    }

    const manifest = await writeUpdaterManifest(staging, { version: VERSION });
    expect(Object.keys(manifest.platforms).sort()).toEqual([...REQUIRED_PLATFORMS].sort());
    expect(manifest.platforms['windows-x86_64'].signature).toBe('windows-x86_64-signature');
  });

  it('refuses an empty signature file', async () => {
    const bundle = await mkdtemp(join(tmpdir(), 'raynard-bundle-'));
    const staging = await mkdtemp(join(tmpdir(), 'raynard-staging-'));
    await writeFile(resolve(bundle, 'Raynard.AppImage.sig'), '   \n', 'utf8');
    await expect(
      stageUpdaterFragment({
        target: 'linux-x86_64',
        bundleDirectory: bundle,
        assetName: 'Raynard.AppImage',
        version: VERSION,
        outputDirectory: staging
      })
    ).rejects.toThrow(/is empty/);
  });
});
