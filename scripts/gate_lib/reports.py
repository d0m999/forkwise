"""Playwright 原始发现/执行报告的公共读取合同。"""
from pathlib import Path

from .files import Invalid, Inventory, read_json, relative


def full_command(item, *, discover=False):
    args = list(item["command"])
    if args[0] == "npm" and "--" not in args:
        args.append("--")
    args.extend(["--forbid-only", "--grep=.*", "--grep-invert=(?!)", "--project=*",
                 "--retries=0", "--repeat-each=1", "--reporter=list,json"])
    if discover:
        args.append("--list")
    return args


def read_proof(directory, proof):
    return read_json(Path(directory) / relative(proof["path"]), expected_sha256=proof["sha256"])


def tests(report):
    found = []
    def visit(suite):
        for spec in suite.get("specs", []):
            for test in spec["tests"]:
                ident = "::".join([spec["file"], spec["id"], test["projectId"], str(test.get("repeatEachIndex", 0))])
                found.append((ident, spec, test))
        for child in suite.get("suites", []):
            visit(child)
    for suite in report["suites"]:
        visit(suite)
    return found


def attachment_manifest(report, directory):
    """只采集报告引用的本次普通附件；内嵌 body 已由报告摘要覆盖。"""
    directory = Path(directory).absolute()
    names = set()
    for _, _, test in tests(report):
        for result in test["results"]:
            for attachment in result.get("attachments", []):
                if "path" not in attachment:
                    continue
                value = attachment["path"]
                if not isinstance(value, str) or not value:
                    raise Invalid("附件路径必须为非空字符串")
                path = Path(value)
                name = str(path.relative_to(directory)) if path.is_absolute() else value
                names.add(relative(name))
    inventory, manifest = Inventory(), []
    for name in sorted(names):
        _, issues = inventory.capture(directory / name, name)
        entry = inventory.entries.get(name, {})
        if issues or entry.get("kind") != "file":
            raise Invalid("原始附件缺失或不是本次目录内的普通文件：" + name)
        manifest.append({"path": name, "sha256": entry["sha256"]})
    return manifest


def full_selection(report):
    config = report.get("config", {})
    return (config.get("shard") is None and config.get("forbidOnly") is True
            and isinstance(config.get("projects"), list) and bool(config["projects"])
            and all(type(p.get("repeatEach")) is int and p["repeatEach"] == 1
                    and type(p.get("retries")) is int and p["retries"] == 0 for p in config["projects"]))


def coverage(discovery, execution):
    collected = [ident for ident, _, _ in tests(discovery)]
    result = {"collected": sorted(collected), "executed": [], "failed": [], "skipped": [], "flaky": []}
    for ident, _, test in tests(execution):
        if test["results"]:
            result["executed"].append(ident)
        if test["status"] == "skipped":
            result["skipped"].append(ident)
        elif test["status"] == "flaky":
            result["flaky"].append(ident)
        elif test["status"] != "expected" or test["expectedStatus"] != "passed":
            result["failed"].append(ident)
    return result
