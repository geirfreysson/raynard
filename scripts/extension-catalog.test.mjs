import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionsDir = join(root, 'extensions');
const runnerPath = join(root, 'scripts', 'plugin-tool-runner.mjs');
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const allowedFilePattern = /(?:\.ts|\.js|\.mjs|\.json|\.md)$/;
const forbiddenNames = new Set([
  '.runtime-tools.json',
  '.plugin-data',
  '.git',
  '.DS_Store',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'target',
  'package-lock.json'
]);

function authoredFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const metadata = lstatSync(path);
      expect(metadata.isSymbolicLink(), `catalog extensions cannot contain symlinks: ${path}`).toBe(false);
      expect(forbiddenNames.has(name) || name === '.env' || name.startsWith('.env.'), `machine-local file is forbidden: ${path}`).toBe(false);
      if (metadata.isDirectory()) {
        expect(name.startsWith('.'), `hidden catalog directory is forbidden: ${path}`).toBe(false);
        visit(path);
      } else {
        const local = relative(directory, path);
        expect(metadata.isFile(), `unsupported catalog entry: ${path}`).toBe(true);
        expect(name.startsWith('.'), `hidden catalog file is forbidden: ${path}`).toBe(false);
        expect(local === 'plugin.json' || local === 'README.md' || allowedFilePattern.test(local), `unsupported catalog file: ${path}`).toBe(true);
        files.push(path);
      }
    }
  };
  visit(directory);
  return files;
}

function catalogDirectories() {
  expect(existsSync(extensionsDir), 'extensions/ must exist').toBe(true);
  return readdirSync(extensionsDir)
    .map((name) => join(extensionsDir, name))
    .filter((path) => statSync(path).isDirectory() && existsSync(join(path, 'plugin.json')));
}

describe('bundled extension catalog', () => {
  it('contains at least one static, valid extension manifest', () => {
    const directories = catalogDirectories();
    expect(directories.length).toBeGreaterThan(0);

    for (const directory of directories) {
      const slug = directory.split('/').at(-1);
      expect(slug).toMatch(slugPattern);
      expect(existsSync(join(directory, 'tools.ts'))).toBe(true);
      expect(existsSync(join(directory, 'README.md'))).toBe(true);
      authoredFiles(directory);

      const manifest = JSON.parse(readFileSync(join(directory, 'plugin.json'), 'utf8'));
      expect(manifest).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          name: expect.any(String),
          description: expect.any(String),
          category: expect.any(String),
          status: 'bundled',
          tags: expect.any(Array),
          icon: expect.any(String),
          author: expect.any(String),
          homepage: expect.stringMatching(/^https:\/\//),
          version: expect.any(String),
          sdkVersion: 1,
          samplePrompts: expect.any(Array),
          contributes: expect.objectContaining({ tools: expect.any(Array) })
        })
      );
      expect(manifest.id.trim()).not.toBe('');
      expect(manifest.id).toBe(`raynard.catalog.${slug}`);
      expect(manifest.name.trim()).not.toBe('');
      expect(manifest.description.trim()).not.toBe('');
      expect(manifest.category.trim()).not.toBe('');
      expect(manifest.tags.length).toBeGreaterThan(0);
      expect(manifest.icon.trim()).not.toBe('');
      expect(manifest.author.trim()).not.toBe('');
      expect(manifest.samplePrompts).toHaveLength(3);
      expect(manifest.contributes.tools.length).toBeGreaterThan(0);
      for (const tool of manifest.contributes.tools) {
        expect(tool).toEqual({
          name: expect.any(String),
          description: expect.any(String),
          hasCard: true
        });
      }
    }
  });

  it('passes mocked tests and runtime discovery for every bundled extension', () => {
    for (const directory of catalogDirectories()) {
      const tests = authoredFiles(directory).filter((path) =>
        /\.(?:test|spec)\.(?:ts|js|mjs)$/i.test(path)
      );
      expect(tests.length, `${directory} needs a mocked executable test`).toBeGreaterThan(0);

      const testRun = spawnSync(process.execPath, ['--test', ...tests], {
        cwd: root,
        encoding: 'utf8'
      });
      expect(testRun.status, testRun.stderr || testRun.stdout).toBe(0);

      const discovery = spawnSync(process.execPath, [runnerPath], {
        cwd: root,
        input: JSON.stringify({ pluginDir: directory, listTools: true }),
        encoding: 'utf8'
      });
      const output = JSON.parse(discovery.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}');
      expect(discovery.status, discovery.stderr || discovery.stdout).toBe(0);
      expect(output.ok).toBe(true);
      expect(output.result.tools.length).toBeGreaterThan(0);
      expect(output.result.tools.every((tool) => tool.callable && tool.card)).toBe(true);
    }
  }, 30_000);
});
