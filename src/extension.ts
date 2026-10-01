import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LiveTerminalPty } from './terminalPty';

let server: net.Server | undefined;
let livePty: LiveTerminalPty | undefined;
let liveTerminal: vscode.Terminal | undefined;

function getSocketPath(): string {
  const config = vscode.workspace.getConfiguration('antigravity-live-terminal');
  return config.get<string>('socketPath', '/tmp/antigravity-live-terminal.sock');
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
    if [[ -S /tmp/antigravity-live-terminal.sock ]]; then
        exec /usr/bin/python3 "$HOME/.antigravity-live/bridge.py" "$ZSH_EXECUTION_STRING"
    fi
fi
`;

  try {
    let content = '';
    if (fs.existsSync(zshenvPath)) {
      content = fs.readFileSync(zshenvPath, 'utf-8');
    }

    if (content.includes('antigravity-live-terminal.sock') && content.includes('.antigravity-live/bridge.py')) {
      return false; // Already up to date
    }

    // If it has old custom path, update it to standard path
    if (content.includes('antigravity-live-terminal.sock')) {
      content = content.replace(/\$HOME\/.*\/bridge\.py/, '$HOME/.antigravity-live/bridge.py');
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
  const socketPath = getSocketPath();

  // Always ensure global bridge script is in ~/.antigravity-live/bridge.py
  syncBridgeScript(context);

  // Check if shell hook needs to be installed or offered
  const zshenvPath = path.join(os.homedir(), '.zshenv');
  let hasHook = false;
  try {
    if (fs.existsSync(zshenvPath)) {
      const content = fs.readFileSync(zshenvPath, 'utf-8');
      hasHook = content.includes('antigravity-live-terminal.sock');
    }
  } catch {
    hasHook = false;
  }

  if (!hasHook) {
    vscode.window.showInformationMessage(
      'Antigravity Live Terminal: Tự động cấu hình shell hook vào ~/.zshenv để xem live logs?',
      'Cài đặt ngay',
      'Để sau'
    ).then((choice) => {
      if (choice === 'Cài đặt ngay') {
        if (installShellHook()) {
          vscode.window.showInformationMessage('Đã cài đặt shell hook thành công!');
        }
      }
    });
  } else {
    // Silently ensure the path in .zshenv points to ~/.antigravity-live/bridge.py
    installShellHook();
  }

  // Clean up stale socket file if it exists
  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch (err) {
    console.error('Failed to unlink existing socket:', err);
  }

  livePty = new LiveTerminalPty();

  // Create Unix Domain Socket server
  server = net.createServer((socket) => {
    const config = vscode.workspace.getConfiguration('antigravity-live-terminal');
    const autoShow = config.get<boolean>('autoShow', true);
    const autoFocus = config.get<boolean>('autoFocus', false);

    // Make sure terminal exists and show it
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
    } catch (e) {
      // Ignore chmod error if not applicable
    }
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
  const socketPath = getSocketPath();
  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch (err) {
    // Ignore cleanup error
  }
}
