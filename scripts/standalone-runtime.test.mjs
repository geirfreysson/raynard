import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

test('sidecars launch nested Node work with the embedded executable', async () => {
  const mainAgent = await readFile(join(scriptsDir, 'main-agent-sidecar.mjs'), 'utf8');
  const pluginBuilder = await readFile(join(scriptsDir, 'plugin-builder-sidecar.mjs'), 'utf8');

  expect(mainAgent).not.toMatch(/spawn\(['"]node['"]/);
  expect(pluginBuilder).not.toMatch(/runCommand\(['"]node['"]/);
  expect(mainAgent).toMatch(/process\.execPath/);
  expect(pluginBuilder).toMatch(/process\.execPath/);
});

test('the standalone runtime packager pins and verifies every supported Node archive', async () => {
  const packager = await import('./standalone-runtime.mjs');

  expect(packager.NODE_RUNTIME.version).toBe('22.21.1');
  expect(Object.keys(packager.NODE_RUNTIMES)).toEqual([
    'aarch64-apple-darwin',
    'x86_64-unknown-linux-gnu',
    'x86_64-pc-windows-msvc'
  ]);
  expect(packager.NODE_RUNTIMES['aarch64-apple-darwin'].sha256).toBe(
    'c170d6554fba83d41d25a76cdbad85487c077e51fa73519e41ac885aa429d8af'
  );
  expect(packager.NODE_RUNTIMES['x86_64-unknown-linux-gnu']).toMatchObject({
    archive: 'node-v22.21.1-linux-x64.tar.gz',
    executable: 'bin/node',
    sha256: '219a152ea859861d75adea578bdec3dce8143853c13c5187f40c40e77b0143b2',
    binarySha256: '92181daccf61361e7c54d6404a3e2c2307a916d076492e3c0b388e6e5f86a854'
  });
  expect(packager.NODE_RUNTIMES['x86_64-pc-windows-msvc']).toMatchObject({
    archive: 'node-v22.21.1-win-x64.zip',
    executable: 'node.exe',
    sha256: '3c624e9fbe07e3217552ec52a0f84e2bdc2e6ffa7348f3fdfb9fbf8f42e23fcf',
    binarySha256: '471961cb355311c9a9dd8ba417eca8269ead32a2231653084112554cda52e8b3'
  });
});

test('the standalone runtime target can be selected by flag or build environment', async () => {
  const { resolveRuntimeTarget } = await import('./standalone-runtime.mjs');

  expect(resolveRuntimeTarget(['--target', 'x86_64-unknown-linux-gnu'], {})).toBe(
    'x86_64-unknown-linux-gnu'
  );
  expect(
    resolveRuntimeTarget([], { RAYNARD_RUNTIME_TARGET: 'x86_64-pc-windows-msvc' })
  ).toBe('x86_64-pc-windows-msvc');
  expect(() => resolveRuntimeTarget(['--target', 'sparc-example-none'], {})).toThrow(
    /unsupported standalone runtime target/i
  );
});

test('every script a packaged sidecar imports is copied into the runtime', async () => {
  const { RUNTIME_SCRIPTS } = await import('./standalone-runtime.mjs');
  const entryPoints = [
    'main-agent-sidecar.mjs',
    'plugin-builder-sidecar.mjs',
    'plugin-tool-runner.mjs',
    'oauth-login-sidecar.mjs'
  ];

  const required = new Set();
  const pending = [...entryPoints];
  while (pending.length > 0) {
    const name = pending.pop();
    if (required.has(name)) continue;
    required.add(name);
    const source = await readFile(join(scriptsDir, name), 'utf8');
    for (const [, imported] of source.matchAll(/from '(\.\/[^']+\.mjs)'/g)) {
      pending.push(imported.slice(2));
    }
  }

  for (const name of [...required].sort()) {
    expect(RUNTIME_SCRIPTS, `${name} is imported at runtime but never packaged`).toContain(name);
  }
});

test('the locked standalone dependency set includes builder runtime dependencies', async () => {
  const runtimePackage = JSON.parse(
    await readFile(join(scriptsDir, 'standalone-runtime/package.json'), 'utf8')
  );

  expect(runtimePackage.dependencies['@mariozechner/pi-agent-core']).toBe('0.73.1');
  expect(runtimePackage.dependencies['@mariozechner/pi-ai']).toBe('0.73.1');
  expect(runtimePackage.dependencies['@mariozechner/pi-coding-agent']).toBe('0.73.1');
  expect(runtimePackage.dependencies.typescript).toBe('5.9.3');
});

test('every native release job prepares its matching standalone runtime', async () => {
  const workflow = await readFile(
    join(scriptsDir, '../.github/workflows/release-macos-arm64.yml'),
    'utf8'
  );
  const macJob = workflow.slice(
    workflow.indexOf('  release-macos-arm64:'),
    workflow.indexOf('  release-linux-x64:')
  );
  const linuxJob = workflow.slice(
    workflow.indexOf('  release-linux-x64:'),
    workflow.indexOf('  release-windows-x64:')
  );
  const windowsJob = workflow.slice(
    workflow.indexOf('  release-windows-x64:'),
    workflow.indexOf('  publish-release:')
  );

  expect(macJob).toContain('RAYNARD_RUNTIME_TARGET: aarch64-apple-darwin');
  expect(macJob).toContain('npm run runtime:prepare:macos-arm64');
  expect(linuxJob).toContain('runs-on: ubuntu-22.04');
  expect(linuxJob).toContain('npm run runtime:prepare:linux-x64');
  expect(linuxJob).toContain('--bundles appimage,deb');
  expect(linuxJob).toContain('verify-standalone-bundle.mjs linux');
  expect(windowsJob).toContain('runs-on: windows-latest');
  expect(windowsJob).toContain('npm run runtime:prepare:windows-x64');
  expect(windowsJob).toContain('--bundles nsis');
  expect(windowsJob).toContain('verify-standalone-bundle.mjs windows');

  for (const job of [macJob, linuxJob, windowsJob]) {
    expect(job.indexOf('- name: Prepare standalone runtime')).toBeGreaterThan(-1);
    expect(job.indexOf('cargo test --manifest-path src-tauri/Cargo.toml --lib')).toBeGreaterThan(
      job.indexOf('- name: Prepare standalone runtime')
    );
  }

  const importCertificate = workflow.indexOf('- name: Import Developer ID certificate');
  const signNativeRuntime = workflow.indexOf('- name: Sign standalone runtime native code');
  const tauriBuild = workflow.indexOf('npm run tauri:build -- --target aarch64-apple-darwin');
  const notarizeDmg = workflow.indexOf('xcrun notarytool submit "$dmg_path"');
  const validateDmgTicket = workflow.indexOf('xcrun stapler validate "$dmg_path"');

  expect(signNativeRuntime).toBeGreaterThan(importCertificate);
  expect(tauriBuild).toBeGreaterThan(signNativeRuntime);
  expect(workflow.slice(signNativeRuntime, tauriBuild)).toContain(
    'codesign --force --options runtime --timestamp'
  );
  expect(notarizeDmg).toBeGreaterThan(tauriBuild);
  expect(validateDmgTicket).toBeGreaterThan(notarizeDmg);
});

test('tagged releases validate their version and publish the binary with its checksum', async () => {
  const workflow = await readFile(
    join(scriptsDir, '../.github/workflows/release-macos-arm64.yml'),
    'utf8'
  );
  const validateVersion = workflow.indexOf('scripts/validate-release-version.mjs');
  const publishJob = workflow.slice(workflow.indexOf('  publish-release:'));
  const createRelease = workflow.indexOf('gh release create "$GITHUB_REF_NAME"');
  const uploadRelease = workflow.indexOf('gh release upload "$GITHUB_REF_NAME"');
  const publishRelease = workflow.indexOf(
    'gh release edit "$GITHUB_REF_NAME" --draft=false --latest'
  );

  expect(validateVersion).toBeGreaterThan(-1);
  expect(uploadRelease).toBeGreaterThan(createRelease);
  expect(workflow.slice(createRelease, uploadRelease)).toContain('--draft');
  expect(publishRelease).toBeGreaterThan(uploadRelease);
  expect(workflow).toContain('--notes-file release-draft.md');
  expect(workflow).toContain('Raynard-${version}-mac-arm64.dmg.sha256');
  expect(workflow).toContain('Raynard-${version}-linux-x86_64.AppImage');
  expect(workflow).toContain('Raynard-$version-windows-x64-setup.exe');
  expect(publishJob).toContain('needs:');
  expect(publishJob).toContain('- release-macos-arm64');
  expect(publishJob).toContain('- release-linux-x64');
  expect(publishJob).toContain('- release-windows-x64');
  expect(publishJob).toContain('pattern: desktop-*');
  expect(publishJob).toContain('docs/static/install.sh');
  expect(publishJob).toContain('docs/static/install.ps1');
});

test('the docs download surfaces use stable assets published by every latest release', async () => {
  const [workflow, shareConfigRaw, homepage, downloadHelper, gettingStarted] = await Promise.all([
    readFile(join(scriptsDir, '../.github/workflows/release-macos-arm64.yml'), 'utf8'),
    readFile(join(scriptsDir, '../share.config.json'), 'utf8'),
    readFile(join(scriptsDir, '../docs/src/pages/index.js'), 'utf8'),
    readFile(join(scriptsDir, '../docs/src/lib/download.js'), 'utf8'),
    readFile(join(scriptsDir, '../docs/docs/getting-started.md'), 'utf8')
  ]);

  // The download URL now lives in share.config.json, which the app and the docs
  // site both read. Deriving the asset name from it ties the link the docs
  // publish to the artifact the release workflow actually uploads.
  const configured = JSON.parse(shareConfigRaw);
  const latestDownload = configured.downloadUrl;
  const assetName = latestDownload.split('/').pop();

  expect(workflow).toContain(`release-assets/${assetName}`);
  expect(workflow).toContain(`${assetName}.sha256`);
  for (const url of Object.values(configured.downloads)) {
    expect(workflow).toContain(url.split('/').pop());
  }

  // Markdown cannot import the config, so this one is checked by equality.
  expect(gettingStarted).toContain(latestDownload);

  // These import the config instead, and must not drift back to literals.
  expect(homepage).not.toContain(latestDownload);
  expect(downloadHelper).not.toContain(latestDownload);
  expect(homepage).toContain('share.config.json');
  expect(downloadHelper).toContain('share.config.json');
});

test('npm is started through a shell on Windows, where it is a .cmd', async () => {
  const { needsShell } = await import('./standalone-runtime.mjs');

  // Node refuses to spawn these directly, so a shell-free spawn fails with
  // EINVAL before npm ever runs. This is what broke the v0.3.0 Windows build.
  expect(needsShell('npm.cmd', 'win32')).toBe(true);
  expect(needsShell('yarn.BAT', 'win32')).toBe(true);

  // Everything else keeps the safer shell-free path, on every platform.
  expect(needsShell('tar', 'win32')).toBe(false);
  expect(needsShell('node.exe', 'win32')).toBe(false);
  expect(needsShell('npm', 'darwin')).toBe(false);
  expect(needsShell('npm', 'linux')).toBe(false);
});

test('shell arguments are quoted, because spawnSync stops doing it for us', async () => {
  const { quoteForShell } = await import('./standalone-runtime.mjs');

  // A user directory with a space is the ordinary case this protects.
  expect(quoteForShell(String.raw`C:\Users\Ada Lovelace\raynard`)).toBe(
    String.raw`"C:\Users\Ada Lovelace\raynard"`
  );
  expect(quoteForShell('--omit=dev')).toBe('--omit=dev');
  expect(quoteForShell('ci')).toBe('ci');

  // cmd.exe would otherwise read these as command separators.
  expect(quoteForShell('a&b')).toBe('"a&b"');
  expect(quoteForShell('a|b')).toBe('"a|b"');
});

test('the Linux AppImage build runs linuxdeploy without FUSE', async () => {
  const workflow = await readFile(
    join(scriptsDir, '../.github/workflows/release-macos-arm64.yml'),
    'utf8'
  );

  // The runner image has no FUSE, so linuxdeploy cannot mount itself and the
  // bundle step fails with a bare "failed to run linuxdeploy".
  expect(workflow).toContain('APPIMAGE_EXTRACT_AND_RUN: 1');
});

async function fakeKoffiTree(platforms) {
  const packageDir = await mkdtemp(join(tmpdir(), 'raynard-prebuilds-'));
  const prebuildRoot = join(packageDir, 'node_modules', 'koffi', 'build', 'koffi');
  for (const platform of platforms) {
    await mkdir(join(prebuildRoot, platform), { recursive: true });
    await writeFile(join(prebuildRoot, platform, 'koffi.node'), 'ELF');
  }
  return { packageDir, prebuildRoot };
}

test('staging keeps only the target platform prebuild, so linuxdeploy can resolve every ELF', async () => {
  const { pruneForeignNativePrebuilds } = await import('./standalone-runtime.mjs');
  const { packageDir, prebuildRoot } = await fakeKoffiTree([
    'linux_x64',
    'openbsd_x64',
    'freebsd_x64',
    'musl_x64',
    'win32_x64'
  ]);

  // openbsd_x64 needs libc++.so.9.0, which does not exist on the Linux runner.
  // linuxdeploy resolves dependencies for every ELF in the AppDir, so shipping
  // that file failed the whole AppImage build.
  const removed = await pruneForeignNativePrebuilds(
    { nativePrebuild: 'linux_x64' },
    packageDir
  );

  expect(removed.sort()).toEqual(['freebsd_x64', 'musl_x64', 'openbsd_x64', 'win32_x64']);
  expect(await readdir(prebuildRoot)).toEqual(['linux_x64']);
});

test('an unrecognised prebuild layout is left alone rather than emptied', async () => {
  const { pruneForeignNativePrebuilds } = await import('./standalone-runtime.mjs');
  const { packageDir, prebuildRoot } = await fakeKoffiTree(['openbsd_x64', 'freebsd_x64']);

  // The target's own copy is missing, so this is not the layout we expect.
  // Pruning here would leave a runtime that cannot load koffi at all.
  const removed = await pruneForeignNativePrebuilds(
    { nativePrebuild: 'linux_x64' },
    packageDir
  );

  expect(removed).toEqual([]);
  expect((await readdir(prebuildRoot)).sort()).toEqual(['freebsd_x64', 'openbsd_x64']);
});

test('every supported target names the native prebuild it keeps', async () => {
  const { NODE_RUNTIMES } = await import('./standalone-runtime.mjs');

  expect(Object.values(NODE_RUNTIMES).map((runtime) => runtime.nativePrebuild)).toEqual([
    'darwin_arm64',
    'linux_x64',
    'win32_x64'
  ]);
});
