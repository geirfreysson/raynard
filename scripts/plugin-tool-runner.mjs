import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

function readStdin() {
  return new Promise((resolve, reject) => {
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      body += chunk;
    });
    process.stdin.on('end', () => resolve(body));
    process.stdin.on('error', reject);
  });
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const raw = await readStdin();
const request = JSON.parse(raw || '{}');
const pluginDir = String(request.pluginDir || '').trim();
const toolName = String(request.toolName || '').trim();
const args = request.args && typeof request.args === 'object' && !Array.isArray(request.args) ? request.args : {};
const listTools = request.listTools === true;
const runnerDir = dirname(fileURLToPath(import.meta.url));
const pluginDataDir = join(dirname(pluginDir), '.plugin-data', basename(pluginDir));

if (!pluginDir) {
  emit({ ok: false, error: 'pluginDir is required.' });
  process.exit(1);
}
if (!toolName && !listTools) {
  emit({ ok: false, error: 'toolName is required.' });
  process.exit(1);
}

const tempDir = await mkdtemp(join(tmpdir(), 'raynard-plugin-tool-'));
const sourceEntry = 'tools.ts';
const modulePath = join(tempDir, 'tools.js');

async function preparePluginModuleDirectory(sourceDir, targetDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await preparePluginModuleDirectory(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) continue;

    const extension = extname(entry.name).toLowerCase();
    if (extension === '.ts') {
      if (/\.(?:test|spec)\.ts$/i.test(entry.name)) continue;
      const source = await readFile(sourcePath, 'utf8');
      const transpiled = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          esModuleInterop: true,
          skipLibCheck: true
        },
        fileName: sourcePath
      }).outputText;
      const javascriptPath = targetPath.slice(0, -3) + '.js';
      await writeFile(javascriptPath, transpiled, 'utf8');
      await writeFile(targetPath, transpiled, 'utf8');
      continue;
    }
    if (['.js', '.mjs', '.json'].includes(extension)) {
      await copyFile(sourcePath, targetPath);
    }
  }
}

async function installSharedSdk(targetDir) {
  const candidates = [
    join(dirname(pluginDir), 'node_modules', '@raynard', 'plugin-sdk'),
    join(runnerDir, 'plugin-sdk')
  ];
  const source = candidates.find((candidate) => existsSync(join(candidate, 'package.json')));
  if (!source) return;
  const target = join(targetDir, 'node_modules', '@raynard', 'plugin-sdk');
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

async function readCacheSettings() {
  try {
    const parsed = JSON.parse(await readFile(join(pluginDataDir, 'cache-settings.json'), 'utf8'));
    const ttlHours = Number(parsed.ttlHours);
    if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 8760) {
      throw new Error('Invalid cache duration.');
    }
    return { enabled: parsed.enabled !== false, ttlHours };
  } catch {
    return { enabled: true, ttlHours: 24 };
  }
}

try {
  await writeFile(join(tempDir, 'package.json'), '{"type":"module"}\n', 'utf8');
  await preparePluginModuleDirectory(pluginDir, tempDir);
  await installSharedSdk(tempDir);
  if (!existsSync(join(pluginDir, sourceEntry))) {
    throw new Error('Plugin must export its registry from tools.ts.');
  }
  const sdk = await import(pathToFileURL(join(tempDir, 'node_modules', '@raynard', 'plugin-sdk', 'index.js')).href);
  const cacheSettings = await readCacheSettings();
  sdk.configureApiCache({
    ...cacheSettings,
    directory: join(pluginDataDir, 'api-cache')
  });
  const loaded = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
  const plugin = loaded;
  const tools = sdk.assertToolRegistry(plugin.tools);
  if (listTools) {
    emit({
      ok: true,
      result: {
        tools: Object.entries(tools).map(([name, definition]) => ({
          name,
          description:
            definition && typeof definition.description === 'string' ? definition.description : '',
          parameters:
            definition && definition.parameters && typeof definition.parameters === 'object'
              ? definition.parameters
              : { type: 'object', properties: {} },
          card:
            definition && definition.card && typeof definition.card === 'object'
              ? definition.card
              : null,
          callable: Boolean(definition && typeof definition.execute === 'function')
        }))
      }
    });
  } else {
    const tool = tools[toolName];
    if (!tool || typeof tool.execute !== 'function') {
      emit({ ok: false, error: `Tool not found: ${toolName}` });
      process.exit(1);
    }

    const result = sdk.assertToolResult(await tool.execute(args));
    emit({ ok: true, result });
  }
} catch (error) {
  emit({ ok: false, error: error && error.message ? error.message : String(error) });
  process.exit(1);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
