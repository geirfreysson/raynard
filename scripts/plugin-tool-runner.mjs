import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

if (!pluginDir) {
  emit({ ok: false, error: 'pluginDir is required.' });
  process.exit(1);
}
if (!toolName && !listTools) {
  emit({ ok: false, error: 'toolName is required.' });
  process.exit(1);
}

const tempDir = await mkdtemp(join(tmpdir(), 'raynard-plugin-tool-'));
const modulePath = join(tempDir, 'index.js');

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

try {
  await writeFile(join(tempDir, 'package.json'), '{"type":"module"}\n', 'utf8');
  await preparePluginModuleDirectory(pluginDir, tempDir);
  const loaded = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
  const plugin = loaded.default || loaded;
  if (listTools) {
    const tools = plugin?.tools && typeof plugin.tools === 'object' ? plugin.tools : {};
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
    const tool = plugin?.tools?.[toolName];
    if (!tool || typeof tool.execute !== 'function') {
      emit({ ok: false, error: `Tool not found: ${toolName}` });
      process.exit(1);
    }

    const result = await tool.execute(args);
    emit({ ok: true, result });
  }
} catch (error) {
  emit({ ok: false, error: error && error.message ? error.message : String(error) });
  process.exit(1);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
