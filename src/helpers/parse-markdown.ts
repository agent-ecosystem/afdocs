import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmTable } from 'micromark-extension-gfm-table';
import type { Nodes, Root } from 'mdast';

export function parseMarkdown(content: string): Root {
  let source = content;
  while (true) {
    const tree = fromMarkdown(source, {
      extensions: [gfmTable()],
      mdastExtensions: [gfmTableFromMarkdown()],
    });
    const vendorFences: Array<{ offset: number; length: number }> = [];
    const visit = (node: Nodes): void => {
      const offset = node.position?.start.offset;
      if (node.type === 'code' && offset !== undefined) {
        const opener = /^(`{3,}|~{3,})[^\r\n]*\|/.exec(source.slice(offset));
        if (opener) vendorFences.push({ offset, length: opener[1].length });
      }
      if ('children' in node) node.children.forEach(visit);
    };
    visit(tree);
    if (vendorFences.length === 0) return tree;
    const characters = source.split('');
    for (const { offset, length } of vendorFences) {
      characters.fill(' ', offset, offset + length);
    }
    source = characters.join('');
  }
}
