import { readFile } from 'node:fs/promises';
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

test('the standalone runtime packager pins and verifies the Apple Silicon Node archive', async () => {
  const packager = await import('./standalone-runtime.mjs');

  expect(packager.NODE_RUNTIME.version).toBe('22.21.1');
  expect(packager.NODE_RUNTIME.target).toBe('aarch64-apple-darwin');
  expect(packager.NODE_RUNTIME.sha256).toBe(
    'c170d6554fba83d41d25a76cdbad85487c077e51fa73519e41ac885aa429d8af'
  );
  expect(packager.NODE_RUNTIME.binarySha256).toBe(
    '8179f1d4a920be531d81edef7a26df5cc5c9cb11c8b5a28fb336aa030fbfe3df'
  );
  expect(packager.NODE_RUNTIME.archive).toBe('node-v22.21.1-darwin-arm64.tar.gz');
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
