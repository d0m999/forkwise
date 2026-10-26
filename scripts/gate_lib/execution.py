"""执行一个已计划检查；保存原结果，不签发交付或独占写者证明。"""
from datetime import datetime, timezone
import fcntl
import fnmatch
import json
import os
from pathlib import Path
import math
import uuid
import time
import stat

from .evidence import compare, evaluate, _reasons, _report_reasons
from .control import live_grant, reference
from .files import Invalid, Inventory, _parent, read_json
from .plans import create
from .runtime import RESOURCE_LOGS, argv, environment, validate_resolution
from .processes import execute, reclaim
from .reports import coverage, full_command, full_selection, tests


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def write_new(path, value):
    raw = (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode()
    if ".." in Path(path).parts:
        raise Invalid("证据写入路径不得包含父目录跳转")
    parent, name = _parent(path)
    try:
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    finally:
        os.close(parent)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def proof(directory, name):
    inventory = Inventory()
    _, issues = inventory.capture(directory / name, name)
    item = inventory.entries.get(name, {})
    if issues or item.get("kind") != "file":
        raise Invalid("原始结果缺失或不是普通文件：" + name)
    return {"path": name, "sha256": item["sha256"]}


def output_directory(root, destination, definition, bindings):
    destination = Path(destination).absolute()
    if ".." in destination.parts:
        raise Invalid("证据目录不得包含父目录跳转")
    protected = [Path(__file__).absolute().parents[1]]
    for value in bindings.values():
        bound = Path(os.path.normpath(Path(value).absolute()))
        protected.append(bound if stat.S_ISDIR(bound.lstat().st_mode) else bound.parent)
    if any(destination == path or path in destination.parents for path in protected):
        raise Invalid("证据目录不得位于 runner 或工具安装目录中")
    for specs in definition["groups"].values():
        for spec in specs:
            parent = root / spec["path"]
            if destination == parent or parent in destination.parents:
                subpath = destination.relative_to(parent)
                if (not subpath.parts or "patterns" not in spec
                        or any(fnmatch.fnmatchcase(subpath.parts[0], p) for p in spec["patterns"])):
                    raise Invalid("证据目录不得位于声明的输入或产物中")
    fd, name = _parent(destination)
    try:
        os.mkdir(name, mode=0o700, dir_fd=fd)
    finally:
        os.close(fd)
    return destination


def upstream_for(item, plan, receipt_paths):
    supplied = {}
    for path in receipt_paths:
        receipt = read_json(path)
        if not isinstance(receipt, dict) or receipt.get("check_id") in supplied:
            raise Invalid("上游回执无效或重复")
        supplied[receipt.get("check_id")] = (receipt, path)
    result = {}
    for dep in item["depends_on"]:
        parent = next(c for c in plan["checks"] if c["id"] == dep)
        if dep not in supplied or parent["depends_on"] or parent["input_issues"] or parent["output_issues"]:
            raise Invalid("需要当前构建产物的有效直接上游回执")
        receipt, path = supplied[dep]
        reasons = _reasons(parent, receipt, path)
        integrity = receipt.get("integrity", {})
        observed_closed = (integrity.get("resources_closed") is True
                           or (receipt.get("process_result", {}).get("observed_processes_closed") is True
                               and receipt.get("cleanup", {}).get("complete") is True))
        if (any(r != "RUN_INTEGRITY_NOT_PROVEN" for r in reasons)
                or integrity.get("inputs_unchanged") is not True or not observed_closed):
            raise Invalid("上游未成功结束、输入变化或资源尚未关闭")
        result[dep] = {"run_id": receipt["run_id"], "input_key": parent["input_key"], "output_key": parent["output_key"]}
    return result


def run(root, definition, bindings, plan_path, check_id, destination, timeout=1800, receipt_paths=(), *,
        control_grant=None, control_proofs=(), reuse=False):
    if not math.isfinite(timeout) or timeout <= 0:
        raise Invalid("timeout 必须为有限正数")
    root = Path(root).resolve(strict=True)
    lock = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = create(root, definition, bindings)
        compare(before, read_json(plan_path))
        item = next((c for c in before["checks"] if c["id"] == check_id), None)
        if item is None or item["input_issues"] or not item["input_matches"]:
            raise Invalid("检查未知、输入缺失或计划输入已变化")
        if reuse:
            evaluated = evaluate(before, receipt_paths, control_proofs=control_proofs)
            selected = next(c for c in evaluated["checks"] if c["id"] == check_id)
            result = {"status": "reuse_refused", "coverage_report": evaluated["coverage_report"],
                      "acceptance": "NOT_EVALUATED"}
            if selected["recommendation"] != "REUSE_CANDIDATE":
                return result
            directory = output_directory(root, destination, before["definition"], bindings)
            result.update(status="reused", check_id=check_id, source_run_id=selected["source_run_id"],
                          source_receipt=selected["source_receipt"], report=str(directory / "coverage.json"))
            write_new(directory / "coverage.json", result)
            return result
        admission = (live_grant(reference(control_grant), item, root, Path(destination).absolute())
                     if control_grant is not None else None)
        upstream = upstream_for(item, before, receipt_paths)
        validate_resolution(item, bindings, root)
        if item["kind"] == "playwright":
            browser = environment(bindings).get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH")
            if not browser or "chromium" not in item["tools"]:
                raise Invalid("Playwright 执行必须显式指定已声明 Chromium 的可执行文件")
            relative_browser = Path(browser).absolute().relative_to(Path(bindings["chromium"]).absolute())
            selected = before["entries"].get("@tool/chromium/" + str(relative_browser), {})
            if selected.get("kind") != "file" or not selected.get("mode", 0) & 0o111:
                raise Invalid("Chromium 可执行文件未被工具清单覆盖")
        directory = output_directory(root, destination, before["definition"], bindings)
        for name in ("home", "tmp", "cache"):
            (directory / name).mkdir(mode=0o700)
        for name in ("user.npmrc", "global.npmrc"):
            (directory / name).touch(mode=0o600, exist_ok=False)
        command = full_command(item) if item["kind"] == "playwright" else item["command"]
        actual = argv(command, bindings, directory, item["tools"])
        if item["kind"] == "playwright":
            actual.append("--output=" + str(directory / "test-results"))
        run_id, started = uuid.uuid4().hex, timestamp()
        write_new(directory / "inputs.json", before)
        write_new(directory / "started.json", {"run_id": run_id, "check_id": check_id,
                  "started_at": started, "input_key": item["input_key"], "executed_command": actual,
                  "control_admission": admission})
        def open_log(name):
            return os.fdopen(os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb")
        discovery_process, discovery_command, discovery_actual = None, None, None
        discovery_error = None
        deadline = time.monotonic() + timeout
        if item["kind"] == "playwright":
            discovery_command = full_command(item, discover=True)
            discovery_actual = argv(discovery_command, bindings, directory, item["tools"])
            discovery_actual.append("--output=" + str(directory / "test-results"))
            discovery_environment = environment(bindings, directory)
            discovery_environment["PLAYWRIGHT_JSON_OUTPUT_NAME"] = str(directory / "discovery.json")
            with open_log("discovery.stdout.log") as out, open_log("discovery.stderr.log") as err:
                discovery_process = execute(discovery_actual, root / item["cwd"], discovery_environment, out, err, timeout)
            if discovery_process["status"] == "passed":
                try:
                    discovered = read_json(directory / "discovery.json")
                    if not full_selection(discovered) or discovered.get("errors") != [] or not tests(discovered):
                        discovery_error = "DISCOVERY_SELECTION_INCOMPLETE"
                except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
                    discovery_error = "DISCOVERY_REPORT_INVALID:" + type(exc).__name__
            else:
                discovery_error = "DISCOVERY_NOT_PASSED"
        with open_log("stdout.log") as out, open_log("stderr.log") as err:
            if discovery_error:
                process = {"status": "incomplete", "exit_code": None,
                           "observed_processes_closed": discovery_process["observed_processes_closed"],
                           "processes": [], "alive_after": [], "signals": [], "interrupted_by": []}
            else:
                process = execute(actual, root / item["cwd"], environment(bindings, directory), out, err,
                                  max(0.01, deadline - time.monotonic()))
        verification_error = None
        try:
            after = create(root, definition, bindings)
            final = next(c for c in after["checks"] if c["id"] == check_id)
            unchanged = item["input_key"] == final["input_key"] and not final["input_issues"]
        except (OSError, ValueError, KeyError, TypeError, StopIteration) as exc:
            verification_error = type(exc).__name__ + ": " + str(exc)
            final = {"input_key": None, "output_key": None, "output_issues": [verification_error]}
            unchanged = False
        status = process["status"]
        if verification_error:
            status = "verification_failed"
        elif not unchanged:
            status = "input_changed"
        elif final["output_issues"] and status == "passed":
            status = "incomplete"
        receipt = {"schema_version": 2, "check_id": check_id, "run_id": run_id,
                   "command": item["command"], "executed_command": None if discovery_error else actual,
                   "main_execution": "NOT_RUN" if discovery_error else "ATTEMPTED", "cwd": item["cwd"], "scope": "full",
                   "started_at": started, "finished_at": timestamp(), "status": status, "exit_code": process["exit_code"],
                   "input_before": item["input_key"], "input_after": final["input_key"], "output_key": final["output_key"],
                   "integrity": {"exclusive_inputs": False, "inputs_unchanged": unchanged,
                                 "resources_closed": False},
                   "evidence_status": "INCOMPLETE",
                   "integrity_gaps": ["EXCLUSIVE_INPUT_LEASE_NOT_PROVEN", "PROCESS_TREE_COMPLETENESS_NOT_PROVEN"],
                   "process_result": process, "timeout_seconds": timeout,
                   "verification_error": verification_error,
                   "coverage": {"collected": ["command"], "executed": [] if process["exit_code"] is None else ["command"],
                                "failed": ["command"] if process["exit_code"] not in (None, 0) else [], "skipped": [], "flaky": []},
                   "upstream": upstream, "logs": [proof(directory, "stdout.log"), proof(directory, "stderr.log")],
                   "input_manifest": proof(directory, "inputs.json"), "environment_key": before["environment_key"],
                   "tool_bindings": before["tool_bindings"], "environment_names": before["environment_names"],
                   "acceptance": "NOT_EVALUATED"}
        if admission is not None:
            receipt["control_admission"] = admission
        if item["kind"] == "playwright":
            receipt["discovery_process"] = discovery_process
            receipt["discovery_error"] = discovery_error
            receipt["logs"].extend([proof(directory, "discovery.stdout.log"), proof(directory, "discovery.stderr.log")])
            try:
                receipt["discovery"] = {**proof(directory, "discovery.json"), "command": discovery_command,
                                        "executed_command": discovery_actual, "exit_code": discovery_process["exit_code"]}
                receipt["report"] = {**proof(directory, "report.json"), "command": command}
                receipt["coverage"] = coverage(read_json(directory / "discovery.json"), read_json(directory / "report.json"))
                report_reasons = _report_reasons(item, receipt, directory / "receipt.json")
            except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
                report_reasons = ["RAW_REPORT_INCOMPLETE:" + type(exc).__name__]
                receipt["coverage"] = {"collected": [], "executed": [], "failed": [], "skipped": [], "flaky": []}
            receipt["evidence_gaps"] = report_reasons
            if report_reasons and receipt["status"] == "passed":
                receipt["status"] = "incomplete"
        receipt["cleanup"] = reclaim(directory, passed=receipt["status"] == "passed",
                                     processes_closed=process["observed_processes_closed"])
        if receipt["status"] == "passed" and not receipt["cleanup"]["complete"]:
            receipt["status"] = "incomplete"
        receipt["resource_logs"] = []
        for name in RESOURCE_LOGS:
            try:
                (directory / name).lstat()
            except FileNotFoundError:
                continue
            try:
                receipt["resource_logs"].append(proof(directory, name))
            except (OSError, ValueError) as exc:
                receipt.setdefault("evidence_gaps", []).append("RESOURCE_LOG_INVALID:" + name + ":" + str(exc))
                if receipt["status"] == "passed":
                    receipt["status"] = "incomplete"
        if admission is not None:
            try:
                receipt["control_release_check"] = live_grant(admission["grant"], item, root, directory)
            except (OSError, ValueError, KeyError, TypeError) as exc:
                receipt["control_release_check"] = None
                receipt["control_error"] = type(exc).__name__ + ": " + str(exc)
        receipt["finished_at"] = timestamp()
        write_new(directory / "receipt.json", receipt)
        return {"status": receipt["status"], "receipt": str(directory / "receipt.json"), "run_id": run_id,
                "exit_code": process["exit_code"], "evidence_status": "INCOMPLETE", "acceptance": "NOT_EVALUATED",
                "coverage_report": [{"check_id": check_id, "action": "EXECUTED", "source_run_id": run_id,
                                     "source_receipt": str(directory / "receipt.json"), "qualification": "INCOMPLETE"}]}
    finally:
        os.close(lock)
