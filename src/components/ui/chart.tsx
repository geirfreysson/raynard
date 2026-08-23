import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import type { ChartSpec } from '../../chart-spec';
import {
  createAxisFormatter,
  formatFullNumber,
  resolveHighlight,
  xTickLayout,
  type HighlightResolution
} from '../../chart-format';
import { Card, CardContent, CardHeader, CardTitle } from './card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';

// Renders a ```chart fence the main agent emitted in place of a markdown table.
// The spec is already validated by parseChartSpec, so this component only draws.

const CHART_HEIGHT = 260;
const SERIES_COLOR_COUNT = 5;
// A transcript re-renders its markdown on every chat switch and reload, so an
// entry animation would replay each time. Static also keeps rendering
// deterministic.
const ANIMATE = false;

function seriesColor(index: number): string {
  return `hsl(var(--chart-${(index % SERIES_COLOR_COUNT) + 1}))`;
}

// When a highlight is active, everything it does not name recedes to grey so the
// subject of the answer is the only thing carrying color.
const MUTED_COLOR = 'hsl(var(--muted-foreground))';
const MUTED_OPACITY = 0.45;
const LINE_STROKE_WIDTH = 2;
const HIGHLIGHTED_LINE_STROKE_WIDTH = 4;
const SECONDARY_LINE_OPACITY = 0.65;
const LINE_DOT_RADIUS = 3;

/**
 * Paint for one series: full palette color, or muted when a highlight excludes
 * it. A category-only highlight leaves every series lit — the per-row Cells do
 * the dimming there, so dimming here too would grey out the whole chart.
 */
function seriesPaint(index: number, key: string, highlight: HighlightResolution) {
  const dimmed = highlight.series.size > 0 && !highlight.series.has(key);
  return {
    color: dimmed ? MUTED_COLOR : seriesColor(index),
    opacity: dimmed ? MUTED_OPACITY : 1,
    dimmed
  };
}

/**
 * A line highlight uses weight instead of removing the other series' colors.
 * Secondary lines recede slightly but retain the palette needed to distinguish
 * them from one another.
 */
function lineSeriesPaint(index: number, key: string, highlight: HighlightResolution) {
  const hasSeriesHighlight = highlight.series.size > 0;
  const highlighted = hasSeriesHighlight && highlight.series.has(key);
  return {
    color: seriesColor(index),
    opacity: hasSeriesHighlight && !highlighted ? SECONDARY_LINE_OPACITY : 1,
    width: highlighted ? HIGHLIGHTED_LINE_STROKE_WIDTH : LINE_STROKE_WIDTH
  };
}

/**
 * The series key behind a legend entry. Recharts types the payload loosely
 * because different graphical items fill it differently, so read it defensively.
 */
function legendKey(entry: unknown): string {
  return String((entry as { dataKey?: unknown } | undefined)?.dataKey ?? '');
}

const axisProps = {
  stroke: 'hsl(var(--muted-foreground))',
  fontSize: 12,
  tickLine: false
} as const;

/** The numbers behind the chart, hidden behind a disclosure by default. */
function ChartData({ spec }: { spec: ChartSpec }) {
  const [open, setOpen] = React.useState(false);
  const columns = [spec.x, ...spec.series.map((series) => series.key)];
  const headers = [spec.xLabel ?? spec.x, ...spec.series.map((series) => series.label)];
  const highlight = React.useMemo(() => resolveHighlight(spec), [spec]);

  // Mirror the plot's emphasis so the numbers carry the same focus.
  const columnClass = (column: string, index: number) => {
    if (!highlight.series.size || index === 0) return '';
    return highlight.series.has(column) ? 'font-semibold text-foreground' : 'text-muted-foreground';
  };
  const rowClass = (row: (typeof spec.rows)[number]) => {
    if (!highlight.categories.size) return '';
    return highlight.categories.has(String(row[spec.x] ?? '')) ? 'font-semibold text-foreground' : '';
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center gap-1.5 self-start bg-transparent py-1 text-left text-sm font-normal text-muted-foreground transition-colors hover:text-foreground"
      >
        <svg
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        <span>Show data</span>
      </button>
      {open && (
        <Table>
          <TableHeader>
            <TableRow>
              {headers.map((header, i) => (
                <TableHead key={i} className={columnClass(columns[i], i)}>
                  {header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {spec.rows.map((row, r) => (
              <TableRow key={r} className={rowClass(row)}>
                {columns.map((column, c) => (
                  <TableCell key={c} className={columnClass(column, c)}>
                    {formatFullNumber(row[column])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function ChartFigure({ spec }: { spec: ChartSpec }) {
  const showLegend = spec.series.length > 1;
  // Clicking a legend entry drops that series from the plot. Recharts' `hide`
  // does the rest: the shape is not drawn, the series leaves the tooltip
  // payload, and the axis domain is recomputed without it.
  const [hiddenKeys, setHiddenKeys] = React.useState<ReadonlySet<string>>(() => new Set());
  const hidden = React.useMemo(
    // Intersecting with the current spec keeps a key left over from a previous
    // spec on this same React root from counting against the guard below.
    () => new Set(spec.series.filter((series) => hiddenKeys.has(series.key)).map((s) => s.key)),
    [spec.series, hiddenKeys]
  );
  const toggleSeries = React.useCallback(
    (key: string) => {
      setHiddenKeys((current) => {
        const next = new Set(current);
        if (next.delete(key)) return next;
        // Hiding the last lit series would leave an empty plot auto-scaled to
        // nothing, which reads as a broken chart rather than an empty one.
        const visible = spec.series.filter((series) => !next.has(series.key)).length;
        if (visible <= 1) return current;
        next.add(key);
        return next;
      });
    },
    [spec.series]
  );
  const leftSeries = React.useMemo(
    () => spec.series.filter((series) => series.axis !== 'right'),
    [spec.series]
  );
  const rightSeries = React.useMemo(
    () => spec.series.filter((series) => series.axis === 'right'),
    [spec.series]
  );
  // Recharts rescales an axis domain to the series still showing, so the tick
  // formatter has to follow. Derived from every series instead, a chart whose
  // large series was switched off would keep compact notation and round the
  // small one still on screen away to "0".
  const visibleLeftSeries = React.useMemo(
    () => leftSeries.filter((series) => !hidden.has(series.key)),
    [leftSeries, hidden]
  );
  const visibleRightSeries = React.useMemo(
    () => rightSeries.filter((series) => !hidden.has(series.key)),
    [rightSeries, hidden]
  );
  // Raw ticks read as 1000000; the axis compacts them while the tooltip and the
  // Show data table keep the exact figure.
  const formatLeftTick = React.useMemo(
    () => createAxisFormatter(spec.rows, visibleLeftSeries),
    [spec.rows, visibleLeftSeries]
  );
  const formatRightTick = React.useMemo(
    () => createAxisFormatter(spec.rows, visibleRightSeries),
    [spec.rows, visibleRightSeries]
  );
  // Recharts drops every other label once they collide, so rotate instead.
  const ticks = React.useMemo(() => xTickLayout(spec.rows, spec.x), [spec.rows, spec.x]);
  const highlight = React.useMemo(() => resolveHighlight(spec), [spec]);

  const common = {
    data: spec.rows,
    margin: {
      top: 8,
      right: 12,
      bottom: (spec.xLabel ? 24 : 4) + ticks.height,
      left: spec.yLabel ? 12 : 0
    }
  };
  const xAxis = (
    <XAxis
      dataKey={spec.x}
      {...axisProps}
      {...(ticks.angled
        ? { interval: ticks.interval, angle: -45, textAnchor: 'end' as const, height: ticks.height }
        : {})}
      label={spec.xLabel ? { value: spec.xLabel, position: 'insideBottom', offset: -12 } : undefined}
    />
  );
  const leftYAxis = (
    <YAxis
      yAxisId="left"
      {...axisProps}
      // Kept mounted so a hidden series' yAxisId still resolves; just not drawn
      // once every series it scales has been switched off.
      hide={leftSeries.length > 0 && visibleLeftSeries.length === 0}
      domain={spec.type === 'line' ? ['auto', 'auto'] : undefined}
      width={64}
      tickFormatter={formatLeftTick}
      label={
        spec.yLabel
          ? { value: spec.yLabel, angle: -90, position: 'insideLeft', textAnchor: 'middle' }
          : undefined
      }
    />
  );
  const rightYAxis = rightSeries.length ? (
    <YAxis
      yAxisId="right"
      orientation="right"
      {...axisProps}
      hide={visibleRightSeries.length === 0}
      domain={spec.type === 'line' ? ['auto', 'auto'] : undefined}
      width={64}
      tickFormatter={formatRightTick}
      label={
        spec.rightYLabel
          ? { value: spec.rightYLabel, angle: 90, position: 'insideRight', textAnchor: 'middle' }
          : undefined
      }
    />
  ) : null;
  const tooltip = (
    <Tooltip
      formatter={(value: unknown) => formatFullNumber(value)}
      contentStyle={{
        borderRadius: 'var(--radius)',
        border: '1px solid hsl(var(--border))',
        background: 'hsl(var(--card))',
        color: 'hsl(var(--card-foreground))',
        fontSize: 12
      }}
    />
  );
  const grid = <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />;
  const legend = showLegend ? (
    <Legend
      wrapperStyle={{ fontSize: 12, cursor: 'pointer' }}
      // Recharts greys an entry whose series is hidden; point it at the theme
      // rather than its hard-coded #ccc, which is invisible in dark mode.
      inactiveColor={MUTED_COLOR}
      onClick={(entry: unknown) => {
        const key = legendKey(entry);
        if (key) toggleSeries(key);
      }}
      formatter={(value: string, entry: unknown) => {
        const key = legendKey(entry);
        const off = hidden.has(key);
        // A hidden series and a highlight-dimmed one are different states, so
        // the strikethrough carries the "switched off" meaning on its own.
        const dimmed = !off && highlight.series.size > 0 && !highlight.series.has(key);
        return (
          <span
            style={{
              color: off || dimmed ? MUTED_COLOR : 'inherit',
              opacity: dimmed ? MUTED_OPACITY : 1,
              textDecoration: off ? 'line-through' : undefined
            }}
          >
            {value}
          </span>
        );
      }}
    />
  ) : null;
  // A line has no per-point fill to mute, so a highlighted category is marked
  // with a vertical rule instead.
  const categoryMarkers = [...highlight.categories].map((value) => (
    <ReferenceLine
      key={value}
      x={value}
      yAxisId="left"
      stroke={seriesColor(0)}
      strokeDasharray="4 3"
    />
  ));

  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT + ticks.height}>
      {spec.type === 'bar' ? (
        <BarChart {...common}>
          {grid}
          {xAxis}
          {leftYAxis}
          {rightYAxis}
          {tooltip}
          {legend}
          {spec.series.map((series, i) => {
            const paint = seriesPaint(i, series.key, highlight);
            // Per-row fills need Cells; a single `fill` cannot vary by category.
            const perCategory = highlight.categories.size > 0;
            return (
              <Bar
                key={series.key}
                dataKey={series.key}
                yAxisId={series.axis ?? 'left'}
                name={series.label}
                fill={paint.color}
                fillOpacity={paint.opacity}
                hide={hidden.has(series.key)}
                stackId={spec.stacked ? 'stack' : undefined}
                radius={[3, 3, 0, 0]}
                isAnimationActive={ANIMATE}
              >
                {perCategory &&
                  spec.rows.map((row, r) => {
                    const lit = highlight.categories.has(String(row[spec.x] ?? ''));
                    return (
                      <Cell
                        key={r}
                        fill={lit ? seriesColor(i) : MUTED_COLOR}
                        fillOpacity={lit ? 1 : MUTED_OPACITY}
                      />
                    );
                  })}
              </Bar>
            );
          })}
        </BarChart>
      ) : (
        <LineChart {...common}>
          {grid}
          {xAxis}
          {leftYAxis}
          {rightYAxis}
          {tooltip}
          {legend}
          {categoryMarkers}
          {spec.series.map((series, i) => {
            const paint = lineSeriesPaint(i, series.key, highlight);
            return (
              <Line
                key={series.key}
                type="monotone"
                dataKey={series.key}
                yAxisId={series.axis ?? 'left'}
                name={series.label}
                stroke={paint.color}
                strokeOpacity={paint.opacity}
                strokeWidth={paint.width}
                hide={hidden.has(series.key)}
                dot={{
                  r: LINE_DOT_RADIUS,
                  fill: paint.color,
                  fillOpacity: paint.opacity,
                  stroke: paint.color,
                  strokeOpacity: paint.opacity,
                  strokeWidth: 1
                }}
                connectNulls
                isAnimationActive={ANIMATE}
              />
            );
          })}
        </LineChart>
      )}
    </ResponsiveContainer>
  );
}

export function ChartBlock({ spec }: { spec: ChartSpec }) {
  return (
    <div className="rc-scope">
      <Card>
        {spec.title && (
          <CardHeader>
            {/* Marked so a copied chart image can redraw the title, which lives
                in HTML rather than in the plot's SVG. */}
            <CardTitle data-chart-title="">{spec.title}</CardTitle>
          </CardHeader>
        )}
        <CardContent>
          <ChartFigure spec={spec} />
          <ChartData spec={spec} />
        </CardContent>
      </Card>
    </div>
  );
}
