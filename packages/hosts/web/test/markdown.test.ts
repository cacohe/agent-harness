import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/ui/markdown.ts';

describe('renderMarkdown', () => {
  it('渲染标题、强调、代码与列表，并转义原始 HTML', () => {
    const html = renderMarkdown(
      '# 标题\n\n这是 **加粗** 和 *斜体* 与 `code`。\n\n- 一项\n- 二项\n\n<script>alert(1)</script>',
    );
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).toContain('<em>斜体</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<ul><li>一项</li><li>二项</li></ul>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('标题和列表即使紧贴段落也能渲染', () => {
    const html = renderMarkdown(
      [
        '以下是各子目录的内容概览：',
        '',
        '## 1. agent-harness/',
        'TypeScript 项目（pnpm monorepo）：',
        '- 配置：package.json、tsconfig.json',
        '- 目录：docs/、packages/',
        '- 文档：AGENTS.md、README.md',
        '',
        '## 2. notes/',
        '中文笔记仓库：',
        '- 1.工作/',
        '  - 子项',
      ].join('\n'),
    );
    expect(html).toContain('<h2>1. agent-harness/</h2>');
    expect(html).toContain('<p>TypeScript 项目（pnpm monorepo）：</p>');
    expect(html).toContain('<li>配置：package.json、tsconfig.json</li>');
    expect(html).toContain('<h2>2. notes/</h2>');
    expect(html).toContain('<ul><li>1.工作/<ul><li>子项</li></ul></li></ul>');
    expect(html).not.toContain('## 1.');
    expect(html).not.toContain('- 配置');
  });

  it('渲染围栏代码块、表格，并拒绝 javascript 链接', () => {
    const html = renderMarkdown(
      '```ts\nconst a = 1\n```\n\n| 列 |\n| --- |\n| 值 |\n\n[危险](javascript:alert(1))\n\n[安全](https://example.com)',
    );
    expect(html).toContain('<pre><code class="language-ts">const a = 1</code></pre>');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>列</th>');
    expect(html).toContain('<td>值</td>');
    expect(html).toContain('危险');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="https://example.com"');
  });
});
