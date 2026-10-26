#!/usr/bin/env python3
"""检查计划、显式执行和证据核验；不写总控或改变验收门槛。"""
import sys
sys.dont_write_bytecode = True

import argparse
import json
from pathlib import Path

from gate_lib.files import Invalid
from gate_lib.plans import create
from gate_lib.evidence import evaluate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["plan", "verify", "run"])
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--definition", type=Path, default=Path(__file__).with_name("gate.frontend.json"))
    parser.add_argument("--tool", action="append", default=[], metavar="NAME=PATH",
                        help="显式声明工具的真实文件或完整安装目录；不执行它")
    parser.add_argument("--plan", type=Path, help="verify 使用的原始计划")
    parser.add_argument("--receipt", action="append", default=[], type=Path, help="原始完整运行回执，可重复")
    parser.add_argument("--summary", action="store_true", help="只输出摘要；摘要不能用作 verify 的原始计划")
    parser.add_argument("--check", help="run 显式选择一个检查")
    parser.add_argument("--output", type=Path, help="run 使用尚不存在的证据目录")
    parser.add_argument("--timeout", type=float, default=1800, help="run 墙钟上限（秒），超时保持失败")
    parser.add_argument("--control-grant", type=Path, help="run 使用的控制者事前输入授权；控制者须持有 POSIX 锁")
    parser.add_argument("--control-proof", action="append", default=[], metavar="AUTHORITY=PATH",
                        help="显式信任该控制者的补充收尾证明，可重复；不认证声明本身的真实性")
    parser.add_argument("--reuse", action="store_true", help="run 只复用合格原回执；不合格即拒绝，不回退执行")
    parser.add_argument("--controller-issue", type=int, help="由真实 v3 总控协调新执行的活动票")
    parser.add_argument("--controller-revision", type=int, help="v3 总控预期 revision")
    parser.add_argument("--input-ownership", type=Path, help="总控对本次完整输入范围的显式冻结复核")
    args = parser.parse_args()
    try:
        tools = {}
        for value in args.tool:
            name, path = value.split("=", 1)
            if not name or not path or name in tools:
                raise Invalid("工具名/路径必须非空且唯一")
            tools[name] = path
        control_proofs = []
        for value in args.control_proof:
            authority, path = value.split("=", 1)
            if not authority.strip() or not path:
                raise Invalid("控制者标识和证明路径必须非空")
            control_proofs.append((authority, Path(path)))
        if (args.reuse or args.control_grant) and args.operation != "run":
            raise Invalid("--reuse 和 --control-grant 仅用于 run")
        if args.reuse and args.control_grant:
            raise Invalid("复用不启动新执行，不能提供新输入授权")
        if args.operation == "run" and not args.reuse and control_proofs:
            raise Invalid("--control-proof 用于 plan、verify 或 run --reuse；新执行使用 --control-grant")
        coordinated = args.controller_issue is not None or args.controller_revision is not None or args.input_ownership is not None
        if coordinated and (args.operation != "run" or args.reuse or args.control_grant or control_proofs
                            or args.controller_issue is None or args.controller_revision is None or args.input_ownership is None):
            raise Invalid("v3 协调执行需要 issue、revision 和 input-ownership，不与其他控制模式混用")
        if args.operation == "run":
            if args.plan is None or not args.check or args.output is None:
                raise Invalid("run 需要 --plan、--check 和 --output")
            if coordinated:
                from gate_lib.controller import Controller
                result = Controller(args.root, args.controller_issue, args.controller_revision).run(
                    args.definition, tools, args.plan, args.check, args.output, args.input_ownership, args.timeout, args.receipt)
            else:
                from gate_lib.execution import run
                result = run(args.root, args.definition, tools, args.plan, args.check, args.output, args.timeout,
                             args.receipt, control_grant=args.control_grant, control_proofs=control_proofs, reuse=args.reuse)
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
            return 0 if result["status"] in {"passed", "reused"} else 1
        result = create(args.root, args.definition, tools)
        if args.operation == "verify":
            if args.plan is None:
                raise Invalid("verify 需要 --plan")
        result = evaluate(result, args.receipt, args.plan if args.operation == "verify" else None, control_proofs)
        if args.summary:
            result["summary_only"] = True
            result["entry_count"] = len(result.pop("entries"))
            result.pop("definition")
            for check in result["checks"]:
                check["input_count"] = len(check.pop("input_entries"))
                check["output_count"] = len(check.pop("output_entries"))
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 1 if args.operation == "verify" and result["status"] != "EVIDENCE_MATCHES" else 0
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"status": "INVALID_INPUT", "error": type(exc).__name__,
                          "message": str(exc), "acceptance": "NOT_EVALUATED"}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    sys.exit(main())
