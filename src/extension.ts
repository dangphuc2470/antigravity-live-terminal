import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
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

export function activate(context: vscode.ExtensionContext) {
  const socketPath = getSocketPath();

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
