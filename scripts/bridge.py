#!/usr/bin/env python3
import sys
import os
import datetime
import json
import socket
import base64
import tempfile

IS_WINDOWS = sys.platform == "win32"

if not IS_WINDOWS:
    import pty
    import select
    import struct
    import fcntl
    import termios
    import errno
else:
    import subprocess
    import threading

def find_connection():
    """
    Finds the active connection to the VS Code Live Terminal extension.
    Returns:
        (conn_type, conn_target, token)
        conn_type: 'tcp' or 'unix'
    """
    # Check explicit env override first
    if "ANTIGRAVITY_LIVE_SOCKET" in os.environ:
        target = os.environ["ANTIGRAVITY_LIVE_SOCKET"]
        if os.path.exists(target):
            return ("unix", target, None)

    cwd = os.getcwd()

    if IS_WINDOWS:
        sock_dir = os.path.join(tempfile.gettempdir(), "antigravity-live")
    else:
        sock_dir = "/tmp/antigravity-live"

    best_target = None
    best_len = 0
    fallback_target = None
    fallback_mtime = 0

    if os.path.isdir(sock_dir):
        try:
            for fname in os.listdir(sock_dir):
                if fname.endswith(".json"):
                    fpath = os.path.join(sock_dir, fname)
                    try:
                        with open(fpath, "r", encoding="utf-8") as f:
                            data = json.load(f)

                        mtime = os.path.getmtime(fpath)

                        if IS_WINDOWS:
                            port = data.get("port")
                            token = data.get("token")
                            if not port:
                                continue
                            current_target = ("tcp", ("127.0.0.1", port), token)
                        else:
                            sock_path = data.get("socket")
                            if not sock_path or not os.path.exists(sock_path):
                                continue
                            current_target = ("unix", sock_path, None)

                        if mtime > fallback_mtime:
                            fallback_mtime = mtime
                            fallback_target = current_target

                        roots = data.get("roots", [])
                        for root in roots:
                            # Normalize paths for case-insensitive Windows comparisons
                            norm_cwd = os.path.normcase(cwd)
                            norm_root = os.path.normcase(root)
                            if norm_cwd == norm_root or norm_cwd.startswith(norm_root + os.sep):
                                if len(root) > best_len:
                                    best_len = len(root)
                                    best_target = current_target
                    except Exception:
                        continue
        except Exception:
            pass

    if best_target:
        return best_target
    if fallback_target:
        return fallback_target

    if not IS_WINDOWS:
        legacy = "/tmp/antigravity-live-terminal.sock"
        if os.path.exists(legacy):
            return ("unix", legacy, None)

    return (None, None, None)

# ─────────────────────────────────────────────────────────────────────────────
# macOS / Linux POSIX Implementation (100% preserved)
# ─────────────────────────────────────────────────────────────────────────────

def set_winsize(fd, rows=35, cols=140):
    try:
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except Exception:
        pass

def run_posix_direct(cmd):
    os.environ["__AGY_INTERCEPTED"] = "1"
    os.execvp("/bin/zsh", ["zsh", "-c", cmd])

def run_posix(cmd, sock):
    pid, master_fd = pty.fork()
    if pid == 0:
        os.environ["__AGY_INTERCEPTED"] = "1"
        os.environ["TERM"] = "xterm-256color"
        os.execvp("/bin/zsh", ["zsh", "-c", cmd])
        sys.exit(1)

    set_winsize(master_fd)

    inputs = [master_fd, sock.fileno()]
    stdin_fd = sys.stdin.fileno()
    try:
        if not sys.stdin.closed:
            inputs.append(stdin_fd)
    except Exception:
        pass

    exit_code = 0
    child_alive = True

    try:
        while inputs:
            readable, _, _ = select.select(inputs, [], [], 0.05)
            for fd in readable:
                if fd == master_fd:
                    try:
                        data = os.read(master_fd, 4096)
                    except OSError as e:
                        if e.errno in (errno.EIO, errno.EBADF):
                            data = b""
                        else:
                            raise

                    if not data:
                        if master_fd in inputs:
                            inputs.remove(master_fd)
                    else:
                        try:
                            sys.stdout.buffer.write(data)
                            sys.stdout.buffer.flush()
                        except Exception:
                            pass
                        try:
                            sock.sendall(data)
                        except Exception:
                            pass

                elif fd == sock.fileno():
                    try:
                        user_input = sock.recv(1024)
                    except Exception:
                        user_input = b""

                    if not user_input:
                        if sock.fileno() in inputs:
                            inputs.remove(sock.fileno())
                    else:
                        try:
                            os.write(master_fd, user_input)
                        except Exception:
                            pass

                elif fd == stdin_fd:
                    try:
                        agent_input = os.read(stdin_fd, 1024)
                    except Exception:
                        agent_input = b""

                    if not agent_input:
                        if stdin_fd in inputs:
                            inputs.remove(stdin_fd)
                    else:
                        try:
                            os.write(master_fd, agent_input)
                        except Exception:
                            pass

            if child_alive:
                res, status = os.waitpid(pid, os.WNOHANG)
                if res == pid:
                    child_alive = False
                    if os.WIFEXITED(status):
                        exit_code = os.WEXITSTATUS(status)
                    elif os.WIFSIGNALED(status):
                        exit_code = 128 + os.WTERMSIG(status)
                    else:
                        exit_code = 1
                    try:
                        while True:
                            r, _, _ = select.select([master_fd], [], [], 0.05)
                            if not r:
                                break
                            d = os.read(master_fd, 4096)
                            if not d:
                                break
                            sys.stdout.buffer.write(d)
                            sys.stdout.buffer.flush()
                            sock.sendall(d)
                    except Exception:
                        pass
                    break

        if child_alive:
            _, status = os.waitpid(pid, 0)
            if os.WIFEXITED(status):
                exit_code = os.WEXITSTATUS(status)
            elif os.WIFSIGNALED(status):
                exit_code = 128 + os.WTERMSIG(status)
            else:
                exit_code = 1

    finally:
        try:
            os.close(master_fd)
        except Exception:
            pass

        color = "\x1b[1;32m" if exit_code == 0 else "\x1b[1;31m"
        footer = f"\r\n{color}[Exit Code: {exit_code}]\x1b[0m\r\n\r\n"
        try:
            sock.sendall(footer.encode("utf-8"))
            sock.close()
        except Exception:
            pass

    sys.exit(exit_code)

# ─────────────────────────────────────────────────────────────────────────────
# Windows Implementation (Interactive Multi-threaded Duplex Bridge)
# ─────────────────────────────────────────────────────────────────────────────

def run_windows_direct(cmd):
    os.environ["__AGY_INTERCEPTED"] = "1"
    p = subprocess.run(["powershell.exe", "-NoLogo", "-Command", cmd])
    sys.exit(p.returncode)

def run_windows(cmd, sock):
    env = os.environ.copy()
    env["__AGY_INTERCEPTED"] = "1"

    proc = subprocess.Popen(
        ["powershell.exe", "-NoLogo", "-Command", cmd],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
        bufsize=0
    )

    child_alive = True

    def stdout_worker():
        nonlocal child_alive
        try:
            while True:
                chunk = proc.stdout.read(1024)
                if not chunk:
                    break
                # Mirror to agent stdout
                try:
                    sys.stdout.buffer.write(chunk)
                    sys.stdout.buffer.flush()
                except Exception:
                    pass
                # Mirror to VS Code Live Terminal
                try:
                    sock.sendall(chunk)
                except Exception:
                    pass
        except Exception:
            pass

    def socket_worker():
        # Receives keystrokes typed by the user in the VS Code Live Terminal panel
        while child_alive:
            try:
                data = sock.recv(1024)
                if not data:
                    break
                if proc.stdin and not proc.stdin.closed:
                    proc.stdin.write(data)
                    proc.stdin.flush()
            except Exception:
                break

    def stdin_worker():
        # Receives input sent by the Antigravity agent (via send_input tool)
        try:
            while child_alive:
                if sys.stdin.closed:
                    break
                data = sys.stdin.buffer.read1(1024) if hasattr(sys.stdin.buffer, "read1") else sys.stdin.buffer.read(1024)
                if not data:
                    break
                if proc.stdin and not proc.stdin.closed:
                    proc.stdin.write(data)
                    proc.stdin.flush()
        except Exception:
            pass

    t_stdout = threading.Thread(target=stdout_worker, daemon=True)
    t_sock = threading.Thread(target=socket_worker, daemon=True)
    t_stdin = threading.Thread(target=stdin_worker, daemon=True)

    t_stdout.start()
    t_sock.start()
    t_stdin.start()

    exit_code = proc.wait()
    child_alive = False

    # Wait for remaining stdout bytes to flush
    t_stdout.join(timeout=2.0)

    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass

    color = "\x1b[1;32m" if exit_code == 0 else "\x1b[1;31m"
    footer = f"\r\n{color}[Exit Code: {exit_code}]\x1b[0m\r\n\r\n"
    try:
        sock.sendall(footer.encode("utf-8"))
        sock.close()
    except Exception:
        pass

    # Use os._exit on Windows to avoid Python shutdown deadlocks caused by background reader daemon threads
    os._exit(exit_code)

# ─────────────────────────────────────────────────────────────────────────────
# Main Entry Point
# ─────────────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        return

    if sys.argv[1] == "--base64" and len(sys.argv) >= 3:
        try:
            cmd = base64.b64decode(sys.argv[2]).decode("utf-8")
        except Exception:
            cmd = sys.argv[2]
    else:
        cmd = sys.argv[1]

    conn_type, conn_target, token = find_connection()
    if not conn_type or not conn_target:
        if IS_WINDOWS:
            run_windows_direct(cmd)
        else:
            run_posix_direct(cmd)
        return

    # Connect to Live Terminal Extension
    try:
        if conn_type == "tcp":
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.connect(conn_target)
            if token:
                sock.sendall(f"{token}\n".encode("utf-8"))
        else:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.connect(conn_target)
    except Exception:
        if IS_WINDOWS:
            run_windows_direct(cmd)
        else:
            run_posix_direct(cmd)
        return

    # Send banner header
    cwd = os.getcwd()
    now_str = datetime.datetime.now().strftime("%H:%M:%S")
    header = f"\r\n\x1b[1;36m[Agent Run | {now_str}]:\x1b[0m \x1b[1;32m{cmd}\x1b[0m\r\n\x1b[90m(in {cwd})\x1b[0m\r\n"
    try:
        sock.sendall(header.encode("utf-8"))
    except Exception:
        pass

    if IS_WINDOWS:
        run_windows(cmd, sock)
    else:
        run_posix(cmd, sock)

if __name__ == "__main__":
    main()
