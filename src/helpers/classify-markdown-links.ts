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

import type { Nodes } from 'mdast';
import { parseMarkdown } from './parse-markdown.js';

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
  /** The destination after CommonMark escape and entity decoding. */
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
  /** Links an agent would follow, in document order, deduplicated by decoded URL. */
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

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}

/** A link as written, before classification: where it sits and what it points at. */
export interface RawMarkdownLink {
  text: string;
  /** Destination decoded once by CommonMark, not a slice of the source. */
  destination: string;
  isImage: boolean;
  /** Offset of the opening `[` (or the `!` of an image) in the scanned text. */
  offset: number;
  /** Offset just past the link's last character. */
  end: number;
}

function linkText(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  if (node.type === 'break') return '\n';
  return 'children' in node ? node.children.map(linkText).join('') : '';
}

/**
 * Scan a markdown document for the links an agent could follow, without
 * classifying them. Code, HTML comments and reference definitions are
 * blanked in a same-length copy, preserving CR/LF and original UTF-16 offsets.
 * Destinations and labels use CommonMark decoding; autolinks are excluded.
 */
export function scanRawLinks(content: string): { links: RawMarkdownLink[]; blanked: string } {
  const tree = parseMarkdown(content);
  const definitions = new Map<string, string>();
  const links: RawMarkdownLink[] = [];
  const blanked = content.split('');

  const collectDefinitions = (node: Nodes): void => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
    if ('children' in node) node.children.forEach(collectDefinitions);
  };
  collectDefinitions(tree);

  const visit = (node: Nodes): void => {
    const offset = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (offset === undefined || end === undefined) return;

    if (
      node.type === 'code' ||
      node.type === 'inlineCode' ||
      node.type === 'definition' ||
      (node.type === 'html' && node.value.trimStart().startsWith('<!--'))
    ) {
      for (let index = offset; index < end; index++) {
        if (blanked[index] !== '\n' && blanked[index] !== '\r') blanked[index] = ' ';
      }
      return;
    }

    if (
      node.type === 'link' ||
      node.type === 'image' ||
      node.type === 'linkReference' ||
      node.type === 'imageReference'
    ) {
      const destination = 'url' in node ? node.url : definitions.get(node.identifier);
      if (destination !== undefined && content[offset] !== '<') {
        links.push({
          text: linkText(node),
          destination,
          isImage: node.type === 'image' || node.type === 'imageReference',
          offset,
          end,
        });
      }
    }
    if ('children' in node) node.children.forEach(visit);
  };
  visit(tree);
  return { links, blanked: blanked.join('') };
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
  const url = rawUrl.trim();
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
 * Inline links (what generated markdown emits) and reference-style links
 * (what hand-authored markdown served as-is may use) are both collected.
 * Autolinks and bare URLs are absolute by construction and would only pad
 * the absolute count, so they are not.
 */
export function scanMarkdownLinks(content: string, baseUrl: string): MarkdownLinkScan {
  const links: MarkdownLink[] = [];
  const images: MarkdownLink[] = [];
  const seenLinks = new Set<string>();
  const seenImages = new Set<string>();

  for (const raw of scanRawLinks(content).links) {
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
