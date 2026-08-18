import { useMemo, useState } from 'react';
import type { CardBlock, CardGap, CardTemplate } from './types';
import { formatValue, getPath, interpolate, resolveRows } from './resolve';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '../components/ui/avatar';
import { Badge } from '../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

type ImageBlock = Extract<CardBlock, { component: 'Image' }>;
type TableBlock = Extract<CardBlock, { component: 'Table' }>;
type TableColumn = TableBlock['columns'][number];

export function filterTableRows(
  rows: Record<string, unknown>[],
  columns: TableColumn[],
  query: string
): Record<string, unknown>[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return rows;

  return rows.filter((row) => {
    const searchable = columns
      .map((column) => formatValue(getPath(row, column.field)))
      .join(' ')
      .toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

function deltaTone(value: string): 'up' | 'down' | 'flat' {
  const t = value.trim();
  if (/^-/.test(t)) return 'down';
  if (/^\+/.test(t)) return 'up';
  return 'flat';
}

function initialsFrom(text: string): string {
  const words = String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '—';
  return words.slice(0, 2).map((w) => (w[0] ?? '').toUpperCase()).join('') || '—';
}

const badgeVariant: Record<string, 'success' | 'warn' | 'secondary'> = {
  success: 'success',
  warn: 'warn',
  muted: 'secondary'
};

const gapSize: Record<CardGap, string> = {
  sm: '0.5rem',
  md: '1rem',
  lg: '1.5rem'
};

const imageAspectRatio: Record<NonNullable<ImageBlock['aspectRatio']>, string> = {
  '1/1': '1 / 1',
  '3/4': '3 / 4',
  '4/3': '4 / 3',
  '16/9': '16 / 9',
  auto: 'auto'
};

function renderLayout(layout: CardBlock[] | undefined, data: unknown) {
  return (layout || []).map((child, i) => <Block key={i} block={child} data={data} />);
}

function ResultTable({ block, data }: { block: TableBlock; data: unknown }) {
  const [query, setQuery] = useState('');
  const rows = resolveRows(data, block.rows);
  const filteredRows = useMemo(
    () => filterTableRows(rows, block.columns, query),
    [rows, block.columns, query]
  );
  const countLabel = query.trim()
    ? `${filteredRows.length} of ${rows.length} rows`
    : `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`;

  return (
    <div className="flex flex-col gap-2">
      {rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-xs text-muted-foreground">{countLabel}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            aria-label="Filter table rows"
            placeholder="Filter rows…"
            className="h-8 w-56 max-w-full rounded-md border border-input bg-transparent px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            {block.columns.map((col, i) => (
              <TableHead key={i}>{col.header}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredRows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={block.columns.length} className="italic text-muted-foreground">
                {rows.length === 0 ? 'No rows' : 'No matching rows'}
              </TableCell>
            </TableRow>
          ) : (
            filteredRows.map((row, r) => (
              <TableRow key={r}>
                {block.columns.map((col, c) => (
                  <TableCell key={c}>{formatValue(getPath(row, col.field))}</TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function Block({ block, data }: { block: CardBlock; data: unknown }) {
  switch (block.component) {
    case 'MetricRow':
      return (
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          {block.items.map((item, i) => {
            const value = formatValue(getPath(data, item.field)) || '—';
            const tone = item.tone === 'delta' ? deltaTone(value) : undefined;
            const valueClass =
              tone === 'up'
                ? 'text-[hsl(var(--success))]'
                : tone === 'down'
                  ? 'text-destructive'
                  : item.tone === 'muted'
                    ? 'text-muted-foreground'
                    : '';
            return (
              <div key={i} className="flex flex-col gap-0.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{item.label}</span>
                <span className={`text-lg font-semibold tabular-nums ${valueClass}`}>{value}</span>
              </div>
            );
          })}
        </div>
      );

    case 'Table': {
      return <ResultTable block={block} data={data} />;
    }

    case 'KeyValue':
      return (
        <dl className="grid gap-2">
          {block.pairs.map((pair, i) => (
            <div key={i} className="flex items-baseline justify-between gap-4">
              <dt className="text-sm text-muted-foreground">{pair.label}</dt>
              <dd className="text-right text-sm font-medium">{formatValue(getPath(data, pair.field)) || '—'}</dd>
            </div>
          ))}
        </dl>
      );

    case 'Text':
      return <p className="text-sm leading-relaxed">{interpolate(block.text, data)}</p>;

    case 'Section':
      return (
        <section className="flex flex-col gap-3">
          {block.title ? (
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{block.title}</h4>
          ) : null}
          {renderLayout(block.layout, data)}
        </section>
      );

    case 'Stack':
      return (
        <div className="rc-stack" style={{ gap: gapSize[block.gap ?? 'md'] }}>
          {renderLayout(block.layout, data)}
        </div>
      );

    case 'Grid': {
      const columns = Math.min(4, Math.max(1, block.columns ?? 2));
      return (
        <div
          className="rc-grid"
          style={{
            gap: gapSize[block.gap ?? 'md'],
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`
          }}
        >
          {renderLayout(block.layout, data)}
        </div>
      );
    }

    case 'Columns':
      return (
        <div
          className="rc-columns"
          data-collapse-below={block.collapseBelow ?? 'sm'}
          style={{
            gap: gapSize[block.gap ?? 'md'],
            gridTemplateColumns: (block.columns || [])
              .map((column) => `${Math.max(0.1, Number(column.width) || 1)}fr`)
              .join(' ')
          }}
        >
          {(block.columns || []).map((column, i) => (
            <div className="rc-column" key={i}>
              {renderLayout(column.layout, data)}
            </div>
          ))}
        </div>
      );

    case 'Badge': {
      const variant = badgeVariant[block.tone ?? 'muted'] ?? 'secondary';
      return <Badge variant={variant}>{formatValue(getPath(data, block.field))}</Badge>;
    }

    case 'Image': {
      const alt = block.alt ? interpolate(block.alt, data) : 'image';
      if (block.variant === 'media') {
        return (
          <img
            className="rc-media-image"
            src={formatValue(getPath(data, block.field))}
            alt={alt}
            style={{
              aspectRatio: imageAspectRatio[block.aspectRatio ?? 'auto'],
              objectFit: block.fit ?? 'cover'
            }}
          />
        );
      }
      return (
        <Avatar className="h-16 w-16">
          <AvatarImage src={formatValue(getPath(data, block.field))} alt={alt} />
          <AvatarFallback>{initialsFrom(alt)}</AvatarFallback>
        </Avatar>
      );
    }

    case 'Json': {
      const value = block.field ? getPath(data, block.field) : data;
      let text: string;
      try {
        text = JSON.stringify(value, null, 2);
      } catch {
        text = String(value);
      }
      return <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 text-xs leading-relaxed">{text}</pre>;
    }

    default:
      return null;
  }
}

export function ResultCard({
  template,
  data,
  cached = false
}: {
  template: CardTemplate;
  data: unknown;
  cached?: boolean;
}) {
  const layout = Array.isArray(template?.layout) ? template.layout : [];
  // Hoist the first top-level Image block into the header as an avatar.
  const headerImageIndex = layout.findIndex(
    (block) => block.component === 'Image' && block.variant !== 'media'
  );
  const headerImage = headerImageIndex >= 0 ? (layout[headerImageIndex] as ImageBlock) : null;
  const bodyBlocks = layout.filter((_, i) => i !== headerImageIndex);
  const title = template?.title ? interpolate(template.title, data) : '';
  const avatarAlt = headerImage?.alt ? interpolate(headerImage.alt, data) : title;
  const hasHeader = Boolean(headerImage || title || cached);

  return (
    <div className="rc-scope">
      <Card>
        {hasHeader && (
          <CardHeader>
            {headerImage && (
              <Avatar>
                <AvatarImage src={formatValue(getPath(data, headerImage.field))} alt={avatarAlt || 'image'} />
                <AvatarFallback>{initialsFrom(avatarAlt || title)}</AvatarFallback>
              </Avatar>
            )}
            {title && <CardTitle className="min-w-0 flex-1">{title}</CardTitle>}
            {cached && <Badge variant="secondary" className="ml-auto shrink-0">Cached</Badge>}
          </CardHeader>
        )}
        {bodyBlocks.length > 0 && (
          <CardContent>
            {bodyBlocks.map((block, i) => (
              <Block key={i} block={block} data={data} />
            ))}
          </CardContent>
        )}
      </Card>
    </div>
  );
}
