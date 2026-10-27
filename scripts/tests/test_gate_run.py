import json
from pathlib import Path
import sys
import os
import time
import shutil
import subprocess
import signal
import shlex
from datetime import datetime

from gate_fixture import GateFixture
from gate_fixture import CLI


class RunTests(GateFixture):
    def configure_command(self, body):
        self.put("backend/src/task.py", body)
        self.definition["checks"] = [self.definition["checks"][0]]
        self.definition["checks"][0]["command"] = ["python", "src/task.py"]
        self.definition["checks"][0]["tools"] = ["python"]
        self.bindings = {"python": Path(sys.executable).resolve()}
        self.put("definition.json", json.dumps(self.definition))

    def test_cleanup_retains_raw_lsof_observations_for_real_resource_boundaries(self):
        for kind in ("none", "reader", "writer", "scan-error"):
            with self.subTest(kind=kind):
                peer = None
                try:
                    output = self.root / ("lsof-" + kind)
                    if kind == "scan-error":
                        argv = [sys.executable, "-B", "-c",
                                "import json,sys\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\n"
                                "from gate_lib.processes import reclaim\n"
                                "print(json.dumps(reclaim(Path(sys.argv[2]),passed=True,processes_closed=True)))\n",
                                str(CLI.parent), str(output)]
                        actual = subprocess.run(argv, capture_output=True, text=True, env=self.environment, timeout=20)
                        print(json.dumps({"fixture": kind, "argv": argv, "parent_wait_exit": actual.returncode,
                                          "stdout": actual.stdout, "stderr": actual.stderr}), flush=True)
                        self.assertEqual(actual.returncode, 0, actual.stderr)
                        cleanup = json.loads(actual.stdout)
                        self.assertFalse(cleanup["complete"])
                        self.assertFalse(output.exists())
                    else:
                        self.configure_command("import os,time\nfrom pathlib import Path\np=Path(os.environ['TMPDIR'])\n"
                            "(p/'held-resource').write_text('owned resource fixture')\n" +
                            ("while not (p.parent/'peer-ready').exists(): time.sleep(0.02)\n" if kind != "none" else ""))
                        if kind != "none":
                            helper = ("import sys,time\nfrom pathlib import Path\np=Path(sys.argv[1])\n"
                                      "while not (p/'tmp/held-resource').exists(): time.sleep(0.02)\n"
                                      "with (p/'tmp/held-resource').open(sys.argv[2]):\n"
                                      " (p/'peer-ready').touch()\n time.sleep(30)\n")
                            peer = subprocess.Popen([sys.executable, "-B", "-c", helper, str(output), "rb" if kind == "reader" else "r+b"])
                        code, result = self.invoke("run", "--plan", self.save_plan(self.plan()), "--check", "workspace-build", "--output", output, "--timeout", "5")
                        receipt = json.loads((output / "receipt.json").read_text())
                        cleanup = receipt["cleanup"]
                        print(json.dumps({"fixture": kind, "cli_parent_wait_exit": code, "product_exit": receipt["exit_code"],
                                          "status": receipt["status"], "cleanup": cleanup}), flush=True)
                        self.assertEqual(receipt["exit_code"], 0)
                        self.assertEqual(code, 0 if kind == "none" else 1, result)
                        if kind == "none":
                            self.assertTrue(cleanup["complete"])
                        else:
                            self.assertFalse(cleanup["complete"])
                            self.assertTrue((output / "tmp/held-resource").exists())
                    self.assertIn("handle_checks", cleanup, "every lsof decision needs its original invocation and output")
                    checks = cleanup["handle_checks"]
                    self.assertTrue(checks)
                    for check in checks:
                        self.assertEqual(check["argv"][0], "/usr/sbin/lsof")
                        self.assertIn("-FpcRgfatn", check["argv"], "the original scan must identify the process and its handle")
                        self.assertNotIn("-t", check["argv"])
                        self.assertNotIn("-w", check["argv"])
                        self.assertEqual(check["argv"][-1], str(output if check["stage"] == "output" else output / check["stage"]))
                        self.assertLessEqual(datetime.fromisoformat(check["started_at"]), datetime.fromisoformat(check["finished_at"]))
                        self.assertIsInstance(check["returncode"], int)
                        self.assertIsInstance(check["stdout"], str)
                        self.assertIsInstance(check["stderr"], str)
                    self.assertEqual(checks[0]["stage"], "output")
                    if kind == "none":
                        self.assertEqual([check["stage"] for check in checks], ["output", "home", "tmp", "cache"])
                        self.assertTrue(all((check["returncode"], check["stdout"], check["stderr"]) == (1, "", "") for check in checks))
                    elif kind == "reader":
                        self.assertEqual(cleanup["output_writers"], [])
                        self.assertIn("p" + str(peer.pid) + "\n", checks[0]["stdout"])
                        temporary = next(check for check in checks if check["stage"] == "tmp")
                        self.assertIn(temporary["returncode"], (0, 1))
                        self.assertIn("p" + str(peer.pid), temporary["stdout"].splitlines())
                    elif kind == "writer":
                        self.assertEqual([check["stage"] for check in checks], ["output"])
                        self.assertIn(peer.pid, cleanup["output_writers"])
                        self.assertIn("p" + str(peer.pid) + "\n", checks[0]["stdout"])
                    else:
                        self.assertEqual([check["stage"] for check in checks], ["output"])
                        self.assertNotEqual(checks[0]["returncode"], 0)
                        self.assertTrue(checks[0]["stderr"])
                    if peer:
                        for check in checks:
                            if check["stage"] not in ("output", "tmp"):
                                continue
                            fields = check["stdout"].splitlines()
                            start = fields.index("p" + str(peer.pid))
                            end = next((i for i in range(start + 1, len(fields)) if fields[i].startswith("p")), len(fields))
                            fields = fields[start:end]
                            self.assertTrue(any(field.startswith("c") and len(field) > 1 for field in fields))
                            self.assertIn("R" + str(os.getpid()), fields)
                            self.assertIn("g" + str(os.getpgid(peer.pid)), fields)
                            self.assertTrue(any(field.startswith("f") and field[1:].isdigit() for field in fields))
                            self.assertIn("ar" if kind == "reader" else "au", fields)
                            self.assertIn("tREG", fields)
                            self.assertIn("n" + str(output / "tmp/held-resource"), fields)
                finally:
                    if peer:
                        peer.terminate()
                        result = peer.wait(timeout=5)
                        print(json.dumps({"fixture": kind, "peer_pid": peer.pid, "peer_parent_wait_exit": result}), flush=True)

    def test_run_registers_actual_exit_logs_and_new_build_outputs(self):
        self.configure_command("from pathlib import Path\nprint('actual child output')\nPath('dist/server.js').write_text('new build')\n")
        plan = self.plan()
        output = self.root / "evidence"
        code, result = self.invoke("run", "--plan", self.save_plan(plan), "--check", "workspace-build", "--output", output)
        self.assertEqual(code, 0, result)
        receipt = json.loads((output / "receipt.json").read_text())
        self.assertEqual(receipt["status"], "passed")
        self.assertEqual(receipt["exit_code"], 0)
        self.assertIn("actual child output", (output / "stdout.log").read_text())
        self.assertNotEqual(receipt["output_key"], plan["checks"][0]["output_key"])
        self.assertEqual(receipt["input_before"], receipt["input_after"])
        self.assertFalse(receipt["integrity"]["exclusive_inputs"])
        self.assertEqual(receipt["acceptance"], "NOT_EVALUATED")

    def test_invalid_resource_log_preserves_failed_run_directories_and_external_target(self):
        target = self.put("external-resource-target", "external fixture evidence must stay unchanged\n")
        target.chmod(0o640)
        original = (target.read_bytes(), target.lstat().st_mode)
        for kind in ("symlink", "directory"):
            with self.subTest(kind=kind):
                self.configure_command("import os\nfrom pathlib import Path\n"
                    "for name in ('HOME','TMPDIR','npm_config_cache'):\n"
                    " Path(os.environ[name], 'retained-marker').write_text('owned runtime evidence')\n"
                    "log=Path(os.environ['FORKWISE_ISSUE10_RESOURCE_LOG'])\n" +
                    ("log.symlink_to(" + repr(str(target)) + ")\n" if kind == "symlink" else "log.mkdir()\n"))
                output = self.root / ("invalid-resource-" + kind)
                code, result = self.invoke("run", "--plan", self.save_plan(self.plan()), "--check", "workspace-build", "--output", output)
                self.assertEqual(code, 1, result)
                receipt = json.loads((output / "receipt.json").read_text())
                self.assertEqual((receipt["status"], receipt["exit_code"]), ("incomplete", 0))
                self.assertTrue(any(gap.startswith("RESOURCE_LOG_INVALID:resources.jsonl:") for gap in receipt["evidence_gaps"]))
                self.assertEqual((target.read_bytes(), target.lstat().st_mode), original)
                self.assertEqual(receipt["cleanup"]["removed"], [])
                for name in ("home", "tmp", "cache"):
                    self.assertTrue((output / name).is_dir(), "failed resource proof must preserve " + name)
                    self.assertEqual((output / name / "retained-marker").read_text(), "owned runtime evidence")

    def test_timeout_stops_the_child_tree_and_preserves_real_failure(self):
        self.configure_command("import os,subprocess,sys,time\nfrom pathlib import Path\n"
                               "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])\n"
                               "Path('dist/child.pid').write_text(str(child.pid))\ntime.sleep(60)\n")
        output = self.root / "timeout-evidence"
        code, result = self.invoke("run", "--plan", self.save_plan(self.plan()), "--check", "workspace-build",
                                   "--output", output, "--timeout", "0.5")
        self.assertEqual(code, 1, result)
        receipt = json.loads((output / "receipt.json").read_text())
        self.assertEqual(receipt["status"], "timed_out")
        self.assertNotEqual(receipt["exit_code"], 0)
        self.assertTrue(receipt["process_result"]["observed_processes_closed"])
        self.assertFalse(receipt["integrity"]["resources_closed"])
        pid = int((self.root / "backend/dist/child.pid").read_text())
        for _ in range(50):
            try: os.kill(pid, 0)
            except ProcessLookupError: break
            time.sleep(0.02)
        else: self.fail("timed-out descendant is still alive")

    def test_failed_and_changed_runs_keep_their_original_result(self):
        for body, expected, exit_code in (
            ("import sys\nprint('original failure')\nsys.exit(7)\n", "failed", 7),
            ("from pathlib import Path\nPath('src/server.ts').write_text('changed during run')\n", "input_changed", 0),
        ):
            with self.subTest(expected=expected):
                self.configure_command(body)
                output = self.root / expected
                code, result = self.invoke("run", "--plan", self.save_plan(self.plan()), "--check", "workspace-build", "--output", output)
                self.assertEqual(code, 1, result)
                receipt = json.loads((output / "receipt.json").read_text())
                self.assertEqual((receipt["status"], receipt["exit_code"]), (expected, exit_code))

    def test_stale_plan_and_existing_output_never_launch_another_process(self):
        self.configure_command("from pathlib import Path\nPath('dist/launched').write_text('yes')\n")
        plan = self.save_plan(self.plan())
        self.put("backend/src/new-input.ts", "new input\n")
        code, _ = self.invoke("run", "--plan", plan, "--check", "workspace-build", "--output", self.root / "stale")
        self.assertEqual(code, 2)
        self.assertFalse((self.root / "backend/dist/launched").exists())
        output = self.root / "existing"
        output.mkdir()
        marker = self.put("existing/original.txt", "keep original evidence\n")
        code, _ = self.invoke("run", "--plan", self.save_plan(self.plan()), "--check", "workspace-build", "--output", output)
        self.assertEqual(code, 2)
        self.assertFalse((self.root / "backend/dist/launched").exists())
        self.assertEqual(marker.read_text(), "keep original evidence\n")

    def test_npm_runs_with_bound_node_and_isolated_config(self):
        self.configure_command("unused\n")
        node = Path(shutil.which("node")).resolve()
        npm = Path(shutil.which("npm")).resolve().parents[1]
        self.bindings = {"node": node, "npm": npm, "sh": Path("/bin/sh")}
        self.definition["checks"][0]["tools"] = list(self.bindings)
        self.definition["checks"][0]["command"] = ["npm", "run", "build"]
        self.definition["groups"]["source"].append({"path": "backend/package.json"})
        self.put("backend/package.json", json.dumps({"scripts": {"build": "node src/task.cjs"}}))
        self.put("backend/src/task.cjs", "console.log(process.execPath); require('fs').writeFileSync('dist/server.js','built by node');\n")
        self.put("definition.json", json.dumps(self.definition))
        output = self.root / "npm-evidence"
        code, result = self.invoke("run", "--plan", self.save_plan(self.plan()), "--check", "workspace-build", "--output", output)
        self.assertEqual(code, 0, result)
        self.assertIn(str(node), (output / "stdout.log").read_text())

    def test_playwright_registers_discovery_and_execution_after_build(self):
        self.configure_command("from pathlib import Path\nPath('dist/server.js').write_text('new product')\n")
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
        self.put("frontend/tests/example.spec.js", "const {test,expect}=require(" + json.dumps(str(installed / "@playwright/test")) + ");\n"
                 "test('runner proof',async({page},info)=>{await page.setContent('<h1>runner proof</h1>');"
                 "await expect(page.getByRole('heading')).toHaveText('runner proof');"
                 "const path=info.outputPath('observations.json');"
                 "require('fs').writeFileSync(path,JSON.stringify({heading:'runner proof'}));"
                 "await info.attach('observations',{path,contentType:'application/json'});"
                 "await page.screenshot({path:info.outputPath('observed-page.png')});});\n")
        before = self.plan()
        build = self.root / "build-evidence"
        code, result = self.invoke("run", "--plan", self.save_plan(before), "--check", "workspace-build", "--output", build)
        self.assertEqual(code, 0, result)
        plan = self.plan()
        self.assertNotEqual(before["checks"][1]["input_key"], plan["checks"][1]["input_key"])
        output = self.root / "playwright-evidence"
        code, result = self.invoke("run", "--plan", self.save_plan(plan), "--check", "frontend-playwright",
                                   "--receipt", build / "receipt.json", "--output", output)
        self.assertEqual(code, 0, result)
        receipt = json.loads((output / "receipt.json").read_text())
        self.assertEqual(len(receipt["coverage"]["collected"]), 1)
        self.assertEqual(receipt["coverage"]["collected"], receipt["coverage"]["executed"])
        self.assertEqual(receipt["discovery"]["exit_code"], 0)
        self.assertNotEqual(receipt["discovery"]["path"], receipt["report"]["path"])
        self.assertEqual(receipt["upstream"]["workspace-build"]["run_id"], json.loads((build / "receipt.json").read_text())["run_id"])
        report = json.loads((output / receipt["report"]["path"]).read_text())
        attachments = report["suites"][0]["specs"][0]["tests"][0]["results"][0]["attachments"]
        attached = Path(next(item["path"] for item in attachments if item["name"] == "observations"))
        self.assertTrue(attached.is_relative_to(output / "test-results"))
        self.assertTrue(attached.exists(), "成功清理后，原始报告引用的附件仍须可读")
        self.assertEqual(json.loads(attached.read_text()), {"heading": "runner proof"})
        screenshots = list((output / "test-results").rglob("observed-page.png"))
        self.assertEqual(len(screenshots), 1)
        self.assertEqual(screenshots[0].read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
        self.assertTrue(receipt["cleanup"]["complete"])
        for name in ("home", "tmp", "cache"):
            self.assertFalse((output / name).exists())

    def test_npm_playwright_separator_keeps_discovery_read_only(self):
        self.bindings = {"npm": Path(shutil.which("npm")).resolve().parents[1], "sh": Path("/bin/sh")}
        installed = self.bind_playwright()
        self.definition["groups"]["package"] = [{"path": "frontend/package.json"}]
        self.put("frontend/package.json", json.dumps({"scripts": {
            "test": "node " + shlex.quote(str(installed / "playwright/cli.js")) + " test"}}))
        (self.root / "frontend/tests/example.spec.ts").unlink()
        self.put("frontend/playwright.config.ts", "module.exports={testDir:'./tests',workers:1,timeout:10000};\n")
        self.put("frontend/tests/example.spec.js", "const {test}=require(" + json.dumps(str(installed / "@playwright/test")) + ");\n"
                 "test('body runs only during execution',()=>{require('fs').appendFileSync('../body-runs',"
                 "require('path').basename(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME)+'\\n')});\n")
        marker = self.root / "body-runs"
        external_report = self.put("prior-report.json", "旧运行的报告，不得覆盖\n")
        self.environment.update(PLAYWRIGHT_JSON_OUTPUT_FILE=str(external_report),
                                PLAYWRIGHT_JSON_OUTPUT_DIR=str(self.root),
                                PLAYWRIGHT_JSON_OUTPUT_NAME="escaped-report.json")
        for index, command in enumerate((["npm", "test"], ["npm", "test", "--", "example.spec.js"],
                                         ["npm", "run", "test", "--", "example.spec.js"])):
            with self.subTest(command=command):
                marker.unlink(missing_ok=True)
                self.definition["checks"] = [{"id": "frontend-playwright", "kind": "playwright", "cwd": "frontend",
                    "command": command, "inputs": ["tests", "package"], "outputs": [],
                    "tools": list(self.bindings), "depends_on": []}]
                self.put("definition.json", json.dumps(self.definition))
                output = self.root / ("npm-playwright-" + str(index))
                code, result = self.invoke("run", "--plan", self.save_plan(self.plan()), "--check", "frontend-playwright",
                                           "--output", output, "--timeout", "15")
                self.assertEqual(external_report.read_text(), "旧运行的报告，不得覆盖\n")
                self.assertFalse((self.root / "escaped-report.json").exists())
                self.assertEqual(marker.read_text().splitlines(), ["report.json"], "发现阶段不得执行测试正文")
                self.assertEqual(code, 0, result)
                receipt = json.loads((output / "receipt.json").read_text())
                discovery = json.loads((output / receipt["discovery"]["path"]).read_text())
                report = json.loads((output / receipt["report"]["path"]).read_text())
                self.assertEqual(discovery["suites"][0]["specs"][0]["tests"][0]["results"], [])
                self.assertEqual(report["stats"]["expected"], 1)
                self.assertEqual(len(receipt["coverage"]["collected"]), 1)
                self.assertEqual(receipt["coverage"]["collected"], receipt["coverage"]["executed"])

    def test_success_reclaims_only_its_generated_temporary_directories(self):
        self.configure_command("import os\nfrom pathlib import Path\nPath(os.environ['TMPDIR'],'fixture.db').write_text('temporary')\n")
        retained = self.put("unrelated.db", "user-owned data\n")
        output = self.root / "cleanup-evidence"
        code, result = self.invoke("run", "--plan", self.save_plan(self.plan()), "--check", "workspace-build", "--output", output)
        self.assertEqual(code, 0, result)
        self.assertFalse((output / "tmp").exists())
        self.assertFalse((output / "home").exists())
        self.assertEqual(retained.read_text(), "user-owned data\n")

    def test_launch_error_is_registered_without_inventing_an_exit_code(self):
        self.configure_command("unused\n")
        broken = self.put("tools/broken", "not an executable format\n")
        broken.chmod(0o700)
        self.bindings = {"broken": broken}
        self.definition["checks"][0].update(command=["broken"], tools=["broken"])
        self.put("definition.json", json.dumps(self.definition))
        output = self.root / "launch-error"
        code, result = self.invoke("run", "--plan", self.save_plan(self.plan()), "--check", "workspace-build", "--output", output)
        self.assertEqual(code, 1, result)
        receipt = json.loads((output / "receipt.json").read_text())
        self.assertEqual(receipt["status"], "not_started")
        self.assertIsNone(receipt["exit_code"])
        self.assertEqual(receipt["coverage"]["executed"], [])

    def test_post_run_verification_error_preserves_the_actual_exit(self):
        self.configure_command("from pathlib import Path\nPath('../definition.json').unlink()\n")
        output = self.root / "verification-error"
        code, result = self.invoke("run", "--plan", self.save_plan(self.plan()), "--check", "workspace-build", "--output", output)
        self.assertEqual(code, 1, result)
        receipt = json.loads((output / "receipt.json").read_text())
        self.assertEqual(receipt["status"], "verification_failed")
        self.assertEqual(receipt["exit_code"], 0)
        self.assertFalse(receipt["integrity"]["inputs_unchanged"])

    def test_workspace_lock_and_cancellation_leave_a_non_success_receipt(self):
        self.configure_command("from pathlib import Path\nimport time\nPath('dist/ready').touch()\ntime.sleep(30)\n")
        saved = self.save_plan(self.plan())
        output = self.root / "cancelled"
        args = [sys.executable, "-B", str(CLI), "run", "--root", str(self.root), "--definition", str(self.root / "definition.json"),
                "--plan", str(saved), "--check", "workspace-build", "--output", str(output), "--timeout", "10"]
        for name, path in self.bindings.items(): args.extend(["--tool", name + "=" + str(path)])
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.environment)
        try:
            deadline = time.monotonic() + 5
            while not (self.root / "backend/dist/ready").exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue((self.root / "backend/dist/ready").exists())
            code, _ = self.invoke("run", "--plan", saved, "--check", "workspace-build", "--output", self.root / "competing")
            self.assertEqual(code, 2)
            self.assertFalse((self.root / "competing").exists())
            process.send_signal(signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 1, stderr)
            self.assertEqual(json.loads(stdout)["status"], "interrupted")
            receipt = json.loads((output / "receipt.json").read_text())
            self.assertNotEqual(receipt["exit_code"], 0)
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                process.communicate(timeout=10)

    def test_output_cannot_escape_into_inputs_or_declared_tools(self):
        self.configure_command("from pathlib import Path\nPath('dist/launched').touch()\n")
        (self.root / "backend/artifacts").mkdir()
        auxiliary = self.root / "tools/auxiliary"
        auxiliary.mkdir()
        self.bindings["auxiliary"] = auxiliary
        self.definition["checks"][0]["tools"].append("auxiliary")
        self.put("definition.json", json.dumps(self.definition))
        for output in (self.root / "backend/artifacts/../src/escaped", auxiliary / "evidence"):
            with self.subTest(output=str(output)):
                code, _ = self.invoke("run", "--plan", self.save_plan(self.plan()), "--check", "workspace-build", "--output", output)
                self.assertEqual(code, 2)
                self.assertFalse(output.exists())
                self.assertFalse((self.root / "backend/dist/launched").exists())

    def test_declared_shell_tool_must_match_npm_path_resolution(self):
        self.configure_command("unused\n")
        wrong_cp = self.put("tools/cp", "#!/bin/sh\nexit 42\n")
        wrong_cp.chmod(0o700)
        self.bindings = {"node": Path(shutil.which("node")).resolve(), "npm": Path(shutil.which("npm")).resolve().parents[1],
                         "sh": Path("/bin/sh"), "cp": wrong_cp}
        self.definition["checks"][0].update(command=["npm", "run", "build"], tools=list(self.bindings))
        self.definition["groups"]["source"].append({"path": "backend/package.json"})
        self.put("backend/package.json", json.dumps({"scripts": {"build": "cp src/server.ts dist/copied.ts"}}))
        self.put("definition.json", json.dumps(self.definition))
        output = self.root / "wrong-tool-evidence"
        code, _ = self.invoke("run", "--plan", self.save_plan(self.plan()), "--check", "workspace-build", "--output", output)
        self.assertEqual(code, 2)
        self.assertFalse(output.exists())
        self.assertFalse((self.root / "backend/dist/copied.ts").exists())

    def test_detached_descendant_cannot_receive_complete_resource_credit(self):
        self.configure_command("import subprocess,sys\n"
                               "subprocess.Popen([sys.executable,'-c','import time; time.sleep(1)'],"
                               "start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n")
        output = self.root / "detached-evidence"
        self.invoke("run", "--plan", self.save_plan(self.plan()), "--check", "workspace-build", "--output", output)
        receipt = json.loads((output / "receipt.json").read_text())
        try:
            self.assertFalse(receipt["integrity"]["resources_closed"])
            self.assertEqual(receipt["evidence_status"], "INCOMPLETE")
        finally:
            time.sleep(1.1)  # 自有短命进程自然结束；不扫描或杀其他进程。

    def test_broken_discovery_keeps_its_exit_and_never_starts_execution(self):
        self.configure_command("import os,sys\nfrom pathlib import Path\n"
                               "if '--list' in sys.argv: Path(os.environ['PLAYWRIGHT_JSON_OUTPUT_NAME']).write_text('{')\n"
                               "else: Path('dist/test-ran').touch()\n")
        browser = self.put("tools/browser/executable", "fixture only\n")
        browser.chmod(0o700)
        self.bindings["chromium"] = browser.parent
        self.environment["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"] = str(browser)
        self.definition["checks"][0].update(kind="playwright", tools=["python", "chromium"], outputs=[])
        self.put("definition.json", json.dumps(self.definition))
        output = self.root / "broken-discovery"
        code, result = self.invoke("run", "--plan", self.save_plan(self.plan()), "--check", "workspace-build", "--output", output)
        self.assertEqual(code, 1, result)
        receipt = json.loads((output / "receipt.json").read_text())
        self.assertEqual(receipt["status"], "incomplete")
        self.assertEqual(receipt["discovery_process"]["exit_code"], 0)
        self.assertIsNone(receipt["exit_code"])
        self.assertEqual(receipt["main_execution"], "NOT_RUN")
        self.assertFalse((self.root / "backend/dist/test-ran").exists())

    def test_open_output_writer_prevents_a_complete_check_result(self):
        self.configure_command("import os,time\nfrom pathlib import Path\n"
                               "marker=Path(os.environ['TMPDIR']).parent/'writer-ready'\n"
                               "while not marker.exists(): time.sleep(0.02)\n")
        output = self.root / "open-writer"
        helper = ("import sys,time\nfrom pathlib import Path\np=Path(sys.argv[1])\n"
                  "while not (p/'stdout.log').exists(): time.sleep(0.02)\n"
                  "with (p/'stdout.log').open('a'):\n (p/'writer-ready').touch()\n time.sleep(30)\n")
        peer = subprocess.Popen([sys.executable, "-B", "-c", helper, str(output)])
        try:
            code, result = self.invoke("run", "--plan", self.save_plan(self.plan()), "--check", "workspace-build", "--output", output, "--timeout", "5")
            self.assertEqual(code, 1, result)
            receipt = json.loads((output / "receipt.json").read_text())
            self.assertEqual(receipt["status"], "incomplete")
            self.assertIn(peer.pid, receipt["cleanup"]["output_writers"])
        finally:
            peer.terminate()
            peer.wait(timeout=5)
