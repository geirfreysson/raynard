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
  // Raw ticks read as 1000000; the axis compacts them while the tooltip and the
  // Show data table keep the exact figure.
  const formatTick = React.useMemo(
    () => createAxisFormatter(spec.rows, spec.series),
    [spec.rows, spec.series]
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
  const yAxis = (
    <YAxis
      {...axisProps}
      width={64}
      tickFormatter={formatTick}
      label={spec.yLabel ? { value: spec.yLabel, angle: -90, position: 'insideLeft' } : undefined}
    />
  );
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
      wrapperStyle={{ fontSize: 12 }}
      formatter={(value: string, entry: unknown) => {
        const key = String((entry as { dataKey?: unknown } | undefined)?.dataKey ?? '');
        const dimmed = highlight.series.size > 0 && !highlight.series.has(key);
        return (
          <span style={{ color: dimmed ? MUTED_COLOR : 'inherit', opacity: dimmed ? MUTED_OPACITY : 1 }}>
            {value}
          </span>
        );
      }}
    />
  ) : null;
  // A line has no per-point fill to mute, so a highlighted category is marked
  // with a vertical rule instead.
  const categoryMarkers = [...highlight.categories].map((value) => (
    <ReferenceLine key={value} x={value} stroke={seriesColor(0)} strokeDasharray="4 3" />
  ));

  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT + ticks.height}>
      {spec.type === 'bar' ? (
        <BarChart {...common}>
          {grid}
          {xAxis}
          {yAxis}
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
                name={series.label}
                fill={paint.color}
                fillOpacity={paint.opacity}
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
          {yAxis}
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
                name={series.label}
                stroke={paint.color}
                strokeOpacity={paint.opacity}
                strokeWidth={paint.width}
                dot={false}
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
