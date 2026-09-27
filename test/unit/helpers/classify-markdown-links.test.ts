import { describe, it, expect } from 'vitest';
import {
  classifyLink,
  countByClass,
  scanMarkdownLinks,
} from '../../../src/helpers/classify-markdown-links.js';

const BASE = 'https://docs.example.com/md/guide/api.md';

describe('classifyLink', () => {
  it('classifies by how much of the base URL the link needs', () => {
    expect(classifyLink('https://docs.example.com/a')).toBe('absolute');
    expect(classifyLink('HTTP://docs.example.com/a')).toBe('absolute');
    expect(classifyLink('//docs.example.com/a')).toBe('protocol-relative');
    expect(classifyLink('/docs/a.md')).toBe('root-relative');
    expect(classifyLink('a.md')).toBe('path-relative');
    expect(classifyLink('./a.md')).toBe('path-relative');
    expect(classifyLink('../a.md')).toBe('path-relative');
    expect(classifyLink('#usage')).toBe('fragment');
    expect(classifyLink('mailto:docs@example.com')).toBe('other-scheme');
    expect(classifyLink('tel:+15551234')).toBe('other-scheme');
  });
});

describe('scanMarkdownLinks', () => {
  it('resolves relative links against the URL that served the markdown', () => {
    const { links } = scanMarkdownLinks('[sibling](other.md) and [root](/other.md)', BASE);
    expect(links.map((l) => l.resolvedUrl)).toEqual([
      'https://docs.example.com/md/guide/other.md',
      'https://docs.example.com/other.md',
    ]);
  });

  it('marks links whose path promises markdown', () => {
    const { links } = scanMarkdownLinks(
      '[a](/a.md) [b](/b.mdx) [c](/c) [d](/d.md?v=2) [e](/e.html)',
      BASE,
    );
    expect(links.map((l) => l.promisesMarkdown)).toEqual([true, true, false, true, false]);
  });

  it('flags cross-origin links against the markdown origin', () => {
    const { links } = scanMarkdownLinks(
      '[here](/a.md) and [there](https://api.other.com/a.md)',
      BASE,
    );
    expect(links.map((l) => l.crossOrigin)).toEqual([false, true]);
  });

  it('ignores links inside fenced code blocks and inline code', () => {
    const content = [
      '# Guide',
      '',
      'Real: [real](/real.md)',
      '',
      '```markdown',
      '[example](../relative/example.md)',
      '```',
      '',
      'Inline: `[inline](../inline.md)`',
    ].join('\n');
    const { links } = scanMarkdownLinks(content, BASE);
    expect(links.map((l) => l.url)).toEqual(['/real.md']);
  });

  it('keeps images separate from links an agent follows', () => {
    const { links, images } = scanMarkdownLinks(
      '![diagram](../img/flow.png) and [guide](/guide.md)',
      BASE,
    );
    expect(links.map((l) => l.url)).toEqual(['/guide.md']);
    expect(images.map((i) => i.url)).toEqual(['../img/flow.png']);
    expect(images[0].class).toBe('path-relative');
  });

  it('does not read an image inside link text as a path-relative link', () => {
    const { links } = scanMarkdownLinks('[![badge](../badge.svg)](https://ci.example.com)', BASE);
    expect(links).toHaveLength(1);
    expect(links[0].class).toBe('absolute');
  });

  it('strips angle-bracket destinations and drops empty ones', () => {
    const { links } = scanMarkdownLinks('[a](<https://example.com/a>) [b]()', BASE);
    expect(links.map((l) => l.url)).toEqual(['https://example.com/a']);
  });

  it('strips the fragment from the URL it hands callers to fetch', () => {
    const { links } = scanMarkdownLinks('[anchored](/docs/b.md#section-two)', BASE);
    expect(links[0].resolvedUrl).toBe('https://docs.example.com/docs/b.md#section-two');
    expect(links[0].fetchUrl).toBe('https://docs.example.com/docs/b.md');
    expect(links[0].promisesMarkdown).toBe(true);
  });

  it('drops destinations carrying characters a URL generator would have encoded', () => {
    // Mintlify serves a page's raw MDX, so a regex literal in the preamble
    // reads as a markdown link: `/[_-](\w)/g` would otherwise resolve to /w.
    const content = [
      'const toCamelCase = str => str.replace(/[_-](\\w)/g, (_, c) => c.toUpperCase());',
      '',
      'Real: [real](/real.md)',
      '',
      'Template: [id]({id})',
    ].join('\n');
    const { links } = scanMarkdownLinks(content, BASE);
    expect(links.map((l) => l.url)).toEqual(['/real.md']);
  });

  it('deduplicates repeated links but keeps document order', () => {
    const { links } = scanMarkdownLinks('[a](/a.md) [b](/b.md) [a again](/a.md)', BASE);
    expect(links.map((l) => l.url)).toEqual(['/a.md', '/b.md']);
    expect(links[0].text).toBe('a');
  });

  it('leaves fragments and non-HTTP schemes unresolved', () => {
    const { links } = scanMarkdownLinks('[jump](#usage) [mail](mailto:docs@example.com)', BASE);
    expect(links.map((l) => l.resolvedUrl)).toEqual([undefined, undefined]);
  });
});

describe('countByClass', () => {
  it('tallies every class and counts cross-origin links separately', () => {
    const { links } = scanMarkdownLinks(
      [
        '[abs](https://docs.example.com/a.md)',
        '[ext](https://other.com/b.md)',
        '[proto](//docs.example.com/c.md)',
        '[root](/d.md)',
        '[rel](e.md)',
        '[frag](#f)',
        '[mail](mailto:x@example.com)',
      ].join(' '),
      BASE,
    );
    expect(countByClass(links)).toEqual({
      absolute: 2,
      protocolRelative: 1,
      rootRelative: 1,
      pathRelative: 1,
      fragment: 1,
      otherScheme: 1,
      crossOrigin: 1,
      total: 7,
    });
  });
});
