import { looksLikeHtml } from './detect-markdown.js';
import type { CheckContext, FetchedPage } from '../types.js';

/**
 * Fetch a page URL, returning the body and content-type metadata.
 * Results are cached on `ctx.htmlCache` so that multiple checks
 * within the same run avoid redundant HTTP requests.
 */
export async function fetchPage(ctx: CheckContext, url: string): Promise<FetchedPage> {
  const cached = ctx.htmlCache.get(url);
  if (cached) return cached;

  const response = await ctx.http.fetch(url);
  const { text: body, bytes } = response.body
    ? await response.body()
    : await response.text().then((text) => ({ text, bytes: Buffer.byteLength(text, 'utf8') }));
  const contentType = response.headers.get('content-type') ?? '';
  const isMarkdownType =
    contentType.includes('text/markdown') || contentType.includes('text/plain');
  const isHtml = !isMarkdownType && (contentType.includes('text/html') || looksLikeHtml(body));

  const result: FetchedPage = { url, status: response.status, body, contentType, isHtml, bytes };

  // Node's fetch decodes the body but leaves the wire headers in place, so
  // Content-Length on an encoded response is the compressed size.
  const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') {
    result.contentEncoding = contentEncoding;
    const length = Number(response.headers.get('content-length'));
    if (Number.isInteger(length) && length > 0) result.wireBytes = length;
  }

  ctx.htmlCache.set(url, result);
  return result;
}
