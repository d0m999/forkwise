# Triage labels

## 状态角色与实际标签

- `needs-triage` → `needs-triage`：待维护者评估
- `needs-info` → `needs-info`：等待报告者补充信息
- `ready-for-agent` → `ready-for-agent`：规格充分，可交由代理执行
- `ready-for-human` → `ready-for-human`：需要人工处理
- `wontfix` → `wontfix`：决定不处理

## 使用规则

分诊后的 issue 恰有一个状态角色。类别使用 `bug` 或 `enhancement`，并恰有一个类别角色；其他主题标签保留。发现多个状态角色同时存在时，先请维护者裁定，再修改。

常规流转为：未分诊 → `needs-triage` → 其余四个状态之一；报告者补充信息后，`needs-info` 返回 `needs-triage`。维护者可明确覆盖流程。

本次 setup 只配置五个状态标签，不批量分诊既有事项。执行分诊时另读 `triage` 技能，遵守其推荐、核实、确认及发布规则。
