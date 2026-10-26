import unittest
import json
import os
from gate_fixture import GateFixture


class PlanTests(GateFixture):
    def test_plan_declares_build_chain_without_executing_it(self):
        plan = self.plan()
        checks = {item["id"]: item for item in plan["checks"]}
        self.assertEqual(set(checks), {"workspace-build", "frontend-playwright"})
        self.assertEqual(checks["frontend-playwright"]["depends_on"], ["workspace-build"])
        self.assertEqual(checks["workspace-build"]["recommendation"], "RUN_REQUIRED")
        self.assertIn("NO_RECEIPT", checks["workspace-build"]["reasons"])
        self.assertIsInstance(checks["frontend-playwright"]["input_key"], str)
        self.assertEqual(plan["acceptance"], "NOT_EVALUATED")
        self.assertEqual((self.root / "backend/dist/server.js").read_text(), "built product\n")

    def test_verify_rejects_new_test_even_when_old_files_are_unchanged(self):
        old = self.save_plan(self.plan())
        self.put("frontend/tests/added.spec.ts", "test('new behavior')\n")
        code, result = self.invoke("verify", "--plan", old)
        self.assertEqual(code, 1, result)
        checks = {item["id"]: item for item in result["checks"]}
        self.assertIn("INPUT_CHANGED", checks["frontend-playwright"]["reasons"])
        self.assertTrue(checks["workspace-build"]["input_matches"])

    def test_same_bytes_at_a_different_tool_path_are_not_the_same_identity(self):
        plan = self.plan()
        replacement = self.put("tools/other-node", (self.root / "tools/node").read_text())
        replacement.chmod(0o700)
        self.bindings["node"] = replacement
        code, result = self.invoke("verify", "--plan", self.save_plan(plan))
        self.assertEqual(code, 1, result)
        self.assertIn("INPUT_CHANGED", result["checks"][0]["reasons"])

    def test_empty_check_set_cannot_be_reported_as_complete_evidence(self):
        self.put("definition.json", json.dumps({"schema_version": 1, "groups": {}, "checks": []}))
        code, result = self.invoke("plan")
        self.assertEqual(code, 2, result)
        self.assertEqual(result["status"], "INVALID_INPUT")

    def test_input_changes_reject_reuse_even_with_complete_old_receipts(self):
        for name, replacement in (
            ("backend/src/server.ts", "changed source\n"),
            ("backend/dist/server.js", "changed product\n"),
            ("frontend/tests/example.spec.ts", "changed assertion\n"),
            ("frontend/playwright.config.ts", "workers: 4, timeout: 90000\n"),
        ):
            with self.subTest(path=name):
                plan = self.plan()
                receipts = self.receipts(plan)
                path = self.root / name
                original, info = path.read_bytes(), path.stat()
                path.write_text(replacement)
                os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns))
                code, result = self.invoke("verify", "--plan", self.save_plan(plan), *self.receipt_args(receipts))
                self.assertEqual(code, 1, result)
                self.assertNotEqual(result["checks"][1]["recommendation"], "REUSE_CANDIDATE")
                path.write_bytes(original)

    def test_tool_mode_change_is_detected_with_identical_content(self):
        plan = self.plan()
        receipts = self.receipts(plan)
        (self.root / "tools/node").chmod(0o600)
        code, result = self.invoke("verify", "--plan", self.save_plan(plan), *self.receipt_args(receipts))
        self.assertEqual(code, 1, result)
        self.assertIn("INPUT_CHANGED", result["checks"][0]["reasons"])

    def test_external_symlink_is_recorded_without_hashing_its_target(self):
        outside = self.put("outside/private.txt", "never read this target\n")
        (self.root / "backend/src/link").symlink_to(outside)
        plan = self.plan()
        self.assertEqual(plan["entries"]["backend/src/link"]["kind"], "link")
        self.assertNotIn("sha256", plan["entries"]["backend/src/link"])
        self.assertIn("EXTERNAL_LINK:backend/src/link", plan["checks"][0]["reasons"])

    def test_definition_cannot_escape_root_or_omit_upstream_artifacts(self):
        for change in ("escape", "upstream", "unknown_kind", "unknown_field"):
            with self.subTest(change=change):
                definition = json.loads(json.dumps(self.definition))
                if change == "escape": definition["groups"]["source"] = [{"path": "../private"}]
                elif change == "upstream": definition["checks"][1]["inputs"].remove("outputs")
                elif change == "unknown_kind": definition["checks"][1]["kind"] = "unknown"
                else: definition["groups"]["source"][0]["exclude"] = ["server.ts"]
                self.put("definition.json", json.dumps(definition))
                code, result = self.invoke("plan")
                self.assertEqual(code, 2, result)

    def test_external_node_preload_cannot_be_reused_from_its_path_alone(self):
        preload = self.put("outside/preload.js", "external code\n")
        self.environment["NODE_OPTIONS"] = "--require=" + str(preload)
        plan = self.plan()
        receipts = self.receipts(plan)
        code, result = self.invoke("verify", "--plan", self.save_plan(plan), *self.receipt_args(receipts))
        self.assertEqual(code, 1, result)
        self.assertIn("UNDECLARED_ENVIRONMENT_INPUT:NODE_OPTIONS", result["checks"][0]["reasons"])

    def test_link_through_declared_directory_alias_stays_inside_inventory(self):
        self.put("backend/src/real/run.js", "declared code\n")
        (self.root / "backend/src/package").symlink_to("real", target_is_directory=True)
        (self.root / "backend/src/bin").mkdir()
        (self.root / "backend/src/bin/tool").symlink_to("../package/run.js")
        plan = self.plan()
        self.assertEqual(plan["checks"][0]["input_issues"], [])
        self.assertEqual(plan["entries"]["backend/src/bin/tool"]["kind"], "link")

    def test_directory_link_cannot_reuse_partially_captured_target(self):
        self.put("backend/package.json", "{}\n")
        private = self.put("backend/private/value.js", "original undeclared input\n")
        (self.root / "backend/src/alias").symlink_to("..", target_is_directory=True)
        self.definition["groups"]["source"].append({"path": "backend", "patterns": ["package*.json"]})
        self.put("definition.json", json.dumps(self.definition))
        plan = self.plan()
        receipts = self.receipts(plan)
        self.assertNotIn("backend/private/value.js", plan["entries"])
        private.write_text("changed undeclared input\n")
        code, result = self.invoke("verify", "--plan", self.save_plan(plan), *self.receipt_args(receipts))
        self.assertEqual(code, 1, result)
        self.assertIn("EXTERNAL_LINK:backend/src/alias", result["checks"][0]["reasons"])
        self.assertNotEqual(result["status"], "EVIDENCE_MATCHES")

    def test_directory_link_requires_all_members_in_the_same_check(self):
        self.put("shared/package.json", "{}\n")
        self.put("shared/private/value.js", "input for a different check\n")
        (self.root / "backend/src/alias").symlink_to("../../shared", target_is_directory=True)
        self.definition["groups"]["source"].append({"path": "shared", "patterns": ["package*.json"]})
        self.definition["groups"]["tests"].append({"path": "shared"})
        self.put("definition.json", json.dumps(self.definition))
        plan = self.plan()
        self.assertIn("EXTERNAL_LINK:backend/src/alias", plan["checks"][0]["input_issues"])
        self.assertNotIn("EXTERNAL_LINK:backend/src/alias", plan["checks"][1]["input_issues"])

    def test_directory_link_accepts_complete_pattern_coverage(self):
        self.put("shared/package.json", "{}\n")
        self.put("shared/private/value.js", "covered input\n")
        (self.root / "backend/src/alias").symlink_to("../../shared", target_is_directory=True)
        self.definition["groups"]["source"].append({"path": "shared", "patterns": ["*"]})
        self.put("definition.json", json.dumps(self.definition))
        plan = self.plan()
        receipts = self.receipts(plan)
        code, result = self.invoke("verify", "--plan", self.save_plan(plan), *self.receipt_args(receipts))
        self.assertEqual(code, 0, result)
        self.assertEqual(result["status"], "EVIDENCE_MATCHES")

    def test_tool_tree_already_in_inputs_preserves_all_link_labels(self):
        resource = self.put("frontend/node_modules/chromium/Resources/value.js", "browser resource\n")
        browser = resource.parent.parent
        (browser / "Current").symlink_to("Resources", target_is_directory=True)
        self.bindings["chromium"] = browser
        self.definition["groups"]["source"].append({"path": "frontend/node_modules"})
        self.put("definition.json", json.dumps(self.definition))
        plan = self.plan()
        for label in ("frontend/node_modules/chromium/Current", "@tool/chromium/Current"):
            self.assertEqual(plan["entries"][label]["kind"], "link")
        for check in plan["checks"]:
            self.assertEqual(check["input_issues"], [])
        receipts = self.receipts(plan)
        saved = self.save_plan(plan)
        code, result = self.invoke("verify", "--plan", saved, *self.receipt_args(receipts))
        self.assertEqual(code, 0, result)
        self.assertEqual(result["status"], "EVIDENCE_MATCHES")
        resource.write_text("changed browser resource\n")
        code, result = self.invoke("verify", "--plan", saved, *self.receipt_args(receipts))
        self.assertEqual(code, 1, result)
        for check in result["checks"]:
            self.assertIn("INPUT_CHANGED", check["reasons"])

    def test_cyclic_links_are_not_treated_as_covered_inputs(self):
        (self.root / "backend/src/a").symlink_to("b")
        (self.root / "backend/src/b").symlink_to("a")
        plan = self.plan()
        self.assertIn("EXTERNAL_LINK:backend/src/a", plan["checks"][0]["input_issues"])

    def test_other_checks_inputs_do_not_cover_a_builds_link_target(self):
        (self.root / "backend/src/test-input").symlink_to("../../frontend/tests/example.spec.ts")
        plan = self.plan()
        receipts = self.receipts(plan)
        code, result = self.invoke("verify", "--plan", self.save_plan(plan), *self.receipt_args(receipts))
        self.assertEqual(code, 1, result)
        self.assertIn("EXTERNAL_LINK:backend/src/test-input", result["checks"][0]["reasons"])
        self.assertNotIn("EXTERNAL_LINK:backend/src/test-input", result["checks"][1]["input_issues"])

    def test_parent_after_directory_alias_uses_the_real_parent(self):
        self.put("backend/src/secret.ts", "declared decoy\n")
        self.put("backend/src/nested/secret.ts", "undeclared actual input\n")
        (self.root / "backend/src/nested/deep").mkdir()
        (self.root / "backend/src/alias").symlink_to("nested/deep")
        (self.root / "backend/src/a").symlink_to("alias/../secret.ts")
        self.definition["groups"]["source"] = [
            {"path": "backend/src", "patterns": ["a", "alias", "secret.ts"]},
            {"path": "backend/src/nested/deep"},
        ]
        self.put("definition.json", json.dumps(self.definition))
        plan = self.plan()
        self.assertIn("EXTERNAL_LINK:backend/src/a", plan["checks"][0]["input_issues"])

    def test_npm_configuration_is_case_insensitive(self):
        plan = self.plan()
        receipts = self.receipts(plan)
        config = self.put("outside/npmrc", "script-shell=/outside/shell\n")
        self.environment["NPM_CONFIG_USERCONFIG"] = str(config)
        code, result = self.invoke("verify", "--plan", self.save_plan(plan), *self.receipt_args(receipts))
        self.assertEqual(code, 1, result)
        self.assertIn("INPUT_CHANGED", result["checks"][0]["reasons"])

    def test_implicit_env_file_blocks_reuse_without_reading_its_secrets(self):
        plan = self.plan()
        receipts = self.receipts(plan)
        self.put("frontend/.env.production", "PRIVATE_VALUE=do-not-export\nNODE_ENV=development\n")
        code, result = self.invoke("verify", "--plan", self.save_plan(plan), *self.receipt_args(receipts))
        self.assertEqual(code, 1, result)
        self.assertIn("UNDECLARED_ENV_FILE:frontend/.env.production", result["checks"][1]["reasons"])
        self.assertNotIn("do-not-export", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
