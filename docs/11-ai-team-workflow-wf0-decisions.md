# AI 团队 Workflow WF0 架构决策

> 状态：已定稿，供 WF1-WF4 实施遵循  
> 日期：2026-07-02  
> 关联规划：`docs/10-ai-team-workflow-optimization-plan.md`

## 1. 目的

本文冻结 WF0 的术语、状态边界和四项前置架构决策。后续实现如果需要改变这些决策，应先更新
本文、契约测试和规划文档，不能在 Store、Scheduler 或 UI 中形成另一套隐式规则。

## 2. 术语

| 术语 | 唯一含义 |
|---|---|
| Workflow Definition | Workspace 内可编辑的流程逻辑身份 |
| Workflow Version | 发布后不可变的图、输入输出契约和引用版本 |
| Workflow Run | 某个 Workflow Version 的一次端到端执行 |
| NodeRun | Run 内一个节点的一次 iteration/attempt 执行事实 |
| Job | JobRunner 管理的一次本地计算或模型执行 |
| Approval Task | 持久化的人类判断事项 |
| Agent Profile | Workspace 内不可变的 Agent 能力修订 |
| Artifact Manifest | 一个 NodeRun 对外交付的有版本材料集合 |
| Artifact Consumption | 下游 NodeRun 对上游 Artifact 的实际使用记录 |
| Task Board Item | 用户管理的普通待办，不参与 Workflow 调度 |

## 3. 决策一：状态真相源

### 3.1 决策

- `WorkflowRun` 是端到端流程状态的唯一真相源。
- `NodeRun` 是流程节点状态的唯一真相源。
- `Job` 只记录执行状态、进度、结果和错误，不代表节点能否推进。
- `ApprovalTask` 只记录人的待办和决定；Scheduler 将决定投影为 NodeRun 状态。
- Task Board 退化为纯用户待办，不创建、驱动或完成 NodeRun。
- Team mailbox 只用于临时沟通，不作为 Workflow 输入、输出或完成证据。

### 3.2 映射规则

```text
Job queued/running       -> NodeRun queued/running
Job succeeded           -> NodeRun output_ready
Job failed/canceled     -> NodeRun failed/canceled
Approval pending        -> NodeRun waiting_approval
Approval approve        -> NodeRun succeeded
Approval reject/retry   -> old NodeRun rejected + new iteration pending
```

映射不是数据库触发器。所有映射统一经过 Scheduler 服务，并由状态转换契约校验。

### 3.3 延迟终态

Job 成功不能直接把 NodeRun 标为 `succeeded`。Scheduler 必须先登记输出 Manifest、消费关系和
审批要求，再将 NodeRun 从 `output_ready` 转为 `waiting_approval` 或 `succeeded`。

## 4. 决策二：稳定 Agent Profile

### 4.1 决策

Agent Profile 与现有 Session Team 解耦。节点通过不可变 `agent_profile_id` 引用一个具体修订，
运行中的 Profile 不随 Team 编辑或新修订漂移。

逻辑角色使用 `key` 标识，例如 `metric-reviewer`；每次修改 instructions、工具白名单或模型策略
都创建新 revision 和新 ID。旧 Profile 只可归档，不可覆盖。

### 4.2 存储

WF1 在每个 Workspace 的内部元数据目录新增：

```text
<workspace>/.zhixi/workflows.sqlite3
```

Workflow、Version、Run、NodeRun、Approval、Agent Profile 和后续 Artifact lineage 共用该
SQLite 数据库。原因：

- 与 Workspace 一起移动，符合团队资产归属。
- 天然隔离不同 Workspace。
- SQLite 事务和唯一约束适合版本、状态与幂等事实。
- 不把协作元数据写入分析用 DuckDB。

未挂载用户 Workspace 时不创建持久 Workflow。系统上传目录仍可进行普通单 Agent 分析。

### 4.3 工具白名单

Profile 的 `allowed_tools` 只是能力上限之一。节点实际工具集合为：

```text
Agent Profile allowed_tools
INTERSECT central Tool Registry availability
INTERSECT current Workspace permission
INTERSECT Workflow node allowed_tools (optional narrowing)
INTERSECT runtime safety guards
```

Profile 不复制 Tool Schema，也不能解锁 Registry 隐藏、缺少数据源、缺少 Workspace 或需要人工
确认的工具。首期 Profile 使用现有模型配置，`model_policy="inherit"`。

### 4.4 与 Teams 的关系

Teams UI 后续可以把多个 Agent Profile 组织成便捷团队，但 Team 不是 Profile 注册表。现有
`WorkspaceTeamStore` 保持兼容，不迁移到 Workflow 数据库，也不参与发布校验。

## 5. 决策三：调度推进触发

### 5.1 单一推进入口

所有实时、恢复和人工操作最终只调用：

```text
WorkflowScheduler.advance(run_id)
```

`advance` 从持久事实重新计算可执行动作，不信任调用方携带的旧状态，并通过 operation key 和
数据库唯一约束保证幂等。

### 5.2 主触发

WF2 为 JobRunner 增加受限的终态监听接口。JobRunner 先持久化 Job 终态，再通知 Workflow
listener；listener 只提交 `advance(run_id)`，不直接修改 NodeRun。

选择完成回调作为主触发的原因：

- 本地单进程架构下延迟最低。
- 不需要新建常驻事件消费线程。
- 现有 `_future_done` 已提供 Future 完成边界。
- Workflow 逻辑不会侵入普通 Job，只对绑定 NodeRun 的 Job 注册监听。

### 5.3 恢复触发

回调不是持久事实。应用可能在 Job 提交成功后、回调执行前退出，因此必须有两类补偿：

1. Workflow 服务启动时扫描非终态 Run 并调用 `advance`。
2. 低频 reconciliation 扫描长期停留在 `queued/running/output_ready` 的 NodeRun。

恢复扫描和回调使用同一个 `advance`，不存在第二套推进逻辑。SSE/event replay 只负责展示，
不承担业务调度。

## 6. 决策四：并行与配额

### 6.1 决策

不按 Run 或 Workspace 创建独立线程池。WF2 将现有 per-session JobRunner pool 收口为进程级
共享执行配额，Scheduler 在提交 Job 前执行分层限流。

首期默认值：

| 层级 | 默认上限 | 说明 |
|---|---:|---|
| 进程全局 Workflow Node Job | 6 | 防止多个 Session 各自创建线程池造成无界增长 |
| 单 Workspace | 3 | 保护 DuckDB、文件 IO 和模型配额 |
| 单 Workflow Run | 2 | 足以验证两路并行扇出，控制单 Run 独占 |
| 单 Agent Profile | 1 | 同一 Profile 默认串行，避免重复角色突发 |

上限必须可配置，但硬上限不超过 8，首期不根据 CPU 数自动放大。普通非 Workflow Job 的现有
行为在迁移完成前保持不变。

### 6.2 排队与公平

- Scheduler 只把获得配额的 `ready` NodeRun 提交为 Job。
- 未获得配额的 NodeRun 保持 `ready`，不伪装成 `queued`。
- 选择顺序按 Run 创建时间和 NodeRun 创建时间稳定排序。
- Workspace DuckDB 写操作继续受现有 `db_lock` 串行保护；线程配额不能替代数据锁。
- `team_delegate` 内部并行不计为多个 NodeRun，首期不允许 Workflow 节点嵌套动态团队委派。

### 6.3 释放

Job 进入任一终态后释放配额，再触发 `advance`。取消和提交失败路径同样必须释放。配额状态
不作为持久真相；应用重启后根据非终态 NodeRun 和 Job 重建。

## 7. 状态与错误契约

代码真相源：

```text
agent/workflows/models.py
```

该模块冻结：

- Run、NodeRun、Approval 状态。
- 允许的状态转换。
- 稳定错误码。
- 不可变 Agent Profile 数据契约。
- 首期 Workflow 图结构校验。

关键约束：

- 终态不可回退。
- 被驳回的旧 NodeRun 保持终态；重做创建新 iteration。
- 普通 `auto/approval` 边必须为 DAG。
- 回流只能使用 `retry_loop`，且必须设置正整数 `max_iterations`。
- 首期节点类型只有 `agent`，边类型只有 `auto/approval/retry_loop`。
- 首期汇合策略只有 `all_success/all_terminal`。

## 8. 固定验证场景

固定 Fixture：

```text
Test/fixtures/workflows/operating_analysis_v1.json
```

它覆盖：

- 单入口。
- 数据检查后双分支并行。
- `all_success` 汇合。
- 汇合后人工审批。
- 受限回流和最大迭代。
- 最终报告输出。

WF1-WF5 的 Store、Scheduler、Approval 和 UI 测试应优先复用该 Fixture，避免各阶段使用互不
一致的临时流程图。

## 9. WF1 进入条件

以下条件全部满足后才能进入 WF1：

1. `agent/workflows/models.py` 的契约测试通过。
2. 固定经营分析 Fixture 通过图校验。
3. 四项前置决策完成评审。
4. Task Board、Teams 和 JobRunner 的责任边界没有未决冲突。
5. WF1 数据库表设计遵循 Workspace 内 `.zhixi/workflows.sqlite3` 的存储决策。
