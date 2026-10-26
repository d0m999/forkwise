"""将真实 v3 协调上下文、实际 gate 父 wait 与显式资源复核接入证明合同。"""
import argparse
from datetime import datetime, timedelta, timezone
import fcntl
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import uuid

from .control import read_reference, reference, validate_closeout
from .files import Invalid, Inventory, read_json
from .plans import validate
from .runtime import RESOURCE_LOGS


_READ = """
import json,sys
sys.path.insert(0,sys.argv[1])
import controller_v3
revision,issue=int(sys.argv[2]),int(sys.argv[3])
value=controller_v3.load(expected_revision=revision)
ticket=None
if value.get('run_state')=='RUNNING':
    ticket=next((t for t in value['tickets'] if t['issue']==issue),None)
keys=('revision','run_state','workspace_root','active_issue','strict_serial','controller_session_id',
      'workspace_policy','controller_writer_release')
print(json.dumps({**{k:value.get(k) for k in keys},'ticket_state':ticket.get('state') if ticket else None,
                  'ticket_issue':ticket.get('issue') if ticket else None}))
"""


def now():
    return datetime.now(timezone.utc).isoformat()


def context(root, issue, revision):
    directory = Path(root) / "backend/artifacts/controller-storage-v3"
    inventory = Inventory()
    keys, issues = inventory.capture(directory, "controller", patterns=["*.py"])
    if issues or inventory.external_links(keys) or "controller/controller_v3.py" not in keys:
        raise Invalid("找不到可核验的 v3 权威入口")
    key = inventory.fingerprint(keys)
    result = subprocess.run([sys.executable, "-B", "-c", _READ, str(directory), str(revision), str(issue)],
                            capture_output=True, text=True, timeout=90)
    if result.returncode != 0:
        raise Invalid("v3 权威读取失败或 revision 已变化：" + result.stderr[-1000:])
    after = Inventory()
    after_keys, issues = after.capture(directory, "controller", patterns=["*.py"])
    if issues or after.fingerprint(after_keys) != key:
        raise Invalid("v3 实现身份在读取期间变化")
    value = json.loads(result.stdout)
    value["implementation_key"] = key
    value["issue"] = issue
    return value


def require_running(value, root, revision):
    policy, release = value.get("workspace_policy"), value.get("controller_writer_release")
    if value.get("run_state") != "RUNNING":
        raise Invalid("v3 不允许新执行：run_state=" + str(value.get("run_state")))
    if (type(value.get("revision")) is not int or value["revision"] != revision
            or type(value.get("active_issue")) is not int or value["active_issue"] != value["issue"]
            or value.get("strict_serial") is not True or value.get("workspace_root") != str(root)
            or not isinstance(policy, dict) or policy.get("mode") != "existing_repository"
            or policy.get("directory") != str(root) or policy.get("create_worktree") is not False
            or policy.get("preserve_preexisting_wip") is not True or value.get("ticket_state") != "IN_PROGRESS"
            or type(value.get("ticket_issue")) is not int or value["ticket_issue"] != value["issue"]
            or not isinstance(value.get("controller_session_id"), str) or not value["controller_session_id"]
            or not isinstance(release, dict) or release.get("owner") != value["controller_session_id"]
            or release.get("outstandingOwnedWriters") != []):
        raise Invalid("v3 活动票、工作区、单写者或会话所有权不匹配")


def reviewed(value, ctx, kind):
    if (not isinstance(value, dict) or value.get("schema_version") != 1
            or type(value.get("schema_version")) is not int or value.get("kind") != kind
            or type(value.get("issue")) is not int or value["issue"] != ctx["issue"]
            or type(value.get("revision")) is not int or value["revision"] != ctx["revision"]
            or value.get("controller_session_id") != ctx["controller_session_id"]
            or not isinstance(value.get("basis"), str) or not value["basis"].strip()):
        raise Invalid("总控复核记录的版本、范围、会话或依据无效")


def resource_sources(closeout, receipt, receipt_path, grant):
    ctx = grant["controller_context"]
    if closeout.get("controller_context") != ctx:
        raise Invalid("收尾与授权的总控上下文不一致")
    ownership = read_reference(grant["input_ownership"])
    reviewed(ownership, ctx, "gate-input-ownership")
    if (ownership.get("input_key") != receipt["input_before"] or ownership.get("check_id") != receipt["check_id"]
            or ownership.get("input_scope") != "ALL_DECLARED_INPUTS" or ownership.get("frozen") is not True
            or ownership.get("outstanding_writers") != []):
        raise Invalid("原输入所有权复核不完整")
    result = read_reference(closeout["controller_result"])
    process = result.get("process_result", {})
    if (type(result.get("actualParentWaitExit")) is not int or result["actualParentWaitExit"] != 0
            or result.get("childPID") != receipt["control_admission"]["runner_pid"]
            or result.get("parentPID") != grant["owner"]["pid"]
            or result.get("controllerContextUnchanged") is not True
            or result.get("controller_before") != ctx or result.get("controller_after") != ctx
            or result.get("receipt") != reference(receipt_path) or process.get("status") != "passed"
            or process.get("signals") != [] or process.get("interrupted_by") != []
            or process.get("observed_processes_closed") is not True or process.get("alive_after") != []):
        raise Invalid("真实总控父 wait 或上下文关联不完整")
    if not result.get("logs") or any(reference(p["path"]) != p for p in result["logs"]):
        raise Invalid("真实总控原始日志缺失或改变")
    review = read_reference(closeout["resource_review"])
    reviewed(review, ctx, "gate-resource-review")
    if (review.get("run_id") != receipt["run_id"] or review.get("inventory_complete") is not True
            or review.get("input_ownership_uninterrupted") is not True
            or review.get("unknown") != [] or review.get("remaining") != []):
        raise Invalid("总控资源复核仍有未知、遗漏或未关闭项")
    required = [reference(receipt_path), closeout["controller_result"]]
    recorded = receipt.get("resource_logs")
    if (not isinstance(recorded, list) or any(not isinstance(record, dict)
            or set(record) != {"path", "sha256"} for record in recorded)):
        raise Invalid("原回执缺少资源日志清单，不能从当前文件补造")
    names = [record.get("path") for record in recorded]
    if names != [name for name in RESOURCE_LOGS if name in names]:
        raise Invalid("原回执资源日志清单包含未知、重复或乱序项")
    for record in recorded:
        expected = {"path": str(Path(receipt_path).absolute().parent / record["path"]), "sha256": record["sha256"]}
        if reference(expected["path"]) != expected:
            raise Invalid("原运行的资源日志已改变")
        required.append(expected)
    if review.get("raw_records") != required:
        raise Invalid("资源复核必须绑定本次原始回执、实际父 wait 及原回执记录的资源日志；不能借用历史记录")


class Controller:
    def __init__(self, root, issue, revision):
        self.root, self.issue, self.revision = Path(root).resolve(strict=True), issue, revision
        self.state = context(self.root, issue, revision)
        require_running(self.state, self.root, revision)

    def run(self, definition, bindings, plan_path, check_id, destination, ownership_path, timeout, receipts):
        from .execution import output_directory, write_new
        from .processes import execute, snapshot
        if not math.isfinite(timeout) or timeout <= 0:
            raise Invalid("timeout 必须为有限正数")
        started = datetime.now(timezone.utc)
        try:
            expires = (started + timedelta(seconds=timeout + 120)).isoformat()
        except OverflowError as exc:
            raise Invalid("timeout 超出可表示的授权有效期") from exc
        plan, definition_value = read_json(plan_path), read_json(definition)
        validate(definition_value)
        if plan.get("root") != str(self.root) or plan.get("definition") != definition_value:
            raise Invalid("计划与真实总控工作区/检查定义不一致")
        item = next(c for c in plan["checks"] if c["id"] == check_id)
        ownership_ref = reference(ownership_path)
        ownership = read_reference(ownership_ref)
        reviewed(ownership, self.state, "gate-input-ownership")
        if (ownership.get("input_key") != item["input_key"] or ownership.get("check_id") != check_id
                or ownership.get("input_scope") != "ALL_DECLARED_INPUTS" or ownership.get("frozen") is not True
                or ownership.get("outstanding_writers") != []):
            raise Invalid("必须先有本次完整输入范围的显式冻结复核，不能从空 writer 列表推断")
        directory = output_directory(self.root, destination, definition_value, bindings)
        target, grant_path = directory / "run", directory / "grant.json"
        grant = {"schema_version": 1, "kind": "gate-input-grant", "authority_id": self.state["controller_session_id"],
                 "grant_id": uuid.uuid4().hex, "owner": {"pid": os.getpid(), "birth": snapshot()[os.getpid()]["birth"]},
                 "root": str(self.root), "check_id": check_id, "input_key": item["input_key"],
                 "output_directory": str(target), "issued_at": started.isoformat(),
                 "expires_at": expires,
                 "coordination": {"input_scope": "ALL_DECLARED_INPUTS", "single_writer": True, "outstanding_writers": []},
                 "controller_context": self.state, "input_ownership": ownership_ref}
        write_new(grant_path, grant)
        command = [sys.executable, "-B", str(Path(__file__).parents[1] / "gate.py"), "run", "--root", str(self.root),
                   "--definition", str(Path(definition).absolute()), "--plan", str(Path(plan_path).absolute()),
                   "--check", check_id, "--output", str(target), "--timeout", str(timeout), "--control-grant", str(grant_path)]
        for name, path in bindings.items():
            command.extend(["--tool", name + "=" + str(path)])
        for path in receipts:
            command.extend(["--receipt", str(path)])
        with grant_path.open("r+b") as stream:
            fcntl.lockf(stream, fcntl.LOCK_EX)
            def log(name):
                return os.fdopen(os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb")
            with log("controller.stdout.log") as stdout, log("controller.stderr.log") as stderr:
                waited = execute(command, Path.cwd(), dict(os.environ), stdout, stderr, timeout + 120)
            try:
                after = context(self.root, self.issue, self.revision)
                unchanged = after == self.state
            except (OSError, ValueError, subprocess.SubprocessError) as exc:
                after, unchanged = {"error": str(exc)}, False
        try:
            result = read_json(directory / "controller.stdout.log")
        except (OSError, ValueError):
            result = {"status": "incomplete", "acceptance": "NOT_EVALUATED"}
        parent = {"state": "GATE_CONTROLLER_ACTUAL_RESULT", "parentPID": os.getpid(), "childPID": waited["root_pid"],
                  "argv": command, "cwd": str(Path.cwd()), "startedAt": started.isoformat(), "finishedAt": waited["finished_at"],
                  "actualParentWaitExit": waited["exit_code"], "process_result": waited,
                  "logs": [reference(directory / name) for name in ("controller.stdout.log", "controller.stderr.log")],
                  "controller_before": self.state, "controller_after": after, "controllerContextUnchanged": unchanged,
                  "receipt": reference(result["receipt"]) if result.get("receipt") else None}
        write_new(directory / "controller-result.json", parent)
        if (waited["status"] != "passed" or not unchanged) and result.get("status") == "passed":
            result["original_result_status"] = result["status"]
            result["status"] = "incomplete"
        result["controller_result"] = str(directory / "controller-result.json")
        return result

    def closeout(self, receipt_path, review_path, destination):
        from .execution import write_new
        destination = Path(destination).absolute()
        bundle = Path(receipt_path).absolute().parents[1]
        if ".." in destination.parts or destination.parent != bundle or destination.suffix != ".json":
            raise Invalid("收尾证明只能新建在原证据 bundle 的顶层，不能写入源码、工具或链接目录")
        receipt = read_json(receipt_path)
        grant_ref = receipt["control_admission"]["grant"]
        grant = read_reference(grant_ref)
        if grant.get("controller_context") != self.state:
            raise Invalid("当前总控上下文与原 grant 不一致")
        parent_path = Path(receipt_path).absolute().parents[1] / "controller-result.json"
        review = read_reference(reference(review_path))
        waits = [{"phase": phase, "exit_code": process["exit_code"], "finished_at": process["finished_at"]}
                 for phase, process in (("discovery", receipt.get("discovery_process")), ("main", receipt["process_result"]))
                 if process is not None]
        value = {"schema_version": 1, "kind": "gate-control-closeout", "authority_id": self.state["controller_session_id"],
                 "check_id": receipt["check_id"], "run_id": receipt["run_id"], "grant": grant_ref,
                 "receipt": reference(receipt_path), "closed_at": now(),
                 "ownership": {"uninterrupted": True, "outstanding_writers": []},
                 "resources": {"scope": "ALL_DECLARED_RESOURCES", "closed": True, "unknown": [], "remaining": [],
                               "terminal_waits": waits, "basis": review["basis"]},
                 "controller_context": self.state, "controller_result": reference(parent_path),
                 "resource_review": reference(review_path)}
        if receipt.get("status") != "passed":
            raise Invalid("原始运行未完整成功，不能签发复用证明")
        # 先核验全部事实再写；不留下看似成功但未完成校验的 closeout。
        from .control import closeout_values
        item = {"id": receipt["check_id"], "input_key": receipt["input_before"]}
        closeout_values(self.state["controller_session_id"], value, item, receipt, receipt_path, self.root)
        write_new(destination, value)
        return {"status": "CONTROL_ATTESTED", "proof": str(Path(destination).absolute()), "acceptance": "NOT_EVALUATED"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--issue", type=int, required=True)
    parser.add_argument("--revision", type=int, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--resource-review", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = Controller(args.root, args.issue, args.revision).closeout(args.receipt, args.resource_review, args.output)
        print(json.dumps(result, ensure_ascii=False)); return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        print(json.dumps({"status": "CONTROL_REJECTED", "message": str(exc), "acceptance": "NOT_EVALUATED"}, ensure_ascii=False)); return 2


if __name__ == "__main__":
    sys.exit(main())
