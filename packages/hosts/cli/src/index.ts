import { pathToFileURL } from 'node:url';
import { runCli } from './cli.js';

export {
  type CliDependencies,
  type CliOutput,
  type CliSignals,
  closeCliResources,
  runCli,
} from './cli.js';
export { createShellTool } from './shell-tool.js';

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await runCli({
    argv: process.argv.slice(2),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    signals: process,
  });
  process.exitCode = code;
}
