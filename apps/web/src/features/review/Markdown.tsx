/**
 * Renders the data tree of ./markdown.ts as React elements. Every piece of source text ends up as a
 * React text node (escaped by React); no HTML string is ever injected, and no <a> element is ever produced.
 */
import { createElement, useMemo } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../../ui/index.ts';
import styles from './Markdown.module.css';
import { parseMarkdown } from './markdown.ts';
import type { Block, Inline, ListBlock } from './markdown.ts';

export interface MarkdownProps {
  source: string;
  /**
   * Added to every heading level so the document nests under the page's own headings:
   * with offset 2 a markdown `#` becomes <h3>. Levels are capped at <h6>. Default 2.
   */
  headingOffset?: number;
  className?: string;
}

function renderInline(nodes: readonly Inline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (node.type) {
      case 'text':
        return node.text;
      case 'strong':
        return <strong key={key}>{renderInline(node.children, key)}</strong>;
      case 'em':
        return <em key={key}>{renderInline(node.children, key)}</em>;
      case 'code':
        return <code key={key}>{node.text}</code>;
      case 'break':
        return <br key={key} />;
      case 'link':
        // The review may be written by an LLM, and its reader is a child: a link is shown as its plain label and is
        // never clickable. The parsed `href` stays in the data tree for tests / future parent views.
        return <span key={key}>{renderInline(node.children, key)}</span>;
    }
  });
}

function renderList(list: ListBlock, key: string): ReactNode {
  const items = list.items.map((item, i) => (
    <li key={`${key}-${i}`}>
      {renderInline(item.children, `${key}-${i}`)}
      {item.sub ? renderList(item.sub, `${key}-${i}-sub`) : null}
    </li>
  ));
  return list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
}

function renderBlock(block: Block, key: string, headingOffset: number): ReactNode {
  switch (block.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, block.level + headingOffset));
      return createElement(`h${level}`, { key, 'data-level': block.level }, renderInline(block.children, key));
    }
    case 'paragraph':
      return <p key={key}>{renderInline(block.children, key)}</p>;
    case 'list':
      return renderList(block, key);
    case 'quote':
      return <blockquote key={key}>{renderInline(block.children, key)}</blockquote>;
    case 'rule':
      return <hr key={key} />;
    case 'table':
      return (
        <div key={key} className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                {block.header.map((cell, col) => (
                  <th key={col} scope="col" style={{ textAlign: block.align[col] ?? undefined }}>
                    {renderInline(cell, `${key}-h${col}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, col) => (
                    <td key={col} style={{ textAlign: block.align[col] ?? undefined }}>
                      {renderInline(cell, `${key}-r${r}c${col}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function Markdown({ source, headingOffset = 2, className }: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return <div className={cx(styles.markdown, className)}>{blocks.map((block, i) => renderBlock(block, `b${i}`, headingOffset))}</div>;
}
