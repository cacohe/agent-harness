import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const exampleDir = resolve(root, 'examples/cli')
const exampleConfigPath = resolve(exampleDir, 'config.example.json')
const configPath = resolve(exampleDir, 'config.json')
const envPath = resolve(exampleDir, '.env')
const sessionsRoot = resolve(exampleDir, 'data/sessions')
const cliEntry = resolve(root, 'packages/hosts/cli/lib/index.js')

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
  if (!(await exists(configPath))) {
    const raw = await readFile(exampleConfigPath, 'utf8')
    const config = JSON.parse(raw)
    config.sessionRoot = sessionsRoot
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  }
}

function injectDefaultConfig(argv) {
  if (argv.includes('--config')) return [...argv]
  const mode = argv[0]
  if (mode !== 'run' && mode !== 'resume' && mode !== 'chat') return [...argv]
  return [mode, '--config', configPath, ...argv.slice(1)]
}

async function main() {
  if (!(await exists(cliEntry))) {
    process.stderr.write('未找到 CLI 构建产物，请先运行：pnpm run build\n')
    process.exitCode = 1
    return
  }

  await ensureLocalConfig()
  if (!(await exists(envPath))) {
    process.stderr.write(
      '未找到 examples/cli/.env。请先执行：\n  cp examples/cli/.env.example examples/cli/.env\n然后填入 DEEPSEEK_API_KEY。\n',
    )
    process.exitCode = 1
    return
  }

  const argv = injectDefaultConfig(process.argv.slice(2))
  if (argv.length === 0) {
    process.stderr.write(
      '用法：\n  pnpm agent run --session <id> --message <文本>\n  pnpm agent resume --session <id> --message <文本>\n  pnpm agent chat --session <id> [--message <文本>]\n',
    )
    process.exitCode = 1
    return
  }

  const nodeArgs = [`--env-file=${envPath}`, cliEntry, ...argv]
  const child = spawn(process.execPath, nodeArgs, { stdio: 'inherit', cwd: root })
  child.on('exit', code => {
    process.exitCode = code ?? 1
  })
  child.on('error', error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

await main()
