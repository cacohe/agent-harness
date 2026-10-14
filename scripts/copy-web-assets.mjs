import { cp, mkdir } from 'node:fs/promises';

const source = new URL('../packages/hosts/web/src/ui/styles.css', import.meta.url);
const destination = new URL('../packages/hosts/web/lib/ui/styles.css', import.meta.url);

await mkdir(new URL('../packages/hosts/web/lib/ui/', import.meta.url), { recursive: true });
await cp(source, destination);
