"""监督自有子进程树；信号仅发往 PID 与出生身份仍匹配的进程。"""
import os
import signal
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
import shutil
import stat
import base64


def snapshot():
    result = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,pgid=,lstart=,stat="],
                            capture_output=True, text=True, check=True, env={"LC_ALL": "C"}, timeout=5)
    entries = {}
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) >= 9:
            entries[int(fields[0])] = {"ppid": int(fields[1]), "pgid": int(fields[2]),
                                      "birth": " ".join(fields[3:8]), "zombie": fields[8].startswith("Z")}
    return entries


def execute(command, cwd, environment, stdout, stderr, timeout):
    started_at = datetime.now(timezone.utc).isoformat()
    try:
        process = subprocess.Popen(command, cwd=cwd, env=environment, stdin=subprocess.DEVNULL,
                                   stdout=stdout, stderr=stderr, start_new_session=True, umask=0o077)
    except OSError as exc:
        stderr.write((str(exc) + "\n").encode())
        return {"exit_code": None, "root_pid": None, "status": "not_started", "observed_processes_closed": True,
                "processes": [], "alive_after": [], "signals": [], "interrupted_by": [],
                "started_at": started_at, "finished_at": datetime.now(timezone.utc).isoformat(),
                "launch_error": str(exc)}
    known, stopped, interrupted, cleanup = {}, None, [], []
    deadline = time.monotonic() + timeout
    def request_stop(signum, _frame):
        interrupted.append(signum)
    previous = {sig: signal.signal(sig, request_stop) for sig in (signal.SIGINT, signal.SIGTERM)}
    def observe():
        current = snapshot()
        if process.pid in current and process.pid not in known:
            known[process.pid] = current[process.pid]
        # 本次 start_new_session 创建的进程组也覆盖父进程已退出的普通孤儿。
        for pid, info in current.items():
            if info["pgid"] == process.pid and pid not in known:
                known[pid] = info
        changed = True
        while changed:
            changed = False
            for pid, info in current.items():
                parent = known.get(info["ppid"])
                if (pid not in known and parent is not None and info["ppid"] in current
                        and current[info["ppid"]]["birth"] == parent["birth"]):
                    known[pid] = info
                    changed = True
        return {pid: info for pid, info in current.items() if pid in known
                and info["birth"] == known[pid]["birth"] and not info["zombie"]}
    def send(sig):
        live = observe()
        for pid in sorted(live, key=lambda pid: pid == process.pid):
            try:
                os.kill(pid, sig)
                cleanup.append({"pid": pid, "signal": sig.name})
            except ProcessLookupError:
                pass
    try:
        while True:
            live = observe()
            if interrupted:
                stopped = "interrupted"
                break
            if process.poll() is not None:
                break
            if time.monotonic() >= deadline:
                stopped = "timed_out"
                break
            time.sleep(0.1)
        if stopped:
            send(signal.SIGTERM)
        grace = time.monotonic() + 1.5
        while observe() and time.monotonic() < grace:
            process.poll()
            time.sleep(0.05)
        live = observe()
        if live:
            stopped = stopped or "incomplete"
            send(signal.SIGKILL)
        process.wait(timeout=5)
        grace = time.monotonic() + 1
        while observe() and time.monotonic() < grace:
            time.sleep(0.05)
        live = observe()
        return {"exit_code": process.returncode, "root_pid": process.pid,
                "status": stopped or ("passed" if process.returncode == 0 else "failed"),
                "started_at": started_at, "finished_at": datetime.now(timezone.utc).isoformat(),
                "observed_processes_closed": not live,
                "processes": [{"pid": pid, **info} for pid, info in known.items()],
                "alive_after": sorted(live), "signals": cleanup, "interrupted_by": interrupted}
    finally:
        if process.poll() is None:
            # 监督器异常也必须收尾；本进程创建的 session/group 仍由存活父进程持有。
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def reclaim(directory, *, passed, processes_closed):
    """仅清理本次创建的目录；只检查元数据，不读取 profile/数据库正文。"""
    removed, retained = [], []
    handle_checks = []
    def observe_handles(stage, argv, **options):
        started_at = datetime.now(timezone.utc).isoformat()
        result = subprocess.run(argv, capture_output=True, timeout=15, **options)
        check = {"stage": stage, "argv": argv, "started_at": started_at,
                 "finished_at": datetime.now(timezone.utc).isoformat(), "returncode": result.returncode}
        for stream in ("stdout", "stderr"):
            value = getattr(result, stream)
            check[stream] = value if isinstance(value, str) else value.decode("utf-8", errors="replace")
            if isinstance(value, bytes):
                check[stream + "_base64"] = base64.b64encode(value).decode("ascii")
        # Keep diagnostics in memory until the caller writes the receipt, so
        # recording the scan cannot itself create a writer inside its scope.
        handle_checks.append(check)
        return result
    handles = observe_handles("output", ["/usr/sbin/lsof", "-FpcRgfatn", "+D", str(directory)], text=True)
    writers, pid = set(), None
    for line in handles.stdout.splitlines():
        if line.startswith("p"):
            pid = int(line[1:])
        elif line.startswith("a") and line[1:] in {"w", "u"} and pid is not None:
            writers.add(pid)
    handles_known = handles.returncode in (0, 1) and not handles.stderr
    processes_closed = processes_closed and handles_known and not writers
    def safe(path):
        info = path.lstat()
        if info.st_uid != os.getuid() or stat.S_ISLNK(info.st_mode):
            return False
        if stat.S_ISDIR(info.st_mode):
            return all(safe(child) for child in path.iterdir())
        return stat.S_ISREG(info.st_mode) and info.st_nlink == 1
    # test-results 包含报告引用的附件、截图和原始观察，属于证据而非临时数据。
    for name in ("home", "tmp", "cache"):
        path = Path(directory) / name
        if not path.exists() and not path.is_symlink():
            continue
        if not processes_closed or not passed or not safe(path):
            retained.append({"path": name, "reason": "failure_or_unreleased_or_special_entry"})
            continue
        handles = observe_handles(name, ["/usr/sbin/lsof", "-FpcRgfatn", "+D", str(path)])
        if handles.returncode != 1 or handles.stdout or handles.stderr:
            retained.append({"path": name, "reason": "open_handles_or_unknown"})
            continue
        shutil.rmtree(path)
        removed.append(name)
    return {"removed": removed, "retained": retained, "complete": not retained and processes_closed,
            "output_writers": sorted(writers), "output_handle_check_known": handles_known, "handle_checks": handle_checks}
