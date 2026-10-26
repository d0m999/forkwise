"""按测试所用 Playwright 解析完整浏览器安装，也允许显式隔离绑定。"""
import json
import os
from pathlib import Path
import subprocess


def browser_binding(installed, node, environment=None):
    environment = os.environ if environment is None else environment
    root = environment.get("FORKWISE_GATE_TEST_BROWSER_ROOT")
    executable = environment.get("FORKWISE_GATE_TEST_BROWSER_EXECUTABLE")
    if bool(root) != bool(executable):
        raise ValueError("测试浏览器须同时设置 ROOT 和 EXECUTABLE")
    if not root:
        # 使用该安装的 registry，连同平台路径与 revision override 一起解析。
        registry = Path(installed) / "playwright-core/lib/server/registry/index.js"
        result = subprocess.run([str(node), "-e",
            "const {registry}=require(process.argv[1]);"
            "const browser=registry.findExecutable('chromium-headless-shell');"
            "console.log(JSON.stringify([browser.directory,browser.executablePath()]));", str(registry)],
            capture_output=True, text=True, check=True, env=environment)
        root, executable = json.loads(result.stdout)
    root, executable = Path(root).resolve(), Path(executable).resolve()
    if root not in executable.parents:
        raise ValueError("测试浏览器可执行文件必须位于声明的完整安装目录内")
    return root, executable
