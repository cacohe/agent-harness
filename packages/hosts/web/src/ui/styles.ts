import { readFile } from 'node:fs/promises';

/** 读取可由独立工具校验的本地聊天界面样式。 */
export const uiCss = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
