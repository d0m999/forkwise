"""真实临时文件与 CLI，工具均为自有文本夹具，不执行产品命令。"""
import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from playwright_binding import browser_binding

CLI = Path(__file__).resolve().parents[1] / "gate.py"


class GateFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="forkwise-gate-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.definition = {
            "schema_version": 1,
            "groups": {
                "source": [{"path": "backend/src"}],
                "tests": [{"path": "frontend/tests"}, {"path": "frontend/playwright.config.ts"}],
                "outputs": [{"path": "backend/dist"}],
            },
            "checks": [
                {"id": "workspace-build", "kind": "build", "cwd": "backend", "command": ["npm", "run", "build:workspace"],
                 "inputs": ["source"], "outputs": ["outputs"], "tools": ["node"], "depends_on": []},
                {"id": "frontend-playwright", "kind": "playwright", "cwd": "frontend", "command": ["npm", "test"],
                 "inputs": ["source", "tests", "outputs"], "outputs": [], "tools": ["node", "chromium"],
                 "depends_on": ["workspace-build"]},
            ],
        }
        self.put("definition.json", json.dumps(self.definition))
        self.put("backend/src/server.ts", "product source\n")
        self.put("backend/dist/server.js", "built product\n")
        self.put("frontend/tests/example.spec.ts", "test('one behavior')\n")
        self.put("frontend/playwright.config.ts", "workers: 2, timeout: 90000\n")
        for name in ("node", "chromium"):
            self.put("tools/" + name, "fixture tool; must never execute\n").chmod(0o700)
        self.bindings = {name: self.root / "tools" / name for name in ("node", "chromium")}
        self.environment = {"PATH": "/usr/bin:/bin", "LANG": "C"}

    def put(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def bind_playwright(self):
        installed = CLI.parents[1] / "frontend/node_modules"
        node = Path(shutil.which("node")).resolve()
        browser, executable = browser_binding(installed, node)
        self.assertTrue(executable.is_file() and os.access(executable, os.X_OK),
                        "未安装匹配的测试浏览器；请在 frontend 执行 npx playwright install chromium，"
                        "或同时显式设置 FORKWISE_GATE_TEST_BROWSER_ROOT / EXECUTABLE：" + str(executable))
        self.bindings.update(node=node, playwright=installed, chromium=browser)
        self.environment["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"] = str(executable)
        return installed

    def invoke(self, operation, *extra):
        args = [sys.executable, "-B", str(CLI), operation, "--root", str(self.root),
                "--definition", str(self.root / "definition.json")]
        for name, path in self.bindings.items():
            args.extend(["--tool", name + "=" + str(path)])
        args.extend(map(str, extra))
        result = subprocess.run(args, capture_output=True, text=True, env=self.environment)
        self.assertTrue(result.stdout, result.stderr)
        return result.returncode, json.loads(result.stdout)

    def plan(self):
        code, result = self.invoke("plan")
        self.assertEqual(code, 0, result)
        return result

    def save_plan(self, plan):
        return self.put("plan.json", json.dumps(plan))

    def receipts(self, plan):
        result = []
        by_id = {item["id"]: item for item in plan["checks"]}
        for check in plan["checks"]:
            name = check["id"]
            log = self.put(name + ".stdout", "Synthetic successful execution for CLI evidence tests.\n")
            manifest = self.put(name + ".inputs.json", json.dumps(plan))
            receipt = {
                "schema_version": 2, "check_id": name, "run_id": "fixture-" + name,
                "command": check["command"], "cwd": check["cwd"], "scope": "full",
                "started_at": "2026-10-25T01:00:00+00:00", "finished_at": "2026-10-25T01:01:00+00:00",
                "status": "passed", "exit_code": 0,
                "input_before": check["input_key"], "input_after": check["input_key"],
                "output_key": check["output_key"],
                "integrity": {"exclusive_inputs": True, "inputs_unchanged": True, "resources_closed": True},
                "logs": [{"path": log.name, "sha256": hashlib.sha256(log.read_bytes()).hexdigest()}],
                "resource_logs": [],
                "input_manifest": {"path": manifest.name, "sha256": hashlib.sha256(manifest.read_bytes()).hexdigest()},
                "upstream": {dep: {"run_id": "fixture-" + dep, "input_key": by_id[dep]["input_key"],
                                   "output_key": by_id[dep]["output_key"]} for dep in check["depends_on"]},
                "coverage": {"collected": ["example.spec.ts::one::chromium::0"],
                             "executed": ["example.spec.ts::one::chromium::0"],
                             "failed": [], "skipped": [], "flaky": []},
            }
            if check["kind"] == "playwright":
                report = self.put(name + ".report.json", json.dumps({
                    "config": {"shard": None, "forbidOnly": True,
                               "projects": [{"id": "chromium", "repeatEach": 1, "retries": 0}]},
                    "stats": {"expected": 1, "unexpected": 0, "flaky": 0, "skipped": 0}, "errors": [],
                    "suites": [{"specs": [{"id": "one", "file": "example.spec.ts", "title": "one behavior",
                        "tests": [{"projectId": "chromium", "expectedStatus": "passed", "status": "expected",
                                   "results": [{"status": "passed", "retry": 0}]}]}]}],
                }))
                command = [*check["command"], "--", "--forbid-only", "--grep=.*", "--grep-invert=(?!)",
                           "--project=*", "--retries=0", "--repeat-each=1", "--reporter=list,json"]
                receipt["report"] = {"path": report.name, "sha256": hashlib.sha256(report.read_bytes()).hexdigest(),
                                     "command": command}
                listed = json.loads(report.read_text())
                listed["suites"][0]["specs"][0]["tests"][0]["results"] = []
                discovery = self.put(name + ".discovery.json", json.dumps(listed))
                receipt["discovery"] = {"path": discovery.name, "sha256": hashlib.sha256(discovery.read_bytes()).hexdigest(),
                                        "command": [*command, "--list"], "exit_code": 0}
            result.append(self.put(name + ".receipt.json", json.dumps(receipt)))
        return result

    def receipt_args(self, paths):
        return [arg for path in paths for arg in ("--receipt", path)]
