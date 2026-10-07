# Antigravity Live Terminal

Real-time mirror and interactive terminal for Antigravity AI Agent commands. Supports both **Windows (PowerShell)** and **macOS / Linux (zsh/bash)**.

## Features
- **Real-Time Streaming**: Watch command output stream live as it runs (build logs, test outputs, package downloads).
- **Interactive Keystroke Forwarding**: Type directly into the terminal tab to input sudo passwords, answer `[y/N]` prompts, or interact with long-running CLI tools.
- **Full Bi-directional Bridging**:
  - **macOS / Linux**: Native POSIX pseudo-terminal (`pty.fork()`, `select`).
  - **Windows**: Multi-threaded duplex stream with full stdin/stdout forwarding over secure local loopback IPC.
- **100% Native Agent Compatibility**: The agent continues to run standard `run_command` tool calls with full exit-code and output capture.

## Setup Instructions

### 1. Build or Install the Extension
```bash
npm install
npm run package
code --install-extension "antigravity-live-terminal-0.0.5.vsix" --force
```

### 2. Configure Shell Interceptor Hook

#### On Windows (PowerShell):
The extension automatically prompts to install the hook on launch. You can also run the command palette action:
- `Antigravity Live: Setup Shell Hook (PowerShell profile / ~/.zshenv)`

Or manually add this snippet into your PowerShell profile (`$PROFILE`):
```powershell
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
        $bridgePath = Join-Path $env:USERPROFILE '.antigravity-live\bridge.py'
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
```

#### On macOS / Linux (zsh):
Add to `~/.zshenv`:
```bash
# Antigravity Live Terminal Interceptor Hook
if [[ -n "$ANTIGRAVITY_TRAJECTORY_ID" && -z "$__AGY_INTERCEPTED" && -n "$ZSH_EXECUTION_STRING" ]]; then
    export __AGY_INTERCEPTED=1
    if [[ -d /tmp/antigravity-live || -S /tmp/antigravity-live-terminal.sock ]]; then
        exec /usr/bin/python3 "$HOME/.antigravity-live/bridge.py" "$ZSH_EXECUTION_STRING"
    fi
fi
```

### 3. Reload Window
Reload VS Code or Antigravity IDE window (`Developer: Reload Window`).
The terminal tab named **Agent Live** will automatically mirror and stream all commands invoked by the agent.
