import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

test('the Linux installer is rootless and verifies the stable AppImage', async () => {
  const installer = await readFile(join(scriptsDir, '../docs/static/install.sh'), 'utf8');

  expect(installer).toContain('Raynard-linux-x86_64.AppImage');
  expect(installer).toContain('checksum_name="${asset_name}.sha256"');
  expect(installer).toMatch(/sha256sum|shasum/);
  expect(installer).toContain('$HOME/.local/bin');
  expect(installer).toContain('raynard.desktop');
  expect(installer).toContain('MimeType=x-scheme-handler/raynard;');
  expect(installer).not.toMatch(/\bsudo\b/);
});

test('the Windows installer is per-user, checksum verified, and creates a launcher', async () => {
  const installer = await readFile(join(scriptsDir, '../docs/static/install.ps1'), 'utf8');

  expect(installer).toContain('Raynard-windows-x64-setup.exe');
  expect(installer).toContain('Get-FileHash -Algorithm SHA256');
  expect(installer).toContain("'Programs\\Raynard'");
  expect(installer).toContain('raynard.cmd');
  expect(installer).toContain("SetEnvironmentVariable('Path'");
  expect(installer).toContain('Start-Process -FilePath $executablePath');
});
