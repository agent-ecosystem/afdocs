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

import { extractMarkdownLinks } from '../checks/content-discoverability/llms-txt-valid.js';

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

/** `![alt](src)`, including the empty-alt form `![](src)`. */
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g;

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
 */
const UNSAFE_DESTINATION = /[\\<>{}|^`"]/;

/**
 * Replace fenced code blocks and inline code spans with spaces of the same
 * length, so that example links inside code samples are not read as the
 * page's own links. Length is preserved to keep the remaining offsets usable.
 */
function blankCode(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, blank)
    .replace(/`[^`\n]+`/g, blank);
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}

/**
 * Strip a CommonMark angle-bracket destination (`[text](<a url>)`) and any
 * surrounding whitespace, leaving the URL itself.
 */
function normalizeDestination(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed.slice(1, -1).trim();
  return trimmed.replace(/^</, '').replace(/>$/, '');
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
  const url = normalizeDestination(rawUrl);
  if (url === '' || UNSAFE_DESTINATION.test(url)) return null;

  const linkClass = classifyLink(url);
  const link: MarkdownLink = {
    url,
    text: shorten(text),
    class: linkClass,
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
    // An unresolvable destination (a malformed URL, or a base that is not a
    // URL) stays classified but unresolved; callers never sample it.
  }
  return link;
}

/**
 * Extract and classify the links in a markdown response.
 *
 * Only inline links (`[text](url)`) are collected, which is what generated
 * markdown emits. Autolinks and bare URLs are absolute by construction and
 * would only pad the absolute count; reference definitions (`[label]: url`)
 * are rare outside hand-authored prose.
 */
export function scanMarkdownLinks(content: string, baseUrl: string): MarkdownLinkScan {
  const blanked = blankCode(content);

  const images: MarkdownLink[] = [];
  const seenImages = new Set<string>();
  const withoutImages = blanked.replace(MARKDOWN_IMAGE, (match, src: string) => {
    const image = describe(src, '', baseUrl);
    if (image && !seenImages.has(image.url)) {
      seenImages.add(image.url);
      images.push(image);
    }
    return match.replace(/[^\n]/g, ' ');
  });

  const links: MarkdownLink[] = [];
  const seen = new Set<string>();
  for (const { name, url } of extractMarkdownLinks(withoutImages)) {
    const link = describe(url, name, baseUrl);
    if (!link || seen.has(link.url)) continue;
    seen.add(link.url);
    links.push(link);
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
  }
  return counts;
}
