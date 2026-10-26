"""运行时只传递声明环境，并显式选择已记录的可执行文件。"""
import os
from pathlib import Path
import stat
import shutil

from .files import Invalid, _parent


GENERATED = {
    "HOME": "home", "TMPDIR": "tmp", "TMP": "tmp", "TEMP": "tmp",
    "npm_config_cache": "cache", "PLAYWRIGHT_JSON_OUTPUT_NAME": "report.json",
    "FORKWISE_ISSUE10_RESOURCE_LOG": "resources.jsonl",
}
RESOURCE_LOGS = (GENERATED["FORKWISE_ISSUE10_RESOURCE_LOG"],)


def environment(bindings, directory=None):
    values = {key: value for key, value in os.environ.items()
              if key in {"PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "CI"}
              or key.startswith(("NODE_", "FORKWISE_", "PLAYWRIGHT_", "VITE_"))
              or key.lower().startswith("npm_config_")}
    # FILE 的优先级高于 NAME；发现与执行报告必须使用本次目录中的独立名称。
    for key in ("PLAYWRIGHT_JSON_OUTPUT_FILE", "PLAYWRIGHT_JSON_OUTPUT_DIR"):
        values.pop(key, None)
    if "node" in bindings:
        values["PATH"] = str(Path(bindings["node"]).absolute().parent) + ":/usr/bin:/bin"
    values["PYTHONDONTWRITEBYTECODE"] = "1"
    for key, suffix in GENERATED.items():
        values[key] = str(Path(directory) / suffix) if directory else "<RUN>/" + suffix
    return values


def argv(command, bindings, directory, allowed):
    name, *args = command
    required = {"node", "npm", "sh"} if name == "npm" else {name}
    if not required.issubset(allowed):
        raise Invalid("执行工具未进入该检查的输入声明")
    if name == "npm":
        if not all(k in bindings for k in ("node", "npm", "sh")):
            raise Invalid("npm 执行须绑定 node/npm/sh")
        executable = Path(bindings["node"]).absolute()
        npm_cli = Path(bindings["npm"]).absolute() / "bin/npm-cli.js"
        fd, leaf = _parent(npm_cli)
        try:
            if not stat.S_ISREG(os.stat(leaf, dir_fd=fd, follow_symlinks=False).st_mode):
                raise Invalid("npm-cli.js 必须为普通文件")
        finally:
            os.close(fd)
        args = [str(npm_cli), "--userconfig=" + str(directory / "user.npmrc"),
                "--globalconfig=" + str(directory / "global.npmrc"),
                "--script-shell=" + str(Path(bindings["sh"]).absolute()), *args]
    else:
        if name not in bindings:
            raise Invalid("命令首项必须显式绑定工具：" + name)
        executable = Path(bindings[name]).absolute()
    info = executable.lstat()
    if not stat.S_ISREG(info.st_mode) or not os.access(executable, os.X_OK):
        raise Invalid("执行工具须为可执行普通文件")
    return [str(executable), *args]


def validate_resolution(item, bindings, root):
    if item["command"][0] != "npm":
        return
    base = environment(bindings)["PATH"]
    # 当前构建会嵌套 npm --prefix ../frontend；同时核对两处脚本 PATH。
    for cwd in {root / item["cwd"], root / "backend", root / "frontend"}:
        local = [str(parent / "node_modules/.bin") for parent in (cwd, *cwd.parents)]
        path = os.pathsep.join(local + [base])
        for name in ("node", "npm", "sh", "cp", "mkdir"):
            if name not in item["tools"]:
                continue
            selected = shutil.which(name, path=path)
            expected = Path(bindings[name]) / "bin/npm-cli.js" if name == "npm" else Path(bindings[name])
            if selected is None or Path(selected).resolve() != expected.resolve():
                raise Invalid("脚本实际工具与声明不一致：" + name + " in " + str(cwd))
