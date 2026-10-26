import unittest
import hashlib
import json
from gate_fixture import GateFixture


class EvidenceTests(GateFixture):
    def attachment_receipts(self, plan, name):
        receipts = self.receipts(plan)
        attached = self.put("test-results/" + name + "/observations.json", '{"observed":true}\n')
        receipt = json.loads(receipts[1].read_text())
        receipt["attachments"] = [{"path": str(attached.relative_to(self.root)),
                                    "sha256": hashlib.sha256(attached.read_bytes()).hexdigest()}]
        report_path = self.root / receipt["report"]["path"]
        report = json.loads(report_path.read_text())
        report["suites"][0]["specs"][0]["tests"][0]["results"][0]["attachments"] = [
            {"name": "observations", "contentType": "application/json", "path": str(attached)}]
        report_path.write_text(json.dumps(report))
        receipt["report"]["sha256"] = hashlib.sha256(report_path.read_bytes()).hexdigest()
        receipts[1].write_text(json.dumps(receipt))
        return receipts, attached

    def test_path_attachments_must_keep_original_bytes_and_regular_file_paths(self):
        plan = self.plan()
        saved = self.save_plan(plan)
        for change in ("missing", "changed", "symlink", "ancestor-symlink"):
            with self.subTest(change=change):
                receipts, attached = self.attachment_receipts(plan, change)
                code, matched = self.invoke("verify", "--plan", saved, *self.receipt_args(receipts), "--summary")
                self.assertEqual(code, 0, matched)
                original = receipts[1].read_bytes()
                if change == "missing": attached.unlink()
                elif change == "changed": attached.write_text('{"observed":null}\n')
                else:
                    target = self.put("replacements/" + change + "/observations.json", attached.read_text())
                    attached.unlink()
                    if change == "symlink": attached.symlink_to(target)
                    else:
                        attached.parent.rmdir()
                        attached.parent.symlink_to(target.parent, target_is_directory=True)
                code, rejected = self.invoke("verify", "--plan", saved, *self.receipt_args(receipts), "--summary")
                self.assertEqual(code, 1, rejected)
                self.assertIn("TEST_ATTACHMENTS_MISSING_OR_CHANGED", rejected["checks"][1]["reasons"])
                destination = self.root / ("attachment-reuse-" + change)
                code, refused = self.invoke("run", "--reuse", "--plan", saved, "--check", "frontend-playwright",
                                            "--output", destination, *self.receipt_args(receipts))
                self.assertEqual(code, 1, refused)
                self.assertEqual(refused["status"], "reuse_refused")
                self.assertFalse(destination.exists())
                self.assertEqual(receipts[1].read_bytes(), original)

    def test_attachment_manifest_cannot_be_missing_or_shrink_to_remaining_files(self):
        plan = self.plan()
        saved = self.save_plan(plan)
        for change in ("missing", "null", "empty", "checksum", "extra", "duplicate"):
            with self.subTest(change=change):
                receipts, _ = self.attachment_receipts(plan, change)
                receipt = json.loads(receipts[1].read_text())
                if change == "missing": del receipt["attachments"]
                elif change == "null": receipt["attachments"] = None
                elif change == "empty": receipt["attachments"] = []
                elif change == "checksum": receipt["attachments"][0]["sha256"] = None
                elif change == "extra": receipt["attachments"].append({"path": "unreported.json", "sha256": "0" * 64})
                else: receipt["attachments"] *= 2
                receipts[1].write_text(json.dumps(receipt))
                code, rejected = self.invoke("verify", "--plan", saved, *self.receipt_args(receipts), "--summary")
                self.assertEqual(code, 1, rejected)
                self.assertIn("TEST_ATTACHMENTS_MISSING_OR_CHANGED", rejected["checks"][1]["reasons"])

    def test_attachment_paths_cannot_escape_the_receipt_directory(self):
        plan = self.plan()
        saved = self.save_plan(plan)
        for path in (str(self.root.parent / "outside.json"), "../outside.json", "test-results/../outside.json", "", None):
            with self.subTest(path=path):
                receipts, _ = self.attachment_receipts(plan, "outside")
                receipt = json.loads(receipts[1].read_text())
                report_path = self.root / receipt["report"]["path"]
                report = json.loads(report_path.read_text())
                report["suites"][0]["specs"][0]["tests"][0]["results"][0]["attachments"][0]["path"] = path
                report_path.write_text(json.dumps(report))
                receipt["report"]["sha256"] = hashlib.sha256(report_path.read_bytes()).hexdigest()
                receipt["attachments"][0]["path"] = path
                receipts[1].write_text(json.dumps(receipt))
                code, rejected = self.invoke("verify", "--plan", saved, *self.receipt_args(receipts), "--summary")
                self.assertEqual(code, 1, rejected)
                self.assertIn("TEST_ATTACHMENTS_MISSING_OR_CHANGED", rejected["checks"][1]["reasons"])

    def test_no_attachments_still_requires_an_explicit_original_empty_manifest(self):
        plan = self.plan()
        receipts = self.receipts(plan)
        receipt = json.loads(receipts[1].read_text())
        del receipt["attachments"]
        receipts[1].write_text(json.dumps(receipt))
        code, rejected = self.invoke("verify", "--plan", self.save_plan(plan), *self.receipt_args(receipts), "--summary")
        self.assertEqual(code, 1, rejected)
        self.assertIn("TEST_ATTACHMENTS_MISSING_OR_CHANGED", rejected["checks"][1]["reasons"])

    def test_empty_native_clipboard_guard_allows_otherwise_complete_evidence(self):
        self.environment["FORKWISE_NATIVE_CLIPBOARD_GUARD"] = ""
        plan = self.plan()
        receipts = self.receipts(plan)
        code, result = self.invoke("verify", "--plan", self.save_plan(plan), *self.receipt_args(receipts), "--summary")
        self.assertEqual(code, 0, result)
        self.assertEqual(result["status"], "EVIDENCE_MATCHES")

    def test_undeclared_native_clipboard_guard_blocks_reuse_after_tool_changes(self):
        guard = self.put("external/clipboard-guard", "original guard\n")
        guard.chmod(0o700)
        self.environment["FORKWISE_NATIVE_CLIPBOARD_GUARD"] = str(guard)
        plan = self.plan()
        saved = self.save_plan(plan)
        receipts = self.receipts(plan)
        for change in ("content", "mode"):
            with self.subTest(change=change):
                if change == "content": guard.write_text("replaced guard\n")
                else:
                    guard.write_text("original guard\n")
                    guard.chmod(0o600)
                code, result = self.invoke("verify", "--plan", saved, *self.receipt_args(receipts), "--summary")
                self.assertEqual(code, 1, result)
                self.assertIn("UNDECLARED_ENVIRONMENT_INPUT:FORKWISE_NATIVE_CLIPBOARD_GUARD",
                              result["checks"][1]["reasons"])
                destination = self.root / ("guard-reuse-" + change)
                code, result = self.invoke("run", "--reuse", "--plan", saved, "--check", "frontend-playwright",
                                           "--output", destination, *self.receipt_args(receipts))
                self.assertEqual(code, 2, result)
                self.assertEqual(result["status"], "INVALID_INPUT")
                self.assertFalse(destination.exists())

    def test_complete_receipts_match_same_inputs_without_product_acceptance(self):
        plan = self.plan()
        saved = self.save_plan(plan)
        receipts = self.receipts(plan)
        self.put("README.md", "unrelated documentation\n")
        self.put(".git/HEAD", "metadata-only change\n")
        code, result = self.invoke("verify", "--plan", saved, *self.receipt_args(receipts))
        self.assertEqual(code, 0, result)
        self.assertEqual(result["status"], "EVIDENCE_MATCHES")
        self.assertTrue(all(check["recommendation"] == "REUSE_CANDIDATE" for check in result["checks"]))
        self.assertEqual(result["acceptance"], "NOT_EVALUATED")

    def test_claimed_test_pass_must_match_original_report(self):
        plan = self.plan()
        receipts = self.receipts(plan)
        report = self.root / "frontend-playwright.report.json"
        data = json.loads(report.read_text())
        data["suites"][0]["specs"][0]["tests"][0]["results"][0]["status"] = "failed"
        report.write_text(json.dumps(data))
        receipt = json.loads(receipts[1].read_text())
        receipt["report"]["sha256"] = hashlib.sha256(report.read_bytes()).hexdigest()
        receipts[1].write_text(json.dumps(receipt))
        code, result = self.invoke("verify", "--plan", self.save_plan(plan), *self.receipt_args(receipts))
        self.assertEqual(code, 1, result)
        self.assertIn("TEST_REPORT_NOT_PASSED", result["checks"][1]["reasons"])

    def test_input_manifest_reference_is_required_and_cannot_disable_checksum_verification(self):
        for change in ("missing-reference", "null-reference", "null-checksum", "outside-path"):
            with self.subTest(change=change):
                plan = self.plan()
                receipts = self.receipts(plan)
                receipt = json.loads(receipts[0].read_text())
                if change == "missing-reference": del receipt["input_manifest"]
                elif change == "null-reference": receipt["input_manifest"] = None
                elif change == "null-checksum": receipt["input_manifest"]["sha256"] = None
                else: receipt["input_manifest"]["path"] = "../outside.json"
                receipts[0].write_text(json.dumps(receipt))
                code, result = self.invoke("verify", "--plan", self.save_plan(plan), *self.receipt_args(receipts))
                self.assertEqual(code, 1, result)
                self.assertIn("INPUT_MANIFEST_MISSING_OR_CHANGED", result["checks"][0]["reasons"])

    def test_partial_shard_cannot_claim_full_suite_coverage(self):
        plan = self.plan()
        receipts = self.receipts(plan)
        report = self.root / "frontend-playwright.report.json"
        data = json.loads(report.read_text())
        data["config"] = {"shard": {"current": 1, "total": 2}}
        report.write_text(json.dumps(data))
        receipt = json.loads(receipts[1].read_text())
        receipt["report"]["sha256"] = hashlib.sha256(report.read_bytes()).hexdigest()
        receipts[1].write_text(json.dumps(receipt))
        code, result = self.invoke("verify", "--plan", self.save_plan(plan), *self.receipt_args(receipts))
        self.assertEqual(code, 1, result)

    def test_execution_must_cover_independently_discovered_tests(self):
        plan = self.plan()
        receipts = self.receipts(plan)
        discovery = self.root / "frontend-playwright.discovery.json"
        data = json.loads(discovery.read_text())
        second = json.loads(json.dumps(data["suites"][0]["specs"][0]))
        second["id"] = "two"
        data["suites"][0]["specs"].append(second)
        discovery.write_text(json.dumps(data))
        receipt = json.loads(receipts[1].read_text())
        receipt["discovery"]["sha256"] = hashlib.sha256(discovery.read_bytes()).hexdigest()
        receipts[1].write_text(json.dumps(receipt))
        code, result = self.invoke("verify", "--plan", self.save_plan(plan), *self.receipt_args(receipts))
        self.assertEqual(code, 1, result)

    def test_finished_execution_cannot_serve_as_the_discovery_report(self):
        plan = self.plan()
        receipts = self.receipts(plan)
        receipt = json.loads(receipts[1].read_text())
        receipt["discovery"] = receipt["report"]
        receipts[1].write_text(json.dumps(receipt))
        code, result = self.invoke("verify", "--plan", self.save_plan(plan), *self.receipt_args(receipts))
        self.assertEqual(code, 1, result)

    def test_missing_or_modified_raw_log_rejects_an_unchanged_plan(self):
        for action in ("missing", "changed", "symlink"):
            with self.subTest(action=action):
                plan = self.plan()
                receipts = self.receipts(plan)
                log = self.root / "frontend-playwright.stdout"
                if action == "missing": log.unlink()
                elif action == "changed": log.write_text("different run\n")
                else:
                    log.unlink()
                    log.symlink_to(self.root / "workspace-build.stdout")
                code, result = self.invoke("verify", "--plan", self.save_plan(plan), *self.receipt_args(receipts))
                self.assertEqual(code, 1, result)
                self.assertIn("RAW_LOG_MISMATCH:frontend-playwright.stdout", result["checks"][1]["reasons"])
                if log.is_symlink(): log.unlink()

    def test_resource_manifest_and_original_logs_are_required_for_reuse(self):
        for action in ("no-manifest", "missing", "changed", "symlink"):
            with self.subTest(action=action):
                plan = self.plan()
                receipts = self.receipts(plan)
                receipt = json.loads(receipts[0].read_text())
                log = self.put("resources.jsonl", '{"event":"actual-exit"}\n')
                receipt["resource_logs"] = [{"path": log.name, "sha256": hashlib.sha256(log.read_bytes()).hexdigest()}]
                if action == "no-manifest": del receipt["resource_logs"]
                elif action == "missing": log.unlink()
                elif action == "changed": log.write_text('{"event":"different-run"}\n')
                else:
                    log.unlink()
                    log.symlink_to(self.root / "workspace-build.stdout")
                receipts[0].write_text(json.dumps(receipt))
                code, result = self.invoke("verify", "--plan", self.save_plan(plan), *self.receipt_args(receipts))
                self.assertEqual(code, 1, result)
                reason = "MISSING_RESOURCE_LOG_MANIFEST" if action == "no-manifest" else "RAW_LOG_MISMATCH:resources.jsonl"
                self.assertIn(reason, result["checks"][0]["reasons"])
                if log.is_symlink(): log.unlink()

    def test_unfinished_or_incomplete_runs_never_supply_pass_credit(self):
        changes = [
            {"status": "partial"}, {"exit_code": None}, {"exit_code": False}, {"schema_version": True}, {"schema_version": 1},
            {"input_after": "changed"}, {"finished_at": None}, {"logs": []},
            {"integrity": {"exclusive_inputs": False, "inputs_unchanged": True, "resources_closed": True}},
            {"coverage": {"collected": ["one", "two"], "executed": ["one"], "failed": [], "skipped": [], "flaky": []}},
            {"upstream": {}}, {"report": {"path": "missing.json", "sha256": "missing"}},
        ]
        for change in changes:
            with self.subTest(change=change):
                plan = self.plan()
                receipts = self.receipts(plan)
                receipt = json.loads(receipts[1].read_text())
                receipt.update(change)
                receipts[1].write_text(json.dumps(receipt))
                code, result = self.invoke("verify", "--plan", self.save_plan(plan), *self.receipt_args(receipts))
                self.assertEqual(code, 1, result)
                self.assertEqual(result["checks"][1]["recommendation"], "RUN_REQUIRED")

    def test_no_receipt_is_a_gap_even_when_all_inputs_match(self):
        plan = self.plan()
        code, result = self.invoke("verify", "--plan", self.save_plan(plan))
        self.assertEqual(code, 1, result)
        self.assertTrue(all(check["input_matches"] for check in result["checks"]))
        self.assertTrue(all("NO_RECEIPT" in check["reasons"] for check in result["checks"]))

    def test_malformed_evidence_fails_closed_with_a_structured_error(self):
        for target in ("plan", "receipt", "coverage", "upstream"):
            with self.subTest(target=target):
                plan = self.plan()
                saved = self.save_plan(plan)
                receipts = self.receipts(plan)
                if target == "plan": saved.write_text("[]")
                elif target == "receipt": receipts[1].write_text("[]")
                else:
                    receipt = json.loads(receipts[1].read_text())
                    receipt[target] = []
                    receipts[1].write_text(json.dumps(receipt))
                code, result = self.invoke("verify", "--plan", saved, *self.receipt_args(receipts))
                self.assertEqual(code, 2, result)
                self.assertEqual(result["status"], "INVALID_INPUT")


if __name__ == "__main__":
    unittest.main()
