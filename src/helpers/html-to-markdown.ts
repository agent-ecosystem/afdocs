import { parse } from 'node-html-parser';
import TurndownService from 'turndown';
import { tables } from 'turndown-plugin-gfm';

export function htmlToMarkdown(html: string): string {
  const root = parse(html);
  for (const el of root.querySelectorAll('script, style')) {
    el.remove();
  }
  // A table skeleton with no rows (a <thead> and <tbody> that a script fills
  // in) makes the GFM table plugin dereference `rows[0]` and throw, which
  // takes every HTML-path check down with it for that page. The skeleton
  // contributes nothing to the converted content, so drop it, keeping a
  // caption as a paragraph so authored text is not lost with it.
  for (const table of root.querySelectorAll('table')) {
    if (table.querySelector('tr')) continue;
    const caption = table.querySelector('caption');
    if (caption && caption.text.trim() !== '') {
      table.insertAdjacentHTML('beforebegin', `<p>${caption.innerHTML}</p>`);
    }
    table.remove();
  }
  const turndown = new TurndownService();
  turndown.use(tables);
  return turndown.turndown(root.toString());
}
