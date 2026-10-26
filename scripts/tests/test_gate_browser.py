import json
from pathlib import Path
import shutil

from gate_fixture import CLI, GateFixture
from playwright_binding import browser_binding


class PlaywrightBindingTests(GateFixture):
    def test_default_browser_matches_installed_playwright_metadata(self):
        installed = CLI.parents[1] / "frontend/node_modules"
        root, executable = browser_binding(installed, Path(shutil.which("node")).resolve(), self.environment)
        descriptors = json.loads((installed / "playwright-core/browsers.json").read_text())["browsers"]
        descriptor = next(item for item in descriptors if item["name"] == "chromium-headless-shell")
        revisions = {descriptor["revision"], *descriptor.get("revisionOverrides", {}).values()}
        self.assertIn(root.name, {"chromium_headless_shell-" + revision for revision in revisions})
        self.assertIn(root, executable.parents)

    def test_explicit_binding_requires_both_paths_and_keeps_executable_inside_installation(self):
        browser = self.root / "custom-browser"
        executable = self.put("custom-browser/bin/browser", "隔离夹具，不执行")
        environment = {"FORKWISE_GATE_TEST_BROWSER_ROOT": str(browser),
                       "FORKWISE_GATE_TEST_BROWSER_EXECUTABLE": str(executable)}
        self.assertEqual(browser_binding(None, None, environment), (browser, executable))
        for changes in ({"FORKWISE_GATE_TEST_BROWSER_ROOT": ""},
                        {"FORKWISE_GATE_TEST_BROWSER_EXECUTABLE": ""},
                        {"FORKWISE_GATE_TEST_BROWSER_EXECUTABLE": str(self.root / "outside-browser")}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                browser_binding(None, None, {**environment, **changes})
