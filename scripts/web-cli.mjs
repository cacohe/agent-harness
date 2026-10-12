import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const exampleDir = resolve(root, 'examples/web')
const exampleConfigPath = resolve(exampleDir, 'config.example.json')
const configPath = resolve(exampleDir, 'config.json')
const envPath = resolve(exampleDir, '.env')
const sessionsRoot = resolve(exampleDir, 'data/sessions')
const webEntry = resolve(root, 'packages/hosts/web/lib/index.js')

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function ensureLocalConfig() {
  await mkdir(sessionsRoot, { recursive: true })
  if (await exists(configPath)) return
  const config = JSON.parse(await readFile(exampleConfigPath, 'utf8'))
  config.sessionRoot = sessionsRoot
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

async function main() {
  if (!(await exists(webEntry))) {
    process.stderr.write('未找到 Web Host 构建产物，请先运行：pnpm run build\n')
    process.exitCode = 1
    return
  }
  await ensureLocalConfig()
  if (!(await exists(envPath))) {
    process.stderr.write('未找到 examples/web/.env。请先执行：\n  cp examples/web/.env.example examples/web/.env\n然后填入 DEEPSEEK_API_KEY。\n')
    process.exitCode = 1
    return
  }
  const child = spawn(process.execPath, [
    `--env-file=${envPath}`,
    webEntry,
    '--config',
    configPath,
    ...process.argv.slice(2),
  ], { stdio: 'inherit', cwd: root })
  child.on('exit', code => { process.exitCode = code ?? 1 })
  child.on('error', error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

await main()
