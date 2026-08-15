/**
 * The hover copy affordance shared by rendered markdown tables and charts.
 *
 * A block is wrapped in a positioned container carrying one button that is
 * invisible until the block is hovered or the button is focused. The payload is
 * a factory rather than a value because an image is rasterized from the live
 * DOM at copy time, and blocks nobody copies should cost nothing.
 */

import { createElement as createLucideElement, Copy } from 'lucide';
import { writeClipboard, type CopyPayload } from './clipboard';

const REVERT_MS = 1400;

type PayloadFactory = () => CopyPayload | Promise<CopyPayload>;

/**
 * Wraps `node` in `.copyable` and returns the wrapper to append in its place.
 * `label` is the resting button text, e.g. `Copy table`.
 */
export function wrapCopyable(node: HTMLElement, label: string, payload: PayloadFactory): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'copyable';
  wrapper.appendChild(node);
  wrapper.appendChild(createCopyButton(label, payload));
  return wrapper;
}

function createCopyButton(label: string, payload: PayloadFactory): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copyable-copy';

  const icon = createLucideElement(Copy, { 'aria-hidden': 'true', width: '14', height: '14' });
  button.appendChild(icon);

  // The visible label is also the button's accessible name, so the swap to
  // "Copied" is what a screen reader reports too.
  const text = document.createElement('span');
  text.className = 'copyable-copy-label';
  text.textContent = label;
  button.appendChild(text);

  let revertTimer: ReturnType<typeof setTimeout> | undefined;
  let copying = false;

  button.addEventListener('click', async () => {
    if (copying) return;
    copying = true;
    clearTimeout(revertTimer);

    let copied = false;
    try {
      copied = await writeClipboard(await payload());
    } catch {
      copied = false;
    }

    setState(button, text, copied ? 'Copied' : 'Copy failed', copied ? 'done' : 'err');
    revertTimer = setTimeout(() => setState(button, text, label, null), REVERT_MS);
    copying = false;
  });

  return button;
}

function setState(
  button: HTMLButtonElement,
  text: HTMLElement,
  label: string,
  state: 'done' | 'err' | null
) {
  text.textContent = label;
  button.classList.toggle('done', state === 'done');
  button.classList.toggle('err', state === 'err');
}
