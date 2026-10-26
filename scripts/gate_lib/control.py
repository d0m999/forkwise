"""核验调用者显式信任的协调证明；不签发授权或修改原始运行事实。"""
from datetime import datetime, timezone
import fcntl
import os
from pathlib import Path
import stat
import struct
import sys

from .files import Invalid, Inventory, _parent, read_json
from .processes import snapshot


def moment(value):
    result = datetime.fromisoformat(value)
    if result.tzinfo is None:
        raise Invalid("控制证明时间必须含时区")
    return result


def reference(path):
    path = Path(path).absolute()
    inventory = Inventory()
    _, issues = inventory.capture(path, "proof")
    entry = inventory.entries.get("proof", {})
    if (issues or entry.get("kind") != "file" or entry.get("nlink") != 1
            or entry.get("mode", 0) & 0o077 or path.lstat().st_uid != os.getuid()):
        raise Invalid("控制证明须为本人所有的私有普通文件，不能是链接或多 hard link")
    return {"path": str(path), "sha256": entry["sha256"]}


def read_reference(proof):
    if not isinstance(proof, dict) or set(proof) != {"path", "sha256"}:
        raise Invalid("控制证明引用须包含 path 和 sha256")
    actual = reference(proof["path"])
    if actual != proof:
        raise Invalid("控制证明身份已变化")
    return read_json(actual["path"], expected_sha256=actual["sha256"])


def grant_values(grant, item, root, directory):
    if (grant.get("schema_version") != 1 or type(grant.get("schema_version")) is not int
            or grant.get("kind") != "gate-input-grant"
            or any(not isinstance(grant.get(k), str) or not grant[k].strip() for k in ("authority_id", "grant_id"))
            or grant.get("root") != str(root) or grant.get("check_id") != item["id"]
            or grant.get("input_key") != item["input_key"] or grant.get("output_directory") != str(directory)
            or grant.get("coordination") != {"input_scope": "ALL_DECLARED_INPUTS", "single_writer": True,
                                              "outstanding_writers": []}):
        raise Invalid("输入授权与本次范围不匹配，或尚有其他写者")
    owner = grant.get("owner", {})
    if type(owner.get("pid")) is not int or owner["pid"] <= 0 or not isinstance(owner.get("birth"), str):
        raise Invalid("输入授权缺少持有者身份")
    if moment(grant["expires_at"]) <= moment(grant["issued_at"]):
        raise Invalid("输入授权有效期无效")


def live_grant(proof, item, root, directory):
    grant = read_reference(proof)
    grant_values(grant, item, root, directory)
    now = datetime.now(timezone.utc)
    if not moment(grant["issued_at"]) <= now <= moment(grant["expires_at"]):
        raise Invalid("输入授权不在有效期内")
    if sys.platform != "darwin":
        raise Invalid("当前输入授权锁核验仅支持 macOS")
    parent, name = _parent(proof["path"])
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            # Darwin struct flock: off_t start/len, pid_t pid, short type/whence。
            query = struct.pack("qqihh", 0, 0, 0, fcntl.F_WRLCK, os.SEEK_SET)
            start, length, pid, kind, whence = struct.unpack("qqihh", fcntl.fcntl(fd, fcntl.F_GETLK, query))
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise Invalid("授权锁不是普通文件")
        finally:
            os.close(fd)
    finally:
        os.close(parent)
    owner = grant["owner"]
    actual = snapshot().get(owner["pid"], {})
    if (pid != owner["pid"] or kind != fcntl.F_WRLCK or start != 0 or length != 0 or whence != os.SEEK_SET
            or actual.get("birth") != owner["birth"] or actual.get("zombie", True)):
        raise Invalid("控制者没有持有整份授权文件的 POSIX 写锁，或持有者身份已变化")
    return {"grant": proof, "authority_id": grant["authority_id"], "grant_id": grant["grant_id"],
            "owner": owner, "checked_at": now.isoformat(), "runner_pid": os.getpid()}


def validate_closeout(authority, path, item, receipt, receipt_path, root):
    closeout_ref = reference(path)
    closeout = read_reference(closeout_ref)
    closeout_values(authority, closeout, item, receipt, receipt_path, root)
    return {"authority_id": authority, "kind": "CONTROL_ATTESTED", "proof": closeout_ref,
            "grant_id": receipt["control_admission"]["grant_id"]}


def closeout_values(authority, closeout, item, receipt, receipt_path, root):
    if receipt.get("integrity", {}).get("inputs_unchanged") is not True:
        raise Invalid("原运行没有确认输入不变，控制证明不能补成通过")
    if (closeout.get("schema_version") != 1 or type(closeout.get("schema_version")) is not int
            or closeout.get("kind") != "gate-control-closeout" or closeout.get("authority_id") != authority
            or closeout.get("check_id") != item["id"] or closeout.get("run_id") != receipt["run_id"]
            or closeout.get("receipt") != reference(receipt_path)):
        raise Invalid("控制收尾证明不属于可信控制者或本次原始回执")
    grant_ref = closeout["grant"]
    grant = read_reference(grant_ref)
    grant_values(grant, item, root, Path(receipt_path).absolute().parent)
    if grant["authority_id"] != authority:
        raise Invalid("授权与收尾的控制者不一致")
    for key in ("control_admission", "control_release_check"):
        observed = receipt[key]
        if (observed["grant"] != grant_ref or observed["owner"] != grant["owner"]
                or observed["authority_id"] != authority or observed["grant_id"] != grant["grant_id"]
                or not moment(grant["issued_at"]) <= moment(observed["checked_at"]) <= moment(grant["expires_at"])):
            raise Invalid("运行前后控制者核验缺失或不匹配")
    if not (moment(grant["issued_at"]) <= moment(receipt["control_admission"]["checked_at"])
            <= moment(receipt["started_at"]) <= moment(receipt["control_release_check"]["checked_at"])
            <= moment(receipt["finished_at"]) <= moment(closeout["closed_at"])):
        raise Invalid("授权、原运行与收尾时间顺序无效")
    if closeout.get("ownership") != {"uninterrupted": True, "outstanding_writers": []}:
        raise Invalid("控制者未证明输入所有权连续保持")
    resources = closeout["resources"]
    if (resources.get("scope") != "ALL_DECLARED_RESOURCES" or resources.get("closed") is not True
            or resources.get("unknown") != [] or resources.get("remaining") != []
            or not isinstance(resources.get("basis"), str) or not resources["basis"].strip()
            or receipt.get("cleanup", {}).get("complete") is not True):
        raise Invalid("资源收尾仍有缺口")
    expected = []
    for phase, process in (("discovery", receipt.get("discovery_process")), ("main", receipt.get("process_result"))):
        if process is None and phase == "discovery":
            continue
        if (not isinstance(process, dict) or process.get("status") != "passed"
                or type(process.get("exit_code")) is not int or process["exit_code"] != 0
                or process.get("observed_processes_closed") is not True or process.get("alive_after") != []
                or process.get("signals") != [] or process.get("interrupted_by") != []):
            raise Invalid("原运行含失败、未知退出或资源终止，不能补成正常通过")
        expected.append({"phase": phase, "exit_code": process["exit_code"], "finished_at": process["finished_at"]})
    waits = resources.get("terminal_waits")
    if waits != expected or any(type(w.get("exit_code")) is not int for w in waits):
        raise Invalid("控制者实际 wait 记录与原运行不一致")
    if "controller_context" in grant:
        from .controller import resource_sources
        resource_sources(closeout, receipt, receipt_path, grant)
