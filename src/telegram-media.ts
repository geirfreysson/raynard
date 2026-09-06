import { chartSourceEntries, type ChartSource } from './chart-sources';
import { type ChartSpec } from './chart-spec';
import { renderChart, unmountChart } from './chart-mount';
import { chartRootToPngBlob } from './copy-export';
import type { TelegramDeliveryPart } from './telegram-channel';

const TELEGRAM_CHART_WIDTH = 720;
const TELEGRAM_PHOTO_LIMIT_BYTES = 10 * 1024 * 1024;
const CHART_RENDER_ATTEMPTS = 30;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

async function waitForChart(root: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < CHART_RENDER_ATTEMPTS; attempt += 1) {
    await nextFrame();
    const plot = root.querySelector<HTMLElement>('.recharts-wrapper');
    const svg = plot?.querySelector(':scope > svg.recharts-surface');
    if (plot && svg && plot.getBoundingClientRect().width > 0) return;
  }
  throw new Error('Chart did not finish rendering for Telegram.');
}

export async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function chartPhoto(
  spec: ChartSpec,
  sources: ChartSource[],
  index: number
): Promise<TelegramDeliveryPart | null> {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  Object.assign(host.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: `${TELEGRAM_CHART_WIDTH}px`,
    pointerEvents: 'none',
    opacity: '0'
  });
  document.body.appendChild(host);

  try {
    renderChart(host, spec);
    await waitForChart(host);
    const entries = chartSourceEntries(sources, spec.sources ?? []);
    const blob = await chartRootToPngBlob(host, spec, entries);
    if (!blob.size || blob.size > TELEGRAM_PHOTO_LIMIT_BYTES) return null;
    return {
      kind: 'photo',
      dataBase64: await blobBase64(blob),
      filename: `raynard-chart-${index + 1}.png`
    };
  } catch (error) {
    console.warn('Could not render a chart for Telegram:', error);
    return null;
  } finally {
    unmountChart(host);
    host.remove();
  }
}

/** Render charts after the text summary; a failed image never removes that text. */
export async function telegramChartParts(
  charts: ChartSpec[] = [],
  sources: ChartSource[] = []
): Promise<TelegramDeliveryPart[]> {
  const parts: TelegramDeliveryPart[] = [];
  for (const [index, spec] of charts.entries()) {
    const photo = await chartPhoto(spec, sources, index);
    if (photo) parts.push(photo);
  }
  return parts;
}
