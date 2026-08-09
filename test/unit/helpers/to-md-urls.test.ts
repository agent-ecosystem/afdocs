import { describe, it, expect } from 'vitest';
import {
  isCrossHostRedirect,
  isMdUrl,
  toHtmlUrl,
  toMdUrls,
} from '../../../src/helpers/to-md-urls.js';

describe('toMdUrls', () => {
  it('returns URL as-is when it already ends in .md', () => {
    expect(toMdUrls('https://example.com/docs/guide.md')).toEqual([
      'https://example.com/docs/guide.md',
    ]);
  });

  it('generates path.md and path/index.md candidates', () => {
    expect(toMdUrls('https://example.com/docs/guide')).toEqual([
      'https://example.com/docs/guide.md',
      'https://example.com/docs/guide/index.md',
    ]);
  });

  it('strips trailing slash before generating candidates', () => {
    expect(toMdUrls('https://example.com/docs/')).toEqual([
      'https://example.com/docs.md',
      'https://example.com/docs/index.md',
    ]);
  });

  it('strips .html extension before appending .md', () => {
    expect(toMdUrls('https://example.com/guide.html')).toEqual([
      'https://example.com/guide.md',
      'https://example.com/guide.html/index.md',
    ]);
  });

  it('strips .htm extension before appending .md', () => {
    expect(toMdUrls('https://example.com/guide.htm')).toEqual([
      'https://example.com/guide.md',
      'https://example.com/guide.htm/index.md',
    ]);
  });

  it('handles root URL', () => {
    const result = toMdUrls('https://example.com/');
    expect(result).toEqual(['https://example.com/.md', 'https://example.com/index.md']);
  });

  it('preserves query and fragment', () => {
    const result = toMdUrls('https://example.com/docs/guide?v=2');
    expect(result[0]).toBe('https://example.com/docs/guide.md?v=2');
  });

  it('returns URL as-is when it already ends in .mdx', () => {
    expect(toMdUrls('https://example.com/docs/guide.mdx')).toEqual([
      'https://example.com/docs/guide.mdx',
    ]);
  });

  it('returns empty array for .txt files', () => {
    expect(toMdUrls('https://example.com/docs/llms.txt')).toEqual([]);
  });

  it('returns empty array for .json files', () => {
    expect(toMdUrls('https://example.com/api/schema.json')).toEqual([]);
  });

  it('returns empty array for .xml files', () => {
    expect(toMdUrls('https://example.com/sitemap.xml')).toEqual([]);
  });

  // Regression: issue #77 — Plaid-style /page/index.html.md URLs from llms.txt
  it('returns .html.md URL as-is (already a markdown URL)', () => {
    expect(toMdUrls('https://example.com/docs/auth/index.html.md')).toEqual([
      'https://example.com/docs/auth/index.html.md',
    ]);
  });

  // Invariant for issue #77 fix: parent-clean .md candidate generation
  // (e.g. /docs/auth/index.html → /docs/auth.md) lives in markdown-url-support
  // only, gated by an originalMdUrl signal from llms.txt. It must NOT be added
  // to toMdUrls() — that would re-introduce the false-positive class where
  // checks like llms-txt-directive-md and llms-txt-links-markdown pass via
  // unrelated sibling .md files. If you need the parent-clean form, add it
  // at the call site, not here.
  it('does NOT generate /foo.md candidate from /foo/index.html (issue #77 isolation)', () => {
    const result = toMdUrls('https://example.com/docs/auth/index.html');
    expect(result).not.toContain('https://example.com/docs/auth.md');
  });

  it('does NOT generate /foo.md candidate from /foo/index.htm (issue #77 isolation)', () => {
    const result = toMdUrls('https://example.com/docs/auth/index.htm');
    expect(result).not.toContain('https://example.com/docs/auth.md');
  });
});

describe('toHtmlUrl', () => {
  it('strips .md extension', () => {
    expect(toHtmlUrl('https://example.com/docs/guide.md')).toBe('https://example.com/docs/guide');
  });

  it('converts index.md to trailing slash', () => {
    expect(toHtmlUrl('https://example.com/docs/guide/index.md')).toBe(
      'https://example.com/docs/guide/',
    );
  });

  it('strips .mdx extension', () => {
    expect(toHtmlUrl('https://example.com/docs/guide.mdx')).toBe('https://example.com/docs/guide');
  });

  it('converts index.mdx to trailing slash', () => {
    expect(toHtmlUrl('https://example.com/docs/guide/index.mdx')).toBe(
      'https://example.com/docs/guide/',
    );
  });

  it('returns non-.md URLs unchanged', () => {
    expect(toHtmlUrl('https://example.com/docs/guide')).toBe('https://example.com/docs/guide');
  });

  it('returns malformed URLs unchanged', () => {
    expect(toHtmlUrl('not-a-url')).toBe('not-a-url');
  });

  describe('html pattern', () => {
    it('replaces .md with .html', () => {
      expect(toHtmlUrl('https://example.com/docs/guide.md', 'html')).toBe(
        'https://example.com/docs/guide.html',
      );
    });

    it('replaces .mdx with .html', () => {
      expect(toHtmlUrl('https://example.com/docs/guide.mdx', 'html')).toBe(
        'https://example.com/docs/guide.html',
      );
    });

    it('does not double the extension for .html.md URLs', () => {
      expect(toHtmlUrl('https://example.com/docs/guide.html.md', 'html')).toBe(
        'https://example.com/docs/guide.html',
      );
    });

    it('converts index.md to index.html', () => {
      expect(toHtmlUrl('https://example.com/docs/guide/index.md', 'html')).toBe(
        'https://example.com/docs/guide/index.html',
      );
    });

    it('returns non-.md URLs unchanged', () => {
      expect(toHtmlUrl('https://example.com/docs/guide', 'html')).toBe(
        'https://example.com/docs/guide',
      );
    });
  });

  describe('md pattern', () => {
    it('keeps .md URLs as-is', () => {
      expect(toHtmlUrl('https://example.com/docs/guide.md', 'md')).toBe(
        'https://example.com/docs/guide.md',
      );
    });

    it('keeps index.md URLs as-is', () => {
      expect(toHtmlUrl('https://example.com/docs/guide/index.md', 'md')).toBe(
        'https://example.com/docs/guide/index.md',
      );
    });
  });
});

describe('isMdUrl', () => {
  it('returns true for .md URLs', () => {
    expect(isMdUrl('https://example.com/docs/guide.md')).toBe(true);
  });

  it('returns true for .mdx URLs', () => {
    expect(isMdUrl('https://example.com/docs/guide.mdx')).toBe(true);
  });

  it('returns false for non-.md URLs', () => {
    expect(isMdUrl('https://example.com/docs/guide')).toBe(false);
  });

  it('returns false for .md in path but not as extension', () => {
    expect(isMdUrl('https://example.com/docs/markdown/guide')).toBe(false);
  });

  it('returns false for malformed URLs', () => {
    expect(isMdUrl('not-a-url')).toBe(false);
  });
});

describe('isCrossHostRedirect', () => {
  it('returns false for same host', () => {
    expect(isCrossHostRedirect('https://example.com/a', 'https://example.com/b')).toBe(false);
  });

  it('returns false for www to bare domain', () => {
    expect(isCrossHostRedirect('https://www.example.com/a', 'https://example.com/a')).toBe(false);
  });

  it('returns false for bare domain to www', () => {
    expect(
      isCrossHostRedirect(
        'https://mongodb.com/docs/llms.txt',
        'https://www.mongodb.com/docs/llms.txt',
      ),
    ).toBe(false);
  });

  it('returns true for genuinely different hosts', () => {
    expect(isCrossHostRedirect('https://example.com/a', 'https://other.com/a')).toBe(true);
  });

  it('returns true for different subdomains (not www)', () => {
    expect(isCrossHostRedirect('https://docs.example.com/a', 'https://api.example.com/a')).toBe(
      true,
    );
  });

  it('returns false for malformed URLs', () => {
    expect(isCrossHostRedirect('not-a-url', 'https://example.com')).toBe(false);
  });
});
