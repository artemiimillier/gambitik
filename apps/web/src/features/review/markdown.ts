/**
 * A tiny, SAFE markdown parser for the game review (the text may come from an LLM).
 *
 * Safety model: the source is parsed into a plain data tree of a few known node types. Nothing in
 * the source can create an element, an attribute or a URL scheme by itself — raw HTML stays literal
 * text (React escapes it on output), links are parsed only for http(s) URLs (and rendered as plain text by
 * Markdown.tsx — the child never gets a clickable external link), everything else is text.
 * There is no `dangerouslySetInnerHTML` anywhere.
 *
 * Supported: # headings, paragraphs, **bold**, *italic* / _italic_, `code`, [links](https://…),
 * - / * / + and 1. lists (nested by indentation), | tables |, > quotes, --- rules, backslash escapes.
 * A leading YAML front-matter block and HTML comments are dropped.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'break' };

export interface ListItem {
  children: Inline[];
  sub?: ListBlock;
}

export interface ListBlock {
  type: 'list';
  ordered: boolean;
  items: ListItem[];
}

export type TableAlign = 'left' | 'center' | 'right' | null;

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | ListBlock
  | { type: 'table'; align: TableAlign[]; header: Inline[][]; rows: Inline[][][] }
  | { type: 'quote'; children: Inline[] }
  | { type: 'rule' };

/**
 * Hard limits so a broken or hostile document cannot freeze the page. The server caps a stored review at
 * 12 000 characters; the emphasis scanner is quadratic in the worst case (~5 s on 60 KB of `_a `), so the
 * renderer uses the same cap (~0.2 s worst case).
 */
export const MAX_MARKDOWN_CHARS = 12_000;
const MAX_INLINE_DEPTH = 6;
const MAX_LIST_DEPTH = 4;

// ───────────────────────── inline ─────────────────────────

const SAFE_URL_RE = /^https?:\/\/[^\s<>"'`]+$/i;

/** Only absolute http(s) URLs survive; `javascript:`, `data:`, relative paths etc. become plain text. */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (!SAFE_URL_RE.test(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function pushText(out: Inline[], text: string): void {
  if (text === '') return;
  const last = out[out.length - 1];
  if (last && last.type === 'text') last.text += text;
  else out.push({ type: 'text', text });
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/** Finds the closing delimiter `marker` starting at `from`; the char before it must not be a space. */
function findClosing(src: string, marker: string, from: number): number {
  let i = from;
  while (i < src.length) {
    const at = src.indexOf(marker, i);
    if (at === -1) return -1;
    if (src[at - 1] === '\\') {
      i = at + 1;
      continue;
    }
    const before = src[at - 1];
    const okBefore = before !== undefined && !/\s/.test(before);
    // a single * or _ must not be part of a double one
    const single = marker.length === 1;
    const partOfDouble = single && (src[at + 1] === marker || src[at - 1] === marker);
    // intraword underscores (snake_case) are not emphasis
    const intraword = marker.startsWith('_') && isWordChar(src[at + marker.length]);
    if (okBefore && !partOfDouble && !intraword && at > from) return at;
    i = at + marker.length;
  }
  return -1;
}

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  if (depth > MAX_INLINE_DEPTH) {
    pushText(out, src);
    return out;
  }
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? '';
    const next = src[i + 1];

    // backslash escape of punctuation
    if (ch === '\\' && next !== undefined && /[\\`*_{}[\]()#+\-.!|>~]/.test(next)) {
      pushText(out, next);
      i += 2;
      continue;
    }

    // hard line break (two trailing spaces or backslash before \n were normalised to \n by the block parser)
    if (ch === '\n') {
      out.push({ type: 'break' });
      i += 1;
      continue;
    }

    // inline code
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        out.push({ type: 'code', text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // strong: ** or __
    if ((ch === '*' || ch === '_') && next === ch) {
      const marker = ch + ch;
      const opensWord = ch === '*' || !isWordChar(src[i - 1]);
      const after = src[i + 2];
      if (opensWord && after !== undefined && !/\s/.test(after)) {
        const end = findClosing(src, marker, i + 2);
        if (end !== -1) {
          out.push({ type: 'strong', children: parseInline(src.slice(i + 2, end), depth + 1) });
          i = end + 2;
          continue;
        }
      }
    }

    // emphasis: * or _
    if (ch === '*' || ch === '_') {
      const opensWord = ch === '*' || !isWordChar(src[i - 1]);
      if (opensWord && next !== undefined && next !== ch && !/\s/.test(next)) {
        const end = findClosing(src, ch, i + 1);
        if (end !== -1) {
          out.push({ type: 'em', children: parseInline(src.slice(i + 1, end), depth + 1) });
          i = end + 1;
          continue;
        }
      }
    }

    // link: [label](url) — an image marker "!" in front is dropped, the label is kept as text
    if (ch === '[') {
      const close = src.indexOf(']', i + 1);
      if (close !== -1 && src[close + 1] === '(') {
        const urlEnd = src.indexOf(')', close + 2);
        if (urlEnd !== -1) {
          const label = src.slice(i + 1, close);
          const target = (src.slice(close + 2, urlEnd).trim().split(/\s+/)[0] ?? '').replace(/^<|>$/g, '');
          const href = safeHref(target);
          const children = parseInline(label, depth + 1);
          const last = out[out.length - 1];
          if (last && last.type === 'text' && last.text.endsWith('!')) last.text = last.text.slice(0, -1);
          if (href !== null) out.push({ type: 'link', href, children });
          else out.push(...children);
          i = urlEnd + 1;
          continue;
        }
      }
    }

    pushText(out, ch);
    i += 1;
  }
  return out.filter((node) => node.type !== 'text' || node.text !== '');
}

// ───────────────────────── blocks ─────────────────────────

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function stripFrontMatter(src: string): string {
  if (!src.startsWith('---')) return src;
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(src);
  return match ? src.slice(match[0].length) : src;
}

function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === '|') {
      current += '|';
      i++;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function alignOf(cell: string): TableAlign {
  const c = cell.trim();
  const left = c.startsWith(':');
  const right = c.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

function indentWidth(space: string): number {
  return space.replace(/\t/g, '    ').length;
}

function isBlockStart(line: string): boolean {
  return HEADING_RE.test(line) || RULE_RE.test(line) || LIST_RE.test(line) || QUOTE_RE.test(line);
}

interface Cursor {
  lines: string[];
  i: number;
}

function parseList(cur: Cursor, indent: number, depth: number): ListBlock {
  const first = LIST_RE.exec(cur.lines[cur.i] ?? '');
  const ordered = first ? /\d/.test(first[2] ?? '') : false;
  const list: ListBlock = { type: 'list', ordered, items: [] };

  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? '';
    const match = LIST_RE.exec(line);
    if (!match) {
      // an indented continuation line belongs to the last item; anything else ends the list
      const last = list.items[list.items.length - 1];
      if (last && line.trim() !== '' && /^\s+/.test(line) && !isBlockStart(line.trim())) {
        last.children = [...last.children, { type: 'text', text: ' ' }, ...parseInline(line.trim())];
        cur.i++;
        continue;
      }
      break;
    }
    const itemIndent = indentWidth(match[1] ?? '');
    if (itemIndent < indent) break;
    if (itemIndent >= indent + 2 && list.items.length > 0 && depth < MAX_LIST_DEPTH) {
      const parent = list.items[list.items.length - 1];
      const sub = parseList(cur, itemIndent, depth + 1);
      if (parent) parent.sub = parent.sub ? { ...parent.sub, items: [...parent.sub.items, ...sub.items] } : sub;
      continue;
    }
    list.items.push({ children: parseInline((match[3] ?? '').trim()) });
    cur.i++;
  }
  return list;
}

export function parseMarkdown(source: string): Block[] {
  const clipped = source.length > MAX_MARKDOWN_CHARS ? source.slice(0, MAX_MARKDOWN_CHARS) : source;
  const cleaned = stripFrontMatter(clipped.replace(/\r\n?/g, '\n')).replace(/<!--[\s\S]*?-->/g, '');
  const cur: Cursor = { lines: cleaned.split('\n'), i: 0 };
  const blocks: Block[] = [];

  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? '';
    if (line.trim() === '') {
      cur.i++;
      continue;
    }

    // fenced code is shown as a plain paragraph of code (never executed, never interpreted)
    if (/^ {0,3}(```|~~~)/.test(line)) {
      const fence = line.trim().slice(0, 3);
      const body: string[] = [];
      cur.i++;
      while (cur.i < cur.lines.length && !(cur.lines[cur.i] ?? '').trim().startsWith(fence)) {
        body.push(cur.lines[cur.i] ?? '');
        cur.i++;
      }
      cur.i++;
      if (body.length > 0) blocks.push({ type: 'paragraph', children: [{ type: 'code', text: body.join('\n') }] });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = (heading[1] ?? '#').length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: 'heading', level, children: parseInline(heading[2] ?? '') });
      cur.i++;
      continue;
    }

    if (RULE_RE.test(line)) {
      blocks.push({ type: 'rule' });
      cur.i++;
      continue;
    }

    // table: a row with pipes followed by a separator row
    const nextLine = cur.lines[cur.i + 1] ?? '';
    if (line.includes('|') && nextLine.includes('-') && TABLE_SEPARATOR_RE.test(nextLine)) {
      const header = splitTableRow(line);
      const align = splitTableRow(nextLine).map(alignOf);
      cur.i += 2;
      const rows: Inline[][][] = [];
      while (cur.i < cur.lines.length && (cur.lines[cur.i] ?? '').includes('|') && (cur.lines[cur.i] ?? '').trim() !== '') {
        const cells = splitTableRow(cur.lines[cur.i] ?? '');
        rows.push(header.map((_, col) => parseInline(cells[col] ?? '')));
        cur.i++;
      }
      blocks.push({ type: 'table', align: header.map((_, col) => align[col] ?? null), header: header.map((cell) => parseInline(cell)), rows });
      continue;
    }

    const listMatch = LIST_RE.exec(line);
    if (listMatch) {
      blocks.push(parseList(cur, indentWidth(listMatch[1] ?? ''), 0));
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const parts: string[] = [];
      while (cur.i < cur.lines.length) {
        const quote = QUOTE_RE.exec(cur.lines[cur.i] ?? '');
        if (!quote) break;
        parts.push((quote[1] ?? '').trim());
        cur.i++;
      }
      blocks.push({ type: 'quote', children: parseInline(parts.filter((part) => part !== '').join(' ')) });
      continue;
    }

    // paragraph: until a blank line or the start of another block
    const para: string[] = [];
    while (cur.i < cur.lines.length) {
      const current = cur.lines[cur.i] ?? '';
      if (current.trim() === '') break;
      if (para.length > 0 && (isBlockStart(current) || /^ {0,3}(```|~~~)/.test(current))) break;
      // two trailing spaces or a trailing backslash = hard break
      const hardBreak = / {2,}$/.test(current) || /\\$/.test(current);
      para.push(current.trim().replace(/\\$/, '') + (hardBreak ? '\n' : ' '));
      cur.i++;
    }
    blocks.push({ type: 'paragraph', children: parseInline(para.join('').trim()) });
  }
  return blocks;
}

/** Plain text of inline nodes — for aria labels and tests. */
export function inlineText(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
        case 'code':
          return node.text;
        case 'break':
          return ' ';
        default:
          return inlineText(node.children);
      }
    })
    .join('');
}
