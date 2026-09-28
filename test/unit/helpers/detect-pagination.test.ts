import { describe, it, expect } from 'vitest';
import { detectPagination, parseLinkHeaderNext } from '../../../src/helpers/detect-pagination.js';

const BASE = 'https://docs.example.com/models.md';

describe('parseLinkHeaderNext', () => {
  it('returns the rel="next" target', () => {
    expect(parseLinkHeaderNext('<https://x/models?page=2>; rel="next"')).toBe(
      'https://x/models?page=2',
    );
  });

  it('handles multiple links, unquoted rel, and multi-valued rel', () => {
    const header =
      '</models?page=1>; rel=prev, </models?page=3>; rel="next last", </models>; rel=self';
    expect(parseLinkHeaderNext(header)).toBe('/models?page=3');
  });

  it('returns null when no next link exists', () => {
    expect(parseLinkHeaderNext('<https://x/models>; rel="canonical"')).toBeNull();
    expect(parseLinkHeaderNext(null)).toBeNull();
    expect(parseLinkHeaderNext('')).toBeNull();
  });
});

describe('detectPagination', () => {
  describe('complete content', () => {
    it('finds nothing in ordinary documentation', () => {
      const content = `# Install\n\nRun the installer, then [configure](./configure.md) the client.\n\n## Step 2 of 5\n\nPart 1 of 3 covers setup.`;
      const result = detectPagination(content, { baseUrl: BASE });
      expect(result.signals).toEqual([]);
      expect(result.continuation).toBeUndefined();
    });

    it('ignores prev/next navigation between separate pages', () => {
      const content = `# Guide\n\nBody.\n\n[Previous](/docs/intro) · [Next](/docs/advanced)\n\n[Next: Deployment →](/docs/deploy.md)`;
      const result = detectPagination(content, { baseUrl: 'https://docs.example.com/guide.md' });
      expect(result.signals).toEqual([]);
    });

    it('ignores paging parameters inside code blocks and inline code', () => {
      const content = [
        '# List items',
        '',
        'Use `GET /v1/items?page=2` to fetch the next page of results.',
        '',
        '```http',
        'GET https://api.example.com/v1/items?offset=100',
        'Link: <https://api.example.com/v1/items?offset=200>; rel="next"',
        '```',
        '',
        'Showing 2 of 2 examples.',
      ].join('\n');
      const result = detectPagination(content, { baseUrl: BASE });
      expect(result.signals).toEqual([]);
    });

    it('ignores paging links to other hosts (API references documenting pagination)', () => {
      const content = `# Pagination\n\nSee [the second page](https://api.example.com/v1/items?page=2) of the API response.`;
      const result = detectPagination(content, { baseUrl: BASE });
      expect(result.signals).toEqual([]);
    });

    it('ignores "N of M" phrasing embedded in a sentence', () => {
      // Seen in the field: afdocs.dev's own checks index explaining proportional scoring.
      const content = [
        '# Checks',
        '',
        'For checks that test multiple pages, results are proportional. If 3 out of 50 pages fail, the check scores ~94% of its weight.',
        'The cache served 12 of 20 results, and page 2 of 5 in the wizard shows the token.',
      ].join('\n');
      expect(detectPagination(content, { baseUrl: BASE }).signals).toEqual([]);
    });

    it.each([64, 72, 80, 100, 200])(
      'ignores illustrative prose hard-wrapped at %i columns',
      (width) => {
        const paragraph =
          'For checks that test multiple pages, results are proportional. If 3 out of 50 pages fail, ' +
          'the check scores ~94% of its weight. The cache served 12 of 20 results, and page 2 of 5 ' +
          'in the wizard shows the token.';
        const lines = [''];
        for (const word of paragraph.split(' ')) {
          const last = lines.length - 1;
          if (!lines[last]) lines[last] = word;
          else if (lines[last].length + word.length + 1 <= width) lines[last] += ` ${word}`;
          else lines.push(word);
        }
        const content = `# Checks\n\n${lines.join('\n')}`;
        expect(detectPagination(content, { baseUrl: BASE }).signals).toEqual([]);
      },
    );

    it.each([
      "Observed on a catalog's markdown\nvariant: 100 of 102 entries shown, a note at the bottom.",
      "Observed on a catalog's markdown variant:\n100 of 102 entries shown, a note at the bottom.",
      'If\n3 out of 50 pages fail, the check scores 94%.',
      'The cache served\n12 of 20 results, and the wizard shows the token.',
      'Note: this listing is windowed,\nshowing 100 of 102 entries.',
      '- The cache served\n  12 of 20 results, and the wizard shows the token.',
      '> The cache served\n12 of 20 results, and the wizard shows the token.',
      'The cache served\n[previous results](/docs/cache)\n12 of 20 results.',
      'The cache served\n`cached entries`\n12 of 20 results.',
      'The cache served\r\n12 of 20 results, and the wizard shows the token.',
    ])('ignores a phrase on a continuation line of prose: %s', (content) => {
      expect(detectPagination(content, { baseUrl: BASE }).signals).toEqual([]);
    });

    it('accepts an "N of M" note behind blockquote, list, emphasis, table, or label prefixes', () => {
      for (const line of [
        '> Showing 100 of 102 models.',
        '- Page 1 of 3',
        '**Showing 1-50 of 200 results**',
        '| Showing 25 of 80 items |',
        'Note: 100 of 102 models shown.',
        '_Displaying 10 of 40 entries_',
      ]) {
        const result = detectPagination(`# Models\n\n${line}\n\n- a`, { baseUrl: BASE });
        expect(
          result.signals.map((s) => s.type),
          line,
        ).toEqual(['n-of-m']);
      }
    });

    it.each([
      '> The cache served\n> 12 of 20 results.',
      '>> The cache served\n>> 12 of 20 results.',
      '> - The cache served\n>   12 of 20 results.',
      '- > The cache served\n  > 12 of 20 results.',
      '[The cache served](/cache)\n12 of 20 results.',
      '`If`\n3 out of 50 pages fail, the check scores 94%.',
      'Showing 100 of\n\n102 models',
      'Showing 100 of\n```text\nUnrelated sample\n```\n102 models',
      'Showing 100 of\n- 102 models',
      '| Showing 100 of | 102 models |',
      'Showing 100 of `unrelated sample` 102 models',
      'Showing 100 of <!-- unrelated sample --> 102 models',
      '# Example\n\n    Showing 100 of 102 models.',
      '# Example\n\n\tShowing 100 of 102 models.',
      '<!--\n\nShowing 100 of 102 models.\n\n-->',
    ])('ignores non-declarations with either line ending: %s', (content) => {
      for (const lineEnding of ['\n', '\r\n']) {
        expect(
          detectPagination(content.replace(/\n/g, lineEnding), { baseUrl: BASE }).signals,
        ).toEqual([]);
      }
    });

    it.each(['    ', '\t', '>     '])(
      'ignores all pagination signals inside indented code: %j',
      (indent) => {
        const example =
          'Showing 100 of 102 models. [Next page](/models?page=2) Fetch /models?offset=100 or https://docs.example.com/models?cursor=next';
        const result = detectPagination(`# Example\n\n${indent}${example}`, { baseUrl: BASE });
        expect(result.signals).toEqual([]);
        expect(result.continuation).toBeUndefined();
      },
    );

    it.each([
      '<!-- Showing 100 of 102 models. [Next page](/models?page=2) -->',
      '<!--\n\nShowing 100 of 102 models.\nFetch /models?offset=100 or https://docs.example.com/models?cursor=next\n\n-->',
      '<!--\n\nShowing 100 of 102 models. [Next page](/models?page=2)',
    ])('ignores all pagination signals inside comments: %s', (content) => {
      const result = detectPagination(content, { baseUrl: BASE });
      expect(result.signals).toEqual([]);
      expect(result.continuation).toBeUndefined();
    });

    it('ignores image syntax whose alt text looks like a next link', () => {
      const content = `# Guide\n\n![Next page](/img/next-page.png)\n\n![](/img/a.png?page=2)`;
      expect(detectPagination(content, { baseUrl: BASE }).signals).toEqual([]);
    });

    it('ignores explicit "next page" links to other hosts', () => {
      const content = `# Pagination\n\nThe API returns a [next page](https://api.example.com/v1/items?page=2) link.`;
      expect(detectPagination(content, { baseUrl: BASE }).signals).toEqual([]);
    });

    it('survives malformed percent-encoding in a paging parameter', () => {
      const content = `# Models\n\n[2](/models?page=%) [next](/models?page=%32)`;
      const result = detectPagination(content, { baseUrl: BASE });
      // `%` is not a later window (NaN); `%32` decodes to page 2 and is.
      expect(result.signals.map((s) => s.url)).toEqual(['/models?page=%32']);
    });

    it('treats "N of M" with N >= M as complete', () => {
      const content = `# Models\n\nShowing 20 of 20 models.\n\nPage 3 of 3.`;
      expect(detectPagination(content, { baseUrl: BASE }).signals).toEqual([]);
    });

    it('does not treat a ?page=1 self link as a continuation', () => {
      const content = `# Models\n\n[1](/models?page=1)`;
      expect(detectPagination(content, { baseUrl: BASE }).signals).toEqual([]);
    });
  });

  describe('signals', () => {
    it.each([
      'Catalog status\n===\nShowing 25 of 80 items',
      'Catalog status\n---\nShowing 25 of 80 items',
      '> Other text.\n>\n> Showing 25 of 80 items',
      '> Note:\n> Showing 25 of 80 items',
      '>> Note:\n>> Showing 25 of 80 items',
      '> - Note:\n>   Showing 25 of 80 items',
      '- Other text.\n- Showing 25 of 80 items',
      '1. Other text.\n2. Showing 25 of 80 items',
      '- Note:\n    Showing 25 of 80 items',
      '> Showing 25 of\n> 80 items',
      '[Note:](/note) Showing 25 of 80 items',
      '[Showing 25 of 80 items](/models)',
      'Showing **25** of **80** items',
      '    An example.\n\nShowing 25 of 80 items',
      '<!-- An example. -->\n\nShowing 25 of 80 items',
    ])('preserves real notes and source offsets with either line ending: %s', (input) => {
      for (const lineEnding of ['\n', '\r\n']) {
        const content = input.replace(/\n/g, lineEnding);
        const result = detectPagination(content, { baseUrl: BASE });
        expect(result.signals).toEqual([
          { type: 'n-of-m', text: 'Showing 25 of 80', offset: content.indexOf('Showing') },
        ]);
      }
    });

    it.each([
      'Showing 25 of 80 items\nfrom the catalog.',
      '\nShowing 25 of 80 items\nfrom the catalog.',
      '# Models\nShowing 25 of 80 items',
      'Models\n===\nShowing 25 of 80 items',
      'Models\n---\nShowing 25 of 80 items',
      'Other text.\n\nShowing 25 of 80 items',
      'Other text.\n \t\nShowing 25 of 80 items',
      'Other text.\n## Showing 25 of 80 items',
      'Other text.\n> Showing 25 of 80 items\n> from the catalog.',
      '- Other item.\n- Showing 25 of 80 items\n  from the catalog.',
      '1. Other item.\n2. Showing 25 of 80 items\n   from the catalog.',
      '| Status |\n| --- |\n| Showing 25 of 80 items |',
      'Note:\nShowing 25 of 80 items',
      '- Note:\n  Showing 25 of 80 items',
      '> Note:\n> Showing 25 of 80 items',
      '**Showing 25 of 80 items\nfrom the catalog.**',
      '_Showing 25 of 80 items\nfrom the catalog._',
      '```text\nAn example.\n```\nShowing 25 of 80 items',
      '~~~text\nAn example.\n~~~\nShowing 25 of 80 items',
    ])('preserves a declaration and its offset across block boundaries: %s', (content) => {
      const result = detectPagination(content, { baseUrl: BASE });
      expect(result.signals).toEqual([
        { type: 'n-of-m', text: 'Showing 25 of 80', offset: content.indexOf('Showing') },
      ]);
      expect(result.continuation).toBeUndefined();
    });

    it('detects "N of M" phrasing without a link and reports no continuation', () => {
      const content = `# Models\n\n- a\n- b\n\nShowing 100 of 102 models.`;
      const result = detectPagination(content, { baseUrl: BASE });
      expect(result.signals).toHaveLength(1);
      expect(result.signals[0]).toMatchObject({ type: 'n-of-m', text: 'Showing 100 of 102' });
      expect(result.signals[0].offset).toBe(content.indexOf('Showing'));
      expect(result.continuation).toBeUndefined();
    });

    it('matches range phrasing and trailing-noun phrasing', () => {
      expect(detectPagination('Showing 1-100 of 102', { baseUrl: BASE }).signals[0]?.type).toBe(
        'n-of-m',
      );
      expect(
        detectPagination('Showing results 1 to 25 of 80', { baseUrl: BASE }).signals[0]?.type,
      ).toBe('n-of-m');
      expect(detectPagination('25 of 1,200 results', { baseUrl: BASE }).signals[0]?.type).toBe(
        'n-of-m',
      );
      expect(detectPagination('Page 1 of 5', { baseUrl: BASE }).signals[0]?.type).toBe('n-of-m');
    });

    it('detects a relative paging link and resolves it against the markdown URL', () => {
      const content = `# Models\n\n- a\n\nShowing 100 of 102 models. [Next page](/models?page=2)`;
      const result = detectPagination(content, { baseUrl: BASE });
      expect(result.signals.map((s) => s.type)).toEqual(['n-of-m', 'next-link']);
      expect(result.continuation).toMatchObject({
        url: '/models?page=2',
        resolvedUrl: 'https://docs.example.com/models?page=2',
        absolute: false,
        declaredIn: 'content',
      });
      expect(result.continuation?.offset).toBe(content.indexOf('[Next page]'));
    });

    it('detects an absolute paging link declared at the top', () => {
      const content = `# Models\n\n> Page 1 of 2. Continue at [https://docs.example.com/models.md?page=2](https://docs.example.com/models.md?page=2).\n\n- a`;
      const result = detectPagination(content, { baseUrl: BASE });
      expect(result.continuation).toMatchObject({
        url: 'https://docs.example.com/models.md?page=2',
        absolute: true,
        declaredIn: 'content',
      });
    });

    it('detects the spec’s grounding case as served: an italic trailing note with a root-relative path', () => {
      // build.nvidia.com/models.md, fetched 2026-09-27.
      const content = `# Models\n\n${'- [m](/x/m.md) — a model\n'.repeat(100)}\n_100 of 101 shown. Fetch /models.md?page=2 for the next 100._\n`;
      const result = detectPagination(content, { baseUrl: 'https://build.nvidia.com/models.md' });
      expect(result.signals.map((s) => s.type)).toEqual(['n-of-m', 'pagination-param']);
      expect(result.signals[0].text).toBe('100 of 101 shown');
      expect(result.continuation).toMatchObject({
        url: '/models.md?page=2',
        resolvedUrl: 'https://build.nvidia.com/models.md?page=2',
        absolute: false,
        declaredIn: 'content',
      });
    });

    it('detects a bare root-relative path quoted in an instruction', () => {
      const content = `# Models\n\n- a\n\nFor the remaining models, fetch /models?offset=100.`;
      const result = detectPagination(content, { baseUrl: BASE });
      expect(result.signals[0]).toMatchObject({
        type: 'pagination-param',
        url: '/models?offset=100',
      });
      expect(result.continuation?.resolvedUrl).toBe('https://docs.example.com/models?offset=100');
    });

    it('detects a bare absolute URL with a paging parameter', () => {
      const content = `# Models\n\n- a\n\nMore at https://docs.example.com/models.md?page=2.`;
      const result = detectPagination(content, { baseUrl: BASE });
      expect(result.continuation).toMatchObject({
        url: 'https://docs.example.com/models.md?page=2',
        absolute: true,
      });
    });

    it('accepts a generic "Next" link when it points to the same document with a different query', () => {
      const content = `# Models\n\n- a\n\n[Next »](/models?p=2)`;
      const result = detectPagination(content, { baseUrl: BASE });
      expect(result.signals[0]).toMatchObject({ type: 'next-link', url: '/models?p=2' });
    });

    it('accepts a generic "Next" link with a paging parameter to another path', () => {
      const content = `# Models\n\n[next](/catalog/list?page=2)`;
      expect(detectPagination(content, { baseUrl: BASE }).signals[0]?.type).toBe('next-link');
    });

    it('detects path-segment paging', () => {
      const content = `# Blog\n\n[2](/blog/page/2) [3](/blog/page/3)`;
      const result = detectPagination(content, { baseUrl: 'https://docs.example.com/blog.md' });
      expect(result.signals).toHaveLength(2);
      expect(result.continuation?.url).toBe('/blog/page/2');
    });

    it('chooses the earliest in-content declaration as the continuation', () => {
      const content = `# Models\n\n> Continued at [next page](https://docs.example.com/models.md?page=2)\n\n${'- item\n'.repeat(50)}\n[Next page](/models?page=2)`;
      const result = detectPagination(content, { baseUrl: BASE });
      expect(result.continuation?.url).toBe('https://docs.example.com/models.md?page=2');
      expect(result.continuation?.absolute).toBe(true);
    });

    it('uses the Link header only when the content declares no continuation', () => {
      const content = `# Models\n\n- a\n\nShowing 100 of 102 models.`;
      const result = detectPagination(content, {
        baseUrl: BASE,
        linkHeader: '</models.md?page=2>; rel="next"',
      });
      expect(result.signals.map((s) => s.type)).toEqual(['n-of-m', 'link-header']);
      expect(result.continuation).toMatchObject({
        url: '/models.md?page=2',
        resolvedUrl: 'https://docs.example.com/models.md?page=2',
        declaredIn: 'header',
      });
    });

    it('is a signal on its own when only the Link header paginates', () => {
      const result = detectPagination('# Models\n\n- a', {
        baseUrl: BASE,
        linkHeader: '<https://docs.example.com/models.md?page=2>; rel="next"',
      });
      expect(result.signals).toHaveLength(1);
      expect(result.continuation?.declaredIn).toBe('header');
    });

    it('treats the page URL as the same document for a .md variant', () => {
      // Markdown served at /models.md, pager links point at the HTML page.
      const content = `# Models\n\n- a\n\n[Next](/models?page=2)`;
      const result = detectPagination(content, {
        baseUrl: BASE,
        pageUrl: 'https://docs.example.com/models',
      });
      expect(result.signals[0]?.type).toBe('next-link');
    });
  });
});

describe('detectPagination: shared link scanner', () => {
  it('finds a continuation written as a reference-style link, reported once', () => {
    const content =
      '# Models\n\n> Page 1 of 2: [next page][p2]\n\n- model-1\n\n[p2]: /models.md?page=2\n';
    const result = detectPagination(content, { baseUrl: BASE });
    expect(result.signals.map((s) => s.type)).toContain('next-link');
    expect(result.continuation?.url).toBe('/models.md?page=2');
    // The definition line is blanked, so it is not reported again as a quoted path.
    expect(result.signals.filter((s) => s.url === '/models.md?page=2')).toHaveLength(1);
  });

  it('ignores an example paging path inside an indented fence', () => {
    const content =
      '# API\n\n1. Fetch the list:\n\n   ```http\n   GET /v1/items?page=2\n   ```\n\n2. Done.\n';
    expect(detectPagination(content, { baseUrl: BASE }).signals).toEqual([]);
  });

  it('accepts a closing fence longer than its opener', () => {
    const content = '# API\n\n```\nGET /v1/items?page=2\n````\n\nThat is all.\n';
    expect(detectPagination(content, { baseUrl: BASE }).signals).toEqual([]);
  });
});
