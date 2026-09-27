/**
 * Detection of machine-generated bulk data in converted page content, for
 * `embedded-data-serialization`.
 *
 * The input is the same text `page-size-html` measures: the HTML-to-markdown
 * conversion for HTML responses, or the body itself for markdown responses.
 * Everything found here therefore survived conversion into content the model
 * reads; payloads inside `<script>` tags never reach this module (conversion
 * strips them, and they belong to `page-size-transfer`).
 *
 * Three kinds of element are recognized, following the spec:
 *
 * - **Tables** above a row threshold with uniform row structure. Pipe tables
 *   (what the GFM table plugin emits for tables with a header row) and raw
 *   `<table>` markup that the converter left in place (headerless tables) are
 *   both counted, because both occupy the converted content.
 * - **JSON blobs** above a size threshold, whether fenced, indented (what
 *   turndown emits for `<pre>`), or dropped inline as a paragraph.
 * - **Base64 runs** above the same size threshold.
 *
 * The module is pure: it reports the elements with their offsets and sizes,
 * and leaves the verdict to the check, which couples it to the size bucket.
 */

export type BulkElementKind = 'table' | 'json' | 'base64';

export type BulkElementForm = 'pipe-table' | 'html-table' | 'fenced' | 'indented' | 'inline';

export interface BulkElement {
  kind: BulkElementKind;
  /** How the element appears in the converted content. */
  form: BulkElementForm;
  /** Character offset of the element's first character. */
  start: number;
  /** Characters the element occupies in the converted content. */
  chars: number;
  /** Share of the converted content, as a rounded percentage. */
  share: number;
  /** Where the element starts, as a rounded percentage of the content. */
  position: number;
  /** Data rows, excluding header and delimiter rows (tables only). */
  rows?: number;
  /** Cells in the header row, or in the first row when there is no header (tables only). */
  columns?: number;
  /** Fraction (0–1) of data rows that share the modal cell count (tables only). */
  uniformity?: number;
}

export interface BulkThresholds {
  /** Data rows at or above which a uniform table counts as bulk. */
  tableRows: number;
  /** Characters at or above which a JSON blob or base64 run counts as bulk. */
  blobChars: number;
  /** Percentage of converted content at or above which bulk is the dominant contributor. */
  dominantShare: number;
}

export interface BulkDetection {
  /** Length of the content that was scanned. */
  totalChars: number;
  /** Bulk elements in document order. */
  elements: BulkElement[];
  /** Characters covered by bulk elements (overlaps counted once). */
  bulkChars: number;
  /** Bulk share of the content, as a rounded percentage. */
  bulkShare: number;
  /** True when `bulkShare` reaches the dominant-share threshold. */
  dominant: boolean;
  /** Characters that are not bulk. */
  proseChars: number;
  /** Non-bulk characters that precede the first bulk element. */
  proseBeforeBulk: number;
  /**
   * Percentage of the non-bulk content that comes before the first bulk
   * element (0–100; 100 when there is no bulk). The spec asks for prose to
   * be placed before bulk elements so truncation removes data rows rather
   * than explanation; this is the number that makes that checkable.
   */
  proseBeforeBulkPercent: number;
}

/** Fraction of data rows that must share the modal cell count for a table to count as uniform. */
const UNIFORMITY_THRESHOLD = 0.8;

/** Fence info strings that declare JSON without needing to parse the body. */
const JSON_LANGS = new Set(['json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'geojson', 'json-ld']);

/**
 * Quoted keys per character below which a block that fails `JSON.parse` is
 * not treated as JSON. Real JSON averages one key per 30–60 characters; this
 * only has to reject prose and code that happen to start with a brace.
 */
const JSON_KEY_DENSITY = 1 / 150;

interface Line {
  text: string;
  start: number;
  end: number;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) {
      if (start < text.length) lines.push({ text: text.slice(start), start, end: text.length });
      break;
    }
    lines.push({ text: text.slice(start, nl), start, end: nl });
    start = nl + 1;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

function isJsonLike(body: string, lang?: string): boolean {
  if (lang && JSON_LANGS.has(lang.toLowerCase())) return true;
  const trimmed = body.trim();
  if (trimmed.length === 0) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    // Comments, trailing commas, and `...` elisions are common in
    // documentation JSON. Fall back to key density.
    const keys = trimmed.match(/"[^"\n]{1,200}"\s*:/g)?.length ?? 0;
    return keys >= 10 && keys >= trimmed.length * JSON_KEY_DENSITY;
  }
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** Split a pipe-table row into cells, ignoring the outer pipes and escaped pipes. */
function pipeCells(line: string): number {
  let cells = 1;
  let i = 0;
  const t = line.trim();
  const inner = t.startsWith('|') ? t.slice(1) : t;
  const body = inner.endsWith('|') && !inner.endsWith('\\|') ? inner.slice(0, -1) : inner;
  while (i < body.length) {
    const c = body[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '|') cells++;
    i++;
  }
  return cells;
}

function uniformity(cellCounts: number[]): number {
  if (cellCounts.length === 0) return 1;
  const tally = new Map<number, number>();
  for (const n of cellCounts) tally.set(n, (tally.get(n) ?? 0) + 1);
  let modal = 0;
  for (const count of tally.values()) if (count > modal) modal = count;
  return modal / cellCounts.length;
}

interface TableStats {
  rows: number;
  columns: number;
  uniformity: number;
}

function htmlTableStats(html: string): TableStats {
  const rowMatches = html.match(/<tr\b[^>]*>[\s\S]*?(?=<tr\b|<\/table\b|$)/gi) ?? [];
  const cellCounts: number[] = [];
  let headerRows = 0;
  const theadEnd = html.search(/<\/thead\b/i);
  const headerRegion = theadEnd >= 0 ? html.slice(0, theadEnd) : '';
  for (let i = 0; i < rowMatches.length; i++) {
    const row = rowMatches[i];
    const cells = row.match(/<t[dh]\b/gi)?.length ?? 0;
    const inThead = theadEnd >= 0 && headerRegion.includes(row);
    const isHeader = inThead || (i === 0 && /<th\b/i.test(row) && !/<td\b/i.test(row));
    if (isHeader) {
      headerRows++;
      continue;
    }
    cellCounts.push(cells);
  }
  const first = rowMatches[0]?.match(/<t[dh]\b/gi)?.length ?? 0;
  return {
    rows: Math.max(0, rowMatches.length - headerRows),
    columns: first,
    uniformity: uniformity(cellCounts),
  };
}

// ---------------------------------------------------------------------------
// Base64
// ---------------------------------------------------------------------------

/**
 * A run of base64 alphabet characters. Optional `data:` URI prefix so the
 * whole payload is attributed; the length requirement applies to the run.
 */
function base64Pattern(minChars: number): RegExp {
  return new RegExp(`(?:data:[\\w.+-]+/[\\w.+-]+;base64,)?[A-Za-z0-9+/]{${minChars},}={0,2}`, 'g');
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

interface RawElement {
  kind: BulkElementKind;
  form: BulkElementForm;
  start: number;
  end: number;
  rows?: number;
  columns?: number;
  uniformity?: number;
}

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;

/**
 * Walk the content once, recognizing code blocks, pipe tables, and raw HTML
 * tables. Everything else is prose. Returns the bulk elements found among
 * the blocks; base64 runs are scanned separately over the whole text.
 */
function scanBlocks(text: string, lines: Line[], thresholds: BulkThresholds): RawElement[] {
  const elements: RawElement[] = [];
  let i = 0;

  const pushTable = (
    form: 'pipe-table' | 'html-table',
    start: number,
    end: number,
    stats: TableStats,
  ) => {
    if (stats.rows >= thresholds.tableRows && stats.uniformity >= UNIFORMITY_THRESHOLD) {
      elements.push({ kind: 'table', form, start, end, ...stats });
    }
  };

  const pushCode = (
    form: 'fenced' | 'indented',
    start: number,
    end: number,
    body: string,
    lang?: string,
  ) => {
    if (end - start >= thresholds.blobChars && isJsonLike(body, lang)) {
      elements.push({ kind: 'json', form, start, end });
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = FENCE_OPEN.exec(line.text);
    if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
      const marker = fence[2];
      const lang = fence[3].trim().split(/\s+/)[0] || undefined;
      const closer = new RegExp(`^\\s*${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !closer.test(lines[j].text)) j++;
      const bodyStart = i + 1 < lines.length ? lines[i + 1].start : line.end;
      const bodyEnd = j < lines.length ? lines[j - 1].end : text.length;
      const end = j < lines.length ? lines[j].end : text.length;
      pushCode(
        'fenced',
        line.start,
        end,
        text.slice(bodyStart, Math.max(bodyStart, bodyEnd)),
        lang,
      );
      i = j + 1;
      continue;
    }

    // Raw HTML table left in place by the converter
    if (/^\s*<table\b/i.test(line.text)) {
      let j = i;
      while (j < lines.length && !/<\/table\s*>/i.test(lines[j].text)) j++;
      const end = j < lines.length ? lines[j].end : text.length;
      const html = text.slice(line.start, end);
      pushTable('html-table', line.start, end, htmlTableStats(html));
      i = j + 1;
      continue;
    }

    // Pipe table: a row followed by a delimiter row
    if (
      line.text.includes('|') &&
      i + 1 < lines.length &&
      DELIMITER_ROW.test(lines[i + 1].text) &&
      lines[i + 1].text.includes('-')
    ) {
      const columns = pipeCells(line.text);
      let j = i + 2;
      const cellCounts: number[] = [];
      while (j < lines.length && lines[j].text.trim() !== '' && lines[j].text.includes('|')) {
        cellCounts.push(pipeCells(lines[j].text));
        j++;
      }
      const end = lines[j - 1].end;
      pushTable('pipe-table', line.start, end, {
        rows: cellCounts.length,
        columns,
        uniformity: uniformity(cellCounts),
      });
      i = j;
      continue;
    }

    // Indented code block (turndown's default for <pre>): a run of lines
    // indented by four spaces or a tab, blank lines allowed inside.
    if (/^(?: {4}|\t)\S/.test(line.text) && (i === 0 || lines[i - 1].text.trim() === '')) {
      let j = i;
      let lastContent = i;
      while (j < lines.length) {
        const t = lines[j].text;
        if (/^(?: {4}|\t)/.test(t)) {
          lastContent = j;
          j++;
        } else if (t.trim() === '') {
          j++;
        } else {
          break;
        }
      }
      const end = lines[lastContent].end;
      const body = text
        .slice(line.start, end)
        .split('\n')
        .map((l) => l.replace(/^(?: {4}|\t)/, ''))
        .join('\n');
      pushCode('indented', line.start, end, body);
      i = lastContent + 1;
      continue;
    }

    // Inline JSON dropped as a paragraph
    const trimmed = line.text.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 1) {
      let j = i;
      while (j + 1 < lines.length && lines[j + 1].text.trim() !== '') j++;
      const end = lines[j].end;
      const body = text.slice(line.start, end);
      if (body.length >= thresholds.blobChars && isJsonLike(body)) {
        elements.push({ kind: 'json', form: 'inline', start: line.start, end });
        i = j + 1;
        continue;
      }
    }

    i++;
  }

  return elements;
}

function overlapsAny(start: number, end: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => start < e && end > s);
}

function unionLength(ranges: Array<[number, number]>): number {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [s, e] of sorted) {
    if (s > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

/**
 * Find the bulk-data elements in converted content and measure their share.
 */
export function detectBulkData(text: string, thresholds: BulkThresholds): BulkDetection {
  const totalChars = text.length;
  const lines = splitLines(text);
  const raw = scanBlocks(text, lines, thresholds);

  // Base64 runs anywhere that is not already a bulk element. A run inside a
  // non-JSON code block (a certificate, an embedded image) still counts.
  const bulkRanges: Array<[number, number]> = raw.map((e) => [e.start, e.end]);
  if (thresholds.blobChars > 0) {
    const pattern = base64Pattern(thresholds.blobChars);
    for (const m of text.matchAll(pattern)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (overlapsAny(start, end, bulkRanges)) continue;
      raw.push({ kind: 'base64', form: 'inline', start, end });
      bulkRanges.push([start, end]);
    }
  }

  raw.sort((a, b) => a.start - b.start);
  const bulkChars = unionLength(bulkRanges);
  const proseChars = totalChars - bulkChars;
  const proseBeforeBulk = raw.length > 0 ? raw[0].start : proseChars;
  const share = (n: number) => (totalChars > 0 ? Math.round((n / totalChars) * 100) : 0);

  const elements: BulkElement[] = raw.map((e) => ({
    kind: e.kind,
    form: e.form,
    start: e.start,
    chars: e.end - e.start,
    share: share(e.end - e.start),
    position: share(e.start),
    ...(e.rows !== undefined && { rows: e.rows }),
    ...(e.columns !== undefined && { columns: e.columns }),
    ...(e.uniformity !== undefined && { uniformity: Math.round(e.uniformity * 100) / 100 }),
  }));

  const bulkShare = share(bulkChars);
  return {
    totalChars,
    elements,
    bulkChars,
    bulkShare,
    dominant: elements.length > 0 && bulkShare >= thresholds.dominantShare,
    proseChars,
    proseBeforeBulk,
    proseBeforeBulkPercent:
      raw.length === 0
        ? 100
        : proseChars > 0
          ? Math.round((proseBeforeBulk / proseChars) * 100)
          : 0,
  };
}

/** Short human description of an element: "218-row table", "6K-char JSON blob". */
export function describeBulkElement(el: Pick<BulkElement, 'kind' | 'rows' | 'chars'>): string {
  if (el.kind === 'table') return `${el.rows ?? 0}-row table`;
  const size = el.chars >= 1000 ? `${Math.round(el.chars / 1000)}K-char` : `${el.chars}-char`;
  return el.kind === 'json' ? `${size} JSON blob` : `${size} base64 run`;
}
