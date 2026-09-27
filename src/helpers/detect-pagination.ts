/**
 * Pagination signal detection for markdown responses (`single-fetch-completeness`).
 *
 * A paginated markdown response looks complete: well-formed, 200, ends
 * cleanly. The only evidence that it is partial is whatever the server put
 * in the content or the headers. This module finds that evidence and picks
 * the continuation an agent would follow. It is a heuristic: it errs toward
 * missing pagination rather than flagging navigation, because the spec
 * distinguishes splitting by meaning (prev/next links between self-contained
 * pages) from windowing by size (arbitrary slices of one logical unit), and
 * only the latter is a defect.
 */

export type PaginationSignalType = 'n-of-m' | 'pagination-param' | 'next-link' | 'link-header';

export interface PaginationSignal {
  type: PaginationSignalType;
  /** The matched phrase or link text, trimmed and shortened. */
  text: string;
  /** Continuation URL exactly as declared, when the signal carries one. */
  url?: string;
  /** Character offset into the content. Absent for header signals. */
  offset?: number;
}

export interface ContinuationCandidate {
  /** The URL as declared in the content or header. */
  url: string;
  /** Resolved absolute URL, or null when it could not be resolved. */
  resolvedUrl: string | null;
  /** True when the declaration itself was an absolute `http(s)://` URL. */
  absolute: boolean;
  /** Where the declaration lives. */
  declaredIn: 'content' | 'header';
  /** Character offset into the content, for in-content declarations. */
  offset?: number;
}

export interface PaginationDetection {
  signals: PaginationSignal[];
  /**
   * The continuation an agent would follow: the earliest in-content link
   * that looks like pagination, or the `Link: rel="next"` header when the
   * content declares none. Undefined when signals exist but no link does.
   */
  continuation?: ContinuationCandidate;
}

export interface DetectPaginationOptions {
  /** URL the markdown was served from; relative continuation URLs resolve against it. */
  baseUrl: string;
  /** The page URL when it differs from `baseUrl` (a `.md` variant of an HTML page). */
  pageUrl?: string;
  /** Raw `Link` response header, if any. */
  linkHeader?: string | null;
}

/** Query parameters that window a resource: `?page=2`, `?offset=100`, cursor tokens. */
const PAGINATION_PARAM = /[?&](page|offset|cursor|page_token|pageToken)=([^&#\s]*)/i;
/** Path-segment paging: `/page/2`. */
const PAGINATION_PATH = /\/page\/(\d+)(?=[/?#]|$)/i;

/**
 * "N of M" phrasing that describes a window of a larger set. Each pattern
 * yields the shown count and the total as its last two capture groups.
 * Tutorial phrasing ("Step 2 of 5", "Part 1 of 3") is deliberately not
 * matched: it describes sequence, not a window of one unit.
 */
const N_OF_M_PATTERNS: RegExp[] = [
  // "Showing 100 of 102", "Page 1 of 5", "Displaying the first 50 of 200"
  /(?<![A-Za-z0-9])(?:showing|displaying|listing|page)\s+(?:the\s+first\s+)?(\d[\d,]*)\s+(?:of|out\s+of)\s+(\d[\d,]*)(?![A-Za-z0-9])/gi,
  // "Showing 1-100 of 102", "Showing results 1 to 25 of 80"
  /(?<![A-Za-z0-9])(?:showing|displaying|listing)\s+(?:results?\s+|items?\s+|entries\s+)?\d[\d,]*\s*(?:-|–|to)\s*(\d[\d,]*)\s+(?:of|out\s+of)\s+(\d[\d,]*)(?![A-Za-z0-9])/gi,
  // "100 of 102 models", "25 of 80 results", "100 of 101 shown"
  /(?<![A-Za-z0-9])(\d[\d,]*)\s+(?:of|out\s+of)\s+(\d[\d,]*)\s+(?:results?|items?|entries|records|models|rows|pages|shown|displayed|listed|total)(?![A-Za-z0-9])/gi,
];

/**
 * Link text that names pagination outright. Counts as a continuation
 * wherever on this site it points; a continuation of this document does
 * not live on another host.
 */
const EXPLICIT_NEXT_TEXT =
  /^\s*(?:[»›→>]+\s*)?(?:next\s+page|next\s+\d+(?:\s+\w+)?|more\s+results|load\s+more|show\s+more)\s*(?:[»›→>]+)?\s*$/i;

/**
 * Link text that could be pagination or ordinary prev/next navigation
 * between separate pages. Counts only when the URL itself looks like
 * pagination (a paging parameter, or the same path with a different query).
 */
const GENERIC_NEXT_TEXT =
  /^\s*(?:[»›→>]+\s*)?(?:next|more|continue|see\s+more|view\s+more|older|newer|next\s*[»›→>]+)\s*(?:[»›→>]+)?\s*$/i;

/** `[text](url)`, but not the tail of an image `![alt](src)`. */
const MARKDOWN_LINK = /(?<!!)\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const BARE_URL = /\bhttps?:\/\/[^\s<>()\]"']+/gi;
/** A root-relative path carrying a paging parameter, quoted in prose or an instruction. */
const BARE_PAGED_PATH =
  /(?:^|[\s"'(])(\/[^\s"'()<>]*[?&](?:page|offset|cursor|page_token|pageToken)=[^\s"'()<>]*)/gim;

const MAX_SIGNAL_TEXT = 80;

/**
 * What may precede an "N of M" phrase on its line for it to read as a
 * pagination note rather than prose: markdown structure (blockquote, list
 * marker, table cell, emphasis) and at most one short label such as
 * "Note:". A phrase inside a sentence ("If 3 out of 50 pages fail, the
 * check scores 94%") is illustrative, not a declaration that the response
 * is partial.
 */
const NOTE_LEAD = /^[\s>*_\-+|#\d.)]*(?:\*\*|__)?(?:[A-Za-z][\w ]{0,24}:\s*)?(?:\*\*|__)?\s*$/;

/**
 * Replace fenced code blocks and inline code spans with spaces of the same
 * length, so offsets into the original content survive and API examples
 * (`GET /v1/items?page=2`) never register as pagination.
 *
 * Known gap, deliberately kept: the fence regex requires the closer at
 * column 1 and exactly as long as the opener, while CommonMark allows a
 * longer closer and an indented fence inside a list item. The link
 * classifier (`classify-markdown-links.ts`, `blankCode`) fixed both with a
 * line scanner after field evidence; this one has produced no fence-related
 * false positive yet, and moving it without evidence would shift
 * `single-fetch-completeness` results. Port the scanner when it does.
 */
function blankCode(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, blank)
    .replace(/`[^`\n]+`/g, blank);
}

/** `decodeURIComponent` throws on malformed escapes (`?page=%`) that `new URL` accepts. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseCount(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SIGNAL_TEXT ? `${flat.slice(0, MAX_SIGNAL_TEXT - 1)}…` : flat;
}

function isAbsoluteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function resolveUrl(url: string, base: string): string | null {
  try {
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

/**
 * The paging parameter points past the first window: `page` of 2 or more,
 * `offset` above zero, or any non-empty cursor. A `?page=1` link is the
 * page itself, not a continuation.
 */
function pointsToLaterWindow(url: string): boolean {
  const param = PAGINATION_PARAM.exec(url);
  if (param) {
    const name = param[1].toLowerCase();
    const value = safeDecode(param[2] ?? '');
    if (name === 'page') return Number(value) >= 2;
    if (name === 'offset') return Number(value) > 0;
    return value.length > 0;
  }
  const path = PAGINATION_PATH.exec(url);
  if (path) return Number(path[1]) >= 2;
  return false;
}

function hasPagingShape(url: string): boolean {
  return PAGINATION_PARAM.test(url) || PAGINATION_PATH.test(url);
}

function sameHost(resolved: string, ...bases: string[]): boolean {
  try {
    const host = new URL(resolved).host;
    return bases.some((b) => {
      try {
        return new URL(b).host === host;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function stripExtension(pathname: string): string {
  return pathname.replace(/\/$/, '').replace(/\.(?:mdx?|html?)$/i, '');
}

/** Same document, different query: the shape of a pager link on the current page. */
function sameDocumentDifferentQuery(resolved: string, ...bases: string[]): boolean {
  try {
    const target = new URL(resolved);
    return bases.some((b) => {
      try {
        const base = new URL(b);
        return (
          base.host === target.host &&
          stripExtension(base.pathname) === stripExtension(target.pathname) &&
          base.search !== target.search
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

interface LinkOccurrence {
  text: string;
  url: string;
  offset: number;
}

const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;

function collectLinks(text: string): { links: LinkOccurrence[]; remainder: string } {
  const links: LinkOccurrence[] = [];
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  // Images are not links an agent follows, and their sources can carry
  // paging-looking query strings; drop them before any URL matching.
  let remainder = text.replace(MARKDOWN_IMAGE, blank);
  remainder = remainder.replace(
    MARKDOWN_LINK,
    (m, linkText: string, url: string, offset: number) => {
      links.push({ text: linkText, url, offset });
      return blank(m);
    },
  );
  remainder = remainder.replace(BARE_URL, (m, offset: number) => {
    links.push({ text: '', url: m.replace(/[.,;:!?]+$/, ''), offset });
    return blank(m);
  });
  return { links, remainder };
}

/**
 * Parse `Link: <url>; rel="next"` and return the `next` target, if any.
 * Handles multiple comma-separated links and space-separated rel values.
 */
export function parseLinkHeaderNext(header: string | null | undefined): string | null {
  if (!header) return null;
  const entry = /<([^>]*)>((?:\s*;\s*[^,;]+)*)/g;
  let m: RegExpExecArray | null;
  while ((m = entry.exec(header)) !== null) {
    const params = m[2];
    const rel = /;\s*rel\s*=\s*"?([^";,]+)"?/i.exec(params);
    if (!rel) continue;
    const rels = rel[1].trim().toLowerCase().split(/\s+/);
    if (rels.includes('next')) return m[1].trim();
  }
  return null;
}

/**
 * Detect pagination signals in a markdown response and pick the continuation
 * an agent would follow.
 */
export function detectPagination(
  content: string,
  options: DetectPaginationOptions,
): PaginationDetection {
  const { baseUrl, pageUrl, linkHeader } = options;
  const bases = pageUrl && pageUrl !== baseUrl ? [baseUrl, pageUrl] : [baseUrl];
  const signals: PaginationSignal[] = [];
  const candidates: ContinuationCandidate[] = [];

  const scannable = blankCode(content);
  const { links, remainder } = collectLinks(scannable);

  const addCandidate = (url: string, offset: number) => {
    candidates.push({
      url,
      resolvedUrl: resolveUrl(url, baseUrl),
      absolute: isAbsoluteUrl(url),
      declaredIn: 'content',
      offset,
    });
  };

  for (const link of links) {
    const resolved = resolveUrl(link.url, baseUrl);
    const explicitNext = EXPLICIT_NEXT_TEXT.test(link.text);
    const genericNext = !explicitNext && GENERIC_NEXT_TEXT.test(link.text);
    const pagedShape = hasPagingShape(link.url);
    const onThisSite =
      !isAbsoluteUrl(link.url) || (resolved !== null && sameHost(resolved, ...bases));

    if (explicitNext && onThisSite) {
      signals.push({
        type: 'next-link',
        text: shorten(link.text),
        url: link.url,
        offset: link.offset,
      });
      addCandidate(link.url, link.offset);
      continue;
    }

    if (
      genericNext &&
      onThisSite &&
      resolved !== null &&
      (pagedShape || sameDocumentDifferentQuery(resolved, ...bases))
    ) {
      signals.push({
        type: 'next-link',
        text: shorten(link.text),
        url: link.url,
        offset: link.offset,
      });
      addCandidate(link.url, link.offset);
      continue;
    }

    if (pagedShape && onThisSite && pointsToLaterWindow(link.url)) {
      signals.push({
        type: 'pagination-param',
        text: shorten(link.text || link.url),
        url: link.url,
        offset: link.offset,
      });
      addCandidate(link.url, link.offset);
    }
  }

  // Root-relative paths quoted in prose ("fetch /models?page=2 for the rest").
  let pathMatch: RegExpExecArray | null;
  BARE_PAGED_PATH.lastIndex = 0;
  while ((pathMatch = BARE_PAGED_PATH.exec(remainder)) !== null) {
    const url = pathMatch[1].replace(/[.,;:!?]+$/, '');
    const offset = pathMatch.index + pathMatch[0].indexOf(pathMatch[1]);
    if (!pointsToLaterWindow(url)) continue;
    signals.push({ type: 'pagination-param', text: shorten(url), url, offset });
    addCandidate(url, offset);
  }

  // One phrase can satisfy more than one pattern ("Showing 100 of 102
  // models" is both "showing N of M" and "N of M models"); report it once.
  const phraseSpans: Array<[number, number]> = [];
  for (const pattern of N_OF_M_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(remainder)) !== null) {
      const shown = parseCount(m[m.length - 2]);
      const total = parseCount(m[m.length - 1]);
      if (!Number.isFinite(shown) || !Number.isFinite(total) || shown >= total) continue;
      const start = m.index;
      const end = start + m[0].length;
      if (phraseSpans.some(([a, b]) => start < b && end > a)) continue;
      const lineStart = remainder.lastIndexOf('\n', start - 1) + 1;
      if (!NOTE_LEAD.test(remainder.slice(lineStart, start))) continue;
      phraseSpans.push([start, end]);
      signals.push({ type: 'n-of-m', text: shorten(m[0]), offset: start });
    }
  }

  const headerNext = parseLinkHeaderNext(linkHeader);
  if (headerNext) {
    signals.push({ type: 'link-header', text: `Link: rel="next"`, url: headerNext });
  }

  signals.sort(
    (a, b) => (a.offset ?? Number.MAX_SAFE_INTEGER) - (b.offset ?? Number.MAX_SAFE_INTEGER),
  );

  let continuation: ContinuationCandidate | undefined;
  if (candidates.length > 0) {
    // The earliest declaration is the one truncation is least likely to remove.
    continuation = candidates.reduce((a, b) => ((b.offset ?? 0) < (a.offset ?? 0) ? b : a));
  } else if (headerNext) {
    continuation = {
      url: headerNext,
      resolvedUrl: resolveUrl(headerNext, baseUrl),
      absolute: isAbsoluteUrl(headerNext),
      declaredIn: 'header',
    };
  }

  return { signals, continuation };
}
