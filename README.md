# Antigravity Live Terminal

Real-time mirror and interactive terminal for Antigravity AI Agent commands.

## Features
- **Real-Time Streaming**: Watch command output stream as it runs (build logs, test outputs, package downloads).
- **Interactive Keystroke Forwarding**: Type directly into the terminal tab to input sudo passwords, answer `[y/N]` prompts, or interact with long-running CLI tools.
- **100% Native Agent Compatibility**: The agent continues to run standard `run_command` tool calls with full exit-code and output capture.

## Setup Instructions

1. Install the extension VSIX:
   ```bash
   code --install-extension "antigravity-live-terminal-0.0.1.vsix" --force
   ```
2. Add the transparent interceptor hook to `~/.zshenv`:
   ```bash
   # Antigravity Live Terminal Interceptor Hook
   if [[ -n "$ANTIGRAVITY_TRAJECTORY_ID" && -z "$__AGY_INTERCEPTED" && -n "$ZSH_EXECUTION_STRING" ]]; then
       export __AGY_INTERCEPTED=1
       if [[ -S /tmp/antigravity-live-terminal.sock ]]; then
           exec /usr/bin/python3 "$HOME/Movies/Interstellar/linh tinh/antigravity-live-terminal/scripts/bridge.py" "$ZSH_EXECUTION_STRING"
       fi
   fi
   ```
3. Reload VS Code / Antigravity IDE window.
