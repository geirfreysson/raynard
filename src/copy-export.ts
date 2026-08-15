/**
 * Turns a rendered table or chart into the flavors the copy button puts on the
 * clipboard: markdown text, and a PNG that can be pasted into image-only
 * composers such as x.com.
 *
 * The PNGs are drawn with the canvas 2D API from measurements taken off the
 * live DOM, not by rendering HTML to an image: the usual
 * `<foreignObject>`-in-an-SVG-data-URL trick is unreliable in WebKit when the
 * SVG is loaded as an image, and this app ships inside a WKWebView. Drawing
 * from `getBoundingClientRect()` and `getComputedStyle()` also means the image
 * follows the app's CSS instead of a second hardcoded copy of it.
 *
 * The markdown renderer caps tables at 40 rows and 8 columns and charts at 8
 * series, so every loop here is bounded.
 */

import foxLogoMarkup from './assets/northfox-fox-logo.svg?raw';
import { formatFullNumber } from './chart-format';
import type { ChartSpec } from './chart-spec';

/** Pixel density of exported images, relative to CSS pixels. */
const SCALE = 2;
/** Breathing room around a chart image, in CSS pixels. */
const CHART_PADDING = 16;
/** Gap under the chart title, in CSS pixels. */
const CHART_TITLE_GAP = 12;
/** Side of the square color swatch drawn for each legend entry. */
const LEGEND_SWATCH = 10;
/** Height of the brand mark on an exported image, in CSS pixels. */
const BRAND_HEIGHT = 10;
/** Space between the content and the footer below it. */
const BRAND_GAP = 6;
/** Room under the wordmark's baseline for its descender. */
const BRAND_DESCENDER = 3;
/** Width-to-height of the fox mark, from its viewBox. Fixed, so the footer can
    be measured before the logo is loaded. */
const FOX_ASPECT = 198 / 180;
/** Leading between stacked source lines. */
const SOURCE_LINE_GAP = 4;
/** Source lines before the rest collapse into a count. */
const MAX_SOURCE_LINES = 3;
/** Between two named sources on the same line. */
const SOURCE_SEPARATOR = ' · ';

/** The chart's rows as a markdown table, for pasting into a text target. */
export function chartSpecToMarkdown(spec: ChartSpec): string {
  const columns = [spec.x, ...spec.series.map((series) => series.key)];
  const headers = [spec.xLabel ?? spec.x, ...spec.series.map((series) => series.label)];
  const lines = [row(headers), row(headers.map(() => '---'))];

  for (const entry of spec.rows) {
    lines.push(row(columns.map((column) => formatFullNumber(entry[column]))));
  }

  return lines.join('\n');
}

function row(cells: string[]): string {
  return `| ${cells.map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`;
}

/** Rasterizes a rendered markdown table exactly as the user sees it. */
export async function tableToPngBlob(
  table: HTMLTableElement,
  sourceEntries: string[] = []
): Promise<Blob> {
  const bounds = table.getBoundingClientRect();
  const footer = planFooter(sourceEntries, bounds.width - BRAND_GAP * 2);
  // The table is drawn flush to the edges; only the footer adds height.
  const height = bounds.height + BRAND_GAP + footer.height;
  const { canvas, context } = createExportCanvas(bounds.width, height);

  for (const cell of Array.from(table.querySelectorAll<HTMLTableCellElement>('th, td'))) {
    drawTableCell(context, cell, bounds);
  }

  // Inset from the edges: a table is drawn edge to edge, and the footer would
  // otherwise sit hard against the border.
  const baseline = height - BRAND_DESCENDER;
  await drawBrandMark(context, bounds.width - BRAND_GAP, baseline);
  drawSourceLines(context, footer.lines, BRAND_GAP, baseline);

  return canvasToPngBlob(canvas);
}

function drawTableCell(
  context: CanvasRenderingContext2D,
  cell: HTMLTableCellElement,
  bounds: DOMRect
) {
  const rect = cell.getBoundingClientRect();
  const x = rect.left - bounds.left;
  const y = rect.top - bounds.top;
  if (!rect.width || !rect.height) return;

  const style = getComputedStyle(cell);
  if (isVisibleColor(style.backgroundColor)) {
    context.fillStyle = style.backgroundColor;
    context.fillRect(x, y, rect.width, rect.height);
  }

  const borderWidth = parseFloat(style.borderTopWidth) || 0;
  if (borderWidth > 0 && isVisibleColor(style.borderTopColor)) {
    context.strokeStyle = style.borderTopColor;
    context.lineWidth = borderWidth;
    // Half-pixel offset so a 1px border lands on the pixel rather than across
    // two of them.
    const inset = borderWidth / 2;
    context.strokeRect(x + inset, y + inset, rect.width - borderWidth, rect.height - borderWidth);
  }

  // Cells hold flattened inline markdown. A cell that is entirely one bold or
  // italic run keeps that emphasis; mixed runs fall back to the cell's own font.
  const emphasis = cell.firstElementChild;
  const wholeCell = cell.childElementCount === 1 && cell.textContent === emphasis?.textContent;
  const textStyle = wholeCell ? getComputedStyle(emphasis as Element) : style;

  const padLeft = parseFloat(style.paddingLeft) || 0;
  const padRight = parseFloat(style.paddingRight) || 0;
  const padTop = parseFloat(style.paddingTop) || 0;
  const width = rect.width - padLeft - padRight;
  if (width <= 0) return;

  context.save();
  context.beginPath();
  context.rect(x, y, rect.width, rect.height);
  context.clip();
  context.fillStyle = textStyle.color || '#000000';
  context.font = fontShorthand(textStyle);
  context.textBaseline = 'top';

  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  const align = style.textAlign === 'right' || style.textAlign === 'center' ? style.textAlign : 'left';
  const lines = wrapText(context, cell.textContent ?? '', width);

  lines.forEach((line, index) => {
    const lineWidth = context.measureText(line).width;
    const offset =
      align === 'right' ? width - lineWidth : align === 'center' ? (width - lineWidth) / 2 : 0;
    context.fillText(line, x + padLeft + offset, y + padTop + index * lineHeight);
  });
  context.restore();
}

/**
 * Rasterizes a chart card: its title and legend are HTML around the plot, so
 * only the plot itself comes from the SVG and the rest is drawn by hand.
 */
export async function chartRootToPngBlob(
  chartRoot: HTMLElement,
  spec: ChartSpec,
  sourceEntries: string[] = []
): Promise<Blob> {
  const plot = chartRoot.querySelector('.recharts-wrapper');
  // Scoped to a direct child: every legend entry has a `recharts-surface` of
  // its own for its icon, and one of those is what a loose query finds first.
  const svg = plot?.querySelector(':scope > svg.recharts-surface');
  if (!svg || !plot) throw new Error('Chart is not rendered yet');

  const plotBounds = plot.getBoundingClientRect();
  const titleElement = chartRoot.querySelector<HTMLElement>('[data-chart-title]');
  const titleStyle = titleElement ? getComputedStyle(titleElement) : null;
  const titleHeight = titleStyle
    ? (parseFloat(titleStyle.lineHeight) || parseFloat(titleStyle.fontSize) * 1.3) + CHART_TITLE_GAP
    : 0;

  const width = plotBounds.width + CHART_PADDING * 2;
  const footer = planFooter(sourceEntries, plotBounds.width);
  const height =
    plotBounds.height + titleHeight + CHART_PADDING * 2 + BRAND_GAP + footer.height;
  const { canvas, context } = createExportCanvas(width, height);

  if (titleElement && titleStyle) {
    context.fillStyle = titleStyle.color || '#000000';
    context.font = fontShorthand(titleStyle);
    context.textBaseline = 'top';
    context.fillText(titleElement.textContent ?? '', CHART_PADDING, CHART_PADDING);
  }

  const top = CHART_PADDING + titleHeight;
  const image = await svgToImage(svg as SVGElement, plotBounds.width, plotBounds.height);
  context.drawImage(image, CHART_PADDING, top, plotBounds.width, plotBounds.height);

  drawLegend(context, chartRoot, plotBounds, CHART_PADDING, top);

  // The citations share the brand mark's baseline, from the opposite corner.
  const baseline = height - CHART_PADDING;
  await drawBrandMark(context, width - CHART_PADDING, baseline);
  drawSourceLines(context, footer.lines, CHART_PADDING, baseline);

  return canvasToPngBlob(canvas);
}

/**
 * Packs named sources into the lines that fit above the image's bottom edge.
 *
 * Every line is measured against the width left over beside the brand mark, so
 * the last one — the one sharing that row — can never run into it.
 */
export function planSourceLines(
  context: Pick<CanvasRenderingContext2D, 'measureText'>,
  entries: string[],
  maxWidth: number,
  maxLines = MAX_SOURCE_LINES
): string[] {
  const named = entries.filter(Boolean);
  if (!named.length || maxWidth <= 0) return [];

  const prefix = named.length === 1 ? 'Source: ' : 'Sources: ';
  const prefixWidth = context.measureText(prefix).width;
  const lines: string[] = [];
  let current = '';
  let placed = 0;
  let index = 0;

  while (index < named.length) {
    const onFirstLine = lines.length === 0;
    const room = maxWidth - (onFirstLine ? prefixWidth : 0);
    const candidate = current ? `${current}${SOURCE_SEPARATOR}${named[index]}` : named[index];

    if (context.measureText(candidate).width <= room) {
      current = candidate;
      index += 1;
      placed += 1;
    } else if (!current) {
      // Nothing on this line yet, so the name itself is too long: cut it rather
      // than emitting a line that is only the "Sources:" label.
      current = truncateToWidth(context, named[index], room);
      index += 1;
      placed += 1;
    } else if (lines.length + 1 >= maxLines) {
      break;
    } else {
      lines.push((onFirstLine ? prefix : '') + current);
      current = '';
    }
  }
  if (current) lines.push((lines.length === 0 ? prefix : '') + current);

  const dropped = named.length - placed;
  if (dropped > 0) {
    const suffix = `${SOURCE_SEPARATOR}+${dropped} more`;
    const last = lines.length - 1;
    lines[last] =
      truncateToWidth(context, lines[last], maxWidth - context.measureText(suffix).width) + suffix;
  }

  return lines;
}

/** Says where the numbers came from, bottom-left, beside the brand mark. */
function drawSourceLines(
  context: CanvasRenderingContext2D,
  lines: string[],
  left: number,
  bottom: number
) {
  if (!lines.length) return;

  context.save();
  context.font = sourceFont();
  context.fillStyle = mutedColor();
  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';
  // Stacked upward from the brand mark's baseline, so the block stays anchored
  // to the bottom edge however many lines it has.
  lines.forEach((line, index) => {
    const offset = (lines.length - 1 - index) * (BRAND_HEIGHT + SOURCE_LINE_GAP);
    context.fillText(line, left, bottom - offset);
  });
  context.restore();
}

function sourceFont(): string {
  const family =
    getComputedStyle(document.documentElement).getPropertyValue('--font-family-sans') ||
    'sans-serif';
  return `400 ${BRAND_HEIGHT}px ${family}`;
}

function brandFont(): string {
  const family =
    getComputedStyle(document.documentElement).getPropertyValue('--font-family-sans') ||
    'sans-serif';
  return `700 ${BRAND_HEIGHT}px ${family}`;
}

function mutedColor(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#5e5e5e'
  );
}

/**
 * Lays out the footer both images share: named sources on the left, brand mark
 * on the right. Measured before the canvas exists, since it decides the height.
 */
function planFooter(entries: string[], contentWidth: number) {
  const scratch = document.createElement('canvas').getContext('2d');
  if (!scratch) return { lines: [] as string[], height: BRAND_HEIGHT + BRAND_DESCENDER, brand: 0 };

  scratch.font = brandFont();
  const brand = scratch.measureText('raynard').width + 4 + BRAND_HEIGHT * FOX_ASPECT;

  scratch.font = sourceFont();
  const lines = planSourceLines(scratch, entries, contentWidth - brand - BRAND_GAP * 2);

  const stacked = Math.max(1, lines.length);
  return {
    lines,
    brand,
    height: stacked * BRAND_HEIGHT + (stacked - 1) * SOURCE_LINE_GAP + BRAND_DESCENDER
  };
}

/** Trims text to fit a width, ending in an ellipsis rather than being condensed. */
export function truncateToWidth(
  context: Pick<CanvasRenderingContext2D, 'measureText'>,
  text: string,
  maxWidth: number
): string {
  if (context.measureText(text).width <= maxWidth) return text;

  let trimmed = text;
  while (trimmed.length > 1 && context.measureText(`${trimmed}…`).width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed.trimEnd()}…`;
}

/**
 * Signs an exported image with the fox and the wordmark, bottom-right. A pasted
 * image travels without the app around it, so it carries its source. Never
 * fails the copy: an unsigned image beats no image.
 */
async function drawBrandMark(context: CanvasRenderingContext2D, right: number, bottom: number) {
  context.save();
  try {
    context.font = brandFont();
    context.fillStyle = mutedColor();
    context.textBaseline = 'alphabetic';
    context.textAlign = 'right';
    context.fillText('raynard', right, bottom);

    const labelWidth = context.measureText('raynard').width;
    const foxWidth = BRAND_HEIGHT * FOX_ASPECT;
    const fox = await loadSvgImage(foxLogoMarkup);
    context.drawImage(
      fox,
      right - labelWidth - 4 - foxWidth,
      bottom - BRAND_HEIGHT,
      foxWidth,
      BRAND_HEIGHT
    );
  } catch {
    // Leave the image unsigned.
  } finally {
    context.restore();
  }
}

/**
 * Recharts renders the legend as HTML positioned over the plot, so the SVG
 * leaves an empty band where it belongs. Redraw it there from the live nodes.
 */
function drawLegend(
  context: CanvasRenderingContext2D,
  chartRoot: HTMLElement,
  plotBounds: DOMRect,
  originX: number,
  originY: number
) {
  const items = Array.from(chartRoot.querySelectorAll<HTMLElement>('.recharts-legend-item'));

  for (const item of items) {
    const rect = item.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;

    const x = originX + rect.left - plotBounds.left;
    const middle = originY + rect.top - plotBounds.top + rect.height / 2;
    const icon = item.querySelector('.recharts-legend-icon') ?? item.querySelector('path, line');
    // The innermost span is the one the legend formatter styles, so it carries
    // the muted color a de-emphasized series is drawn with.
    const spans = item.querySelectorAll<HTMLElement>('span');
    const label = spans[spans.length - 1] ?? item;
    const labelStyle = getComputedStyle(label);

    if (icon) {
      const iconStyle = getComputedStyle(icon);
      const swatch = isVisibleColor(iconStyle.stroke) ? iconStyle.stroke : iconStyle.fill;
      if (isVisibleColor(swatch)) {
        context.fillStyle = swatch;
        context.fillRect(x, middle - LEGEND_SWATCH / 2, LEGEND_SWATCH, LEGEND_SWATCH);
      }
    }

    context.fillStyle = labelStyle.color || '#000000';
    context.font = fontShorthand(labelStyle);
    context.textBaseline = 'middle';
    context.globalAlpha = Number(labelStyle.opacity) || 1;
    context.fillText(label.textContent ?? '', x + LEGEND_SWATCH + 6, middle);
    context.globalAlpha = 1;
  }
}

/**
 * Clones an SVG with its computed paint and type inlined. Recharts paints with
 * `hsl(var(--chart-N))`, and a serialized SVG loaded as an image has no
 * stylesheet to resolve those variables against.
 */
export function inlineComputedSvgStyles(svg: SVGElement): SVGElement {
  const clone = svg.cloneNode(true) as SVGElement;
  const originals = [svg, ...Array.from(svg.querySelectorAll('*'))];
  const clones = [clone, ...Array.from(clone.querySelectorAll('*'))];
  const properties = [
    'fill',
    'fill-opacity',
    'stroke',
    'stroke-width',
    'stroke-opacity',
    'stroke-dasharray',
    'stroke-linecap',
    'opacity',
    'font-family',
    'font-size',
    'font-weight',
    'text-anchor'
  ];

  originals.forEach((original, index) => {
    const target = clones[index] as SVGElement | undefined;
    if (!target) return;
    const style = getComputedStyle(original);
    for (const property of properties) {
      const value = style.getPropertyValue(property);
      if (value) target.style.setProperty(property, value);
    }
  });

  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return clone;
}

function svgToImage(svg: SVGElement, width: number, height: number): Promise<HTMLImageElement> {
  const clone = inlineComputedSvgStyles(svg);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  return loadSvgImage(new XMLSerializer().serializeToString(clone));
}

function loadSvgImage(markup: string): Promise<HTMLImageElement> {
  // A data URL rather than a blob URL: WebKit taints a canvas drawn from a
  // blob-backed SVG, which makes toBlob() throw.
  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not rasterize an SVG'));
    image.src = source;
  });
}

function createExportCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * SCALE));
  canvas.height = Math.max(1, Math.round(height * SCALE));

  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable');

  context.scale(SCALE, SCALE);
  // Pasted images land on unknown backgrounds, so the transparent default would
  // read as black in a dark composer.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);

  return { canvas, context };
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode the image'));
    }, 'image/png');
  });
}

function fontShorthand(style: CSSStyleDeclaration): string {
  const size = style.fontSize || '13px';
  const family = style.fontFamily || 'sans-serif';
  return `${style.fontStyle || 'normal'} ${style.fontWeight || '400'} ${size} ${family}`;
}

function isVisibleColor(color: string): boolean {
  // `none` matters for legend icons: a bar's icon is filled with no stroke, a
  // line's is stroked with no fill, and assigning "none" to fillStyle is
  // silently ignored — which would paint the swatch in whatever color the
  // context last held.
  return (
    Boolean(color) &&
    color !== 'none' &&
    color !== 'transparent' &&
    !/rgba\(0,\s*0,\s*0,\s*0\)/.test(color)
  );
}

/** Greedy word wrap, matching how a cell wraps in the DOM closely enough. */
export function wrapText(
  context: Pick<CanvasRenderingContext2D, 'measureText'>,
  text: string,
  width: number
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const lines: string[] = [];
  let line = words[0];

  for (const word of words.slice(1)) {
    const candidate = `${line} ${word}`;
    if (context.measureText(candidate).width <= width) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);

  return lines;
}
