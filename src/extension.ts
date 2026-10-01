import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { LiveTerminalPty } from './terminalPty';

let server: net.Server | undefined;
let livePty: LiveTerminalPty | undefined;
let liveTerminal: vscode.Terminal | undefined;
let activeSocketPath: string | undefined;
let activeJsonPath: string | undefined;

function getWorkspaceRoots(): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }
  return folders.map((f) => f.uri.fsPath);
}

function getSocketAndJsonPaths(): { socketPath: string; jsonPath: string } {
  const sockDir = '/tmp/antigravity-live';
  if (!fs.existsSync(sockDir)) {
    fs.mkdirSync(sockDir, { recursive: true });
    try {
      fs.chmodSync(sockDir, 0o700);
    } catch (_) {}
  }

  const roots = getWorkspaceRoots();
  const idStr = roots.length > 0 ? roots.sort().join('|') : `window-${process.pid}`;
  const hash = crypto.createHash('sha256').update(idStr).digest('hex').slice(0, 10);

  const socketPath = path.join(sockDir, `sock-${hash}.sock`);
  const jsonPath = path.join(sockDir, `ws-${hash}.json`);
  return { socketPath, jsonPath };
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
      fs.chmodSync(targetFile, 0o755);
    }
  } catch (err) {
    console.error('Failed to sync bridge script:', err);
  }

  return targetFile;
}

function installShellHook(): boolean {
  const zshenvPath = path.join(os.homedir(), '.zshenv');
  const hookSnippet = `
# Antigravity Live Terminal Interceptor Hook
if [[ -n "$ANTIGRAVITY_TRAJECTORY_ID" && -z "$__AGY_INTERCEPTED" && -n "$ZSH_EXECUTION_STRING" ]]; then
    export __AGY_INTERCEPTED=1
    if [[ -d /tmp/antigravity-live || -S /tmp/antigravity-live-terminal.sock ]]; then
        exec /usr/bin/python3 "$HOME/.antigravity-live/bridge.py" "$ZSH_EXECUTION_STRING"
    fi
fi
`;

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
        hookSnippet.trim()
      );
      fs.writeFileSync(zshenvPath, content, 'utf-8');
      return true;
    }

    fs.appendFileSync(zshenvPath, hookSnippet, 'utf-8');
    return true;
  } catch (err) {
    console.error('Failed to install shell hook:', err);
    return false;
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Always ensure global bridge script is in ~/.antigravity-live/bridge.py
  syncBridgeScript(context);

  // Compute workspace-isolated socket & metadata paths
  const { socketPath, jsonPath } = getSocketAndJsonPaths();
  activeSocketPath = socketPath;
  activeJsonPath = jsonPath;

  // Clean up stale socket file if it exists
  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch (err) {
    console.error('Failed to unlink existing socket:', err);
  }

  // Write workspace metadata JSON so bridge.py can match cwd to this workspace
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

  // Also maintain legacy symlink /tmp/antigravity-live-terminal.sock
  try {
    const legacyPath = '/tmp/antigravity-live-terminal.sock';
    if (fs.existsSync(legacyPath)) {
      fs.unlinkSync(legacyPath);
    }
    fs.symlinkSync(socketPath, legacyPath);
  } catch (_) {}

  // Check if shell hook needs to be installed or offered
  const zshenvPath = path.join(os.homedir(), '.zshenv');
  let hasHook = false;
  try {
    if (fs.existsSync(zshenvPath)) {
      const content = fs.readFileSync(zshenvPath, 'utf-8');
      hasHook = content.includes('antigravity-live') || content.includes('bridge.py');
    }
  } catch {
    hasHook = false;
  }

  if (!hasHook) {
    vscode.window
      .showInformationMessage(
        'Antigravity Live Terminal: Tự động cấu hình shell hook vào ~/.zshenv để xem live logs?',
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
    // Silently ensure the path in .zshenv is up to date
    installShellHook();
  }

  livePty = new LiveTerminalPty();

  // Create Unix Domain Socket server for this workspace
  server = net.createServer((socket) => {
    const config = vscode.workspace.getConfiguration('antigravity-live-terminal');
    const autoShow = config.get<boolean>('autoShow', false);
    const autoFocus = config.get<boolean>('autoFocus', false);

    // Make sure terminal exists quietly without stealing panel view
    ensureTerminal(autoShow, !autoFocus);

    if (livePty) {
      livePty.registerSocket(socket);
    }

    socket.on('data', (data) => {
      if (livePty) {
        livePty.writeMessage(data.toString());
      }
    });

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

  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o700);
    } catch (_) {}
  });

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
      if (updated) {
        vscode.window.showInformationMessage('Đã cài đặt shell hook vào ~/.zshenv thành công!');
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
  if (activeSocketPath && fs.existsSync(activeSocketPath)) {
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
