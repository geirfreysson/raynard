import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { verifyStandaloneBundle } from './verify-standalone-bundle.mjs';

export function verifyStandaloneMacApp(appPath) {
  return verifyStandaloneBundle('macos', appPath);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const appPath = process.argv[2];
  if (!appPath) {
    process.stderr.write('Usage: node scripts/verify-standalone-macos.mjs /path/to/Raynard.app\n');
    process.exitCode = 2;
  } else {
    verifyStandaloneMacApp(appPath)
      .then((result) => {
        process.stdout.write(
          `Standalone macOS bundle verified (${result.nodeVersion}): ${result.bundlePath}\n`
        );
      })
      .catch((error) => {
        process.stderr.write(`${error?.stack || error}\n`);
        process.exitCode = 1;
      });
  }
}
