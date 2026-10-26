"""真实 CLI 与隔离的权威存储接口夹具；不改真实 v3 状态。"""
import json
import hashlib
import os
from pathlib import Path
import subprocess
import sys

from gate_fixture import CLI, GateFixture


class ControllerTests(GateFixture):
    def prepare(self, state="RUNNING"):
        self.definition["checks"] = [self.definition["checks"][0]]
        self.definition["checks"][0].update(command=["python", "src/task.py"], tools=["python"])
        self.bindings = {"python": Path(sys.executable).resolve()}
        self.put("backend/src/task.py", "from pathlib import Path\nimport os,json\n"
                 "Path('dist/server.js').write_text('actual build')\n"
                 "Path(os.environ['FORKWISE_ISSUE10_RESOURCE_LOG']).write_text(json.dumps({'event':'direct-build-complete','pid':os.getpid()})+'\\n')\n")
        self.put("definition.json", json.dumps(self.definition))
        self.put("backend/artifacts/controller-storage-v3/controller_v3.py", "import json\nfrom pathlib import Path\n"
                 "HERE=Path(__file__).parent\n"
                 "def load(expected_revision=None):\n"
                 " value=json.loads((HERE/'state.json').read_text())\n"
                 " if expected_revision is not None and value['revision']!=expected_revision: raise ValueError('revision mismatch')\n"
                 " return value\n"
                 "def get_ticket(issue,hydrate=False):\n"
                 " return next(t for t in load()['tickets'] if t['issue']==issue)\n")
        self.state = {"revision": 7, "run_state": state, "workspace_root": str(self.root), "active_issue": 26,
                      "strict_serial": True, "controller_session_id": "/root",
                      "workspace_policy": {"mode": "existing_repository", "directory": str(self.root),
                                           "create_worktree": False, "preserve_preexisting_wip": True},
                      "controller_writer_release": {"owner": "/root", "outstandingOwnedWriters": []},
                      "tickets": [{"issue": 26, "state": "IN_PROGRESS"}]}
        self.put("backend/artifacts/controller-storage-v3/state.json", json.dumps(self.state))
        self.plan_path = self.save_plan(self.plan())
        self.plan_path.chmod(0o600)
        item = json.loads(self.plan_path.read_text())["checks"][0]
        self.ownership = self.put("ownership.json", json.dumps({
            "schema_version": 1, "kind": "gate-input-ownership", "issue": 26, "revision": 7,
            "controller_session_id": "/root", "check_id": item["id"], "input_key": item["input_key"],
            "input_scope": "ALL_DECLARED_INPUTS", "frozen": True, "outstanding_writers": [],
            "basis": "Test controller owns this temporary workspace and has stopped all input writers.",
        }))
        self.ownership.chmod(0o600)

    def controller_args(self):
        return ("--controller-issue", "26", "--controller-revision", "7")

    def test_controller_adapter_runs_waits_and_registers_a_bound_closeout(self):
        self.prepare()
        output = self.root / "controlled"
        code, result = self.invoke("run", *self.controller_args(), "--input-ownership", self.ownership,
                                   "--plan", self.plan_path, "--check", "workspace-build", "--output", output)
        self.assertEqual(code, 0, result)
        receipt = Path(result["receipt"])
        value = json.loads(receipt.read_text())
        parent_result = json.loads((output / "controller-result.json").read_text())
        self.assertEqual(parent_result["actualParentWaitExit"], 0)
        self.assertEqual(parent_result["childPID"], value["control_admission"]["runner_pid"])
        self.assertTrue(parent_result["controllerContextUnchanged"])
        review = self.put("resources.json", json.dumps({
            "schema_version": 1, "kind": "gate-resource-review", "issue": 26, "revision": 7,
            "controller_session_id": "/root", "run_id": value["run_id"],
            "inventory_complete": True, "input_ownership_uninterrupted": True,
            "unknown": [], "remaining": [], "basis": "Reviewed the one direct build process and its actual waits.",
            "raw_records": [{"path": str(p), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                            for p in (receipt, output / "controller-result.json")],
        }))
        review.chmod(0o600)
        closed = output / "closeout.json"
        command = [sys.executable, "-B", "-m", "gate_lib.controller", "--root", str(self.root),
                   "--issue", "26", "--revision", "7", "--receipt", str(receipt),
                   "--resource-review", str(review), "--output", str(closed)]
        omitted = subprocess.run(command, capture_output=True, text=True,
                                 env={**self.environment, "PYTHONPATH": str(CLI.parent)})
        self.assertEqual(omitted.returncode, 2, "The real generated resource log must not be omitted: " + omitted.stdout)
        self.assertFalse(closed.exists())
        resource_log = receipt.parent / "resources.jsonl"
        original_resource = resource_log.read_bytes()
        original_mode = resource_log.stat().st_mode & 0o777
        resource_log.unlink()
        lost = subprocess.run(command, capture_output=True, text=True,
                              env={**self.environment, "PYTHONPATH": str(CLI.parent)})
        self.assertEqual(lost.returncode, 2, "删除运行已生成的日志不能缩小收尾证据范围：" + lost.stdout)
        self.assertFalse(closed.exists())
        resource_log.write_bytes(original_resource)
        resource_log.chmod(original_mode)
        value = json.loads(review.read_text())
        value["raw_records"].append({"path": str(resource_log), "sha256": hashlib.sha256(resource_log.read_bytes()).hexdigest()})
        review.write_text(json.dumps(value))
        valid_review = review.read_text()
        resource_log.write_bytes(original_resource + b'{"event":"replaced-before-closeout"}\n')
        value["raw_records"][-1]["sha256"] = hashlib.sha256(resource_log.read_bytes()).hexdigest()
        review.write_text(json.dumps(value))
        changed = subprocess.run(command, capture_output=True, text=True,
                                 env={**self.environment, "PYTHONPATH": str(CLI.parent)})
        self.assertEqual(changed.returncode, 2, "按改写后日志重新复核不能替代原运行摘要：" + changed.stdout)
        self.assertFalse(closed.exists())
        resource_log.write_bytes(original_resource)
        for change in (lambda v: v.update(unknown=["missing child exit"]),
                       lambda v: v["raw_records"][0].update(sha256="0" * 64)):
            value = json.loads(valid_review); change(value); review.write_text(json.dumps(value))
            rejected = subprocess.run(command, capture_output=True, text=True,
                                      env={**self.environment, "PYTHONPATH": str(CLI.parent)})
            self.assertEqual(rejected.returncode, 2, rejected.stdout + rejected.stderr)
            self.assertFalse(closed.exists())
        review.write_text(valid_review)
        redirect = self.root / "redirect"
        redirect.symlink_to(self.root / "backend/src", target_is_directory=True)
        for destination in (self.root / "backend/src/escaped-proof.json", redirect / "linked-proof.json",
                            output / "../backend/src/parent-proof.json"):
            with self.subTest(destination=str(destination)):
                denied = subprocess.run([*command[:-1], str(destination)], capture_output=True, text=True,
                                        env={**self.environment, "PYTHONPATH": str(CLI.parent)})
                self.assertEqual(denied.returncode, 2, "Closeout must stay inside its evidence bundle: " + denied.stdout)
                self.assertFalse(destination.exists())
        finished = subprocess.run(command, capture_output=True, text=True,
                                  env={**self.environment, "PYTHONPATH": str(CLI.parent)})
        self.assertEqual(finished.returncode, 0, finished.stdout + finished.stderr)
        code, verified = self.invoke("verify", "--plan", self.save_plan(self.plan()), "--receipt", receipt,
                                     "--control-proof", "/root=" + str(closed), "--summary")
        self.assertEqual(code, 0, verified)
        self.assertEqual(verified["coverage_report"][0]["action"], "REUSED")
        resource_log.write_text(resource_log.read_text() + '{"event":"unexpected-late-record"}\n')
        code, changed = self.invoke("verify", "--plan", self.save_plan(self.plan()), "--receipt", receipt,
                                    "--control-proof", "/root=" + str(closed), "--summary")
        self.assertEqual(code, 1, changed)
        self.assertEqual(changed["coverage_report"][0]["action"], "GAP")

    def test_controller_preserves_the_original_failed_check_result(self):
        self.prepare()
        self.put("backend/src/task.py", "import sys\nprint('actual failure')\nsys.exit(7)\n")
        self.plan_path = self.save_plan(self.plan())
        ownership = json.loads(self.ownership.read_text())
        ownership["input_key"] = json.loads(self.plan_path.read_text())["checks"][0]["input_key"]
        self.ownership.write_text(json.dumps(ownership))
        output = self.root / "failed"
        code, result = self.invoke("run", *self.controller_args(), "--input-ownership", self.ownership,
                                   "--plan", self.plan_path, "--check", "workspace-build", "--output", output)
        self.assertEqual(code, 1, result)
        self.assertEqual((result["status"], result["exit_code"]), ("failed", 7))
        parent = json.loads((output / "controller-result.json").read_text())
        self.assertEqual(parent["actualParentWaitExit"], 1)

    def test_paused_wrong_owner_or_non_serial_controller_never_launches(self):
        self.prepare()
        baseline = json.dumps(self.state)
        for name, changes in (("paused", {"run_state": "PAUSED"}),
                              ("wrong-issue", {"active_issue": 27}),
                              ("not-boolean", {"strict_serial": 1}),
                              ("wrong-root", {"workspace_root": "/not/this/workspace"})):
            with self.subTest(name=name):
                value = json.loads(baseline); value.update(changes)
                self.put("backend/artifacts/controller-storage-v3/state.json", json.dumps(value))
                output = self.root / name
                code, _ = self.invoke("run", *self.controller_args(), "--input-ownership", self.ownership,
                                      "--plan", self.plan_path, "--check", "workspace-build", "--output", output)
                self.assertEqual(code, 2)
                self.assertFalse(output.exists())
                self.assertEqual((self.root / "backend/dist/server.js").read_text(), "built product\n")

    def test_stale_controller_revision_never_authorizes_execution(self):
        self.prepare()
        self.state["revision"] += 1
        self.put("backend/artifacts/controller-storage-v3/state.json", json.dumps(self.state))
        output = self.root / "stale-snapshot"
        code, _ = self.invoke("run", *self.controller_args(), "--input-ownership", self.ownership,
                              "--plan", self.plan_path, "--check", "workspace-build", "--output", output)
        self.assertEqual(code, 2)
        self.assertFalse(output.exists())

    def test_each_context_boundary_reads_one_complete_authoritative_snapshot(self):
        self.prepare()
        module = self.root / "backend/artifacts/controller-storage-v3/controller_v3.py"
        module.write_text(module.read_text().replace(
            " return value\n",
            " with (HERE/'reads.jsonl').open('a') as f: f.write(json.dumps(value)+'\\n')\n"
            " return value\n"))
        output = self.root / "single-snapshot"
        code, result = self.invoke("run", *self.controller_args(), "--input-ownership", self.ownership,
                                   "--plan", self.plan_path, "--check", "workspace-build", "--output", output)
        self.assertEqual(code, 0, result)
        reads = [json.loads(line) for line in (module.parent / "reads.jsonl").read_text().splitlines()]
        self.assertEqual(reads, [self.state, self.state], "One authoritative read before and one after the real run")
        parent = json.loads((output / "controller-result.json").read_text())
        self.assertTrue(parent["controllerContextUnchanged"])
        self.assertEqual(parent["controller_before"], parent["controller_after"])
        self.assertEqual(parent["controller_before"]["ticket_issue"], 26)
        self.assertEqual(parent["controller_before"]["ticket_state"], "IN_PROGRESS")

    def test_controller_context_change_keeps_actual_success_but_withholds_qualification(self):
        self.prepare()
        self.put("backend/src/task.py", "import json\nfrom pathlib import Path\n"
                 "p=Path('artifacts/controller-storage-v3/state.json')\n"
                 "v=json.loads(p.read_text());v['revision']+=1;p.write_text(json.dumps(v))\n")
        self.plan_path = self.save_plan(self.plan())
        ownership = json.loads(self.ownership.read_text())
        ownership["input_key"] = json.loads(self.plan_path.read_text())["checks"][0]["input_key"]
        self.ownership.write_text(json.dumps(ownership))
        output = self.root / "context-changed"
        code, result = self.invoke("run", *self.controller_args(), "--input-ownership", self.ownership,
                                   "--plan", self.plan_path, "--check", "workspace-build", "--output", output)
        self.assertEqual(code, 1, result)
        self.assertEqual(result["original_result_status"], "passed")
        parent = json.loads((output / "controller-result.json").read_text())
        self.assertEqual(parent["actualParentWaitExit"], 0)
        self.assertFalse(parent["controllerContextUnchanged"])
        self.assertEqual(json.loads(Path(result["receipt"]).read_text())["status"], "passed")
