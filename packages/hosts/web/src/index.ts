import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createSessionRegistry } from './application.js'
import { parseCommand } from './command.js'
import { readWebConfig } from './config.js'
import { LocalWebServer } from './server.js'

export { createSessionRegistry } from './application.js'
export { parseCommand, type WebCommand } from './command.js'
export { readWebConfig, WebUsageError, type WebHostConfig } from './config.js'
export { LocalWebServer } from './server.js'

/** 启动本机 loopback Web UI，并在收到进程信号时有序关闭会话。 */
export async function runWeb(argv: readonly string[]): Promise<number> {
  let server: LocalWebServer | undefined
  try {
    const command = parseCommand(argv)
    const config = await readWebConfig(command.configPath, readFile)
    server = new LocalWebServer(createSessionRegistry(config, process.env))
    const address = await server.listen(command.port)
    process.stdout.write(`Agent Harness Web 已启动：${address}\n`)
    await waitForTermination()
    await server.close()
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    await server?.close().catch(() => undefined)
    return 1
  }
}

function waitForTermination(): Promise<void> {
  return new Promise(resolve => {
    const stop = (): void => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolve()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runWeb(process.argv.slice(2))
}
