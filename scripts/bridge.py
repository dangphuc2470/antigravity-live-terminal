#!/usr/bin/env python3
import sys
import os
import pty
import select
import socket
import struct
import fcntl
import termios
import errno
import datetime

SOCKET_PATH = os.environ.get("ANTIGRAVITY_LIVE_SOCKET", "/tmp/antigravity-live-terminal.sock")

def set_winsize(fd, rows=35, cols=140):
    try:
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except Exception:
        pass

def run_direct(cmd):
    # Fallback to direct execution without interception
    os.environ["__AGY_INTERCEPTED"] = "1"
    os.execvp("/bin/zsh", ["zsh", "-c", cmd])

def main():
    if len(sys.argv) < 2:
        return

    cmd = sys.argv[1]

    # Check if live terminal socket exists
    if not os.path.exists(SOCKET_PATH):
        run_direct(cmd)
        return

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(SOCKET_PATH)
    except Exception:
        # Cannot connect to extension, fallback
        sock.close()
        run_direct(cmd)
        return

    cwd = os.getcwd()
    now_str = datetime.datetime.now().strftime("%H:%M:%S")
    header = f"\r\n\x1b[1;36m>>> [Agent Run | {now_str}]:\x1b[0m \x1b[1;32m{cmd}\x1b[0m \x1b[90m(in {cwd})\x1b[0m\r\n"
    try:
        sock.sendall(header.encode("utf-8"))
    except Exception:
        pass

    # Allocate a pseudo-terminal for the command using pty.fork()
    pid, master_fd = pty.fork()
    if pid == 0:
        # Child process has acquired controlling terminal automatically
        os.environ["__AGY_INTERCEPTED"] = "1"
        os.environ["TERM"] = "xterm-256color"
        os.execvp("/bin/zsh", ["zsh", "-c", cmd])
        sys.exit(1)

    # Parent process
    set_winsize(master_fd)

    # Keep track of open descriptors to monitor
    inputs = [master_fd, sock.fileno()]
    stdin_fd = sys.stdin.fileno()
    try:
        # Only add sys.stdin if valid
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
                    # Output from child command
                    try:
                        data = os.read(master_fd, 4096)
                    except OSError as e:
                        if e.errno in (errno.EIO, errno.EBADF):
                            data = b""
                        else:
                            raise

                    if not data:
                        # Child has closed stdout
                        if master_fd in inputs:
                            inputs.remove(master_fd)
                    else:
                        # 1. Pipe to sys.stdout for Antigravity native capture
                        try:
                            sys.stdout.buffer.write(data)
                            sys.stdout.buffer.flush()
                        except Exception:
                            pass
                        # 2. Mirror to Live Terminal socket
                        try:
                            sock.sendall(data)
                        except Exception:
                            pass

                elif fd == sock.fileno():
                    # Input from User typing in Live Terminal
                    try:
                        user_input = sock.recv(1024)
                    except Exception:
                        user_input = b""

                    if not user_input:
                        if sock.fileno() in inputs:
                            inputs.remove(sock.fileno())
                    else:
                        # Write keystroke to child command's stdin
                        try:
                            os.write(master_fd, user_input)
                        except Exception:
                            pass

                elif fd == stdin_fd:
                    # Input from Antigravity agent stdin
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

            # Check if child process has terminated
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
                    # Drain remaining output from master_fd
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
        footer = f"\r\n{color}<<< [Exit Code: {exit_code}]\x1b[0m\r\n\r\n"
        try:
            sock.sendall(footer.encode("utf-8"))
            sock.close()
        except Exception:
            pass

    sys.exit(exit_code)

if __name__ == "__main__":
    main()
