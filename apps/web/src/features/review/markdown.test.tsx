import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown.tsx';
import { MAX_MARKDOWN_CHARS, inlineText, parseInline, parseMarkdown, safeHref } from './markdown.ts';

function html(source: string, headingOffset?: number): string {
  return renderToStaticMarkup(<Markdown source={source} headingOffset={headingOffset} />);
}

describe('markdown safety', () => {
  it('escapes script tags instead of creating them', () => {
    const out = html('Привет <script>alert(1)</script> мир');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes raw HTML blocks, event handlers and iframes everywhere', () => {
    const source = [
      '<img src=x onerror="alert(1)">',
      '',
      '# <iframe src="https://evil.example"></iframe>',
      '',
      '- <b onclick="x()">жирный</b>',
      '',
      '| <svg onload=alert(1)> | b |',
      '|---|---|',
      '| <a href="javascript:alert(1)">x</a> | **<u>y</u>** |',
      '',
      '> <style>body{display:none}</style>',
    ].join('\n');
    const out = html(source);
    for (const tag of ['<img', '<iframe', '<b ', '<svg', '<a ', '<u>', '<style']) expect(out, tag).not.toContain(tag);
    // no REAL element carries an event-handler attribute (the escaped text may still mention one)
    expect(out).not.toMatch(/<[a-z][^<>]*\son\w+=/i);
    expect(out).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('never turns javascript:, data: or relative targets into links', () => {
    for (const target of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html;base64,AAAA', 'vbscript:x', './file.pgn', '//evil.example', 'file:///etc/passwd']) {
      const out = html(`[нажми](${target})`);
      expect(out, target).not.toContain('<a');
      expect(out, target).not.toContain('href');
      expect(out).toContain('нажми');
    }
  });

  it('shows http(s) links as their plain label: the child never gets a clickable external link', () => {
    for (const source of ['[Личесс](https://lichess.org/training)', '[Личесс](https://user:pw@evil.example/x)', '[Личесс](http://127.0.0.1:8787/api/student)']) {
      const out = html(source);
      expect(out, source).toContain('Личесс');
      expect(out, source).not.toContain('<a');
      expect(out, source).not.toContain('href');
      expect(out, source).not.toMatch(/lichess\.org|evil\.example|127\.0\.0\.1/);
    }
    // the parser still recognises the link (data only) — the renderer decides not to make it clickable
    expect(parseInline('[Личесс](https://lichess.org/training)')).toEqual([{ type: 'link', href: 'https://lichess.org/training', children: [{ type: 'text', text: 'Личесс' }] }]);
    expect(safeHref('https://example.org/a b')).toBeNull();
    expect(safeHref('https://exa"mple.org')).toBeNull();
    expect(safeHref(' http://example.org/x ')).toBe('http://example.org/x');
  });

  it('cannot break out of an attribute through a link', () => {
    const out = html('[x](https://a.example/"onmouseover="alert(1))');
    expect(out).not.toMatch(/onmouseover="alert/);
    expect(out).not.toContain('<a');
  });

  it('drops images but keeps their alt text', () => {
    const out = html('Смотри: ![доска](https://example.org/board.png)');
    expect(out).not.toContain('<img');
    expect(out).toContain('доска');
    expect(out).not.toContain('!');
  });

  it('drops HTML comments and YAML front-matter', () => {
    const out = html('---\nschema: game-journal/1\nsecret: 1\n---\n\n# Заголовок\n\n<!-- parent-notes:start -->\nтекст\n<!-- parent-notes:end -->');
    expect(out).not.toContain('schema');
    expect(out).not.toContain('parent-notes');
    expect(out).toContain('Заголовок');
    expect(out).toContain('текст');
  });

  it('survives hostile input sizes and nesting', () => {
    const deep = `${'**_'.repeat(200)}x${'_**'.repeat(200)}`;
    expect(() => html(deep)).not.toThrow();
    const huge = 'а'.repeat(MAX_MARKDOWN_CHARS * 2);
    expect(inlineText(parseMarkdown(huge).flatMap((b) => (b.type === 'paragraph' ? b.children : []))).length).toBe(MAX_MARKDOWN_CHARS);
    expect(() => parseMarkdown('|'.repeat(5000) + '\n' + '-|'.repeat(5000))).not.toThrow();
    expect(() => parseMarkdown(`${'  '.repeat(50)}- a\n`.repeat(200))).not.toThrow();
  });
});

describe('markdown features', () => {
  it('renders headings with an offset and caps them at h6', () => {
    expect(html('# Раз\n\n## Два')).toContain('<h3 data-level="1">Раз</h3>');
    expect(html('# Раз\n\n## Два')).toContain('<h4 data-level="2">Два</h4>');
    expect(html('###### Шесть', 3)).toContain('<h6');
    expect(html('# Раз', 0)).toContain('<h1');
    expect(html('#хэштег')).toContain('<p>#хэштег</p>');
  });

  it('renders bold, italic and code', () => {
    const out = html('**Победа!** Счёт _1-0_ и *мат*, тема `hangingPiece`.');
    expect(out).toContain('<strong>Победа!</strong>');
    expect(out).toContain('<em>1-0</em>');
    expect(out).toContain('<em>мат</em>');
    expect(out).toContain('<code>hangingPiece</code>');
  });

  it('leaves snake_case, lone stars and unclosed markers alone', () => {
    expect(html('файл my_game_file.pgn')).toContain('my_game_file.pgn');
    expect(html('2 * 3 * 4')).toContain('2 * 3 * 4');
    expect(html('**не закрыто')).toContain('**не закрыто');
    expect(html('Ход 12… Фxe5+ ?? и `код')).toContain('`код');
  });

  it('supports backslash escapes', () => {
    expect(html('\\*не курсив\\*')).toContain('<p>*не курсив*</p>');
    expect(html('\\# не заголовок')).toContain('<p># не заголовок</p>');
  });

  it('renders bullet, ordered and nested lists', () => {
    const out = html('- один\n- два\n  - вложенный\n  - ещё\n- три\n\n1. первый\n2) второй');
    expect(out).toContain('<ul><li>один</li><li>два<ul><li>вложенный</li><li>ещё</li></ul></li><li>три</li></ul>');
    expect(out).toContain('<ol><li>первый</li><li>второй</li></ol>');
  });

  it('joins an indented continuation line to its list item', () => {
    expect(html('- первая строка\n  продолжение\n- вторая')).toContain('<li>первая строка продолжение</li>');
  });

  it('renders tables with alignment and escaped pipes', () => {
    const out = html('| Качество хода | Сколько |\n|---|--:|\n| Лучший ход ★ | 3 |\n| Зевок ?? | **1** |\n| a \\| b |');
    expect(out).toContain('<th scope="col">Качество хода</th>');
    expect(out).toContain('<th scope="col" style="text-align:right">Сколько</th>');
    expect(out).toContain('<td>Лучший ход ★</td>');
    expect(out).toContain('<td style="text-align:right"><strong>1</strong></td>');
    expect(out).toContain('<td>a | b</td>');
    // short rows are padded to the header width
    expect(out.match(/<td/g)?.length).toBe(6);
  });

  it('renders quotes, rules, hard breaks and fenced code as inert text', () => {
    expect(html('> Думай **спокойно**\n> и смело')).toContain('<blockquote>Думай <strong>спокойно</strong> и смело</blockquote>');
    expect(html('a\n\n---\n\nb')).toContain('<hr/>');
    expect(html('строка  \nновая')).toContain('строка<br/>новая');
    const fenced = html('```html\n<script>alert(1)</script>\n```');
    expect(fenced).toContain('<code>&lt;script&gt;alert(1)&lt;/script&gt;</code>');
  });

  it('parses the real template review shape', () => {
    const source = [
      '# Разбор партии: Тёма — Петя',
      '',
      '_21.09.2026 · 10 минут · Тёма играет белыми_',
      '',
      '## Ключевые моменты',
      '',
      '### 1. Ход 3. Фxe5+ — зевок',
      '',
      '- Сыграно: **3. Фxe5+** ??',
      '- Сильнее было: **3. Сc4**',
      '',
      'Тема: **Фигура без защиты** (`hangingPiece`). Пяти–шести задач хватит.',
    ].join('\n');
    const blocks = parseMarkdown(source);
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'heading', 'heading', 'list', 'paragraph']);
    const out = html(source);
    expect(out).toContain('<em>21.09.2026 · 10 минут · Тёма играет белыми</em>');
    expect(out).toContain('<li>Сыграно: <strong>3. Фxe5+</strong> ??</li>');
  });

  it('parseInline merges plain text into single nodes', () => {
    expect(parseInline('просто текст')).toEqual([{ type: 'text', text: 'просто текст' }]);
    expect(inlineText(parseInline('a **b** `c` [d](https://e.example)'))).toBe('a b c d');
  });
});
