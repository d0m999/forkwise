"""Playwright 原始发现/执行报告的公共读取合同。"""
from pathlib import Path

from .files import read_json, relative


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
