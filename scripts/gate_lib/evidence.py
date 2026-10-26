"""比较当前输入与原始计划；从不推断未记录的运行事实。"""
from datetime import datetime
from pathlib import Path

from .files import Invalid, Inventory, read_json, relative
from .reports import full_command, full_selection, read_proof, tests
from .control import validate_closeout


def _report_reasons(item, receipt, path):
    if item["kind"] != "playwright":
        return []
    try:
        proof = receipt["report"]
        name = relative(proof["path"])
        target = Path(path).absolute().parent / name
        inventory = Inventory()
        _, issues = inventory.capture(target, name)
        entry = inventory.entries.get(name, {})
        if issues or entry.get("kind") != "file" or entry.get("sha256") != proof["sha256"]:
            return ["TEST_REPORT_MISSING_OR_CHANGED"]
        report = read_json(target, expected_sha256=proof["sha256"])
        discovery = read_proof(Path(path).absolute().parent, receipt["discovery"])
        discovery_proof = receipt["discovery"]
        if (discovery_proof["path"] == proof["path"]
                or discovery_proof.get("command") != full_command(item, discover=True)
                or type(discovery_proof.get("exit_code")) is not int or discovery_proof["exit_code"] != 0
                or proof.get("command") != full_command(item)
                or any(test.get("results") != [] for _, _, test in tests(discovery))):
            return ["DISCOVERY_NOT_PROVEN"]
        if not full_selection(report) or not full_selection(discovery):
            return ["TEST_SELECTION_NOT_FULL"]
        discovered = [ident for ident, _, _ in tests(discovery)]
        # 发现报告独立产生；执行报告不能自行定义本次应覆盖的集合。
        if (discovery.get("errors") != [] or len(set(discovered)) != len(discovered)
                or sorted(discovered) != sorted(receipt["coverage"]["collected"])):
            return ["DISCOVERY_MISMATCH"]
        ids, passed = [], True
        for ident, spec, test in tests(report):
            ids.append(ident)
            results = test["results"]
            passed = passed and (spec.get("ok", True) and test["expectedStatus"] == "passed" and test["status"] == "expected"
                                 and len(results) == 1 and results[0]["status"] == "passed"
                                 and results[0].get("retry", 0) == 0
                                 and results[0].get("errors", []) == [] and results[0].get("error") is None)
        expected_stats = {"expected": len(ids), "unexpected": 0, "flaky": 0, "skipped": 0}
        if (not ids or len(set(ids)) != len(ids) or not passed or report["errors"] != []
                or any(type(report["stats"].get(k)) is not int or report["stats"][k] != v for k, v in expected_stats.items())
                or sorted(ids) != sorted(receipt["coverage"]["collected"])):
            return ["TEST_REPORT_NOT_PASSED"]
        return []
    except (KeyError, TypeError, ValueError, OSError, AttributeError):
        return ["INVALID_TEST_REPORT"]


def compare(current, previous):
    if not isinstance(previous, dict) or not isinstance(previous.get("entries"), dict):
        raise Invalid("需要完整的原始计划对象")
    if (type(previous.get("schema_version")) is not int or previous["schema_version"] != 1
            or previous.get("root") != current["root"]):
        raise Invalid("计划版本或工作区不匹配")
    if previous.get("definition") != current["definition"]:
        raise Invalid("检查定义已改变，需要新计划")
    old = {item["id"]: item for item in previous["checks"]}
    if set(old) != {item["id"] for item in current["checks"]} or len(old) != len(previous["checks"]):
        raise Invalid("检查集合不完整或重复")
    for item in current["checks"]:
        prior = old[item["id"]]
        item["input_matches"] = item["input_key"] == prior["input_key"]
        item["output_matches"] = item["output_key"] == prior["output_key"]
        item["reasons"].extend(item["input_issues"] + item["output_issues"])
        if not item["input_matches"]:
            item["reasons"].append("INPUT_CHANGED")
        if not item["output_matches"]:
            item["reasons"].append("OUTPUT_CHANGED")
        before = set(prior["input_entries"] + prior["output_entries"])
        after = set(item["input_entries"] + item["output_entries"])
        item["changes"] = {
            "added": sorted(after - before), "removed": sorted(before - after),
            "changed": sorted(key for key in before & after if previous["entries"].get(key) != current["entries"][key]),
        }
    return current


def _reasons(item, receipt, path):
    if not isinstance(receipt.get("coverage"), dict) or not isinstance(receipt.get("upstream"), dict):
        raise Invalid("回执 coverage/upstream 必须为对象")
    reasons = []
    for field, expected in (("schema_version", 2), ("check_id", item["id"]),
                            ("command", item["command"]), ("cwd", item["cwd"]), ("scope", "full")):
        if (receipt.get(field) != expected
                or (field == "schema_version" and type(receipt.get(field)) is not int)):
            reasons.append("RECEIPT_MISMATCH:" + field)
    if not isinstance(receipt.get("run_id"), str) or not receipt["run_id"].strip():
        reasons.append("MISSING_RUN_ID")
    if receipt.get("status") != "passed" or type(receipt.get("exit_code")) is not int or receipt["exit_code"] != 0:
        reasons.append("RUN_NOT_PASSED")
    try:
        start, end = (datetime.fromisoformat(receipt[key]) for key in ("started_at", "finished_at"))
        if start.tzinfo is None or end.tzinfo is None or end < start:
            raise ValueError("time")
    except (KeyError, TypeError, ValueError):
        reasons.append("INVALID_RUN_TIME")
    if any(receipt.get(field) != item["input_key"] for field in ("input_before", "input_after")):
        reasons.append("RECEIPT_INPUT_MISMATCH")
    if receipt.get("output_key") != item["output_key"]:
        reasons.append("RECEIPT_OUTPUT_MISMATCH")
    integrity = receipt.get("integrity", {})
    if not isinstance(integrity, dict) or any(integrity.get(k) is not True for k in
                                            ("exclusive_inputs", "inputs_unchanged", "resources_closed")):
        reasons.append("RUN_INTEGRITY_NOT_PROVEN")
    try:
        manifest = receipt["input_manifest"]
        if not isinstance(manifest["sha256"], str):
            raise Invalid("输入清单引用必须包含原始 SHA-256")
        read_proof(Path(path).absolute().parent, manifest)
    except (KeyError, TypeError, ValueError, OSError):
        reasons.append("INPUT_MANIFEST_MISSING_OR_CHANGED")
    logs = receipt.get("logs", [])
    resource_logs = receipt.get("resource_logs")
    if not isinstance(resource_logs, list):
        reasons.append("MISSING_RESOURCE_LOG_MANIFEST")
        resource_logs = []
    if not isinstance(logs, list) or not logs:
        reasons.append("MISSING_RAW_LOG")
    else:
        for log in [*logs, *resource_logs]:
            try:
                name = relative(log["path"])
                inventory = Inventory()
                keys, issues = inventory.capture(Path(path).absolute().parent / name, name)
                record = inventory.entries.get(name, {})
                if issues or record.get("kind") != "file" or record.get("sha256") != log["sha256"]:
                    reasons.append("RAW_LOG_MISMATCH:" + name)
            except (KeyError, TypeError, ValueError, OSError):
                reasons.append("INVALID_RAW_LOG")
    coverage = receipt["coverage"]
    collected, executed = coverage.get("collected"), coverage.get("executed")
    if (not isinstance(collected, list) or not collected or not all(isinstance(x, str) and x for x in collected)
            or len(set(collected)) != len(collected) or not isinstance(executed, list)
            or sorted(collected) != sorted(executed)
            or any(coverage.get(k) != [] for k in ("failed", "skipped", "flaky"))):
        reasons.append("COVERAGE_INCOMPLETE")
    reasons.extend(_report_reasons(item, receipt, path))
    return reasons


def evaluate(current, receipt_paths, plan_path=None, control_proofs=()):
    if plan_path is not None:
        compare(current, read_json(plan_path))
    by_id = {item["id"]: item for item in current["checks"]}
    receipts = {}
    for path in receipt_paths:
        receipt = read_json(path)
        if not isinstance(receipt, dict):
            raise Invalid("回执必须为 JSON 对象")
        ident = receipt.get("check_id")
        if ident not in by_id or ident in receipts:
            raise Invalid("回执检查名未知或重复")
        receipts[ident] = (receipt, path)
    controls = {}
    for authority, path in control_proofs:
        value = read_json(path)
        ident = value.get("check_id") if isinstance(value, dict) else None
        if ident not in receipts or ident in controls:
            raise Invalid("控制证明必须对应一份已提供的回执且不能重复")
        controls[ident] = (authority, path)
    for item in current["checks"]:
        item["reasons"] = [r for r in item["reasons"] if r != "NO_RECEIPT"]
        item["reasons"].extend(item["input_issues"] + item["output_issues"])
        pair = receipts.get(item["id"])
        if pair is None:
            item["reasons"].append("NO_RECEIPT")
        else:
            receipt, path = pair
            reasons = _reasons(item, receipt, path)
            if item["id"] in controls:
                try:
                    authority, control_path = controls[item["id"]]
                    item["control_evidence"] = validate_closeout(authority, control_path, item, receipt, path,
                                                                 Path(current["root"]))
                    reasons = [r for r in reasons if r != "RUN_INTEGRITY_NOT_PROVEN"]
                except (OSError, ValueError, KeyError, TypeError, AttributeError):
                    reasons.append("CONTROL_PROOF_INVALID")
            item["reasons"].extend(reasons)
            item["source_run_id"] = receipt.get("run_id")
            item["source_receipt"] = str(Path(path).absolute())
            for dep in item["depends_on"]:
                parent = by_id[dep]
                expected = {"run_id": parent.get("source_run_id"), "input_key": parent["input_key"],
                            "output_key": parent["output_key"]}
                if parent["recommendation"] != "REUSE_CANDIDATE" or receipt.get("upstream", {}).get(dep) != expected:
                    item["reasons"].append("UPSTREAM_NOT_PROVEN:" + dep)
        item["reasons"] = sorted(set(item["reasons"]))
        if not item["reasons"]:
            item["recommendation"] = "REUSE_CANDIDATE"
    current["coverage_report"] = [{"check_id": item["id"],
        "action": "REUSED" if item["recommendation"] == "REUSE_CANDIDATE" else "GAP",
        "input_key": item["input_key"], "source_run_id": item.get("source_run_id"),
        "source_receipt": item.get("source_receipt"), "control_evidence": item.get("control_evidence"),
        "reasons": item["reasons"]} for item in current["checks"]]
    current["status"] = ("EVIDENCE_MATCHES" if all(c["recommendation"] == "REUSE_CANDIDATE"
                                                 for c in current["checks"]) else "NOT_REUSABLE")
    return current
