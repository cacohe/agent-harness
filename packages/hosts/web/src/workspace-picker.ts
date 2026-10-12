import { spawn } from 'node:child_process';

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProcessRunner = (file: string, args: readonly string[]) => Promise<ProcessResult>;

/** 通过本机系统文件夹对话框选择工作目录；取消时返回 undefined。 */
export async function pickWorkspaceDirectory(
  options: { readonly platform?: NodeJS.Platform; readonly run?: ProcessRunner } = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runProcess;
  const invocation = pickerInvocation(platform);
  const result = await run(invocation.file, invocation.args);
  if (result.exitCode !== 0) return undefined;
  const selected = result.stdout.trim().replace(/\/$/, '');
  return selected.length === 0 ? undefined : selected;
}

function pickerInvocation(platform: NodeJS.Platform): {
  readonly file: string;
  readonly args: readonly string[];
} {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-STA', '-NoProfile', '-Command', windowsPickerScript()],
    };
  }
  if (platform === 'darwin') {
    return {
      file: 'osascript',
      args: ['-e', 'POSIX path of (choose folder with prompt "选择 Agent 工作目录")'],
    };
  }
  return {
    file: 'zenity',
    args: ['--file-selection', '--directory', '--title=选择 Agent 工作目录'],
  };
}

function windowsPickerScript(): string {
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.Description = "选择 Agent 工作目录"',
    '$dialog.ShowNewFolderButton = $true',
    '$form = New-Object System.Windows.Forms.Form',
    '$form.TopMost = $true',
    'if ($dialog.ShowDialog($form) -ne [System.Windows.Forms.DialogResult]::OK) { exit 2 }',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    'Write-Output $dialog.SelectedPath',
  ].join('; ');
}

function runProcess(file: string, args: readonly string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}
