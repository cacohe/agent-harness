/** 把模型输出的 Markdown 转成安全 HTML；不解释原文中的 HTML 标签。 */
export function renderMarkdown(source: string): string {
  function escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function sanitizeHref(href: string): string | undefined {
    const trimmed = href.trim();
    if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return trimmed;
    return undefined;
  }

  function fenceHtml(language: string, code: string): string {
    const lang = language.trim();
    const safeLang = /^[A-Za-z0-9_-]+$/.test(lang) ? lang : '';
    const cls = safeLang === '' ? '' : ` class="language-${escapeHtml(safeLang)}"`;
    return `<pre><code${cls}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`;
  }

  function renderInline(value: string): string {
    const placeholders: string[] = [];
    const stash = (html: string): string => {
      placeholders.push(html);
      return `%%INLINE${placeholders.length - 1}%%`;
    };
    let text = escapeHtml(value);
    text = text.replace(/`([^`]+)`/g, (_match, code: string) => stash(`<code>${code}</code>`));
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
      const url = sanitizeHref(href.replaceAll('&amp;', '&'));
      if (url === undefined) return label;
      return stash(
        `<a href="${escapeHtml(url)}" rel="noreferrer noopener" target="_blank">${label}</a>`,
      );
    });
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    return text.replace(/%%INLINE(\d+)%%/g, (_match, index: string) => {
      return placeholders[Number(index)] ?? '';
    });
  }

  const listItem = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

  function isDivider(line: string): boolean {
    return /^\|?[\s:|-]+\|[\s:|-]*$/.test(line.trim());
  }

  function isTableStart(line: string, next: string | undefined): boolean {
    return line.includes('|') && next !== undefined && isDivider(next);
  }

  function isBlockStart(line: string, next: string | undefined): boolean {
    const trimmed = line.trim();
    if (trimmed === '') return true;
    if (/^%%FENCE\d+%%$/.test(trimmed)) return true;
    if (/^#{1,6}\s+\S/.test(trimmed)) return true;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return true;
    if (trimmed.startsWith('>')) return true;
    if (listItem.test(line)) return true;
    return isTableStart(line, next);
  }

  function splitRow(line: string): string[] {
    return line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
  }

  function takeTable(lines: string[], start: number): { html: string; next: number } | undefined {
    const headerLine = lines[start];
    const dividerLine = lines[start + 1];
    if (headerLine === undefined || dividerLine === undefined) return undefined;
    if (!isTableStart(headerLine, dividerLine)) return undefined;
    const rows: string[] = [];
    let index = start + 2;
    while (index < lines.length) {
      const line = lines[index];
      if (line === undefined || line.trim() === '' || !line.includes('|') || isDivider(line)) break;
      rows.push(line);
      index += 1;
    }
    const head = splitRow(headerLine)
      .map((cell) => `<th>${renderInline(cell)}</th>`)
      .join('');
    const body = rows
      .map(
        (row) =>
          `<tr>${splitRow(row)
            .map((cell) => `<td>${renderInline(cell)}</td>`)
            .join('')}</tr>`,
      )
      .join('');
    return {
      html: `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
      next: index,
    };
  }

  function takeList(lines: string[], start: number): { html: string; next: number } | undefined {
    const first = listItem.exec(lines[start] ?? '');
    if (first === null || first[1] === undefined || first[2] === undefined) return undefined;
    const baseIndent = first[1].length;
    const ordered = /^\d+\./.test(first[2]);
    const items: Array<{ text: string; nested: string }> = [];
    let index = start;
    while (index < lines.length) {
      const line = lines[index] ?? '';
      if (line.trim() === '') {
        const following = lines.slice(index + 1).find((candidate) => candidate.trim() !== '');
        if (following === undefined || !listItem.test(following)) break;
        index += 1;
        continue;
      }
      const item = listItem.exec(line);
      if (
        item === null ||
        item[1] === undefined ||
        item[2] === undefined ||
        item[3] === undefined
      ) {
        break;
      }
      const indent = item[1].length;
      if (indent < baseIndent) break;
      if (indent > baseIndent) {
        const nested = takeList(lines, index);
        if (nested === undefined || items.length === 0) break;
        const last = items[items.length - 1];
        if (last === undefined) break;
        last.nested += nested.html;
        index = nested.next;
        continue;
      }
      if (/^\d+\./.test(item[2]) !== ordered) break;
      items.push({ text: item[3], nested: '' });
      index += 1;
    }
    if (items.length === 0) return undefined;
    const tag = ordered ? 'ol' : 'ul';
    const inner = items.map((item) => `<li>${renderInline(item.text)}${item.nested}</li>`).join('');
    return { html: `<${tag}>${inner}</${tag}>`, next: index };
  }

  const fences: string[] = [];
  let remaining = source.replaceAll('\r\n', '\n');
  remaining = remaining.replace(
    /```([^\n]*)\n([\s\S]*?)```/g,
    (_match, language: string, code: string) => {
      fences.push(fenceHtml(language, code));
      return `\n\n%%FENCE${fences.length - 1}%%\n\n`;
    },
  );
  remaining = remaining.replace(
    /```([^\n]*)(?:\n([\s\S]*))?$/,
    (_match, language: string, code: string) => {
      fences.push(fenceHtml(language, code ?? ''));
      return `\n\n%%FENCE${fences.length - 1}%%\n\n`;
    },
  );

  const lines = remaining.split('\n');
  const html: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (trimmed === '') {
      index += 1;
      continue;
    }
    const fence = /^%%FENCE(\d+)%%$/.exec(trimmed);
    if (fence !== null) {
      html.push(fences[Number(fence[1])] ?? '');
      index += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading !== null && heading[1] !== undefined && heading[2] !== undefined) {
      html.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
      index += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      html.push('<hr>');
      index += 1;
      continue;
    }
    if (trimmed.startsWith('>')) {
      const quote: string[] = [];
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('>')) {
        quote.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index += 1;
      }
      html.push(
        `<blockquote>${renderInline(quote.join('\n')).replaceAll('\n', '<br>')}</blockquote>`,
      );
      continue;
    }
    const table = takeTable(lines, index);
    if (table !== undefined) {
      html.push(table.html);
      index = table.next;
      continue;
    }
    const list = takeList(lines, index);
    if (list !== undefined) {
      html.push(list.html);
      index = list.next;
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (isBlockStart(current, lines[index + 1])) break;
      paragraph.push(current);
      index += 1;
    }
    if (paragraph.length > 0) {
      html.push(`<p>${renderInline(paragraph.join('\n')).replaceAll('\n', '<br>')}</p>`);
    } else {
      index += 1;
    }
  }
  return html.join('');
}
