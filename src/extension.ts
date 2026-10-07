import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { LiveTerminalPty } from './terminalPty';

const IS_WINDOWS = process.platform === 'win32';

let server: net.Server | undefined;
let livePty: LiveTerminalPty | undefined;
let liveTerminal: vscode.Terminal | undefined;
let activeSocketPath: string | undefined;
let activeJsonPath: string | undefined;
let activeAuthToken: string | undefined;

function getWorkspaceRoots(): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }
  return folders.map((f) => f.uri.fsPath);
}

/**
 * Returns the IPC metadata / socket directory.
 * Unix/macOS: /tmp/antigravity-live
 * Windows: %TEMP%\antigravity-live
 */
function getSockDir(): string {
  if (IS_WINDOWS) {
    return path.join(os.tmpdir(), 'antigravity-live');
  }
  return '/tmp/antigravity-live';
}

function getSocketAndJsonPaths(): { socketPath: string; jsonPath: string; hash: string } {
  const sockDir = getSockDir();
  if (!fs.existsSync(sockDir)) {
    fs.mkdirSync(sockDir, { recursive: true });
    if (!IS_WINDOWS) {
      try {
        fs.chmodSync(sockDir, 0o700);
      } catch (_) {}
    }
  }

  const roots = getWorkspaceRoots();
  const idStr = roots.length > 0 ? roots.sort().join('|') : `window-${process.pid}`;
  const hash = crypto.createHash('sha256').update(idStr).digest('hex').slice(0, 10);

  const socketPath = path.join(sockDir, `sock-${hash}.sock`);
  const jsonPath = path.join(sockDir, `ws-${hash}.json`);
  return { socketPath, jsonPath, hash };
}

function ensureTerminal(show: boolean = false, preserveFocus: boolean = true): vscode.Terminal {
  if (!livePty) {
    livePty = new LiveTerminalPty();
  }

  if (!liveTerminal) {
    liveTerminal = vscode.window.createTerminal({
      name: 'Agent Live',
      pty: livePty,
      iconPath: new vscode.ThemeIcon('hubot'),
      location: vscode.TerminalLocation.Panel,
    });
  }

  if (show) {
    liveTerminal.show(preserveFocus);
  }

  return liveTerminal;
}

function syncBridgeScript(context: vscode.ExtensionContext): string {
  const targetDir = path.join(os.homedir(), '.antigravity-live');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const targetFile = path.join(targetDir, 'bridge.py');
  const sourceFile = context.asAbsolutePath(path.join('scripts', 'bridge.py'));

  try {
    if (fs.existsSync(sourceFile)) {
      fs.copyFileSync(sourceFile, targetFile);
      if (!IS_WINDOWS) {
        fs.chmodSync(targetFile, 0o755);
      }
    }
  } catch (err) {
    console.error('Failed to sync bridge script:', err);
  }

  return targetFile;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unix / macOS zsh hook
// ─────────────────────────────────────────────────────────────────────────────

const ZSH_HOOK_SNIPPET = `
# Antigravity Live Terminal Interceptor Hook
if [[ -n "$ANTIGRAVITY_TRAJECTORY_ID" && -z "$__AGY_INTERCEPTED" && -n "$ZSH_EXECUTION_STRING" ]]; then
    export __AGY_INTERCEPTED=1
    if [[ -d /tmp/antigravity-live || -S /tmp/antigravity-live-terminal.sock ]]; then
        exec /usr/bin/python3 "$HOME/.antigravity-live/bridge.py" "$ZSH_EXECUTION_STRING"
    fi
fi
`;

function hasZshHook(): boolean {
  const zshenvPath = path.join(os.homedir(), '.zshenv');
  try {
    if (fs.existsSync(zshenvPath)) {
      const content = fs.readFileSync(zshenvPath, 'utf-8');
      return content.includes('antigravity-live') || content.includes('bridge.py');
    }
  } catch {}
  return false;
}

function installZshHook(): boolean {
  const zshenvPath = path.join(os.homedir(), '.zshenv');

  try {
    let content = '';
    if (fs.existsSync(zshenvPath)) {
      content = fs.readFileSync(zshenvPath, 'utf-8');
    }

    if (content.includes('antigravity-live') && content.includes('.antigravity-live/bridge.py')) {
      return false; // Already up to date
    }

    // If it has old custom path, update it to standard path
    if (content.includes('antigravity-live-terminal.sock') || content.includes('bridge.py')) {
      content = content.replace(
        /# Antigravity Live Terminal[\s\S]*?fi\s*fi/,
        ZSH_HOOK_SNIPPET.trim()
      );
      fs.writeFileSync(zshenvPath, content, 'utf-8');
      return true;
    }

    fs.appendFileSync(zshenvPath, ZSH_HOOK_SNIPPET, 'utf-8');
    return true;
  } catch (err) {
    console.error('Failed to install zsh hook:', err);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows PowerShell profile hook
// ─────────────────────────────────────────────────────────────────────────────

const PS_HOOK_MARKER = 'Antigravity Live Terminal Interceptor Hook';

const PS_HOOK_SNIPPET = `
# Antigravity Live Terminal Interceptor Hook
if ($env:ANTIGRAVITY_TRAJECTORY_ID -and -not $env:__AGY_INTERCEPTED) {
    $cmdLineArgs = [System.Environment]::GetCommandLineArgs()
    $cmdIdx = -1
    $isEncoded = $false
    for ($i = 0; $i -lt $cmdLineArgs.Length; $i++) {
        $a = $cmdLineArgs[$i]
        if ($a -ieq '-Command' -or $a -ieq '-c') { $cmdIdx = $i; break }
    }
    if ($cmdIdx -eq -1) {
        for ($i = 0; $i -lt $cmdLineArgs.Length; $i++) {
            $a = $cmdLineArgs[$i]
            if ($a -ieq '-EncodedCommand' -or $a -ieq '-enc' -or $a -ieq '-en') {
                $cmdIdx = $i; $isEncoded = $true; break
            }
        }
    }
    if ($cmdIdx -ge 0 -and ($cmdIdx + 1) -lt $cmdLineArgs.Length) {
        $theCmd = $cmdLineArgs[$cmdIdx + 1]
        if ($isEncoded) {
            $theCmd = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String($theCmd))
        }
        $bridgePath = Join-Path $env:USERPROFILE '.antigravity-live\\bridge.py'
        if (Test-Path $bridgePath) {
            $env:__AGY_INTERCEPTED = '1'
            $pyExe = 'python'
            foreach ($exe in @('py', 'python', 'python3')) {
                if (Get-Command $exe -ErrorAction SilentlyContinue) { $pyExe = $exe; break }
            }
            $b64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($theCmd))
            & $pyExe $bridgePath --base64 $b64
            exit $LASTEXITCODE
        }
    }
}
`;

function getPowerShellProfilePaths(): string[] {
  return [
    path.join(os.homedir(), 'Documents', 'PowerShell', 'profile.ps1'),
    path.join(os.homedir(), 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
    path.join(os.homedir(), 'Documents', 'WindowsPowerShell', 'profile.ps1'),
    path.join(os.homedir(), 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
  ];
}

function hasPowerShellHook(): boolean {
  for (const profilePath of getPowerShellProfilePaths()) {
    try {
      if (fs.existsSync(profilePath)) {
        const content = fs.readFileSync(profilePath, 'utf-8');
        if (content.includes(PS_HOOK_MARKER)) {
          return true;
        }
      }
    } catch {}
  }
  return false;
}

function installPowerShellHook(): boolean {
  let anyUpdated = false;
  for (const profilePath of getPowerShellProfilePaths()) {
    try {
      const profileDir = path.dirname(profilePath);
      if (!fs.existsSync(profileDir)) {
        fs.mkdirSync(profileDir, { recursive: true });
      }

      let content = '';
      if (fs.existsSync(profilePath)) {
        content = fs.readFileSync(profilePath, 'utf-8');
      }

      if (content.includes(PS_HOOK_MARKER)) {
        if (!content.includes('--base64') || !content.includes('$b64')) {
          content = content.replace(
            /# Antigravity Live Terminal Interceptor Hook[\s\S]*?\n\}/,
            PS_HOOK_SNIPPET.trim()
          );
          fs.writeFileSync(profilePath, content, 'utf-8');
          anyUpdated = true;
        }
        continue;
      }

      fs.appendFileSync(profilePath, PS_HOOK_SNIPPET, 'utf-8');
      anyUpdated = true;
    } catch (err) {
      console.error(`Failed to install PowerShell hook to ${profilePath}:`, err);
    }
  }
  return anyUpdated;
}

function hasShellHook(): boolean {
  return IS_WINDOWS ? hasPowerShellHook() : hasZshHook();
}

function installShellHook(): boolean {
  return IS_WINDOWS ? installPowerShellHook() : installZshHook();
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  // Always ensure global bridge script is synced to ~/.antigravity-live/bridge.py
  syncBridgeScript(context);

  const { socketPath, jsonPath } = getSocketAndJsonPaths();
  activeSocketPath = socketPath;
  activeJsonPath = jsonPath;
  activeAuthToken = crypto.randomBytes(16).toString('hex');

  // Clean up stale Unix domain socket file if on Unix
  if (!IS_WINDOWS) {
    try {
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    } catch (err) {
      console.error('Failed to unlink existing socket:', err);
    }
  }

  // Also maintain legacy symlink /tmp/antigravity-live-terminal.sock (Unix only)
  if (!IS_WINDOWS) {
    try {
      const legacyPath = '/tmp/antigravity-live-terminal.sock';
      if (fs.existsSync(legacyPath)) {
        fs.unlinkSync(legacyPath);
      }
      fs.symlinkSync(socketPath, legacyPath);
    } catch (_) {}
  }

  // Check if shell hook needs to be installed
  if (!hasShellHook()) {
    const hookTarget = IS_WINDOWS ? 'PowerShell profile' : '~/.zshenv';
    vscode.window
      .showInformationMessage(
        `Antigravity Live Terminal: Tự động cấu hình shell hook vào ${hookTarget} để xem live logs?`,
        'Cài đặt ngay',
        'Để sau'
      )
      .then((choice) => {
        if (choice === 'Cài đặt ngay') {
          if (installShellHook()) {
            vscode.window.showInformationMessage('Đã cài đặt shell hook thành công!');
          }
        }
      });
  } else {
    installShellHook();
  }

  livePty = new LiveTerminalPty();

  // Create socket / TCP server
  server = net.createServer((socket) => {
    let authenticated = !IS_WINDOWS; // Unix sockets are permission-protected (0700)

    const config = vscode.workspace.getConfiguration('antigravity-live-terminal');
    const autoShow = config.get<boolean>('autoShow', false);
    const autoFocus = config.get<boolean>('autoFocus', false);

    ensureTerminal(autoShow, !autoFocus);

    socket.on('data', (data) => {
      if (IS_WINDOWS && !authenticated) {
        const text = data.toString('utf-8');
        const lines = text.split('\n');
        if (lines[0].trim() === activeAuthToken) {
          authenticated = true;
          if (livePty) {
            livePty.registerSocket(socket);
          }
          const remaining = lines.slice(1).join('\n');
          if (remaining.length > 0 && livePty) {
            livePty.writeMessage(remaining);
          }
          return;
        } else {
          socket.destroy();
          return;
        }
      }

      if (livePty) {
        livePty.writeMessage(data.toString());
      }
    });

    if (!IS_WINDOWS) {
      if (livePty) {
        livePty.registerSocket(socket);
      }
    }

    socket.on('close', () => {
      if (livePty) {
        livePty.unregisterSocket(socket);
      }
    });

    socket.on('error', (err) => {
      console.error('Socket client error:', err);
      if (livePty) {
        livePty.unregisterSocket(socket);
      }
    });
  });

  if (IS_WINDOWS) {
    // On Windows, use local TCP on 127.0.0.1 with ephemeral port
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address() as net.AddressInfo | null;
      const port = address ? address.port : 0;
      try {
        const metadata = {
          roots: getWorkspaceRoots(),
          port: port,
          token: activeAuthToken,
          pid: process.pid,
          updatedAt: Date.now(),
        };
        fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2), 'utf-8');
      } catch (err) {
        console.error('Failed to write workspace metadata:', err);
      }
    });
  } else {
    // On macOS / Linux, use Unix domain socket
    try {
      const metadata = {
        roots: getWorkspaceRoots(),
        socket: socketPath,
        pid: process.pid,
        updatedAt: Date.now(),
      };
      fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to write workspace metadata:', err);
    }

    server.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o700);
      } catch (_) {}
    });
  }

  server.on('error', (err) => {
    console.error('Agent Live Terminal Server error:', err);
  });

  // Track terminal disposal
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closedTerminal) => {
      if (closedTerminal === liveTerminal) {
        liveTerminal = undefined;
        livePty = undefined;
      }
    })
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity-live-terminal.showTerminal', () => {
      ensureTerminal(true, false);
    }),
    vscode.commands.registerCommand('antigravity-live-terminal.clearTerminal', () => {
      if (livePty) {
        livePty.clear();
      }
    }),
    vscode.commands.registerCommand('antigravity-live-terminal.setupShellHook', () => {
      syncBridgeScript(context);
      const updated = installShellHook();
      const hookTarget = IS_WINDOWS ? 'PowerShell profile' : '~/.zshenv';
      if (updated) {
        vscode.window.showInformationMessage(`Đã cài đặt shell hook vào ${hookTarget} thành công!`);
      } else {
        vscode.window.showInformationMessage('Shell hook đã được cài đặt từ trước.');
      }
    })
  );

  // Ensure terminal is ready on startup
  ensureTerminal(false, true);
}

export function deactivate() {
  if (server) {
    server.close();
    server = undefined;
  }
  if (!IS_WINDOWS && activeSocketPath && fs.existsSync(activeSocketPath)) {
    try {
      fs.unlinkSync(activeSocketPath);
    } catch (_) {}
  }
  if (activeJsonPath && fs.existsSync(activeJsonPath)) {
    try {
      fs.unlinkSync(activeJsonPath);
    } catch (_) {}
  }
}
