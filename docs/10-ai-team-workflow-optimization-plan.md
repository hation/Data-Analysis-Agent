# AI 团队协作与 Workflow 优化规划

> 文档状态：**已结束；WF0-WF4 已完成；WF5 主要功能已完成；WF6-WF7 最小闭环已完成；WF8 动态协作闭环已完成（2026-07-16）**
> 制定日期：2026-07-01  
> 适用范围：Workspace、Teams、Tasks、JobRunner、Artifacts、Skills、Knowledge 与聊天工作台  
> 实施策略：复用现有运行底座，先确定性 Workflow，后动态协作；先打通一个真实场景，再扩展平台能力  
> 参考输入：《Cube Harness MultiCube：让 AI 团队像真团队一样协作》

## 1. 背景与判断

当前项目的产品定位仍以“一个能够调用多种工具的数据分析 Agent”为主，但代码中已经具备 AI
团队协作所需的多数基础设施：

- Teams 支持角色、消息、成员状态、并行委派和受限只读工具。
- Tasks 支持持久任务、负责人、状态和依赖关系。
- JobRunner 支持持久状态、父子任务、进度、取消、事件补发和重启后终态收敛。
- Workspace 提供稳定身份、权限、持久 DuckDB、文件边界和运行时 lease。
- Artifact envelope 支持来源、摘要、产物引用和大结果落盘。
- Skills 支持内置、用户、Workspace 三层能力覆盖。
- 输出工具已经具备 proposal/confirm 的人工确认入口。
- Knowledge 支持指标、规则、笔记和文档检索。

这些能力目前主要服务于单轮对话和临时并行委派，还没有形成统一的协作运行协议。Teams、
Tasks、Jobs 和 Artifacts 分别记录不同事实，但系统无法完整回答：

1. 本次分析按哪个已发布流程运行？
2. 当前执行到哪个节点，为什么等待或失败？
3. 某个 Agent 使用了哪些上游材料和数据快照？
4. 人在哪个版本上做了什么判断和修改？
5. 重启后应从哪里继续，重复推进是否安全？
6. 哪次成功经验可以直接复用到下一次分析？

因此，下一阶段的重点不是继续增加 Agent 数量，而是将现有能力收敛成一条可发布、可审批、
可追踪、可恢复、可沉淀的分析生产线。

## 2. 目标

### 2.1 产品目标

1. 让非技术用户能够用模板或一句目标启动一条多 Agent 分析流程。
2. AI 负责产出，平台负责推进，人负责关键判断。
3. 长任务允许异步运行、断线查看、失败重试和服务重启后恢复。
4. 每次运行绑定不可变流程版本、数据快照、输入材料和产出物。
5. 成功运行可以沉淀为 Workspace 模板、Skill 和知识资产。
6. 团队负责人能够查看运行健康度、返工原因、耗时和资源消耗。

### 2.2 工程目标

1. JobRunner 继续作为唯一长任务执行底座，不创建第二套执行引擎。
2. Workspace ID、Job ID 和 Artifact ID 继续作为持久资源主键。
3. 新增统一 Workflow 领域模型，连接 Teams、Tasks、Jobs 和 Artifacts。
4. 调度推进必须确定、幂等、可测试；Agent 不得临时改写已发布流程。
5. Workflow 事件复用现有 SQLite 持久事件和 sequence 补发机制。
6. 现有单 Agent 对话、Skill、Job 和输出确认流程保持兼容。

## 3. 非目标

本轮不包含：

- 让 Lead Agent 在没有边界的情况下自主创建、删除或改写全局流程。
- 一次性实现通用 BPMN、复杂表达式语言或低代码平台。
- 允许子 Agent 创建嵌套团队或获得不受限制的写权限。
- 建设跨组织、多租户、云端协作和企业级 RBAC。
- 默认把所有普通对话升级为多 Agent 流程。
- 在首个阶段实现跨进程分布式队列或远程 worker。
- 自动发布 AI 提出的流程修改；所有新版本仍需人工确认。

## 4. 设计原则

### 4.1 平台调度，Agent 执行

Agent 只完成当前节点任务并交付结果。节点是否开始、等待、重试、回流或结束，由调度器根据
已发布 Workflow 版本决定。

### 4.2 发布版本不可变

草稿可以编辑，发布版本不可修改。每次 Run 固定绑定 `workflow_version_id`，后续发布的新版本
不影响运行中的任务和历史复盘。

### 4.3 Artifact 是协作接口

Agent 之间不直接复制完整聊天历史。上游交付结构化 Artifact，下游接收材料清单，并记录实际
消费关系。短文本可以内联，长内容使用现有 Artifact URI。

### 4.4 人工判断是可恢复任务

审批不是一次性弹窗，而是持久化 Approval Task。用户关闭页面、切换 Session 或重启应用后，
待审批事项仍然存在。

### 4.5 先保存事实，再推进状态

节点完成时先原子记录输出、消费关系和执行结果，再计算后续动作。任何推进动作都必须能重复
调用而不产生重复节点、重复消息或重复 Artifact。

### 4.6 Workflow 与动态协作分工

- 流程明确、重复运行、需要审计的任务使用 Workflow。
- 调研、排障和开放式方案探索使用动态协作。
- 动态协作中的成功路径可以人工整理并发布为 Workflow。
- Workflow 节点未来可以调用一个受限动态协作子任务，但不在首期实现。

## 5. 当前能力映射与缺口

| 能力 | 当前基础 | 主要缺口 | 优化方向 |
|---|---|---|---|
| 团队角色 | `WorkspaceTeamStore`、`team_delegate` | 团队偏 Session 邮箱，结果以文本为主 | 团队定义与 Workflow 节点引用稳定 Agent Profile |
| 任务依赖 | `WorkspaceTaskStore` | 与 Job、Team、Artifact 无强关联 | Workflow NodeRun 成为运行任务事实源 |
| 长任务 | JobRunner、jobs/events | 只知道工具和对话任务，不知道流程节点 | NodeRun 绑定 parent/child job |
| 产出物 | envelope、Artifact URI、父任务归档 | 缺少输入输出血缘和版本关系 | 增加 ArtifactRef、Consumption、Revision |
| 人工确认 | 输出 proposal/confirm | 仅覆盖部分输出工具 | 抽象通用 Approval Task |
| 恢复 | Job 状态、事件补发、Session 恢复 | 无节点级 continuation 和幂等推进 | 持久调度游标与 operation key |
| Skills | 三层 Skill Loader | 主要是单 Agent 提示词工作流 | 支持 Workflow as Skill |
| 知识库 | 指标、规则、笔记、文档检索 | 成功产物和反馈不会自动沉淀 | 增加人工确认后的知识入库候选 |
| 可观测性 | Job 历史和工具步骤 | 缺少流程、节点、审批和返工指标 | 增加 Run 时间线和团队看板 |

### 5.1 底座现状勘误（评审核对，2026-07-02）

对照真实代码核对上表后，明确区分“可直接复用”与“需从零新建”，避免把新建能力误当成既有能力的优化：

**可直接复用（声明属实，部分强于描述）：**

- JobRunner：`agent/jobs.py` + `data/jobs_store.py`，`ThreadPoolExecutor(max_workers=2)`，SQLite WAL（`journal_mode=WAL` + `BEGIN IMMEDIATE`），支持父子任务、进度、协作式取消、`job_events` + 每 session `sequence` 补发、重启终态收敛（`_recover_interrupted_jobs_locked`）。
- Workspace facade：`data/workspace.py`，稳定 `workspace_id`、读写权限与路径边界、持久 DuckDB（`.zhixi/workspace.duckdb`）、运行时 lease；`db_lock` 为 `threading.RLock`（DuckDB 单写者串行化）。
- 数据库分职：SQLite（WAL）管 jobs/事件流（`outputs/jobs/jobs.db`），DuckDB 管分析数据层，两者职责清晰。
- 事件/SSE：`api/jobs.py` 按 `after_sequence` 增量补发，返回 `oldest_sequence` 与 `replay_truncated` 判断截断。
- Skills：`agent/skills/loader.py` 三层 `builtin -> user -> workspace` 覆盖，支持热重载。
- Tasks：`agent/tools/workspace/tasks.py`，有 `assignee`、状态、`blocks`/`blocked_by` 依赖。

**需从零新建（本方案实为“新增能力”，非“优化现状”）：**

- **稳定 Agent Profile（前置依赖，未列入原计划）**：现有 Teams 在 `agent/tools/workspace/teams.py`，`scope="session"`，持久化为 JSON（`outputs/teams/{session}/agent_teams.json`），**无跨 Run 稳定身份**。方案节点引用的 `agent_profile_id` 依赖一个尚不存在的 Agent Profile 注册表，必须在 WF1 之前补齐，否则发布校验中的“Agent 引用存在”无从校验。
- **Artifact 血缘/版本/消费（WF3 为全新开发）**：`agent/tools/results.py` 现有 envelope、`artifact://` URI、大结果落盘与 SHA-256，但**无 lineage / revision / consumption 三表**。ArtifactManifest、ArtifactConsumption、Revision 均为新建。
- **持久审批队列（WF4 为全新能力）**：现有“人工确认”是命令门控——`agent/agent.py` 的 `_OUTPUT_TOOL_GUARDS` 拦截 `generate_ppt/export_report/export_excel/generate_dashboard` 四个工具，须由对应 `*_confirm` 命令解锁，**不是持久化 ApprovalTask 队列**，不跨 Session/重启留存待办。ApprovalTask Store 为新建。

**路径与命名勘误：**

- 原文多处将 Team/Task Store 描述在 `data/` 或未指明；实际均位于 `agent/tools/workspace/`。
- 已新增并投入使用：`data/workflow_store.py`、`data/workflow_run_store.py`、`agent/workflows/service.py`、`agent/workflows/scheduler.py`、`agent/workflows/runtime.py`、`api/workflows.py` 与 `api/workflow_runs.py`。Approval 事实目前与 Run/NodeRun/Manifest 一同保存在 Workflow SQLite 中，没有另建 `data/approval_store.py`。
- 第 7 节“运行事实必须进入事务型表”与现有 Teams 存 JSON 的做法冲突：若 Workflow 复用 Team 概念，需评估是否将团队/成员事实一并迁入 SQLite，或在 NodeRun 层完全绕开现有 Team JSON。

## 6. 目标架构

```text
Chat / Scenario UI / Hook
             |
             v
Workflow Service
  - draft / validate / publish
  - start / pause / cancel / resume
             |
             v
Deterministic Scheduler
  - dependency resolution
  - approval gates
  - retry / loop limits
  - idempotent advancement
             |
     +-------+--------+
     |                |
     v                v
JobRunner         Approval Service
  |                  |
  v                  v
Agent Node        Human Decision
  |
  v
Artifact Registry + Lineage
  |
  +--> Workspace Knowledge / Workflow Template / Skill
```

### 6.1 责任边界

| 模块 | 负责 | 不负责 |
|---|---|---|
| Workflow Service | 草稿、校验、发布、版本和 Run 生命周期 | 执行模型调用 |
| Scheduler | 按发布图推进、等待、汇合、重试和终态判断 | 判断业务内容是否正确 |
| JobRunner | 可靠执行节点、事件、取消和资源 lease | 决定下一个节点 |
| Agent | 完成一个明确节点任务并交付 Artifact | 改写全局流程 |
| Approval Service | 保存人的判断、评论、修改和审批任务 | 自动替人做质量决策 |
| Artifact Registry | 版本、来源、消费、修订和完整性 | 解释业务结论 |
| Knowledge | 保存人工确认的可复用知识 | 自动收录所有中间结果 |

## 7. 核心领域模型

首期建议继续使用现有 SQLite 数据库，不使用 JSON 整文件保存运行状态。Workflow 草稿可以使用
JSON 图定义，但发布版本和运行事实必须进入事务型表。

### 7.1 WorkflowDefinition

表示可编辑的场景定义。

```text
id
workspace_id
name
description
status: draft | published | archived
current_version_id
created_by
created_at
updated_at
```

### 7.2 WorkflowVersion

表示不可变发布版本。

```text
id
workflow_id
version_number
graph_json
graph_hash
input_schema_json
output_schema_json
published_by
published_at
```

发布校验至少包括：

- 节点 ID 和边 ID 唯一。
- 至少一个入口节点。
- 所有 Agent、Skill 和工具引用存在。
- 无不可达节点。
- 普通边不能形成无限环。
- 循环边必须配置最大迭代次数。
- 汇合策略明确。
- 输出声明能够由上游输入满足。
- 需要写入或输出的节点声明权限需求。

### 7.3 WorkflowRun

表示一次运行。

```text
id
workflow_version_id
workspace_id
session_id
status
input_manifest_id
started_by
started_at
finished_at
cancel_requested_at
failure_code
failure_message
```

建议状态：

```text
created -> running -> waiting_approval -> running
                   -> paused -> running
                   -> canceling -> canceled
                   -> succeeded
                   -> failed
```

`waiting_approval` 表示当前无可运行节点且存在待审批事项；如果仍有其他并行分支运行，Run 保持
`running`。

### 7.4 NodeRun

表示某个节点的一次尝试或修订轮次。

```text
id
run_id
node_id
iteration
attempt
status
agent_profile_id
job_id
input_manifest_id
output_manifest_id
operation_key
started_at
finished_at
error
```

建议状态：

```text
pending
ready
queued
running
output_ready
waiting_approval
succeeded
rejected
skipped
failed
canceled
```

`output_ready` 是延迟终态：节点已经保存输出，但调度器尚未完成审批、下游分发和状态收口。

### 7.5 ApprovalTask

```text
id
run_id
node_run_id
status: pending | decided | canceled
approver_role
decision
comments_json
base_artifact_manifest_id
revised_artifact_manifest_id
created_at
decided_at
decided_by
```

首期支持四种决策：

| 决策 | 行为 |
|---|---|
| `approve` | 当前输出成为正式输出，继续下游 |
| `approve_with_changes` | 保存人工修订版，下游消费修订后的 Artifact |
| `reject_and_retry` | 带评论创建下一 iteration，受最大迭代次数限制 |
| `reject_and_stop` | 关闭分支；按节点策略决定 Run 失败或终止 |

### 7.6 ArtifactManifest

一个节点可以交付多个材料，Manifest 用于形成稳定交接边界。

```text
id
workspace_id
run_id
node_run_id
items_json
summary
supersedes_manifest_id
created_at
```

`supersedes_manifest_id` 记录 `approve_with_changes` 产生的人工修订版指向被替代的原始 Manifest，用于保留修订血缘与下游正确消费。

每个 Artifact Item 至少记录：

```text
artifact_id
type
name
uri
sha256
media_type
size
source_job_id
source_tool
data_snapshot_id
created_at
```

### 7.7 ArtifactConsumption

```text
id
consumer_node_run_id
producer_node_run_id
artifact_id
purpose
created_at
```

该表回答“这个结论使用了什么材料”，也是后续复现、清理保护和知识沉淀的依据。

## 8. Workflow 图契约

首期只支持满足业务分析需求的最小 DAG 和受限回流，不引入通用表达式引擎。

```json
{
  "entry_node_ids": ["inspect_data"],
  "nodes": [
    {
      "node_id": "inspect_data",
      "type": "agent",
      "agent_profile_id": "data-analyst",
      "input_contract": ["source_snapshot"],
      "output_contract": ["analysis-notes"]
    },
    {
      "node_id": "verify_metrics",
      "type": "agent",
      "agent_profile_id": "metric-reviewer",
      "input_contract": ["analysis-notes"],
      "output_contract": ["verification-report"]
    }
  ],
  "edges": [
    {
      "edge_id": "e1",
      "from_node": "inspect_data",
      "to_node": "verify_metrics",
      "type": "auto"
    }
  ],
  "limits": {
    "max_run_minutes": 120,
    "max_total_node_runs": 30
  }
}
```

首期边类型：

- `auto`：上游成功后自动推进。
- `approval`：上游输出创建审批任务，通过后推进。
- `retry_loop`：审批驳回后回到指定节点，必须有 `max_iterations`。

首期汇合策略：

- `all_success`：所有必需上游成功。
- `all_terminal`：所有上游进入终态，允许消费成功分支。

条件分支首期只允许基于平台事实，例如审批结果、节点状态和结构化评分字段。禁止执行任意
Python、SQL 或模型生成表达式。

## 9. 首个验证场景

建议选择“经营分析报告”作为首个端到端场景，因为它能覆盖数据检查、并行分析、独立复核、
人工判断和报告产出。

```text
数据与口径检查
       |
       +-------------------+
       |                   |
       v                   v
核心指标分析          异常与分群分析
       |                   |
       +---------+---------+
                 v
            独立指标复核
                 |
            [人工审批]
                 |
                 v
          图表与报告生成
                 |
            [发布审批]
                 |
                 v
          归档与知识候选
```

### 9.1 角色

| 角色 | 职责 | 权限 |
|---|---|---|
| 数据检查员 | Schema、质量、缺失值和时间范围检查 | 只读数据与 Workspace |
| 业务分析师 | 指标、趋势、分群和异常解释 | 只读查询与分析工具 |
| 复核员 | 独立复算关键指标、检查 SQL 和结论 | 只读，不能看到分析师推理文本 |
| 报告编辑 | 基于已批准材料生成图表与报告 | 输出工具，仅确认后执行 |
| 负责人 | 审批口径、结论和最终发布 | 人工操作 |

### 9.2 验证重点

1. 两个分析节点能够并行执行。
2. 汇合节点必须等待所需材料。
3. 复核员消费明确的 Artifact，而不是整段历史。
4. 审批驳回后只重跑指定节点。
5. 人工修改后的版本成为下游正式输入。
6. 刷新页面和重启应用后仍能查看状态和继续审批。
7. 最终报告能够追溯到 SQL、数据快照和审批记录。

## 10. 分阶段实施

### WF0：契约与基线（已完成）

预计：2-3 天。

任务：

| 编号 | 内容 | 主要涉及 |
|---|---|---|
| WF0.1 | 冻结 Workflow、Run、NodeRun、Approval、Artifact Lineage 术语 | 本文、`docs/02-architecture.md` |
| WF0.2 | 明确现有 Job、Team、Task、Artifact 可复用接口 | `agent/`、`data/`、`api/` |
| WF0.3 | 建立状态转换表和错误码 | 新增 Workflow models |
| WF0.4 | 建立首个场景固定测试 Fixture | `Test/fixtures/` |
| WF0.5 | 修正文档索引中不存在的文档链接 | `01-notes-for-development.md` |
| WF0.6 | **锁死状态真相源边界（硬决策，不得延后）**：NodeRun 管流程状态、Job 管执行状态、Task Board 退化为纯用户待办不参与调度 | 本文、Scheduler 设计 |
| WF0.7 | **定义稳定 Agent Profile 模型（WF1 前置）**：与 Session 级 Team 解耦，节点通过 `agent_profile_id` 引用不可变 Profile；确定注册表存储位置与工具白名单来源 | `agent/tools/workspace/`、新增 profile 注册 |
| WF0.8 | **定义调度推进触发机制**：Job 完成后由谁调用 advance（JobRunner 完成回调 vs 事件订阅 vs 定时扫描），确定单一入口并保证幂等 | Scheduler、JobRunner |
| WF0.9 | **确定并行并发模型**：现 `max_workers=2` 无法支撑扇出图 + 多 Run 并发，明确是否按 workspace/Run 分池、每 Run 并发上限与全局配额 | JobRunner、Scheduler |

验收：

- 每个持久状态都有唯一含义和允许的转换。
- 明确旧 Task Board 是否只保留为用户待办，避免与 NodeRun 双重记账。
- 首期图契约可以表达经营分析报告场景。
- **状态真相源、Agent Profile、调度触发机制、并发模型四项前置决策已定稿，否则不进入 WF1。**

### WF1：持久化模型与发布（已完成）

预计：4-6 天。

任务：

| 编号 | 内容 | 主要涉及 |
|---|---|---|
| WF1.1 | 新增 Workflow SQLite 表和迁移 | `data/workflow_store.py` |
| WF1.2 | 实现草稿创建、更新、校验和发布 | `agent/workflows/service.py` |
| WF1.3 | 发布时生成 graph hash 和不可变版本 | Workflow Service |
| WF1.4 | 增加列表、详情、校验、发布 API | `api/workflows.py` |
| WF1.5 | 增加 Workspace 隔离和权限检查 | Workspace Runtime |

验收：

- 发布版本不可修改。
- 相同草稿重复发布行为明确，不产生歧义版本。
- 跨 Workspace 无法读取或启动流程。
- 非法环、缺失 Agent、不可达节点和输入契约错误会被拒绝。

> 实施结果：25 项 WF0/WF1 专项测试、128 项相关回归和 Ruff 通过；真实应用 API 完成 Profile 创建、Workflow 创建、校验和 v1 发布端到端验收。

### WF2：确定性调度与 JobRunner 接入（已完成）

预计：6-8 天。

任务：

| 编号 | 内容 | 主要涉及 |
|---|---|---|
| WF2.1 | 创建 Run、入口 NodeRun 和输入 Manifest | Workflow Service |
| WF2.2 | 实现 ready 计算、派发、汇合和全局终态判断 | `agent/workflows/scheduler.py` |
| WF2.3 | NodeRun 通过现有 JobRunner 执行 | `agent/jobs.py`、Agent |
| WF2.4 | 增加 operation key 和唯一约束 | Workflow Store |
| WF2.5 | 支持取消、失败重试和超时 | Scheduler、JobRunner |
| WF2.6 | 将 Workflow 事件写入持久事件流 | jobs/events 或独立 workflow events |

验收：

- 并行入口和扇出节点只派发一次。
- 同一推进函数重复执行不会产生重复 Job。
- 汇合节点不会提前启动。
- 取消 Run 会停止后续派发，并协作式取消运行中子 Job。
- 进程重启后不会把不确定状态伪装为成功。

> 实施结果：已新增 `data/workflow_run_store.py`、`agent/workflows/scheduler.py`、`agent/workflows/runtime.py` 与 `api/workflow_runs.py`，完成 Run/NodeRun 持久化、auto-edge DAG ready/dispatch/join、operation key 幂等派发、JobRunner 终态回调、Workflow 事件流、Run 取消、节点自动重试（`max_attempts`）和 Run 超时（`limits.max_run_minutes`）。WF2 初始运行时只支持 `auto` 边；`approval` 与 `retry_loop` 已在 WF4 接入持久审批和返工上限语义。相关 36 项 Workflow/Job listener 测试通过，Ruff 通过。

### WF3：Artifact 交接与血缘（已完成）

预计：4-6 天。

任务：

| 编号 | 内容 | 主要涉及 |
|---|---|---|
| WF3.1 | 为节点输出创建 Artifact Manifest | `agent/tools/results.py` |
| WF3.2 | 生成下游材料清单和有界上下文 | Agent prompt builder |
| WF3.3 | 记录 ArtifactConsumption | Workflow Store |
| WF3.4 | 关联 source snapshot、SQL 和工具结果 | Chat/Job artifact events |
| WF3.5 | 扩展存储清理引用保护 | `data/workspace_storage.py` |

验收：

- 下游只收到契约声明的材料。
- 长材料通过 URI 读取，不整体进入 Prompt。
- 删除或清理被 Run 引用的 Artifact 时会被保护。
- 最终报告可以反查输入 Artifact、数据快照和生成 Job。

> 实施结果（最小血缘，2026-07-03）：`WorkflowRunStore` 已新增 `workflow_artifact_manifests` 与 `workflow_artifact_consumptions`，Run 输入、NodeRun 输入和 NodeRun 输出都会形成 Manifest；节点成功进入 `output_ready` 时先保存输出 Manifest，再推进为成功；Scheduler 下游输入改为只按 `input_contract` 从上游输出 Manifest 取材料，并记录消费关系；长材料以 `artifact://workflow/...` 引用和 SHA-256 元数据传递，不把全文塞进下游输入。当前仍未完成 WF3.4 的 SQL/数据快照/工具结果关联，以及 WF3.5 的存储清理引用保护。
>
> WF3 收尾（2026-07-07）：Manifest item 现在会保留节点输出中携带的 `data_snapshot_id`、`sql`/`sql_hash`、`tool`、`sources` 与工具产物引用，最终报告可从 Workflow Manifest 反查数据快照、SQL 和工具结果；Workspace 存储清理计划会扫描 `.zhixi/workflows.sqlite3` 中的 Workflow Manifest 引用，被 Workflow 血缘引用的 stale/missing 注册表不会进入 cleanup candidates，而会进入 protected references。WF3.4/WF3.5 已完成，下一阶段进入 WF4 的持久审批与人工修订 Artifact。
>
> 动态团队可靠性补丁（2026-07-03）：在 Workflow 全量接管动态协作前，先修复现有 Teams 的审计缺口：delegated LLM 的工具参数写回消息历史前必须规范化为合法 JSON；成员只有工具调用清单、没有最终 Markdown 结论时不得计为成功；固定质量复核员输出“严重缺失/无法验证/必须重做”等阻断结论时，团队结果进入 `needs_review`；`team_delete` 默认保留已有消息、错误和复核证据，只有用户明确确认并传 `force=true` 才允许删除。这些补丁服务于第 9 节首个验证场景的“独立复核”和第 19 节最终报告可追溯要求。

### WF4：人工审批与修订（核心闭环已完成）

预计：5-7 天。

任务：

| 编号 | 内容 | 主要涉及 |
|---|---|---|
| WF4.1 | 实现 Approval Task Store 与 API | `data/approval_store.py`、`api/workflows.py` |
| WF4.2 | 支持四种审批决策 | Approval Service |
| WF4.3 | 评论进入下一修订轮次 | Agent input builder |
| WF4.4 | 支持人工修订 Artifact | Workspace file/artifact service |
| WF4.5 | 实现迭代上限和分支终止策略 | Scheduler |

验收：

- 审批事项跨刷新、Session 和应用重启存在。
- 重复提交同一审批决策不会重复推进。
- `reject_and_retry` 只创建一个新 iteration。
- 下游消费人工修订版，而不是被替代的原始版本。
- 达到迭代上限后必须等待人决定，不自动无限重跑。

> 实施进展（最小闭环，2026-07-08）：沿用 `workflow_approvals` 作为持久审批事实源，并扩展为规划中的四种标准决策：`approve`、`approve_with_changes`、`reject_and_retry`、`reject_and_stop`；旧前端/API 仍兼容 `rework`、`retry`、`reject` 等别名。审批创建时现在绑定最新 `artifact_manifest_id`，不再丢失待审原始 Manifest。`approve_with_changes` 会创建 `node_output_revision` Manifest，写入 `supersedes_manifest_id`，并把 NodeRun 的 `output_manifest_id` 替换为人工修订版，下游节点因此消费修订后的 Artifact。`reject_and_retry` 创建下一 `iteration`，与节点执行失败的 `attempt` 重试语义分离。API 已支持 `comments`、`revised_outputs` 和 `revised_summary`。
>
> WF4 硬化补丁（2026-07-08）：`reject_and_retry` 现在会读取待审节点发出的 `retry_loop.max_iterations`，达到上限时拒绝决策并保持 Approval `pending`，避免“先落库决策、后发现无法返工”的半推进状态；未声明 `retry_loop` 的异常复核路径暂以 2 次总 iteration 为保守默认兜底。
>
> WF4 恢复验收（2026-07-08）：新增 Store/Scheduler 重建测试，验证 pending Approval 在关闭并重新打开 `.zhixi/workflows.sqlite3` 后仍可读取、保持 `pending`，并能继续 `approve` 推进下游节点。
>
> WF4 回流语义（2026-07-08）：`reject_and_retry` 现在会按待审节点发出的 `retry_loop` 创建目标节点的新 iteration，同时为当前待审节点创建新 iteration 以便目标节点重跑后重新复核；没有显式 `retry_loop` 时仍回到当前节点。
>
> WF4 分支终止（2026-07-08）：节点可声明 `on_reject: "fail_run" | "close_branch"`，默认 `fail_run` 保持旧行为；`close_branch` 会在 `reject_and_stop` 时把该节点收口为 `skipped`，下游 `all_terminal` 汇合节点可继续消费其它成功分支。
>
> WF4/WF5 面板补齐（2026-07-08）：团队页 Workflow 审批卡片已接入审批意见、结构化 comments、修订摘要与 `approve_with_changes` 的 `revised_outputs` 提交；批准、带修改批准、要求重做和驳回终止都可从底部聊天区团队页面完成。审批卡片现在会基于待审 `artifact_manifest_id` 预填字段级修订草稿，并与 JSON 高级编辑区保持同步。

> WF5 流程图补齐（2026-07-08）：Run detail API 已返回发布版本 Graph，团队页 Workflow 详情顶部新增 DAG 视图，按节点层级展示运行状态、待审批点、返工目标、可关闭分支和 `auto`/`approval`/`retry_loop` 边。

> 对话入口补齐（2026-07-08）：新增 conversation-facing `workflow_create` 工具，用户在聊天里说“创建 workflow / 创建工作流”时可直接创建并发布标准 AI-team Workflow 模板，不再误判为没有创建能力。

> 当前剩余：人工修订尚未提供新文件上传、跨 Manifest 差异高亮或富文本/表格型 Artifact 专用编辑器；Workflow 事件仍以轮询刷新为主，尚需完成增量补发/SSE 恢复与桌面、平板、手机视口的 Playwright 视觉验收。拖拽图编排仍属于后置能力。

### WF5：运行界面（主要功能已完成，可靠性验收进行中）

预计：6-8 天。

任务：

| 编号 | 内容 | 主要涉及 |
|---|---|---|
| WF5.1 | 增加 Workflow 列表和场景详情 | `frontend/features/` |
| WF5.2 | 增加 Run 时间线和节点状态 | Vue UI |
| WF5.3 | 增加审批抽屉和评论流 | Vue UI |
| WF5.4 | 增加 Artifact 材料与血缘视图 | Vue UI |
| WF5.5 | Job 历史关联 Workflow Run | Job History UI |

界面原则：

- 首屏直接展示可运行场景和进行中 Run，不做营销式落地页。
- 默认展示运行状态和待办，不要求普通用户先理解 DAG。
- 图编辑器不是首期门槛；首期允许表单配置和 JSON/固定模板。
- 只有流程设计者进入图视图，普通使用者通过聊天或“运行”按钮启动。

验收：

- 用户能在一个页面看清正在做什么、为什么等待、需要谁处理。
- 失败节点展示可读原因、输入材料和重试入口。
- 移动端不存在状态、按钮和文本重叠。
- SSE 断线后通过持久事件补发恢复最新状态。


> WF5 操作闭环（2026-07-10）：新增暂停 Run 的恢复 API/按钮，以及失败 Run 最新失败节点的显式手动重试；手动重试保留原失败 NodeRun，创建新 attempt，并重新打开受影响的下游节点。节点 Job ID 现在可跳转到 Job 历史并自动定位、展开对应任务。后端契约、Scheduler、路由和前端静态回归已补齐。

### WF6：模板、Skill 与知识沉淀（最小闭环已完成）

预计：5-7 天。

任务：

| 编号 | 内容 | 主要涉及 |
|---|---|---|
| WF6.1 | 将已发布 Workflow 暴露为受控 Skill | Skill Loader/Executor |
| WF6.2 | 支持从聊天按名称启动 Workflow | Agent tool/command |
| WF6.3 | 成功 Run 标记为模板 | Workflow Service |
| WF6.4 | 生成知识入库候选，不自动发布 | Knowledge API/UI |
| WF6.5 | 保存高质量 SQL、指标口径和报告模板引用 | Knowledge + Artifact |

验收：

- Workflow as Skill 只暴露必要输入，不泄漏内部节点复杂性。
- 普通 Agent 不能绕过审批直接执行受保护输出。
- 只有人工确认的内容可以进入正式知识库。
- 模板引用发布版本，不引用可变草稿。


> WF6 实施结果（2026-07-11）：每个当前发布的不可变 WorkflowVersion 会动态暴露为 source=workflow 的受控 Skill；Skill 名称绑定 workflow_version_id，提示词只包含名称、说明和输入 schema，不泄漏 DAG、Agent Profile 或内部节点工具，只能解锁 workflow_start。显式 Skill 激活、自动语义匹配、Skill 列表和详情 API 均已接入。
>
> 成功 Run 现在可以人工标记为模板，模板固定保存 Run、WorkflowVersion 和最终 Manifest 引用；成功 Run 可幂等生成报告模板与高质量 SQL 知识候选。候选默认 pending，团队页提供“接受入库/拒绝”，只有接受后才写入现有 KnowledgeBase。Run/Workflow 永久删除会级联清理模板和候选。68 项 Workflow 专项回归通过。
>
> WF6 后续增强项：模板列表管理与删除界面、候选内容差异预览、入库前分类选择和更细粒度的指标口径抽取；这些不阻塞最小闭环验收。

### WF7：团队看板与流程优化建议（最小闭环已完成）

预计：4-6 天。

任务：

| 编号 | 内容 |
|---|---|
| WF7.1 | Run 成功率、平均耗时、等待审批时间 |
| WF7.2 | 节点失败率、重试率和人工驳回率 |
| WF7.3 | Agent 调用量、Token 和模型成本 |
| WF7.4 | Artifact 复用率和知识候选采纳率 |
| WF7.5 | 基于统计生成流程优化建议，由人确认后创建新草稿 |

验收：

- 指标可以定位到 Workflow 版本和节点。
- 优化建议只创建草稿，不自动修改已发布版本。
- 看板不展示模型推理原文或敏感数据正文。

> WF7 实施结果（2026-07-11）：NodeRun 新增实际模型、Provider、输入/输出/缓存 Token 和工具调用量审计字段，调度器将内部 usage 与业务 Artifact 分离。指标 API 按不可变 WorkflowVersion 聚合 Run 成功率、平均耗时、审批等待与驳回、节点失败/重试、Token 覆盖、Artifact 复用和知识候选采纳率；未配置模型价格时成本明确显示“未配置价格”，不推算虚假金额。
>
> 团队页 Workflow 区域新增紧凑运行看板、版本明细和规则化优化建议。建议由确定性统计规则产生，用户点击后服务端重新校验建议并克隆对应发布版本为独立草稿，不修改已发布版本。看板只展示审计元数据和聚合值，不展示模型推理或产物正文。WF7 后端 5 项集成测试与 41 项 Workflow 核心回归通过。
>
> WF7 后续增强项：模型价格表与币种配置、时间范围筛选、指标趋势图、建议忽略/归档、跨版本对比和大规模历史数据的预聚合；这些不阻塞最小闭环验收。

### WF8：动态协作模式（闭环已完成）

进入条件：

- 至少一个 Workflow 连续稳定运行。
- 节点恢复、审批、Artifact 血缘和权限模型通过真实数据验收。
- 已有足够运行记录验证审计和成本边界。

首期能力：

- Lead Agent 根据目标创建有界任务列表。
- 成员继续使用现有只读委派权限。
- 每次委派绑定 Task、Job 和 Artifact。
- 人可以协作式终止运行，或将成功路径保存为 Workflow 草稿。

暂不支持：

- 无限递归委派。
- Agent 自动提升权限。
- Agent 自动发布 Workflow。
- 无预算上限的自运行。

> WF8.1 实施结果（2026-07-11）：复用现有 team_delegate 只读成员执行和固定质量复核，在其外增加 Workspace 隔离的 Dynamic Plan/Task 状态层。Lead 可声明有界 goal、1-8 个独立并行 Task 和成员；执行自动记录 Plan ID、Task 状态、结果摘要和受限工具证据。
>
> 团队页新增动态任务计划区，支持查看独立并行任务状态，并由人工请求协作式终止。仅完整成功的计划可由用户保存为未发布 Workflow 草稿；草稿在 Workflow 页人工审核后才能发布并注册动态 Skill。54 项相关契约、草稿图校验和面板回归通过。
>
> WF8.3 实施结果（2026-07-12）：每个 Dynamic Task 现在创建真实 `team_dynamic_task` 子 Job，并继承当前对话 Job 作为 parent。Task 持久化 job_id，团队页可跳转 Job 历史；成功、失败或终止会同步子 Job 终态。用户请求终止计划时，API 会立即取消所有关联的未终态 Task 子 Job。
>
> WF8.4 实施结果（2026-07-12）：成功 Dynamic Task 会生成受限的 `team_task_result` 交付摘要 Artifact，并同时写入 Task 的 artifacts 引用和对应子 Job 的 artifact_created 事件。团队面板展示交付物数量，点击 Task Job 可在 Job 历史查看交付摘要与 Task/Job/Plan 关联。
>
> WF8.5 实施结果（2026-07-12）：失败 Dynamic Task 可由 Lead 通过 team_delegate 的 retry_plan_id / retry_task_ids 重新派发。重试会复用持久化的原成员和提示词，只重跑指定失败 Task，增加 attempt 并创建新的子 Job；已成功 Task 不会重复执行。团队页的失败 Task 可一键填入受控重试请求，仍须在对话中发送后执行。
>
> WF8.6 实施结果（2026-07-13）：Dynamic Plan 支持 depends_on，并在创建时拒绝未知依赖、自依赖和循环。team_delegate 按“前置成功”计算可运行批次，同批 Task 并行派发；下游 Task 只在前置全部成功后才写入成员运行状态并创建子 Job。前置失败会阻塞下游 Task，记录原因且不派发、不创建 Job、不消耗模型调用。
>
>
> WF8.7 实施结果（2026-07-13）：Dynamic Plan 持久化每个成员 Task 和固定质量复核的实际模型用量（输入/输出/缓存 Token、工具调用、模型与 Provider）。计划面板汇总累计消耗、已测量任务和子 Job 数；失败重试会保留先前尝试及 Job 历史，不能通过覆盖状态抹掉真实用量。未配置价格表时成本固定显示“未配置价格”，不产生虚构金额。83 项动态团队、工具契约、Job 与前端面板回归通过。
> WF8.8 实施结果（2026-07-13）：新增 discoverable 的 team_plan_create 对话工具。用户明确要求“先创建/预览计划”时，只会校验并持久化 status=planned 的 1-8 个有界任务，不派发成员、不创建子 Job、不调用模型。团队页展示“在对话中执行”，填入受控确认请求；Lead 仅可通过 team_delegate(team_name, plan_id) 启动同一计划，且先校验团队归属再切换为 running。
>
> WF8.9 实施结果（2026-07-16）：质量复核出现交付物不完整、输出被截断或“方可对外发布”等阻断证据时，Dynamic Plan 进入 `needs_review`，记录复核摘要，禁止保存为 Workflow 草稿。团队面板显示待修正原因并提供“按复核意见补全”对话入口。
>
> WF8.10 实施结果（2026-07-16）：复核阻断计划可通过 team_delegate(review_plan_id, review_task_ids) 定向返工。系统仅重置所选 Task，并自动扩展到所有下游依赖；不受影响且已完成的上游 Task 保留结果、Artifact、Job 历史和累计用量。对话上下文与团队面板均提示 Lead 使用受控返工参数。
>
> WF8 闭环完成（2026-07-16）：有界计划创建、显式确认执行、依赖调度、子 Job/Artifact、质量复核阻断、定向返工和用量审计均已交付并通过核心回归。
>
> WF8 后续增强项（不阻塞闭环验收）：根据复核文本自动识别受影响 Task；长输出完整 Artifact 与更全面的最小交付完整性校验；按模型价格表进行可选的预算预估/硬性阻断。

## 11. API 草案

```text
GET    /api/session/<sid>/workflows
POST   /api/session/<sid>/workflows
GET    /api/session/<sid>/workflows/<workflow_id>
PUT    /api/session/<sid>/workflows/<workflow_id>/draft
POST   /api/session/<sid>/workflows/<workflow_id>/validate
POST   /api/session/<sid>/workflows/<workflow_id>/publish

POST   /api/session/<sid>/workflow-runs
GET    /api/session/<sid>/workflow-runs
GET    /api/session/<sid>/workflow-runs/<run_id>
POST   /api/session/<sid>/workflow-runs/<run_id>/cancel
POST   /api/session/<sid>/workflow-runs/<run_id>/resume
POST   /api/session/<sid>/workflow-runs/<run_id>/nodes/<node_run_id>/retry

GET    /api/session/<sid>/workflow-runs/<run_id>/approvals
POST   /api/session/<sid>/workflow-runs/<run_id>/approvals/<approval_id>/decide

GET    /api/session/<sid>/workflow-runs/<run_id>/artifacts
GET    /api/session/<sid>/workflow-runs/<run_id>/lineage
```

写操作要求：

- 校验 Session 与固定 Workspace ID。
- 使用请求幂等键或服务端 operation key。
- 返回当前资源版本，避免前端基于过期状态覆盖。
- 审批、取消、重试和发布必须记录操作者与时间。

## 12. 可靠性与恢复

### 12.1 幂等键

建议：

```text
dispatch:{run_id}:{node_id}:{iteration}:{attempt}
approval:{approval_id}:{decision_version}
advance:{run_id}:{source_node_run_id}:{edge_id}
artifact:{node_run_id}:{logical_output_name}:{content_hash}
```

数据库使用唯一约束兜底，不只依赖进程内锁。

### 12.2 重启恢复

应用启动后执行恢复扫描：

1. `queued/running` 且 Job 不存在的 NodeRun 标记为 `interrupted` 或 `failed_recoverable`。
2. 已有成功 Job 但 NodeRun 仍为 `running` 时，从 Job 结果恢复输出登记。
3. `output_ready` 节点重新执行幂等推进。
4. 待审批任务保持 `pending`。
5. Run 根据全部节点和审批事实重新计算状态。

首期不尝试恢复模型的内存中间推理。恢复边界是“节点”，节点内失败从已保存输入重新执行。

### 12.3 终态判断

Run 成功不能只看某个终点节点。只有同时满足以下条件才可成功：

- 没有 `pending/ready/queued/running/output_ready` NodeRun。
- 没有必须处理的 `pending` Approval Task。
- 没有未关闭的必需分支。
- 所有声明的 Workflow 输出均存在。

## 13. 权限与安全

1. Agent Profile 明确工具白名单和 Workspace 权限。
2. Workflow 发布时校验节点声明权限，运行时再次执行后端 guard。
3. 下游 Agent 只获得契约要求的 Artifact 和数据访问能力。
4. 审批中的人工修改仍通过 Workspace 文件鉴权和 FileHistory。
5. 外部 MCP、Webhook、命令 Hook 和覆盖已有 Artifact 默认需要人工确认。
6. Run、Artifact 和审批 API 必须校验 Workspace 归属，不能只依赖 Session ID。
7. 团队看板不存储或展示模型隐藏推理。
8. Workflow JSON 不允许嵌入任意脚本。

## 14. 测试策略

### 14.1 单元测试

- 图校验、入口发现、不可达节点和环检测。
- 每个状态转换的允许与拒绝路径。
- 汇合策略、迭代上限和终态判断。
- 幂等派发、重复审批和重复 Artifact 登记。
- Workspace 隔离和权限拒绝。

### 14.2 集成测试

- Run 创建到并行 NodeRun 派发。
- Job 成功后 Artifact 登记和下游启动。
- 审批通过、人工修改、驳回重做和终止。
- Run 取消对子 Job 的传播。
- 重启后的 `output_ready` 恢复推进。
- 旧 Workflow 版本运行时发布新版本，旧 Run 不漂移。

### 14.3 故障注入

- Job 已成功但 NodeRun 状态写入失败。
- Artifact 文件已写入但 Manifest 事务失败。
- 审批请求响应丢失后客户端重试。
- Scheduler 同一 Run 并发推进。
- 应用在汇合、审批和回流节点前后重启。
- `output_ready` 节点已保存输出、下游仅部分派发时应用重启，恢复不得重复派发已启动分支。
- Workspace 切换、卸载和清理时仍有活跃 Run。

### 14.4 前端测试

- Run 时间线事件乱序和重复事件幂等。
- 待审批数量与详情同步。
- 长名称、长错误和多 Artifact 不溢出。
- 桌面、平板和手机视口视觉回归。
- SSE 中断后轮询补发。

### 14.5 回归门禁

每阶段至少执行：

```text
python -m unittest discover -s Test -p "test_*.py" -v
ruff check .
pnpm quality
```

涉及前端交互的阶段还需使用 Playwright 验证真实页面。

## 15. 度量指标

### 15.1 可靠性

- Run 成功率。
- 节点非业务失败率。
- 重启后可恢复率。
- 重复派发和重复 Artifact 数量，目标为 0。
- SSE 补发后状态一致率。

### 15.2 质量

- 人工一次通过率。
- 节点驳回率和平均修订轮次。
- 复核发现的指标或 SQL 错误数量。
- 最终产物可追溯覆盖率。

### 15.3 效率

- 端到端运行耗时。
- Agent 执行时间与人工等待时间占比。
- 并行节点带来的耗时下降。
- 单 Run Token、模型和工具成本。

### 15.4 复用

- Workflow 模板复用次数。
- Artifact 被后续运行引用次数。
- 知识候选采纳率。
- 相同场景人工修改量的变化趋势。

## 16. 发布策略

1. 使用 Feature Flag，默认不改变现有聊天行为。
2. 首期只内置一个经营分析 Workflow。
3. 先向开发环境和少量真实 Workspace 开放。
4. 每个阶段保持旧 Teams、Tasks 和 Job API 可用。
5. 新 UI 稳定前，保留通过 API 查看和恢复 Run 的能力。
6. 真实运行达到可靠性门槛后，再开放自定义 Workflow。
7. 动态协作模式必须单独启用，并配置时间、节点和 Token 预算。

建议首个正式开放门槛：

- 连续 30 次测试 Run 无重复派发。
- 审批重试和应用重启场景全部通过。
- 最终 Artifact 血缘完整率达到 100%。
- 首个业务场景成功率达到 95% 以上（分母定义：排除用户主动取消与人工驳回终止后，因平台调度、恢复或数据访问原因导致的非业务失败；即“成功率”仅衡量平台可靠性，不含业务结论对错）。
- 无跨 Workspace 数据访问问题。

## 17. 风险与控制

| 风险 | 影响 | 控制措施 |
|---|---|---|
| 同时维护 Task、Job、NodeRun 导致状态冲突 | 难以判断真实状态 | NodeRun 管流程状态，Job 管执行状态，Task Board 不参与调度 |
| Agent 输出不符合契约 | 下游无法消费 | 结构化输出校验、失败可读、允许有限修复 |
| 循环返工失控 | 成本和时间不可控 | 最大 iteration、Run 预算、超限转人工 |
| Artifact 过多造成存储增长 | Workspace 膨胀 | 引用保护、可审计清理、保留策略 |
| Workflow UI 过早复杂化 | 开发成本高、用户难用 | 首期固定模板和表单，图编辑器后置 |
| 动态协作不可预测 | 审计和恢复困难 | 在 Workflow 稳定后再做，所有委派仍绑定 Job/Artifact |
| 知识库被低质量结果污染 | 后续分析持续出错 | 只生成候选，人工确认后入库 |
| 模型或工具升级导致结果漂移 | 历史不可复现 | Run 保存模型、工具 schema、Workflow 和数据快照版本 |

## 18. 推荐优先级

```text
P0  WF0 四项前置决策：状态真相源、稳定 Agent Profile、调度触发机制、并发模型
P0  垂直最小闭环（2-3 周）：单一线性流程 + 2 个 Agent 节点 + 1 个审批节点，
    仅验证确定性调度、幂等推进与重启恢复，暂不做并行/血缘/UI
P0  Workflow 数据模型、版本发布、确定性调度、幂等恢复
P0  Artifact Manifest、消费血缘、通用人工审批
P1  经营分析报告端到端场景和运行界面
P1  Workflow as Skill、模板和知识候选
P2  团队看板和流程优化建议
P3  动态 Lead Agent 协作模式
```

垂直最小闭环是全量推进的前置：它以最小成本验证本方案最贵、最不确定的假设（确定性调度 + 幂等恢复）。闭环跑通并通过重启/重复推进故障注入后，再决定是否按原节奏铺开 WF2-WF7。

判断是否进入下一优先级时，以真实 Run 的可靠性和复盘质量为准，不以新增 Agent 数量或演示
效果为准。

## 19. 最终验收标准

本规划完成后，系统应能稳定完成以下流程：

1. 用户从聊天或场景列表启动一个已发布的经营分析 Workflow。
2. Run 固定绑定 Workspace、流程版本和数据快照。
3. 多个分析 Agent 按图并行运行，并交付结构化 Artifact。
4. 复核 Agent 使用明确材料独立验证指标和结论。
5. 人在审批任务中批准、修改、驳回重做或终止。
6. 调度器根据人的决定幂等推进，不由 Agent 自行改变流程。
7. 页面刷新、SSE 断线或应用重启后，Run 仍可查看和继续。
8. 最终报告能够追溯到输入数据、SQL、节点、Agent、审批和 Artifact 版本。
9. 成功 Run 可以保存为模板，并生成待确认的知识沉淀候选。
10. 团队看板能够展示成功率、耗时、返工、成本和复用情况。

达到以上标准后，项目才从“支持多个 Agent 的分析助手”升级为“可交付真实业务任务的 AI
分析团队工作平台”。

## 20. 开发结束说明

本轮 AI 团队协作与 Workflow 优化开发于 2026-07-16 结束。WF0-WF8 的计划闭环已交付：Workflow 发布与调度、审批与 Artifact 血缘、模板/知识候选、运行看板，以及动态计划创建、依赖执行、质量复核、审计与定向返工。

以下事项保留为后续增强，不阻塞本轮结束：模型价格表与硬预算、复核文本自动定位返工节点、长输出完整 Artifact、SSE/Playwright 可靠性验收、模板和指标看板的运营增强。

验证记录：核心团队、工具、Job 和前端面板回归 86 项通过，聊天前端构建通过。全量 unittest discover 在 124 秒超时且未输出断言失败栈，后续如恢复开发应优先定位该慢集成测试。

