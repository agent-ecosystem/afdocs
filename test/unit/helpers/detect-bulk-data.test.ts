import { describe, it, expect } from 'vitest';
import { detectBulkData, describeBulkElement } from '../../../src/helpers/detect-bulk-data.js';
import { htmlToMarkdown } from '../../../src/helpers/html-to-markdown.js';

const T = { tableRows: 20, blobChars: 2000, dominantShare: 50 };

function pipeTable(rows: number, cols = 3): string {
  const header = `| ${Array.from({ length: cols }, (_, i) => `Col ${i}`).join(' | ')} |`;
  const delim = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`;
  const body = Array.from(
    { length: rows },
    (_, r) => `| ${Array.from({ length: cols }, (_, c) => `r${r}c${c}`).join(' | ')} |`,
  );
  return [header, delim, ...body].join('\n');
}

function jsonBlob(items: number): string {
  return JSON.stringify(
    { items: Array.from({ length: items }, (_, i) => ({ id: i, name: `item-${i}`, ok: true })) },
    null,
    2,
  );
}

describe('detectBulkData', () => {
  it('reports no elements for prose', () => {
    const d = detectBulkData('# Title\n\nSome prose.\n\n- a\n- b\n', T);
    expect(d.elements).toEqual([]);
    expect(d.bulkShare).toBe(0);
    expect(d.dominant).toBe(false);
    expect(d.proseBeforeBulkPercent).toBe(100);
  });

  describe('tables', () => {
    it('flags a uniform pipe table at or above the row threshold', () => {
      const md = `Intro.\n\n${pipeTable(20)}\n\nOutro.`;
      const d = detectBulkData(md, T);
      expect(d.elements).toHaveLength(1);
      const el = d.elements[0];
      expect(el.kind).toBe('table');
      expect(el.form).toBe('pipe-table');
      expect(el.rows).toBe(20);
      expect(el.columns).toBe(3);
      expect(el.uniformity).toBe(1);
      expect(el.start).toBe(md.indexOf('| Col 0'));
      expect(el.chars).toBe(pipeTable(20).length);
    });

    it('ignores a pipe table below the row threshold', () => {
      const d = detectBulkData(pipeTable(19), T);
      expect(d.elements).toEqual([]);
    });

    it('honours a configured row threshold', () => {
      expect(detectBulkData(pipeTable(5), { ...T, tableRows: 5 }).elements).toHaveLength(1);
      expect(detectBulkData(pipeTable(5), { ...T, tableRows: 6 }).elements).toHaveLength(0);
    });

    it('does not flag a table whose rows have no common structure', () => {
      const lines = ['| a | b |', '| --- | --- |'];
      for (let i = 0; i < 30; i++) {
        lines.push(`| ${Array.from({ length: (i % 5) + 1 }, () => 'x').join(' | ')} |`);
      }
      const d = detectBulkData(lines.join('\n'), T);
      expect(d.elements).toEqual([]);
    });

    it('tolerates a few rows with a stray pipe in a cell', () => {
      const t = pipeTable(30).split('\n');
      t[5] = '| a | b \\| c | d |'; // escaped pipe: still 3 cells
      t[6] = '| a | b | c | d |'; // unescaped pipe from converted content: 4 cells
      const d = detectBulkData(t.join('\n'), T);
      expect(d.elements).toHaveLength(1);
      expect(d.elements[0].uniformity).toBeCloseTo(29 / 30, 2);
    });

    it('counts a table without outer pipes', () => {
      const lines = ['a | b', '--- | ---'];
      for (let i = 0; i < 25; i++) lines.push(`${i} | v`);
      const d = detectBulkData(lines.join('\n'), T);
      expect(d.elements).toHaveLength(1);
      expect(d.elements[0].rows).toBe(25);
      expect(d.elements[0].columns).toBe(2);
    });

    it('flags raw <table> markup the converter left in place (headerless tables)', () => {
      const rows = Array.from({ length: 40 }, (_, i) => `<tr><td>${i}</td><td>v</td></tr>`).join(
        '',
      );
      const md = htmlToMarkdown(`<p>intro</p><table>${rows}</table><p>after</p>`);
      expect(md).toContain('<table>');
      const d = detectBulkData(md, T);
      expect(d.elements).toHaveLength(1);
      expect(d.elements[0].form).toBe('html-table');
      expect(d.elements[0].rows).toBe(40);
      expect(d.elements[0].columns).toBe(2);
    });

    it('does not count header rows of a raw table', () => {
      const rows = (n: number) =>
        Array.from({ length: n }, (_, i) => `<tr><td>${i}</td></tr>`).join('');
      const table = (n: number) =>
        `<table><thead><tr><th>h</th></tr></thead><tbody>${rows(n)}</tbody></table>`;
      const d = detectBulkData(table(20), T);
      expect(d.elements[0]?.rows).toBe(20);
      // 19 data rows plus the header row: not bulk, so the header was not counted.
      expect(detectBulkData(table(19), T).elements).toEqual([]);
    });

    it('measures the grounding case: a 218-row generated table converted from HTML', () => {
      const rows = Array.from(
        { length: 218 },
        (_, i) => `<tr><td>driver-${i}</td><td>${i % 7}.x</td><td>yes</td></tr>`,
      ).join('');
      const html = `<h1>Compat</h1><p>${'Prose. '.repeat(300)}</p><table><thead><tr><th>Driver</th><th>Version</th><th>Ok</th></tr></thead><tbody>${rows}</tbody></table>`;
      const d = detectBulkData(htmlToMarkdown(html), T);
      expect(d.elements).toHaveLength(1);
      expect(d.elements[0].rows).toBe(218);
      expect(d.elements[0].columns).toBe(3);
      expect(d.dominant).toBe(true);
      expect(d.proseBeforeBulkPercent).toBe(100);
    });
  });

  describe('JSON blobs', () => {
    it('flags a fenced JSON block at or above the size threshold', () => {
      const blob = jsonBlob(60);
      expect(blob.length).toBeGreaterThan(2000);
      const d = detectBulkData(`Text.\n\n\`\`\`json\n${blob}\n\`\`\`\n\nMore.`, T);
      expect(d.elements).toHaveLength(1);
      expect(d.elements[0].kind).toBe('json');
      expect(d.elements[0].form).toBe('fenced');
    });

    it('recognizes JSON by shape when the fence has no language', () => {
      const d = detectBulkData(`\`\`\`\n${jsonBlob(60)}\n\`\`\``, T);
      expect(d.elements.map((e) => e.kind)).toEqual(['json']);
    });

    it('flags JSON with comments and elisions by key density', () => {
      const lines = ['{'];
      for (let i = 0; i < 80; i++) lines.push(`  "field_${i}": "value ${i}", // note`);
      lines.push('  ...', '}');
      const body = lines.join('\n');
      expect(() => JSON.parse(body)).toThrow();
      const d = detectBulkData(`\`\`\`\n${body}\n\`\`\``, T);
      expect(d.elements.map((e) => e.kind)).toEqual(['json']);
    });

    it('flags an indented code block (what turndown emits for <pre>)', () => {
      const md = htmlToMarkdown(`<p>Response:</p><pre><code>${jsonBlob(60)}</code></pre>`);
      expect(md).toMatch(/\n {4}\{/);
      const d = detectBulkData(md, T);
      expect(d.elements).toHaveLength(1);
      expect(d.elements[0].form).toBe('indented');
    });

    it('flags JSON dropped inline as a paragraph', () => {
      const d = detectBulkData(`Intro\n\n${jsonBlob(60).replace(/\n/g, ' ')}\n\nAfter`, T);
      expect(d.elements).toHaveLength(1);
      expect(d.elements[0].form).toBe('inline');
    });

    it('ignores a small JSON example', () => {
      const d = detectBulkData(`\`\`\`json\n${jsonBlob(3)}\n\`\`\``, T);
      expect(d.elements).toEqual([]);
    });

    it('ignores a long code block that is not JSON', () => {
      const code = Array.from({ length: 200 }, (_, i) => `const v${i} = compute(${i});`).join('\n');
      const d = detectBulkData(`\`\`\`js\n${code}\n\`\`\``, T);
      expect(d.elements).toEqual([]);
    });

    it('does not treat a brace-led paragraph of prose as JSON', () => {
      const prose = `{note} ${'This paragraph happens to start with a brace. '.repeat(60)}}`;
      const d = detectBulkData(prose, T);
      expect(d.elements).toEqual([]);
    });

    it('accepts a longer closing fence and a fence nested in a list', () => {
      const md = `- item\n\n  \`\`\`json\n${jsonBlob(60)}\n  \`\`\`\`\n\n- next`;
      const d = detectBulkData(md, T);
      expect(d.elements.map((e) => e.kind)).toEqual(['json']);
    });
  });

  describe('base64 runs', () => {
    it('flags a data URI at or above the size threshold', () => {
      const run = 'QUJDRA=='.slice(0, 4).repeat(600); // 2400 chars
      const d = detectBulkData(`![img](data:image/png;base64,${run})`, T);
      expect(d.elements).toHaveLength(1);
      expect(d.elements[0].kind).toBe('base64');
      expect(d.elements[0].chars).toBe('data:image/png;base64,'.length + run.length);
    });

    it('flags a bare base64 run inside a non-JSON code block', () => {
      const run = 'MIIB'.repeat(600);
      const d = detectBulkData(
        `\`\`\`\n-----BEGIN CERTIFICATE-----\n${run}\n-----END CERTIFICATE-----\n\`\`\``,
        T,
      );
      expect(d.elements.map((e) => e.kind)).toEqual(['base64']);
    });

    it('ignores a short base64 run', () => {
      const d = detectBulkData(`data:image/png;base64,${'QUJD'.repeat(100)}`, T);
      expect(d.elements).toEqual([]);
    });

    it('does not double-count a run inside a JSON blob', () => {
      const blob = JSON.stringify({ payload: 'QUJD'.repeat(600) }, null, 2);
      const d = detectBulkData(`\`\`\`json\n${blob}\n\`\`\``, T);
      expect(d.elements.map((e) => e.kind)).toEqual(['json']);
      expect(d.bulkChars).toBeLessThanOrEqual(d.totalChars);
    });
  });

  describe('shares and position', () => {
    it('computes share, dominance, and prose position', () => {
      const table = pipeTable(50);
      const before = 'Explanation first. '.repeat(20);
      const after = 'Notes after. '.repeat(5);
      const md = `${before}\n\n${table}\n\n${after}`;
      const d = detectBulkData(md, T);
      expect(d.bulkChars).toBe(table.length);
      expect(d.bulkShare).toBe(Math.round((table.length / md.length) * 100));
      expect(d.dominant).toBe(true);
      expect(d.proseBeforeBulk).toBe(md.indexOf('| Col 0'));
      expect(d.proseBeforeBulkPercent).toBeGreaterThan(70);
      expect(d.elements[0].position).toBe(Math.round((md.indexOf('| Col 0') / md.length) * 100));
    });

    it('reports prose after the data as a low prose-before percentage', () => {
      const md = `${pipeTable(50)}\n\n${'Explanation last. '.repeat(50)}`;
      const d = detectBulkData(md, T);
      expect(d.proseBeforeBulkPercent).toBe(0);
    });

    it('is not dominant below the configured share', () => {
      const md = `${'Prose. '.repeat(400)}\n\n${pipeTable(20)}`;
      const d = detectBulkData(md, T);
      expect(d.elements).toHaveLength(1);
      expect(d.bulkShare).toBeLessThan(50);
      expect(d.dominant).toBe(false);
      expect(detectBulkData(md, { ...T, dominantShare: 10 }).dominant).toBe(true);
    });

    it('lists several elements in document order', () => {
      const md = `${pipeTable(25)}\n\n\`\`\`json\n${jsonBlob(60)}\n\`\`\`\n\n${pipeTable(30)}`;
      const d = detectBulkData(md, T);
      expect(d.elements.map((e) => e.kind)).toEqual(['table', 'json', 'table']);
      expect(d.elements[0].start).toBeLessThan(d.elements[1].start);
      expect(d.elements[1].start).toBeLessThan(d.elements[2].start);
    });
  });

  describe('describeBulkElement', () => {
    it('names tables by rows and blobs by size', () => {
      expect(describeBulkElement({ kind: 'table', rows: 218, chars: 50_000 })).toBe(
        '218-row table',
      );
      expect(describeBulkElement({ kind: 'json', chars: 6_400 })).toBe('6K-char JSON blob');
      expect(describeBulkElement({ kind: 'base64', chars: 900 })).toBe('900-char base64 run');
    });
  });
});
