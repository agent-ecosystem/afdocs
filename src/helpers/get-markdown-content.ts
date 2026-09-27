import { extractMarkdownLinks } from '../checks/content-discoverability/llms-txt-valid.js';
import { looksLikeMarkdown } from './detect-markdown.js';
import { isSoft404Body } from './detect-soft-404.js';
import { discoverAndSamplePages, filterByPathPrefix, getPathFilterBase } from './get-page-urls.js';
import { getLlmsTxtFilesForAnalysis } from './llms-txt.js';
import { toMdUrls } from './to-md-urls.js';
import type { CheckContext, DiscoveredFile } from '../types.js';

export interface MarkdownPage {
  url: string;
  content: string;
  source: string;
  /**
   * The URL that served the markdown, when known: the final URL after any
   * redirect. Relative links inside the content resolve against this. It
   * differs from `url` for `.md` variants cached under the page URL and
   * for anything that redirected.
   */
  mdUrl?: string;
  /** Raw `Link` response header, when the server sent one. */
  linkHeader?: string;
}

export type MarkdownContentResult =
  | { mode: 'cached'; pages: MarkdownPage[]; depPassed: boolean }
  | { mode: 'standalone'; pages: MarkdownPage[] };

/**
 * Get markdown content for analysis, either from dependency cache or by fetching directly.
 *
 * When markdown-url-support or content-negotiation have already run, reads from
 * ctx.pageCache (fast). Otherwise, discovers pages and probes for markdown itself.
 * Always includes llms.txt content when available.
 */
export async function getMarkdownContent(ctx: CheckContext): Promise<MarkdownContentResult> {
  const mdUrlResult = ctx.previousResults.get('markdown-url-support');
  const cnResult = ctx.previousResults.get('content-negotiation');
  const depRan = mdUrlResult || cnResult;

  const llmsTxtPages = collectLlmsTxtContent(ctx);

  if (depRan) {
    const depPassed =
      (mdUrlResult && (mdUrlResult.status === 'pass' || mdUrlResult.status === 'warn')) ||
      (cnResult && (cnResult.status === 'pass' || cnResult.status === 'warn'));

    const cachedPages = collectCachedPages(ctx);
    return { mode: 'cached', pages: [...cachedPages, ...llmsTxtPages], depPassed: !!depPassed };
  }

  // Standalone mode: fetch markdown ourselves
  const fetchedPages = await fetchMarkdownPages(ctx);
  return { mode: 'standalone', pages: [...fetchedPages, ...llmsTxtPages] };
}

function collectCachedPages(ctx: CheckContext): MarkdownPage[] {
  const pages: MarkdownPage[] = [];
  for (const [url, cached] of ctx.pageCache) {
    if (cached.markdown?.content) {
      const { content, source, mdUrl, linkHeader } = cached.markdown;
      pages.push({
        url,
        content,
        source,
        ...(mdUrl && { mdUrl }),
        ...(linkHeader && { linkHeader }),
      });
    }
  }
  return pages;
}

function collectLlmsTxtContent(ctx: CheckContext): MarkdownPage[] {
  const existsResult = ctx.previousResults.get('llms-txt-exists');
  const discovered = (existsResult?.details?.discoveredFiles ?? []) as DiscoveredFile[];
  const pages: MarkdownPage[] = [];
  for (const file of discovered) {
    if (file.content) {
      pages.push({ url: file.url, content: file.content, source: 'llms-txt' });
    }
  }
  return pages;
}

async function fetchMarkdownPages(ctx: CheckContext): Promise<MarkdownPage[]> {
  const pages: MarkdownPage[] = [];
  const { urls: pageUrls } = await discoverAndSamplePages(ctx);
  const concurrency = ctx.options.maxConcurrency;

  for (let i = 0; i < pageUrls.length; i += concurrency) {
    const batch = pageUrls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url): Promise<MarkdownPage | null> => {
        // Try .md URL candidates
        const candidates = toMdUrls(url);
        for (const candidateUrl of candidates) {
          try {
            const response = await ctx.http.fetch(candidateUrl);
            if (!response.ok) continue;
            const body = await response.text();
            if (looksLikeMarkdown(body)) {
              const linkHeader = response.headers.get('link');
              return {
                url: candidateUrl,
                content: body,
                source: 'standalone-md-url',
                mdUrl: response.url || candidateUrl,
                ...(linkHeader && { linkHeader }),
              };
            }
          } catch {
            // Try next candidate
          }
        }

        // Try content negotiation
        try {
          const response = await ctx.http.fetch(url, {
            headers: { Accept: 'text/markdown' },
          });
          if (response.ok) {
            const body = await response.text();
            if (looksLikeMarkdown(body)) {
              const linkHeader = response.headers.get('link');
              return {
                url,
                content: body,
                source: 'standalone-content-negotiation',
                mdUrl: response.url || url,
                ...(linkHeader && { linkHeader }),
              };
            }
          }
        } catch {
          // No markdown available for this page
        }

        return null;
      }),
    );

    for (const r of batchResults) {
      if (r) pages.push(r);
    }
  }

  return pages;
}

/**
 * Markdown reached through `llms.txt` links alone, for sites that publish
 * agent-facing markdown without page-level `.md` variants or content
 * negotiation. Same-origin links under the base path are fetched as
 * published and kept when the response is markdown by content type or by
 * shape. A link that already carries a `.md` or `.mdx` extension is fetched
 * without `Accept: text/markdown`, because the path is already the request
 * for that representation and some servers answer the header with a 404;
 * extensionless links are negotiated. Extension-qualified links are tried
 * first; the total is capped at `maxLinksToTest`, taken in file order so
 * repeated runs test the same set.
 *
 * The result is memoized on the context: `single-fetch-completeness` and
 * `markdown-link-portability` both fall back to it when the page cache is
 * empty, and the second caller must not fetch the same pages again.
 */
export async function fetchLlmsTxtLinkedMarkdown(ctx: CheckContext): Promise<MarkdownPage[]> {
  if (ctx._llmsTxtLinkedMarkdown) return ctx._llmsTxtLinkedMarkdown;
  const pages = await fetchLlmsTxtLinkedMarkdownUncached(ctx);
  ctx._llmsTxtLinkedMarkdown = pages;
  return pages;
}

async function fetchLlmsTxtLinkedMarkdownUncached(ctx: CheckContext): Promise<MarkdownPage[]> {
  const existsResult = ctx.previousResults.get('llms-txt-exists');
  const files = getLlmsTxtFilesForAnalysis(existsResult);
  if (files.length === 0) return [];

  const linked = new Set<string>();
  for (const file of files) {
    for (const link of extractMarkdownLinks(file.content)) {
      if (/^https?:\/\//i.test(link.url)) linked.add(link.url);
    }
  }

  const siteOrigin = ctx.effectiveOrigin ?? ctx.origin;
  const scoped = filterByPathPrefix(Array.from(linked), getPathFilterBase(ctx)).filter((url) => {
    try {
      return new URL(url).origin === siteOrigin;
    } catch {
      return false;
    }
  });
  const hasMdExtension = (url: string) => /\.mdx?$/i.test(new URL(url).pathname);
  const candidates = [
    ...scoped.filter((url) => hasMdExtension(url)),
    ...scoped.filter((url) => !hasMdExtension(url)),
  ].slice(0, ctx.options.maxLinksToTest);

  const pages: MarkdownPage[] = [];
  const concurrency = ctx.options.maxConcurrency;
  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url): Promise<MarkdownPage | null> => {
        try {
          const response = hasMdExtension(url)
            ? await ctx.http.fetch(url)
            : await ctx.http.fetch(url, { headers: { Accept: 'text/markdown' } });
          if (!response.ok) return null;
          const body = await response.text();
          const contentType = response.headers.get('content-type') ?? '';
          const isMarkdown = contentType.includes('text/markdown') || looksLikeMarkdown(body);
          if (!isMarkdown || isSoft404Body(body)) return null;
          const linkHeader = response.headers.get('link');
          return {
            url,
            content: body,
            source: 'llms-txt-link',
            mdUrl: response.url || url,
            ...(linkHeader && { linkHeader }),
          };
        } catch {
          return null;
        }
      }),
    );
    for (const page of batchResults) {
      if (page) pages.push(page);
    }
  }
  return pages;
}
