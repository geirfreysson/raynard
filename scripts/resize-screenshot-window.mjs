import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCREENSHOT_SIZE_PRESETS = Object.freeze({
  showcase: Object.freeze({ width: 960, height: 600, ratio: '16:10' }),
  hero: Object.freeze({ width: 960, height: 540, ratio: '16:9' })
});

const USAGE = `Usage:
  npm run screenshot:size -- <showcase|hero|WIDTHxHEIGHT> [--process <name>]

Examples:
  npm run screenshot:size -- showcase
  npm run screenshot:size -- hero
  npm run screenshot:size -- 1200x750

Raynard must already be running. macOS may ask for permission to let your
terminal control System Events.`;

const APPLE_SCRIPT = `on run argv
  set processName to item 1 of argv
  set targetWidth to item 2 of argv as integer
  set targetHeight to item 3 of argv as integer

  tell application "System Events"
    if not (exists process processName) then
      error "No running process named " & processName & "."
    end if

    tell process processName
      if not (exists front window) then
        error processName & " has no open window."
      end if
      set size of front window to {targetWidth, targetHeight}
    end tell
  end tell
end run`;

function positiveDimension(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function parseScreenshotSizeArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };

  let processName = 'Raynard';
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--process') {
      const candidate = args[index + 1]?.trim();
      if (!candidate) throw new Error('--process needs an application process name.');
      processName = candidate;
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`);
    positional.push(argument);
  }

  if (positional.length !== 1) throw new Error('Choose one size preset or WIDTHxHEIGHT.');
  const requested = positional[0].toLowerCase();
  const preset = SCREENSHOT_SIZE_PRESETS[requested];
  if (preset) return { processName, preset: requested, ...preset };

  const custom = requested.match(/^(\d+)x(\d+)$/);
  if (!custom) throw new Error(`Unknown screenshot size: ${positional[0]}`);
  return {
    processName,
    preset: 'custom',
    width: positiveDimension(custom[1], 'Width'),
    height: positiveDimension(custom[2], 'Height'),
    ratio: null
  };
}

export function resizeScreenshotWindow(options, run = spawnSync) {
  if (process.platform !== 'darwin') {
    throw new Error('Screenshot window resizing is currently supported on macOS only.');
  }

  const result = run(
    'osascript',
    ['-', options.processName, String(options.width), String(options.height)],
    { input: APPLE_SCRIPT, encoding: 'utf8' }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || `osascript exited with status ${result.status}`;
    const permissionHint = /assistive|authorized|not allowed|-1743|-10004/i.test(detail)
      ? ' Allow your terminal under System Settings > Privacy & Security > Accessibility, then retry.'
      : '';
    throw new Error(`${detail}${permissionHint}`);
  }
}

const isCommandLine =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCommandLine) {
  try {
    const options = parseScreenshotSizeArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
    } else {
      resizeScreenshotWindow(options);
      const purpose = options.ratio ? ` (${options.ratio} ${options.preset})` : '';
      console.log(
        `Resized ${options.processName}'s front window to ${options.width} x ${options.height}${purpose}.`
      );
      console.log('Capture it without a shadow with: screencapture -o -W');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${USAGE}`);
    process.exitCode = 1;
  }
}
