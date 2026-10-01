import * as vscode from 'vscode';
import * as net from 'net';

export class LiveTerminalPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;

  private activeSockets: Set<net.Socket> = new Set();
  public onInputReceived?: (data: string) => void;
  public onDimensionsChanged?: (dimensions: vscode.TerminalDimensions) => void;

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.writeMessage('\x1b[1;36m=== Antigravity Agent Live Terminal Ready ===\x1b[0m\r\n');
    this.writeMessage('\x1b[90mWaiting for agent commands...\x1b[0m\r\n\r\n');
  }

  close(): void {
    this.activeSockets.clear();
  }

  writeMessage(message: string): void {
    this.writeEmitter.fire(message);
  }

  clear(): void {
    // ANSI clear screen and scrollback buffer
    this.writeEmitter.fire('\x1b[2J\x1b[3J\x1b[H');
    this.writeMessage('\x1b[1;36m=== Antigravity Agent Live Terminal Ready ===\x1b[0m\r\n\r\n');
  }

  handleInput(data: string): void {
    // Broadcast input to all currently active child process sockets
    for (const socket of this.activeSockets) {
      if (!socket.destroyed) {
        socket.write(data);
      }
    }
    if (this.onInputReceived) {
      this.onInputReceived(data);
    }
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    if (this.onDimensionsChanged) {
      this.onDimensionsChanged(dimensions);
    }
  }

  registerSocket(socket: net.Socket): void {
    this.activeSockets.add(socket);
  }

  unregisterSocket(socket: net.Socket): void {
    this.activeSockets.delete(socket);
  }
}
