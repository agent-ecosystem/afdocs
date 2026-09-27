/**
 * Link extraction and portability classification for served markdown
 * (`markdown-link-portability`).
 *
 * Relative URL resolution is well defined, but it needs the base URL, and
 * agent pipelines lose it: markdown gets summarized, chunked for RAG, or
 * pasted somewhere the fetch URL is gone. This module says, for each link in
 * a markdown response, how much of the base it needs to survive, and where it
 * points once resolved.
 */

/**
 * How much of the base URL a link needs to be reconstructable.
 *
 * - `absolute`: nothing. `https://docs.example.com/guide.md`.
 * - `protocol-relative`: the scheme. `//docs.example.com/guide.md`.
 * - `root-relative`: the scheme and host. `/guide.md`.
 * - `path-relative`: the scheme, host, and the directory of the document
 *   that carried the link. `../guide.md`.
 * - `fragment`: nothing, and nothing to fetch. `#usage` resolves inside the
 *   content the agent already holds.
 * - `other-scheme`: not an HTTP(S) resource. `mailto:`, `tel:`, `data:`.
 */
export type LinkClass =
  | 'absolute'
  | 'protocol-relative'
  | 'root-relative'
  | 'path-relative'
  | 'fragment'
  | 'other-scheme';

export interface MarkdownLink {
  /** The URL exactly as written in the markdown. */
  url: string;
  /** The link text, collapsed and shortened. */
  text: string;
  class: LinkClass;
  /** The absolute URL the link resolves to against the base, when resolvable. */
  resolvedUrl?: string;
  /**
   * The URL to actually request: `resolvedUrl` without its fragment. The
   * fragment is a client-side concern, and sending it can turn a working
   * link into a 404 on servers that route on the raw path.
   */
  fetchUrl?: string;
  /**
   * True when the destination should have resolved to an absolute URL and
   * did not: a malformed target such as `https://[`. Such a link is as
   * unusable as a broken one, and it must not be quietly counted as a
   * well-formed absolute link.
   */
  unresolvable: boolean;
  /** True when the resolved target sits on a different origin than the base. */
  crossOrigin: boolean;
  /** True when the target's path ends in `.md` or `.mdx`: it promises markdown. */
  promisesMarkdown: boolean;
}

export interface MarkdownLinkScan {
  /** Links an agent would follow, in document order, deduplicated by raw URL. */
  links: MarkdownLink[];
  /**
   * Image references, classified the same way but kept separate: they point
   * at assets rather than at documentation an agent navigates to, and the
   * representation verification has nothing to say about a PNG.
   */
  images: MarkdownLink[];
}

/** Longest link text kept in a result, so details stay readable. */
const MAX_TEXT = 60;

/** A scheme prefix: `mailto:`, `tel:`, `data:`, `ftp:`. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** A target whose path promises markdown, ignoring any query or fragment. */
const MARKDOWN_EXTENSION = /\.mdx?$/i;

/**
 * Characters a URL generator always percent-encodes, so a destination that
 * still contains one was never a URL. This is the guard against source code
 * that is served as markdown: Mintlify ships a page's raw MDX, and a regex
 * literal such as `/[_-](\w)/g` reads as a markdown link to `\w`, which the
 * URL parser then happily resolves to `/w`.
 *
 * `<` and `>` are not listed: a CommonMark angle-bracket destination is
 * unwrapped before this runs.
 */
const UNSAFE_DESTINATION = /[\\{}|^`"]/;

/**
 * Named character references that turn up in generated link destinations.
 * CommonMark accepts the full HTML5 entity list; this covers what
 * HTML-to-markdown converters actually emit into URLs, and anything else is
 * left as written rather than guessed at.
 */
const NAMED_REFERENCES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

const CHARACTER_REFERENCE = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/**
 * Decode the character references CommonMark resolves inside a link
 * destination. `[search](/search?a=1&amp;b=2)` navigates to `?a=1&b=2`, so
 * fetching the raw text would verify a different resource than the one the
 * link points at.
 */
export function decodeCharacterReferences(text: string): string {
  return text.replace(CHARACTER_REFERENCE, (match, body: string) => {
    if (body[0] !== '#') return NAMED_REFERENCES[body] ?? match;
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return '\uFFFD';
    try {
      return String.fromCodePoint(code);
    } catch {
      return '\uFFFD';
    }
  });
}

/** Whether a URL's path promises markdown. Safe on anything unparseable. */
export function promisesMarkdownUrl(url: string): boolean {
  try {
    return MARKDOWN_EXTENSION.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function blankRun(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * Replace fenced code blocks and inline code spans with spaces of the same
 * length, so that example links inside code samples are not read as the
 * page's own links. Length is preserved so the result lines up with the
 * original.
 *
 * Fences are matched by scanning lines rather than with a backreference,
 * because CommonMark lets a closing fence be longer than its opener, and
 * because a fence nested inside a list item carries the list's indent.
 * Deeply indented fences are ordinary in tutorial documentation, and a fence
 * this function fails to recognize puts every example link inside it into
 * the scan. An opener is therefore accepted at any indent: within served
 * markdown, a line that is nothing but three or more backticks or tildes is
 * a fence, and erring toward blanking costs recall while erring the other
 * way invents broken links.
 */
function blankCode(text: string): string {
  const lines = text.split('\n');
  let open: { char: string; length: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);

    if (open) {
      // Everything inside an open fence is blanked, whatever it contains.
      // The table-cell guard below must not reach here: a fenced shell
      // example such as `cat x | grep '[a](../b.md)'` would otherwise stay
      // in the scan and fail the page on a link that is sample code.
      lines[i] = blankRun(line);
      if (
        match &&
        match[1][0] === open.char &&
        match[1].length >= open.length &&
        match[2].trim() === ''
      ) {
        open = null;
      }
      continue;
    }

    if (!match) continue;
    // Fences inside markdown table cells are a vendor extension, not real
    // CommonMark fences; `markdown-code-fence-validity` skips them too. This
    // only prevents *opening* a fence.
    if (line.includes('|')) continue;
    // A backtick fence's info string may not itself contain a backtick.
    if (match[1][0] === '`' && match[2].includes('`')) continue;
    open = { char: match[1][0], length: match[1].length };
    lines[i] = blankRun(line);
  }

  // An unclosed fence runs to the end of the document, per CommonMark, so
  // whatever followed it has already been blanked.
  return blankCodeSpans(lines.join('\n'));
}

/**
 * Blank inline code spans the way CommonMark delimits them: a backtick
 * string of length N opens a span, the next backtick string of exactly
 * length N closes it, and the span may run across lines. A backtick run with
 * no matching closer is literal text, not a delimiter.
 *
 * A regex over single backticks on one line gets both directions wrong: a
 * double-backtick span wrapping a link on the following line stays visible
 * to the scanner and fails the page on sample code, while a backslash-escaped
 * backtick reads as a delimiter and can hide a real link.
 */
function blankCodeSpans(text: string): string {
  const out = text.split('');
  let i = 0;

  while (i < text.length) {
    if (text[i] !== '`' || isEscapedAt(text, i)) {
      i++;
      continue;
    }
    const start = i;
    while (i < text.length && text[i] === '`') i++;
    const runLength = i - start;

    let j = i;
    let closed = false;
    while (j < text.length) {
      if (text[j] !== '`' || isEscapedAt(text, j)) {
        j++;
        continue;
      }
      const runStart = j;
      while (j < text.length && text[j] === '`') j++;
      if (j - runStart === runLength) {
        for (let k = start; k < j; k++) {
          if (out[k] !== '\n') out[k] = ' ';
        }
        i = j;
        closed = true;
        break;
      }
    }
    if (!closed) i = start + runLength;
  }

  return out.join('');
}

/** True when the character at `i` is preceded by an odd run of backslashes. */
function isEscapedAt(text: string, i: number): boolean {
  let count = 0;
  for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) count++;
  return count % 2 === 1;
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}

interface RawLink {
  text: string;
  destination: string;
  isImage: boolean;
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * CommonMark backslash escapes apply to ASCII punctuation only. `\w` is a
 * literal backslash followed by `w`, not an escaped `w`, which is what keeps
 * a regex literal in an MDX preamble from unescaping into a plausible URL.
 */
const ASCII_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

function isEscape(text: string, i: number): boolean {
  return text[i] === '\\' && i + 1 < text.length && ASCII_PUNCTUATION.test(text[i + 1]);
}

/**
 * Read a CommonMark inline-link destination starting just after the `(`.
 *
 * Two forms: an angle-bracket destination, which may contain spaces, and a
 * bare destination, which runs to whitespace or to the closing paren and may
 * contain balanced parentheses. Getting the second right matters: a regex
 * that stops at the first `)` turns
 * `https://host/chapter_(draft).md` into `https://host/chapter_(draft`, and
 * this check would then fetch that truncated URL and report a broken link
 * that does not exist.
 */
function readDestination(text: string, start: number): { value: string; end: number } | null {
  let i = start;
  while (i < text.length && isSpace(text[i])) i++;

  let value = '';
  if (text[i] === '<') {
    i++;
    while (i < text.length && text[i] !== '>' && text[i] !== '\n') {
      if (isEscape(text, i)) {
        value += text[i + 1];
        i += 2;
        continue;
      }
      value += text[i++];
    }
    if (text[i] !== '>') return null;
    i++;
  } else {
    let depth = 0;
    while (i < text.length) {
      const ch = text[i];
      if (isSpace(ch)) break;
      if (isEscape(text, i)) {
        value += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
      value += ch;
      i++;
    }
    // An unbalanced `(` means the destination was never closed; treating what
    // was read as a URL is how a truncated target becomes a phantom 404.
    if (depth !== 0) return null;
  }

  while (i < text.length && isSpace(text[i])) i++;
  const quote = text[i];
  if (quote === '"' || quote === "'" || quote === '(') {
    const closer = quote === '(' ? ')' : quote;
    i++;
    while (i < text.length && text[i] !== closer) {
      if (text[i] === '\\') {
        i += 2;
        continue;
      }
      i++;
    }
    if (text[i] !== closer) return null;
    i++;
    while (i < text.length && isSpace(text[i])) i++;
  }

  if (text[i] !== ')') return null;
  return { value, end: i + 1 };
}

/**
 * Collect inline links and images (`[text](dest)`, `![alt](src)`) in document
 * order. Reference definitions and autolinks are deliberately not collected:
 * see `scanMarkdownLinks`.
 */
function scanInlineLinks(text: string): RawLink[] {
  const found: RawLink[] = [];
  let i = 0;

  while (i < text.length) {
    const open = text.indexOf('[', i);
    if (open === -1) break;
    // CommonMark renders `\[example](../x)` as literal text, so an escaped
    // bracket opens nothing. Without this, documentation that shows escaped
    // markdown syntax is graded on its own examples.
    if (isEscapedAt(text, open)) {
      i = open + 1;
      continue;
    }

    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      const ch = text[j];
      if (isEscape(text, j)) {
        j += 2;
        continue;
      }
      if (ch === '[') depth++;
      else if (ch === ']') depth--;
      j++;
    }
    if (depth !== 0 || text[j] !== '(') {
      i = open + 1;
      continue;
    }

    const label = text.slice(open + 1, j - 1);
    // A link label may not span a blank line; without this a stray `[` runs
    // the bracket scan across half the document.
    if (label.includes('\n\n')) {
      i = open + 1;
      continue;
    }

    const destination = readDestination(text, j + 1);
    if (!destination) {
      i = open + 1;
      continue;
    }

    const isImage = open > 0 && text[open - 1] === '!';
    found.push({ text: label, destination: destination.value, isImage });
    // An image inside link text (a badge linking somewhere) still counts as
    // an image; the label is not rescanned for anything else.
    if (!isImage && label.includes('![')) {
      for (const nested of scanInlineLinks(label)) {
        if (nested.isImage) found.push(nested);
      }
    }
    i = destination.end;
  }

  return found;
}

export function classifyLink(url: string): LinkClass {
  if (url.startsWith('#')) return 'fragment';
  if (/^https?:\/\//i.test(url)) return 'absolute';
  if (url.startsWith('//')) return 'protocol-relative';
  if (SCHEME.test(url)) return 'other-scheme';
  if (url.startsWith('/')) return 'root-relative';
  return 'path-relative';
}

function describe(rawUrl: string, text: string, baseUrl: string): MarkdownLink | null {
  const url = decodeCharacterReferences(rawUrl.trim());
  if (url === '' || UNSAFE_DESTINATION.test(url)) return null;

  const linkClass = classifyLink(url);
  const link: MarkdownLink = {
    url,
    text: shorten(text),
    class: linkClass,
    unresolvable: false,
    crossOrigin: false,
    promisesMarkdown: false,
  };
  if (linkClass === 'fragment' || linkClass === 'other-scheme') return link;

  try {
    const resolved = new URL(url, baseUrl);
    link.resolvedUrl = resolved.toString();
    resolved.hash = '';
    link.fetchUrl = resolved.toString();
    link.crossOrigin = resolved.origin !== new URL(baseUrl).origin;
    link.promisesMarkdown = MARKDOWN_EXTENSION.test(resolved.pathname);
  } catch {
    // A destination that should have resolved and didn't is as unusable as a
    // 404. It is reported rather than dropped, so a page whose only link is
    // `https://[` cannot pass as fully portable.
    link.unresolvable = true;
  }
  return link;
}

/**
 * Extract and classify the links in a markdown response.
 *
 * Only inline links are collected, which is what generated markdown emits.
 * Autolinks and bare URLs are absolute by construction and would only pad
 * the absolute count; reference definitions (`[label]: url`) are rare
 * outside hand-authored prose.
 */
export function scanMarkdownLinks(content: string, baseUrl: string): MarkdownLinkScan {
  const links: MarkdownLink[] = [];
  const images: MarkdownLink[] = [];
  const seenLinks = new Set<string>();
  const seenImages = new Set<string>();

  for (const raw of scanInlineLinks(blankCode(content))) {
    const link = describe(raw.destination, raw.text, baseUrl);
    if (!link) continue;
    const [bucket, seen] = raw.isImage
      ? ([images, seenImages] as const)
      : ([links, seenLinks] as const);
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    bucket.push(link);
  }

  return { links, images };
}

/** Tally of links by class, for reporting. */
export interface LinkClassCounts {
  absolute: number;
  protocolRelative: number;
  rootRelative: number;
  pathRelative: number;
  fragment: number;
  otherScheme: number;
  /** Cross-origin links, counted again here; every one of them is absolute. */
  crossOrigin: number;
  /** Links whose destination never parsed as a URL. */
  unresolvable: number;
  total: number;
}

export function countByClass(links: MarkdownLink[]): LinkClassCounts {
  const counts: LinkClassCounts = {
    absolute: 0,
    protocolRelative: 0,
    rootRelative: 0,
    pathRelative: 0,
    fragment: 0,
    otherScheme: 0,
    crossOrigin: 0,
    unresolvable: 0,
    total: links.length,
  };
  for (const link of links) {
    switch (link.class) {
      case 'absolute':
        counts.absolute++;
        break;
      case 'protocol-relative':
        counts.protocolRelative++;
        break;
      case 'root-relative':
        counts.rootRelative++;
        break;
      case 'path-relative':
        counts.pathRelative++;
        break;
      case 'fragment':
        counts.fragment++;
        break;
      case 'other-scheme':
        counts.otherScheme++;
        break;
    }
    if (link.crossOrigin) counts.crossOrigin++;
    if (link.unresolvable) counts.unresolvable++;
  }
  return counts;
}
