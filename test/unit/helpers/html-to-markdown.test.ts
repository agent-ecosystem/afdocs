import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from '../../../src/helpers/html-to-markdown.js';

describe('htmlToMarkdown', () => {
  it('converts basic HTML to markdown', () => {
    const html = '<html><body><h1>Title</h1><p>Hello world.</p></body></html>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('Title');
    expect(md).toContain('Hello world.');
  });

  it('strips <script> elements and their contents', () => {
    const html = `<html><body>
      <script>const x = 42; console.log(x);</script>
      <h1>Title</h1>
      <script type="application/json">{"key": "value"}</script>
      <p>Content.</p>
    </body></html>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain('Title');
    expect(md).toContain('Content.');
    expect(md).not.toContain('const x = 42');
    expect(md).not.toContain('console.log');
    expect(md).not.toContain('"key"');
  });

  it('strips <style> elements and their contents', () => {
    const html = `<html><head>
      <style>.nav { color: red; margin: 10px; font-size: 14px; }</style>
    </head><body>
      <h1>Title</h1>
      <style>body { background: blue; }</style>
      <p>Content.</p>
    </body></html>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain('Title');
    expect(md).toContain('Content.');
    expect(md).not.toContain('color: red');
    expect(md).not.toContain('background: blue');
    expect(md).not.toContain('.nav');
  });

  it('strips both <script> and <style> while preserving content', () => {
    const css = Array.from({ length: 50 }, (_, i) => `.c${i} { color: red; }`).join('\n');
    const js = 'function init() { document.getElementById("app").render(); }';
    const html = `<html><head><style>${css}</style></head><body>
      <script>${js}</script>
      <h1>Documentation</h1>
      <p>This is the real content.</p>
    </body></html>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain('Documentation');
    expect(md).toContain('This is the real content.');
    expect(md).not.toContain('color: red');
    expect(md).not.toContain('document.getElementById');
  });

  it('preserves HTML tables as markdown tables', () => {
    const html = `<table><tr><th>Name</th><th>Value</th></tr>
      <tr><td>foo</td><td>bar</td></tr></table>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain('Name');
    expect(md).toContain('foo');
    expect(md).toContain('|');
  });

  it('drops a table skeleton with no rows instead of crashing the GFM plugin', () => {
    // A <thead>/<tbody> pair that a script fills in client-side (seen on a
    // model-comparison widget) made turndown-plugin-gfm read rows[0].parentNode
    // and throw, failing every HTML-path check for the page.
    const html =
      '<p>Compare models.</p><table class="w-full"><thead data-head></thead><tbody data-body></tbody></table><p>After.</p>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('Compare models.');
    expect(md).toContain('After.');
    expect(md).not.toContain('<table');
  });
});
