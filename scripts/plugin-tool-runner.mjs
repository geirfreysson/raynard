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
// Host-resolved secrets for this plugin. They stay in memory: they are never
// written into the temp module directory and never reach the listTools path,
// whose output the host caches on disk.
const credentials =
  request.credentials && typeof request.credentials === 'object' && !Array.isArray(request.credentials)
    ? request.credentials
    : {};
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
    // The SDK shipped beside this runner is its compatible runtime pair. The
    // app-local SDK can lag behind while a development app process is still
    // running, so use it only as a fallback.
    join(runnerDir, 'plugin-sdk'),
    join(dirname(pluginDir), 'node_modules', '@raynard', 'plugin-sdk')
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

// Hoisted so the catch below can redact secrets out of a failure message.
let sdk = null;

try {
  await writeFile(join(tempDir, 'package.json'), '{"type":"module"}\n', 'utf8');
  await preparePluginModuleDirectory(pluginDir, tempDir);
  await installSharedSdk(tempDir);
  if (!existsSync(join(pluginDir, sourceEntry))) {
    throw new Error('Plugin must export its registry from tools.ts.');
  }
  sdk = await import(pathToFileURL(join(tempDir, 'node_modules', '@raynard', 'plugin-sdk', 'index.js')).href);
  const cacheSettings = await readCacheSettings();
  sdk.configureApiCache({
    ...cacheSettings,
    directory: join(pluginDataDir, 'api-cache')
  });
  // Tool discovery must stay credential-free: its result is cached to
  // .runtime-tools.json, and the plugin builder runs it while writing code.
  if (!listTools) sdk.configureCredentials(credentials);
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

    if (typeof sdk.beginApiCacheTrace === 'function') sdk.beginApiCacheTrace();
    const result = sdk.assertToolResult(await tool.execute(args));
    const cacheTrace =
      typeof sdk.readApiCacheTrace === 'function' ? sdk.readApiCacheTrace() : { hits: 0 };
    // This namespace is host-owned: discard anything a plugin supplied and
    // add it only when the shared API client observed a real cache hit.
    const { _raynard: _pluginMetadata, ...safeResult } = result;
    if (cacheTrace.hits > 0) safeResult._raynard = { cacheHit: true };
    emit({ ok: true, result: safeResult });
  }
} catch (error) {
  const rawMessage = error && error.message ? error.message : String(error);
  const message = sdk && typeof sdk.redactSecrets === 'function' ? sdk.redactSecrets(rawMessage) : rawMessage;
  const failure = { ok: false, error: message };
  // A credential the host has not stored is a request for input, not a bug.
  // The structured form lets the app prompt for the key by name.
  if (error && error.name === 'MissingCredentialError') {
    failure.credentialRequest = {
      key: String(error.credentialKey || ''),
      label: String(error.credentialLabel || error.credentialKey || '')
    };
  }
  emit(failure);
  process.exit(1);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
