"""通过真实 CLI 验证控制者授权、补充证明及不执行命令的复用。"""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import threading
import time
import uuid

from gate_fixture import CLI, GateFixture


class ReuseTests(GateFixture):
    def configure_build(self):
        self.put("backend/src/task.py", "from pathlib import Path\n"
                 "p=Path('../executions.txt')\np.write_text(p.read_text()+'executed\\n' if p.exists() else 'executed\\n')\n"
                 "Path('dist/server.js').write_text('built by actual process\\n')\n")
        self.definition["checks"] = [self.definition["checks"][0]]
        self.definition["checks"][0].update(command=["python", "src/task.py"], tools=["python"])
        self.bindings = {"python": Path(sys.executable).resolve()}
        self.put("definition.json", json.dumps(self.definition))

    @contextmanager
    def controlled(self, plan, check_id, output):
        authority = "test-controller"
        now = datetime.now(timezone.utc)
        birth = subprocess.check_output(["/bin/ps", "-p", str(os.getpid()), "-o", "lstart="],
                                        text=True, env={"LC_ALL": "C"}).strip()
        grant = self.put("control/" + uuid.uuid4().hex + ".json", json.dumps({
            "schema_version": 1, "kind": "gate-input-grant", "authority_id": authority,
            "grant_id": uuid.uuid4().hex, "owner": {"pid": os.getpid(), "birth": birth},
            "root": str(self.root), "check_id": check_id,
            "input_key": next(c["input_key"] for c in plan["checks"] if c["id"] == check_id),
            "output_directory": str(output), "issued_at": now.isoformat(),
            "expires_at": (now + timedelta(minutes=5)).isoformat(),
            "coordination": {"input_scope": "ALL_DECLARED_INPUTS", "single_writer": True,
                             "outstanding_writers": []},
        }))
        grant.chmod(0o600)
        with grant.open("r+b") as stream:
            fcntl.lockf(stream, fcntl.LOCK_EX)
            yield grant

    def reference(self, path):
        return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}

    def closeout(self, grant, receipt_path):
        receipt = json.loads(receipt_path.read_text())
        process = receipt["process_result"]
        waits = [{"phase": "main", "exit_code": process["exit_code"], "finished_at": process["finished_at"]}]
        if receipt.get("discovery_process"):
            discovery = receipt["discovery_process"]
            waits.insert(0, {"phase": "discovery", "exit_code": discovery["exit_code"],
                             "finished_at": discovery["finished_at"]})
        path = self.put("control/" + receipt["run_id"] + "-closeout.json", json.dumps({
            "schema_version": 1, "kind": "gate-control-closeout", "authority_id": "test-controller",
            "check_id": receipt["check_id"], "run_id": receipt["run_id"],
            "grant": self.reference(grant), "receipt": self.reference(receipt_path),
            "closed_at": datetime.now(timezone.utc).isoformat(),
            "ownership": {"uninterrupted": True, "outstanding_writers": []},
            "resources": {"scope": "ALL_DECLARED_RESOURCES", "closed": True, "unknown": [], "remaining": [],
                          "terminal_waits": waits,
                          "basis": "Test controller owns this temporary workspace and reviewed the explicit command lifecycle; actual waits and cleanup are in the bound receipt."},
        }))
        path.chmod(0o600)
        return "test-controller=" + str(path)

    def test_same_inputs_reuse_requires_original_manifest_without_relaunching(self):
        self.configure_build()
        plan = self.plan()
        output = self.root / "first-run"
        with self.controlled(plan, "workspace-build", output) as grant:
            code, result = self.invoke("run", "--plan", self.save_plan(plan), "--check", "workspace-build",
                                       "--output", output, "--control-grant", grant)
            self.assertEqual(code, 0, result)
            receipt = output / "receipt.json"
            control_proof = self.closeout(grant, receipt)
        original = receipt.read_bytes()
        fresh = self.save_plan(self.plan())
        code, verified = self.invoke("verify", "--plan", fresh, "--receipt", receipt,
                                     "--control-proof", control_proof, "--summary")
        self.assertEqual(code, 0, verified)
        self.assertEqual(verified["coverage_report"][0]["action"], "REUSED")
        code, reused = self.invoke("run", "--reuse", "--plan", fresh, "--check", "workspace-build",
                                   "--receipt", receipt, "--control-proof", control_proof,
                                   "--output", self.root / "reuse-report")
        self.assertEqual(code, 0, reused)
        self.assertEqual(reused["status"], "reused")
        self.assertEqual(reused["source_run_id"], result["run_id"])
        self.assertNotIn("exit_code", reused)
        self.assertEqual((self.root / "executions.txt").read_text(), "executed\n")
        self.assertEqual(receipt.read_bytes(), original)
        manifest = output / json.loads(original)["input_manifest"]["path"]
        contents = manifest.read_bytes()
        original_mode = manifest.stat().st_mode & 0o777
        replacement = self.put("same-inputs.json", contents.decode())
        for change in ("missing", "changed", "symlink"):
            with self.subTest(change=change):
                if change == "missing": manifest.unlink()
                elif change == "changed": manifest.write_text('{"different":"input inventory"}\n')
                else:
                    manifest.unlink()
                    manifest.symlink_to(replacement)
                code, rejected = self.invoke("verify", "--plan", fresh, "--receipt", receipt,
                                              "--control-proof", control_proof, "--summary")
                self.assertEqual(code, 1, rejected)
                self.assertIn("INPUT_MANIFEST_MISSING_OR_CHANGED", rejected["coverage_report"][0]["reasons"])
                destination = self.root / ("refused-" + change)
                code, refused = self.invoke("run", "--reuse", "--plan", fresh, "--check", "workspace-build",
                                             "--receipt", receipt, "--control-proof", control_proof, "--output", destination)
                self.assertEqual(code, 1, refused)
                self.assertEqual(refused["status"], "reuse_refused")
                self.assertFalse(destination.exists())
                if manifest.is_symlink(): manifest.unlink()
                manifest.write_bytes(contents)
                manifest.chmod(original_mode)
        self.assertEqual(receipt.read_bytes(), original)
        self.assertEqual((self.root / "executions.txt").read_text(), "executed\n")

    def test_released_input_authority_during_execution_cannot_be_attested(self):
        self.configure_build()
        self.put("backend/src/task.py", "from pathlib import Path\nimport time\n"
                 "Path('dist/started').touch()\ntime.sleep(0.5)\n")
        plan, output = self.plan(), self.root / "authority-lost"
        with self.controlled(plan, "workspace-build", output) as grant:
            def release_when_started():
                deadline = time.monotonic() + 5
                while not (self.root / "backend/dist/started").exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                # POSIX locks belong to the process: closing another fd releases this process's lock.
                with grant.open("rb"):
                    pass
            helper = threading.Thread(target=release_when_started)
            helper.start()
            try:
                code, result = self.invoke("run", "--plan", self.save_plan(plan), "--check", "workspace-build",
                                           "--output", output, "--control-grant", grant)
            finally:
                helper.join(timeout=6)
            self.assertEqual(code, 0, result)  # Actual command result remains separate from qualification.
            receipt = output / "receipt.json"
            self.assertIsNone(json.loads(receipt.read_text())["control_release_check"])
            proof = self.closeout(grant, receipt)
        code, result = self.invoke("verify", "--plan", self.save_plan(self.plan()), "--receipt", receipt,
                                   "--control-proof", proof, "--summary")
        self.assertEqual(code, 1, result)
        self.assertEqual(result["coverage_report"][0]["action"], "GAP")

    def test_control_proof_cannot_override_unknown_input_stability(self):
        self.configure_build()
        plan, output = self.plan(), self.root / "first-run"
        with self.controlled(plan, "workspace-build", output) as grant:
            code, result = self.invoke("run", "--plan", self.save_plan(plan), "--check", "workspace-build",
                                       "--output", output, "--control-grant", grant)
            self.assertEqual(code, 0, result)
            value = json.loads((output / "receipt.json").read_text())
            value["integrity"]["inputs_unchanged"] = False
            unknown = self.put("first-run/unknown-inputs.json", json.dumps(value))
            unknown.chmod(0o600)
            control_proof = self.closeout(grant, unknown)
        code, result = self.invoke("verify", "--plan", self.save_plan(self.plan()), "--receipt", unknown,
                                   "--control-proof", control_proof, "--summary")
        self.assertEqual(code, 1, result)
        self.assertEqual(result["coverage_report"][0]["action"], "GAP")

    def test_real_chromium_chain_reuses_then_rejects_changed_tests_and_artifacts(self):
        self.configure_build()
        installed = self.bind_playwright()
        self.definition["checks"].append({
            "id": "frontend-playwright", "kind": "playwright", "cwd": "frontend",
            "command": ["node", str(installed / "playwright/cli.js"), "test"],
            "inputs": ["source", "tests", "outputs"], "outputs": [],
            "tools": ["node", "playwright", "chromium"], "depends_on": ["workspace-build"],
        })
        self.put("definition.json", json.dumps(self.definition))
        (self.root / "frontend/tests/example.spec.ts").unlink()
        self.put("frontend/playwright.config.ts", "module.exports={testDir:'./tests',workers:1,timeout:10000,"
                 "use:{headless:true,launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}}};\n")
        test_source = ("const {test,expect}=require(" + json.dumps(str(installed / "@playwright/test")) + ");\n"
                       "test('renders built input',async({page},info)=>{"
                       "const fs=require('node:fs'); const value=fs.readFileSync('../backend/dist/server.js','utf8').trim();"
                       "await page.setContent('<h1>'+value+'</h1>');"
                       "await expect(page.getByRole('heading')).toHaveText('built by actual process');"
                       "const path=info.outputPath('observations.json');"
                       "fs.writeFileSync(path,JSON.stringify({heading:'built by actual process'}));"
                       "await info.attach('observations',{path,contentType:'application/json'});"
                       "await info.attach('inline',{body:'inline evidence',contentType:'text/plain'});"
                       "fs.appendFileSync('../browser-executions.txt','rendered\\n')});\n")
        self.put("frontend/tests/example.spec.js", test_source)
        receipts, proofs = [], []
        originals = {}
        for check in ("workspace-build", "frontend-playwright"):
            plan, output = self.plan(), self.root / ("actual-" + check)
            with self.controlled(plan, check, output) as grant:
                code, result = self.invoke("run", "--plan", self.save_plan(plan), "--check", check,
                                           "--output", output, "--control-grant", grant, *self.receipt_args(receipts))
                self.assertEqual(code, 0, result)
                self.assertEqual(result["coverage_report"][0]["action"], "EXECUTED")
                receipt = output / "receipt.json"
                proofs.extend(["--control-proof", self.closeout(grant, receipt)])
            receipts.append(receipt)
            originals[receipt] = receipt.read_bytes()
        self.put("README.md", "ordinary documentation changed after the runs\n")
        ready = self.save_plan(self.plan())
        code, verified = self.invoke("verify", "--plan", ready, *self.receipt_args(receipts), *proofs, "--summary")
        self.assertEqual(code, 0, verified)
        self.assertEqual([r["action"] for r in verified["coverage_report"]], ["REUSED", "REUSED"])
        code, reused = self.invoke("run", "--reuse", "--plan", ready, "--check", "frontend-playwright",
                                   "--output", self.root / "second-request", *self.receipt_args(receipts), *proofs)
        self.assertEqual(code, 0, reused)
        self.assertEqual(reused["status"], "reused")
        report = json.loads((output / "report.json").read_text())
        attachments = report["suites"][0]["specs"][0]["tests"][0]["results"][0]["attachments"]
        attached = Path(next(a["path"] for a in attachments if a["name"] == "observations"))
        contents = attached.read_bytes()
        self.assertEqual(json.loads(receipts[1].read_text())["attachments"],
                         [{"path": str(attached.relative_to(output)), "sha256": hashlib.sha256(contents).hexdigest()}])
        shutil.rmtree(output / "test-results")
        code, missing = self.invoke("verify", "--plan", ready, *self.receipt_args(receipts), *proofs, "--summary")
        self.assertEqual(code, 1, missing)
        self.assertIn("TEST_ATTACHMENTS_MISSING_OR_CHANGED", missing["coverage_report"][1]["reasons"])
        destination = self.root / "missing-attachments"
        code, refused = self.invoke("run", "--reuse", "--plan", ready, "--check", "frontend-playwright",
                                    "--output", destination, *self.receipt_args(receipts), *proofs)
        self.assertEqual(code, 1, refused)
        self.assertEqual(refused["status"], "reuse_refused")
        self.assertFalse(destination.exists())
        attached.parent.mkdir(parents=True)
        attached.write_bytes(contents)
        code, restored = self.invoke("verify", "--plan", ready, *self.receipt_args(receipts), *proofs, "--summary")
        self.assertEqual(code, 0, restored)
        self.put("frontend/tests/example.spec.js", test_source.replace("built by actual process');", "different requirement');"))
        code, changed = self.invoke("verify", "--plan", self.save_plan(self.plan()),
                                    *self.receipt_args(receipts), *proofs, "--summary")
        self.assertEqual(code, 1, changed)
        self.assertEqual([r["action"] for r in changed["coverage_report"]], ["REUSED", "GAP"])
        self.put("frontend/tests/example.spec.js", test_source)
        self.put("backend/dist/server.js", "changed artifact\n")
        code, changed = self.invoke("run", "--reuse", "--plan", self.save_plan(self.plan()),
                                    "--check", "frontend-playwright", "--output", self.root / "refused",
                                    *self.receipt_args(receipts), *proofs)
        self.assertEqual(code, 1, changed)
        self.assertEqual(changed["status"], "reuse_refused")
        self.assertFalse((self.root / "refused").exists())
        self.assertEqual((self.root / "executions.txt").read_text(), "executed\n")
        self.assertEqual((self.root / "browser-executions.txt").read_text(), "rendered\n")
        for receipt, original in originals.items():
            self.assertEqual(receipt.read_bytes(), original)

    def test_unheld_or_expired_input_grants_never_launch(self):
        self.configure_build()
        plan, output = self.plan(), self.root / "not-started"
        with self.controlled(plan, "workspace-build", output) as grant:
            expired = json.loads(grant.read_text())
            expired["expires_at"] = expired["issued_at"]
            expired_path = self.put("control/expired.json", json.dumps(expired))
            expired_path.chmod(0o600)
        for invalid in (grant, expired_path):
            with self.subTest(grant=str(invalid)):
                code, _ = self.invoke("run", "--plan", self.save_plan(plan), "--check", "workspace-build",
                                      "--output", output, "--control-grant", invalid)
                self.assertEqual(code, 2)
                self.assertFalse(output.exists())
                self.assertFalse((self.root / "executions.txt").exists())

    def test_execution_does_not_silently_ignore_a_closeout_argument(self):
        self.configure_build()
        output = self.root / "must-not-run"
        code, _ = self.invoke("run", "--plan", self.save_plan(self.plan()), "--check", "workspace-build",
                              "--output", output, "--control-proof", "test-controller=missing.json")
        self.assertEqual(code, 2)
        self.assertFalse(output.exists())
        self.assertFalse((self.root / "executions.txt").exists())

    def test_untrusted_incomplete_or_mismatched_closeout_cannot_enable_reuse(self):
        self.configure_build()
        plan, output = self.plan(), self.root / "actual"
        with self.controlled(plan, "workspace-build", output) as grant:
            code, result = self.invoke("run", "--plan", self.save_plan(plan), "--check", "workspace-build",
                                       "--output", output, "--control-grant", grant)
            self.assertEqual(code, 0, result)
            receipt = output / "receipt.json"
            proof = self.closeout(grant, receipt)
        ready = self.save_plan(self.plan())
        code, _ = self.invoke("verify", "--plan", ready, "--receipt", receipt)
        self.assertEqual(code, 1)
        code, _ = self.invoke("verify", "--plan", ready, "--receipt", receipt,
                              "--control-proof", proof.replace("test-controller=", "untrusted="))
        self.assertEqual(code, 1)
        valid = json.loads(Path(proof.split("=", 1)[1]).read_text())
        for name, change in (
            ("unknown-parent", lambda v: v["resources"].update(unknown=["parent wait missing"])),
            ("wrong-wait", lambda v: v["resources"]["terminal_waits"][0].update(exit_code=1)),
            ("wrong-receipt", lambda v: v["receipt"].update(sha256="0" * 64)),
            ("writer", lambda v: v["ownership"].update(outstanding_writers=["another-writer"])),
            ("before-finish", lambda v: v.update(closed_at="2000-01-01T00:00:00+00:00")),
        ):
            with self.subTest(name=name):
                value = json.loads(json.dumps(valid))
                change(value)
                bad = self.put("control/" + name + ".json", json.dumps(value))
                bad.chmod(0o600)
                code, result = self.invoke("run", "--reuse", "--plan", ready, "--check", "workspace-build",
                                           "--receipt", receipt, "--control-proof", "test-controller=" + str(bad),
                                           "--output", self.root / name)
                self.assertEqual(code, 1, result)
                self.assertEqual(result["status"], "reuse_refused")
                self.assertFalse((self.root / name).exists())
        self.assertEqual((self.root / "executions.txt").read_text(), "executed\n")
