"""从声明生成计划，构建输入和产物分开；不执行任何检查命令。"""
import os
import platform
from pathlib import Path
import sys

from .files import Invalid, Inventory, digest, read_json, relative
from .runtime import environment as runtime_environment


def validate(definition):
    if not isinstance(definition, dict) or set(definition) != {"schema_version", "groups", "checks"}:
        raise Invalid("检查定义字段不完整或含未知字段")
    if type(definition["schema_version"]) is not int or definition["schema_version"] != 1:
        raise Invalid("未知检查定义版本")
    groups, checks = definition["groups"], definition["checks"]
    if not isinstance(groups, dict) or not groups or not isinstance(checks, list) or not checks:
        raise Invalid("输入组和检查集合必须非空")
    for name, specs in groups.items():
        if not name or not isinstance(specs, list) or not specs:
            raise Invalid("输入组必须有名称及范围")
        for spec in specs:
            if not isinstance(spec, dict) or "path" not in spec or set(spec) - {"path", "optional", "patterns"}:
                raise Invalid("输入范围含未知字段")
            relative(spec["path"])
            if type(spec.get("optional", False)) is not bool:
                raise Invalid("optional 必须为布尔值")
            patterns = spec.get("patterns")
            if patterns is not None and (not isinstance(patterns, list) or not patterns
                                         or not all(isinstance(p, str) and p and "/" not in p for p in patterns)):
                raise Invalid("patterns 必须为当前目录的非空名称模式")
    prior = {}
    for check in checks:
        required = {"id", "kind", "cwd", "command", "inputs", "outputs", "tools", "depends_on"}
        if not isinstance(check, dict) or set(check) != required or check["kind"] not in {"build", "playwright"}:
            raise Invalid("检查字段或类别无效")
        if not isinstance(check["id"], str) or not check["id"] or check["id"] in prior:
            raise Invalid("检查名必须非空且唯一")
        relative(check["cwd"])
        for field in ("command", "inputs", "outputs", "tools", "depends_on"):
            values = check[field]
            if not isinstance(values, list) or not all(isinstance(v, str) and v for v in values):
                raise Invalid("检查列表字段格式无效")
            if field != "command" and len(set(values)) != len(values):
                raise Invalid("检查列表不得重复")
        if not check["command"] or not check["inputs"] or not check["tools"]:
            raise Invalid("命令、输入和工具声明必须非空")
        if check["kind"] == "build" and not check["outputs"]:
            raise Invalid("构建必须声明产物")
        if any(g not in groups for g in check["inputs"] + check["outputs"]):
            raise Invalid("检查引用了未声明的输入组")
        for dep in check["depends_on"]:
            if dep not in prior or not set(prior[dep]["outputs"]).issubset(check["inputs"]):
                raise Invalid("依赖必须先声明且消费其全部产物组")
        prior[check["id"]] = check


def create(root, definition_path, bindings):
    root = Path(root).resolve(strict=True)
    definition = read_json(definition_path)
    validate(definition)
    inventory, groups, problems = Inventory(), {}, {}
    for group, specs in definition["groups"].items():
        keys, issues = [], []
        for spec in specs:
            path = relative(spec["path"])
            found, failed = inventory.capture(root / path, path, optional=spec.get("optional", False),
                                              patterns=spec.get("patterns"))
            keys.extend(found)
            issues.extend(failed)
        groups[group], problems[group] = sorted(set(keys)), issues
    tool_groups = {}
    for name in sorted({tool for check in definition["checks"] for tool in check["tools"]}):
        label = "@tool/" + name
        if name in bindings:
            keys, issues = inventory.capture(Path(bindings[name]).absolute(), label)
        else:
            keys, issues = [], ["MISSING_TOOL:" + name]
        tool_groups[name] = {"keys": keys, "issues": issues}
    runner_keys = []
    for path in sorted(Path(__file__).parent.glob("*.py")) + [Path(__file__).parents[1] / "gate.py"]:
        keys, issues = inventory.capture(path, "@runner/" + path.name)
        if issues:
            raise Invalid("无法固定工具自身输入")
        runner_keys.extend(keys)
    keys, issues = inventory.capture(Path(sys.executable).resolve(), "@runner/python")
    if issues:
        raise Invalid("无法固定当前 Python 工具身份")
    runner_keys.extend(keys)
    for name, executable in (("ps", "/bin/ps"), ("lsof", "/usr/sbin/lsof")):
        keys, issues = inventory.capture(Path(executable), "@runner/" + name)
        if issues:
            raise Invalid("无法固定进程监督工具身份")
        runner_keys.extend(keys)
    environment = runtime_environment(bindings)
    environment_issues = []
    # .env 可能含凭据；v1 只检测文件名，未声明时拒绝，不读取正文。
    for directory in {root, *(root / check["cwd"] for check in definition["checks"])}:
        for candidate in directory.glob(".env*"):
            environment_issues.append("UNDECLARED_ENV_FILE:" + str(candidate.relative_to(root)))
    for key in list(environment):
        if any(part in key.upper() for part in ("TOKEN", "SECRET", "PASSWORD", "API_KEY", "CREDENTIAL")):
            environment[key] = "REDACTED"
            environment_issues.append("SENSITIVE_ENVIRONMENT_UNSUPPORTED:" + key)
    external_settings = {"node_options", "node_path", "npm_config_userconfig", "npm_config_globalconfig", "npm_config_script_shell"}
    for key, value in environment.items():
        if key.lower() in external_settings and value:
            environment_issues.append("UNDECLARED_ENVIRONMENT_INPUT:" + key)
    if any("npm" in check["tools"] for check in definition["checks"]):
        configs = [root / ".npmrc", Path.home() / ".npmrc"]
        configs.extend(root / check["cwd"] / ".npmrc" for check in definition["checks"])
        for config in set(configs):
            if config.exists() or config.is_symlink():
                environment_issues.append("UNDECLARED_NPM_CONFIG:" + str(config))
    # 不把环境原文写入输出；调用方另在原始回执记录有效、非敏感配置。
    environment_key = digest(environment)
    checks, by_id = [], {}
    for check in definition["checks"]:
        ident = check["id"]
        if ident in by_id or any(dep not in by_id for dep in check["depends_on"]):
            raise Invalid("检查必须唯一并按依赖顺序声明")
        relative(check["cwd"])
        if not check["command"] or not all(isinstance(v, str) and v for v in check["command"]):
            raise Invalid("命令必须为非空 argv")
        keys, outputs, issues, output_issues = list(runner_keys), [], list(environment_issues), []
        for group in check["inputs"]:
            keys.extend(groups[group]); issues.extend(problems[group])
        for group in check["outputs"]:
            outputs.extend(groups[group]); output_issues.extend(problems[group])
        for name in check["tools"]:
            keys.extend(tool_groups[name]["keys"]); issues.extend(tool_groups[name]["issues"])
        issues.extend("EXTERNAL_LINK:" + key for key in inventory.external_links(keys))
        output_issues.extend("EXTERNAL_LINK:" + key for key in inventory.external_links(outputs))
        for dep in check["depends_on"]:
            if by_id[dep]["input_issues"]:
                issues.append("UPSTREAM_INPUT_INCOMPLETE:" + dep)
        key = digest({"definition": check, "root": str(root), "inputs": inventory.fingerprint(keys),
                      "input_definitions": {group: definition["groups"][group] for group in check["inputs"]},
                      "environment": environment_key, "python": sys.version, "platform": platform.platform(),
                      "tool_paths": {name: str(Path(bindings[name]).absolute()) if name in bindings else None
                                     for name in check["tools"]},
                      "upstream": {dep: by_id[dep]["input_key"] for dep in check["depends_on"]}})
        item = {**check, "input_key": key, "output_key": inventory.fingerprint(outputs),
                "input_entries": sorted(set(keys)), "output_entries": sorted(set(outputs)),
                "input_issues": sorted(set(issues)), "output_issues": sorted(set(output_issues)),
                "recommendation": "RUN_REQUIRED", "reasons": ["NO_RECEIPT"]}
        checks.append(item); by_id[ident] = item
    return {"schema_version": 1, "root": str(root), "definition": definition,
            "environment_key": environment_key, "environment_names": sorted(environment),
            "tool_bindings": {name: str(Path(path).absolute()) for name, path in sorted(bindings.items())},
            "entries": inventory.entries, "checks": checks, "acceptance": "NOT_EVALUATED"}
