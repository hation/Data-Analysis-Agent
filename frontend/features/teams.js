// Teams panel for session-scoped analyst teams and communication history.
import { state } from "../core/runtime.js";
import { renderMd } from "../legacy/markdown.js";
import { open as openJobHistory } from "../legacy/job_history.js";

  const Vue = window.Vue;
  const root = document.getElementById("teams-panel-root");
  const hasVue = root && Vue && Vue.h && Vue.render;
  const local = {
    loading: false,
    error: "",
    teams: [],
    selected: "",
    selectedParticipant: "leader",
    team: null,
    teamPlans: [],
    teamPlanActing: "",
    isOpen: false,
    pollTimer: null,
    clearing: false,
    deleting: "",
    activeView: "teams",
    workflowsLoading: false,
    workflowsError: "",
    workflowMetrics: null,
    workflowSuggestions: [],
    workflowMetricsLoading: false,
    workflowCreatingDraft: "",
    workflows: [],
    runs: [],
    selectedRun: "",
    runDetail: null,
    workflowInputs: {},
    workflowExpanded: {},
    workflowStarting: "",
    workflowDeleting: "",
    workflowRunDeleting: "",
    workflowCanceling: "",
    workflowResuming: "",
    workflowRetrying: "",
    workflowSavingTemplate: "",
    workflowGeneratingCandidates: "",
    workflowCandidateDeciding: "",
    workflowApproving: "",
    workflowApprovalForms: {},
    workflowCreating: false,
    workflowCreateOpen: false,
    workflowCreate: {
      name: "经营分析 Workflow",
      description: "自动检查数据、分析关键指标、复核发现并生成报告。",
      mode: "full_auto",
      sourceKey: "source_snapshot",
    },
  };

  function formatTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
  }

  function statusLabel(status) {
    const map = {
      idle: "空闲",
      queued: "待处理",
      running: "运行中",
      completed: "已完成",
      failed: "失败",
    };
    return map[status] || status || "未知";
  }

  function memberStatusClass(status) {
    return `team-status team-status-${status || "unknown"}`;
  }

  function participantLabel(id) {
    if (id === "leader" || id === "lead") return "Leader";
    return id || "成员";
  }

  function isLeaderId(id) {
    return id === "leader" || id === "lead";
  }

  function renderMarkdown(text) {
    return renderMd(text || "");
  }

  function workflowStatusLabel(status) {
    const map = {
      created: "已创建",
      running: "运行中",
      waiting_approval: "待审批",
      paused: "已暂停",
      canceling: "取消中",
      canceled: "已取消",
      succeeded: "已成功",
      failed: "失败",
      pending: "待处理",
      ready: "就绪",
      queued: "排队中",
      output_ready: "产出就绪",
      skipped: "已跳过",
    };
    return map[status] || status || "未知";
  }

  function workflowStatusClass(status) {
    return `workflow-status workflow-status-${status || "unknown"}`;
  }

  function workflowEdgeLabel(type) {
    const map = {
      auto: "自动",
      approval: "审批",
      retry_loop: "返工",
    };
    return map[type] || type || "边";
  }

  function workflowEdgeClass(type) {
    return `workflow-dag-edge-chip workflow-dag-edge-${type || "auto"}`;
  }

  function latestNodeRunsById(nodes) {
    const result = new Map();
    for (const node of nodes || []) {
      const id = node?.node_id || "";
      if (!id) continue;
      const current = result.get(id);
      const score = (Number(node.iteration) || 1) * 1000 + (Number(node.attempt) || 1);
      const currentScore = current
        ? (Number(current.iteration) || 1) * 1000 + (Number(current.attempt) || 1)
        : -1;
      if (!current || score >= currentScore) result.set(id, node);
    }
    return result;
  }

  function workflowDagLevels(graph) {
    const nodes = graph?.nodes || [];
    const levels = new Map(nodes.map(node => [String(node.node_id || ""), 0]));
    const entryIds = new Set((graph?.entry_node_ids || []).map(String));
    entryIds.forEach(id => levels.set(id, 0));
    const forwardEdges = (graph?.edges || []).filter(edge => edge.type !== "retry_loop");
    for (let pass = 0; pass < nodes.length + 1; pass += 1) {
      let changed = false;
      for (const edge of forwardEdges) {
        const from = String(edge.from_node || "");
        const to = String(edge.to_node || "");
        if (!from || !to || !levels.has(to)) continue;
        const nextLevel = (levels.get(from) || 0) + 1;
        if (nextLevel > (levels.get(to) || 0)) {
          levels.set(to, nextLevel);
          changed = true;
        }
      }
      if (!changed) break;
    }
    return levels;
  }

  function isPendingApprovalNode(detail, nodeId) {
    return (detail?.approvals || []).some(
      approval => approval.status === "pending" && approval.node_id === nodeId,
    );
  }

  function isRetryTarget(graph, nodeId) {
    return (graph?.edges || []).some(
      edge => edge.type === "retry_loop" && edge.to_node === nodeId,
    );
  }

  function isWorkflowActive(status) {
    return ["created", "running", "waiting_approval", "paused", "canceling"].includes(status);
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function fetchTeams() {
    return fetchJson(`/api/session/${state.SID}/teams`);
  }

  async function fetchTeamPlans(teamName = "") {
    const query = teamName ? `?team_name=${encodeURIComponent(teamName)}` : "";
    return fetchJson(`/api/session/${state.SID}/team-plans${query}`);
  }

  async function fetchTeam(name) {
    return fetchJson(`/api/session/${state.SID}/teams/${encodeURIComponent(name)}`);
  }

  async function fetchWorkflows() {
    return fetchJson(`/api/session/${state.SID}/workflows`);
  }

  async function fetchWorkflowRuns() {
    return fetchJson(`/api/session/${state.SID}/workflow-runs`);
  }

  async function fetchWorkflowMetrics() {
    return fetchJson(`/api/session/${state.SID}/workflow-metrics`);
  }

  async function fetchWorkflowRun(runId) {
    return fetchJson(`/api/session/${state.SID}/workflow-runs/${encodeURIComponent(runId)}`);
  }

  async function createAgentProfile(profile) {
    return fetchJson(`/api/session/${state.SID}/agent-profiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });
  }

  async function createWorkflowDraft(payload) {
    return fetchJson(`/api/session/${state.SID}/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async function validateWorkflow(workflowId) {
    return fetchJson(`/api/session/${state.SID}/workflows/${encodeURIComponent(workflowId)}/validate`, {
      method: "POST",
    });
  }

  async function publishWorkflow(workflowId) {
    return fetchJson(`/api/session/${state.SID}/workflows/${encodeURIComponent(workflowId)}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ published_by: "teams_panel" }),
    });
  }

  function workflowModeLabel(mode) {
    const map = {
      full_auto: "全自动",
      key_approval: "关键审批",
      exception_review: "异常复核",
    };
    return map[mode] || mode || "全自动";
  }

  function normalizedWorkflowCreate() {
    const form = local.workflowCreate || {};
    const sourceKey = String(form.sourceKey || "source_snapshot").trim() || "source_snapshot";
    return {
      name: String(form.name || "经营分析 Workflow").trim() || "经营分析 Workflow",
      description: String(form.description || "").trim(),
      mode: ["full_auto", "key_approval", "exception_review"].includes(form.mode)
        ? form.mode
        : "full_auto",
      sourceKey,
    };
  }

  function updateWorkflowCreate(key, value) {
    local.workflowCreate = {
      ...local.workflowCreate,
      [key]: value,
    };
  }

  function getApprovalForm(approval) {
    const id = approval?.id || "";
    if (!id) return { comment: "", revisedSummary: "", revisedOutputs: "{}" };
    if (!local.workflowApprovalForms[id]) {
      local.workflowApprovalForms[id] = {
        comment: "",
        revisedSummary: "",
        revisedOutputs: "{}",
        revisionFields: [],
        seededManifestId: "",
      };
    }
    return local.workflowApprovalForms[id];
  }

  function updateApprovalForm(approval, key, value) {
    const id = approval?.id || "";
    if (!id) return;
    local.workflowApprovalForms[id] = {
      ...getApprovalForm(approval),
      [key]: value,
    };
  }

  function manifestItemName(item) {
    return String(item?.logical_name || item?.name || item?.artifact_id || "");
  }

  function manifestItemEditableValue(item) {
    if (!item) return "";
    const value = Object.prototype.hasOwnProperty.call(item, "data")
      ? item.data
      : item.data_preview || item.uri || "";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value ?? "");
    }
  }

  function parseEditableValue(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    try {
      return JSON.parse(raw);
    } catch {
      return String(value ?? "");
    }
  }

  function revisionFieldsToOutputs(fields) {
    const outputs = {};
    for (const field of fields || []) {
      const key = String(field.key || "").trim();
      if (!key) continue;
      outputs[key] = parseEditableValue(field.value);
    }
    return outputs;
  }

  function approvalManifest(detail, approval) {
    const manifestId = approval?.artifact_manifest_id || "";
    if (!manifestId) return null;
    return (detail?.manifests || []).find(manifest => manifest.id === manifestId) || null;
  }

  function seedApprovalRevisionFields(approval, manifest, force = false) {
    const form = getApprovalForm(approval);
    if (!manifest || (!force && (form.seededManifestId === manifest.id || form.revisionFields.length))) return;
    const revisionFields = (manifest.items || []).map(item => ({
      key: manifestItemName(item),
      value: manifestItemEditableValue(item),
      source: item.artifact_id || item.uri || "",
    })).filter(field => field.key);
    local.workflowApprovalForms[approval.id] = {
      ...form,
      revisionFields,
      seededManifestId: manifest.id,
      revisedOutputs: JSON.stringify(revisionFieldsToOutputs(revisionFields), null, 2),
    };
  }

  function updateApprovalRevisionField(approval, index, key, value) {
    const form = getApprovalForm(approval);
    const revisionFields = [...(form.revisionFields || [])];
    if (!revisionFields[index]) return;
    revisionFields[index] = {
      ...revisionFields[index],
      [key]: value,
    };
    local.workflowApprovalForms[approval.id] = {
      ...form,
      revisionFields,
      revisedOutputs: JSON.stringify(revisionFieldsToOutputs(revisionFields), null, 2),
    };
  }

  function addApprovalRevisionField(approval) {
    const form = getApprovalForm(approval);
    const revisionFields = [...(form.revisionFields || []), { key: "", value: "", source: "manual" }];
    local.workflowApprovalForms[approval.id] = {
      ...form,
      revisionFields,
      revisedOutputs: JSON.stringify(revisionFieldsToOutputs(revisionFields), null, 2),
    };
  }

  function removeApprovalRevisionField(approval, index) {
    const form = getApprovalForm(approval);
    const revisionFields = (form.revisionFields || []).filter((_, itemIndex) => itemIndex !== index);
    local.workflowApprovalForms[approval.id] = {
      ...form,
      revisionFields,
      revisedOutputs: JSON.stringify(revisionFieldsToOutputs(revisionFields), null, 2),
    };
  }

  function buildApprovalDecisionPayload(approval, decision) {
    const form = getApprovalForm(approval);
    const comment = String(form.comment || "").trim();
    const revisedSummary = String(form.revisedSummary || "").trim();
    const payload = {
      decision,
      decided_by: "teams_panel",
    };
    const comments = {};
    if (comment) {
      payload.comment = comment;
      comments.review_note = comment;
    }
    if (revisedSummary) comments.revised_summary = revisedSummary;
    if (decision === "approve_with_changes") {
      const raw = String(form.revisedOutputs || "").trim();
      let revisedOutputs = {};
      try {
        revisedOutputs = raw ? JSON.parse(raw) : {};
      } catch (error) {
        throw new Error(`修订输出 JSON 无效：${error.message || error}`);
      }
      if (!revisedOutputs || typeof revisedOutputs !== "object" || Array.isArray(revisedOutputs)) {
        throw new Error("修订输出必须是 JSON object");
      }
      payload.revised_outputs = revisedOutputs;
      payload.revised_summary = revisedSummary || "团队面板人工修订";
      comments.revised_summary = payload.revised_summary;
    }
    if (Object.keys(comments).length) payload.comments = comments;
    return payload;
  }

  function buildWorkflowTemplate(profileIds, form) {
    const approvalEdgeType = form.mode === "key_approval" ? "approval" : "auto";
    return {
      run_policy: { mode: form.mode },
      entry_node_ids: ["inspect_data"],
      nodes: [
        {
          node_id: "inspect_data",
          type: "agent",
          agent_profile_id: profileIds.inspect,
          input_contract: [form.sourceKey],
          output_contract: ["data_quality_report", "metric_scope"],
        },
        {
          node_id: "analyze_metrics",
          type: "agent",
          agent_profile_id: profileIds.metrics,
          input_contract: ["metric_scope"],
          output_contract: ["metric_analysis"],
        },
        {
          node_id: "analyze_anomalies",
          type: "agent",
          agent_profile_id: profileIds.anomalies,
          input_contract: ["metric_scope"],
          output_contract: ["anomaly_analysis"],
        },
        {
          node_id: "verify_findings",
          type: "agent",
          agent_profile_id: profileIds.reviewer,
          join_policy: "all_success",
          input_contract: ["metric_analysis", "anomaly_analysis"],
          output_contract: ["verification_report"],
        },
        {
          node_id: "generate_report",
          type: "agent",
          agent_profile_id: profileIds.reporter,
          input_contract: ["verification_report"],
          output_contract: ["operating_report"],
        },
      ],
      edges: [
        { edge_id: "inspect-to-metrics", from_node: "inspect_data", to_node: "analyze_metrics", type: "auto" },
        { edge_id: "inspect-to-anomalies", from_node: "inspect_data", to_node: "analyze_anomalies", type: "auto" },
        { edge_id: "metrics-to-verify", from_node: "analyze_metrics", to_node: "verify_findings", type: "auto" },
        { edge_id: "anomalies-to-verify", from_node: "analyze_anomalies", to_node: "verify_findings", type: "auto" },
        { edge_id: "verify-to-report", from_node: "verify_findings", to_node: "generate_report", type: approvalEdgeType },
        { edge_id: "verify-retry", from_node: "verify_findings", to_node: "analyze_metrics", type: "retry_loop", max_iterations: 2 },
      ],
      limits: {
        max_run_minutes: 120,
        max_total_node_runs: 30,
      },
    };
  }

  async function createWorkflowFromTemplate() {
    if (local.workflowCreating) return;
    const form = normalizedWorkflowCreate();
    local.workflowCreating = true;
    local.workflowsError = "";
    renderPanel();
    try {
      const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const baseTools = ["get_schema", "query_data", "read_tool_result"];
      const specs = [
        ["inspect", "数据检查员", "data_inspector", "识别数据表、字段质量、可用指标范围，输出 data_quality_report 与 metric_scope。", baseTools],
        ["metrics", "指标分析师", "metric_analyst", "围绕业务目标执行 SQL/指标分析，输出 metric_analysis。", baseTools],
        ["anomalies", "异常分析师", "anomaly_analyst", "发现波动、异常与可解释原因，输出 anomaly_analysis。", baseTools],
        ["reviewer", "结论复核员", "finding_reviewer", "交叉检查指标分析与异常分析，输出 verification_report。", ["read_tool_result"]],
        ["reporter", "报告编辑", "report_editor", "把复核后的发现整理成可读经营报告，输出 operating_report。", ["read_tool_result"]],
      ];
      const profileIds = {};
      for (const [id, name, role, instructions, allowedTools] of specs) {
        const result = await createAgentProfile({
          key: `workflow_${id}_${suffix}`,
          name,
          role,
          instructions,
          allowed_tools: allowedTools,
          model_policy: "inherit",
          created_by: "teams_panel",
        });
        profileIds[id] = result.profile?.id;
      }
      const workflow = await createWorkflowDraft({
        name: form.name,
        description: form.description || `${workflowModeLabel(form.mode)}模式的团队分析模板`,
        graph: buildWorkflowTemplate(profileIds, form),
        input_schema: {
          type: "object",
          properties: {
            [form.sourceKey]: { type: "string" },
          },
          required: [form.sourceKey],
        },
        output_schema: {
          type: "object",
          properties: {
            operating_report: { type: "string" },
          },
          required: ["operating_report"],
        },
        created_by: "teams_panel",
      });
      const workflowId = workflow.workflow?.id;
      await validateWorkflow(workflowId);
      const published = await publishWorkflow(workflowId);
      local.workflowInputs[workflowId] = JSON.stringify({ [form.sourceKey]: "当前工作区数据" }, null, 2);
      local.selectedRun = "";
      local.runDetail = null;
      await refreshWorkflows({ silent: true, keepSelection: true });
      local.workflowCreateOpen = false;
      window.BAA.ui?.toast?.(`Workflow 已创建并发布 v${String(published.version?.id || "").slice(-6)}`, "ok");
    } catch (error) {
      local.workflowsError = String(error.message || error);
      window.BAA.ui?.toast?.(local.workflowsError, "err");
    } finally {
      local.workflowCreating = false;
      renderPanel();
    }
  }

  async function cancelWorkflowRun(runId) {
    if (!runId || local.workflowCanceling) return;
    local.workflowCanceling = runId;
    local.workflowsError = "";
    renderPanel();
    try {
      const detail = await fetchJson(
        `/api/session/${state.SID}/workflow-runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST" },
      );
      local.runDetail = detail;
      await refreshWorkflows({ silent: true, keepSelection: true });
      window.BAA.ui?.toast?.("Workflow Run 已取消", "ok");
    } catch (error) {
      local.workflowsError = String(error.message || error);
      window.BAA.ui?.toast?.(local.workflowsError, "err");
    } finally {
      local.workflowCanceling = "";
      renderPanel();
    }
  }

  async function resumeWorkflowRun(runId) {
    if (!runId || local.workflowResuming) return;
    local.workflowResuming = runId;
    local.workflowsError = "";
    renderPanel();
    try {
      const detail = await fetchJson(
        `/api/session/${state.SID}/workflow-runs/${encodeURIComponent(runId)}/resume`,
        { method: "POST" },
      );
      local.runDetail = detail;
      await refreshWorkflows({ silent: true, keepSelection: true });
      window.BAA.ui?.toast?.("Workflow Run 已恢复", "ok");
    } catch (error) {
      local.workflowsError = String(error.message || error);
      window.BAA.ui?.toast?.(local.workflowsError, "err");
    } finally {
      local.workflowResuming = "";
      renderPanel();
    }
  }

  async function retryWorkflowNode(node) {
    const runId = local.runDetail?.run?.id || "";
    if (!runId || !node?.id || local.workflowRetrying) return;
    local.workflowRetrying = node.id;
    local.workflowsError = "";
    renderPanel();
    try {
      const detail = await fetchJson(
        `/api/session/${state.SID}/workflow-runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(node.id)}/retry`,
        { method: "POST" },
      );
      local.runDetail = detail;
      await refreshWorkflows({ silent: true, keepSelection: true });
      window.BAA.ui?.toast?.(`${node.node_id || "节点"}已重新派发`, "ok");
    } catch (error) {
      local.workflowsError = String(error.message || error);
      window.BAA.ui?.toast?.(local.workflowsError, "err");
    } finally {
      local.workflowRetrying = "";
      renderPanel();
    }
  }

  async function openWorkflowJob(jobId) {
    if (!jobId) return;
    closePanelState();
    await openJobHistory(jobId);
  }

  async function saveWorkflowTemplate(run) {
    if (!run?.id || local.workflowSavingTemplate) return;
    local.workflowSavingTemplate = run.id;
    local.workflowsError = "";
    renderPanel();
    try {
      await fetchJson(
        `/api/session/${state.SID}/workflow-runs/${encodeURIComponent(run.id)}/template`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `${workflowForRun(run)?.name || "Workflow"} 成功模板`,
            created_by: "teams_panel",
          }),
        },
      );
      local.runDetail = await fetchWorkflowRun(run.id);
      window.BAA.ui?.toast?.("成功 Run 已保存为模板", "ok");
    } catch (error) {
      local.workflowsError = String(error.message || error);
      window.BAA.ui?.toast?.(local.workflowsError, "err");
    } finally {
      local.workflowSavingTemplate = "";
      renderPanel();
    }
  }

  function focusWorkflowKnowledgeCandidates() {
    requestAnimationFrame(() => {
      document.querySelector(".workflow-knowledge-candidates")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }

  async function generateWorkflowKnowledgeCandidates(run) {
    if (!run?.id || local.workflowGeneratingCandidates) return;
    local.workflowGeneratingCandidates = run.id;
    local.workflowsError = "";
    renderPanel();
    try {
      await fetchJson(
        `/api/session/${state.SID}/workflow-runs/${encodeURIComponent(run.id)}/knowledge-candidates`,
        { method: "POST" },
      );
      local.runDetail = await fetchWorkflowRun(run.id);
      focusWorkflowKnowledgeCandidates();
      window.BAA.ui?.toast?.("入库候选已生成，请在详情顶部接受或拒绝", "ok");
    } catch (error) {
      local.workflowsError = String(error.message || error);
      window.BAA.ui?.toast?.(local.workflowsError, "err");
    } finally {
      local.workflowGeneratingCandidates = "";
      renderPanel();
    }
  }

  async function decideWorkflowKnowledgeCandidate(candidate, decision) {
    if (!candidate?.id || local.workflowCandidateDeciding) return;
    local.workflowCandidateDeciding = candidate.id;
    local.workflowsError = "";
    renderPanel();
    try {
      await fetchJson(
        `/api/session/${state.SID}/workflow-knowledge-candidates/${encodeURIComponent(candidate.id)}/decide`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision, decided_by: "teams_panel" }),
        },
      );
      local.runDetail = await fetchWorkflowRun(candidate.run_id);
      window.BAA.ui?.toast?.(
        decision === "accept" ? "候选已写入业务知识库" : "候选已拒绝",
        "ok",
      );
    } catch (error) {
      local.workflowsError = String(error.message || error);
      window.BAA.ui?.toast?.(local.workflowsError, "err");
    } finally {
      local.workflowCandidateDeciding = "";
      renderPanel();
    }
  }

  async function publishSavedWorkflowDraft(workflow) {
    if (!workflow?.id || local.workflowCreating) return;
    local.workflowCreating = true;
    renderPanel();
    try {
      await validateWorkflow(workflow.id);
      await publishWorkflow(workflow.id);
      await refreshWorkflows({ silent: true, keepSelection: true });
      await window.BAA.skills?.loadSkills?.();
      window.BAA.ui?.toast?.("Workflow 草稿已发布", "ok");
    } catch (error) {
      local.workflowsError = String(error.message || error);
      window.BAA.ui?.toast?.(local.workflowsError, "err");
    } finally {
      local.workflowCreating = false;
      renderPanel();
    }
  }

  async function createWorkflowOptimizationDraft(suggestion) {
    if (!suggestion?.id || local.workflowCreatingDraft) return;
    local.workflowCreatingDraft = suggestion.id;
    local.workflowsError = "";
    renderPanel();
    try {
      const result = await fetchJson(
        `/api/session/${state.SID}/workflow-optimization-suggestions/${encodeURIComponent(suggestion.id)}/draft`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ created_by: "teams_panel" }),
        },
      );
      await refreshWorkflows({ silent: true, keepSelection: true });
      window.BAA.ui?.toast?.(
        `已创建「${result.workflow?.name || "优化草稿"}」，发布前请人工检查`,
        "ok",
      );
    } catch (error) {
      local.workflowsError = String(error.message || error);
      window.BAA.ui?.toast?.(local.workflowsError, "err");
    } finally {
      local.workflowCreatingDraft = "";
      renderPanel();
    }
  }

  async function startWorkflow(workflow) {
    if (!workflow?.current_version_id || local.workflowStarting) return;
    let inputs = {};
    const raw = String(local.workflowInputs[workflow.id] || "{}").trim();
    try {
      inputs = raw ? JSON.parse(raw) : {};
      if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
        throw new Error("输入必须是 JSON object");
      }
    } catch (error) {
      local.workflowsError = `输入 JSON 无效：${error.message || error}`;
      renderPanel();
      return;
    }

    local.workflowStarting = workflow.id;
    local.workflowsError = "";
    renderPanel();
    try {
      const detail = await fetchJson(`/api/session/${state.SID}/workflow-runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow_version_id: workflow.current_version_id,
          inputs,
          started_by: "teams_panel",
        }),
      });
      local.selectedRun = detail.run?.id || "";
      local.runDetail = detail;
      await refreshWorkflows({ silent: true, keepSelection: true });
      window.BAA.ui?.toast?.("Workflow 已启动", "ok");
    } catch (error) {
      local.workflowsError = String(error.message || error);
    } finally {
      local.workflowStarting = "";
      renderPanel();
    }
  }

  async function deleteWorkflow(workflow) {
    if (!workflow?.id || local.workflowDeleting) return;
    const accepted = await window.BAA.ui?.confirm?.({
      danger: true,
      title: "永久删除 Workflow？",
      message: `将彻底删除「${workflow.name || workflow.id}」的全部版本、运行记录、节点、审批、事件、材料、关联 Job，以及未被其他流程复用的专属角色。原始数据源不会删除。此操作不可恢复。`,
      confirmText: "永久删除",
      cancelText: "取消",
    });
    if (!accepted) return;
    local.workflowDeleting = workflow.id;
    local.workflowsError = "";
    renderPanel();
    try {
      const result = await fetchJson(
        `/api/session/${state.SID}/workflows/${encodeURIComponent(workflow.id)}`,
        { method: "DELETE" },
      );
      delete local.workflowInputs[workflow.id];
      delete local.workflowExpanded[workflow.id];
      local.selectedRun = "";
      local.runDetail = null;
      await refreshWorkflows({ silent: true, keepSelection: false });
      const deletedRuns = result.deleted?.runs || 0;
      const deletedJobs = result.deleted?.jobs || 0;
      window.BAA.ui?.toast?.(
        `Workflow 已永久删除，同时清理 ${deletedRuns} 次运行和 ${deletedJobs} 个 Job`,
        "ok",
      );
    } catch (error) {
      local.workflowsError = String(error.message || error);
      window.BAA.ui?.toast?.(local.workflowsError, "err");
    } finally {
      local.workflowDeleting = "";
      renderPanel();
    }
  }

  function workflowForRun(run) {
    return local.workflows.find(
      workflow => workflow.current_version_id === run?.workflow_version_id
    ) || null;
  }

  async function deleteWorkflowRun(run) {
    if (!run?.id || local.workflowRunDeleting) return;
    const workflow = workflowForRun(run);
    const accepted = await window.BAA.ui?.confirm?.({
      danger: true,
      title: "永久删除运行记录？",
      message: `将彻底删除「${workflow?.name || run.id}」本次运行的节点输出、审批、事件、材料、Manifest 和关联 Job。Workflow 定义与原始数据源会保留。此操作不可恢复。`,
      confirmText: "永久删除",
      cancelText: "取消",
    });
    if (!accepted) return;
    local.workflowRunDeleting = run.id;
    local.workflowsError = "";
    renderPanel();
    try {
      const result = await fetchJson(
        `/api/session/${state.SID}/workflow-runs/${encodeURIComponent(run.id)}`,
        { method: "DELETE" },
      );
      if (local.selectedRun === run.id) {
        local.selectedRun = "";
        local.runDetail = null;
      }
      await refreshWorkflows({ silent: true, keepSelection: false });
      window.BAA.ui?.toast?.(
        `运行记录已永久删除，同时清理 ${result.deleted?.jobs || 0} 个 Job`,
        "ok",
      );
    } catch (error) {
      local.workflowsError = String(error.message || error);
      window.BAA.ui?.toast?.(local.workflowsError, "err");
    } finally {
      local.workflowRunDeleting = "";
      renderPanel();
    }
  }

  async function decideWorkflowApproval(approval, decision) {
    if (!approval?.id || !approval?.run_id || local.workflowApproving) return;
    let payload = {};
    try {
      payload = buildApprovalDecisionPayload(approval, decision);
    } catch (error) {
      local.workflowsError = String(error.message || error);
      renderPanel();
      return;
    }
    local.workflowApproving = approval.id;
    local.workflowsError = "";
    renderPanel();
    try {
      const detail = await fetchJson(
        `/api/session/${state.SID}/workflow-runs/${encodeURIComponent(approval.run_id)}/approvals/${encodeURIComponent(approval.id)}/decide`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      local.selectedRun = detail.run?.id || approval.run_id;
      local.runDetail = detail;
      delete local.workflowApprovalForms[approval.id];
      await refreshWorkflows({ silent: true, keepSelection: true });
      const label = {
        approve: "已批准",
        approve_with_changes: "已带修改批准",
        reject_and_retry: "已要求重做",
        reject_and_stop: "已驳回终止",
      }[decision] || "已处理";
      window.BAA.ui?.toast?.(`审批${label}`, "ok");
    } catch (error) {
      local.workflowsError = String(error.message || error);
      window.BAA.ui?.toast?.(local.workflowsError, "err");
    } finally {
      local.workflowApproving = "";
      renderPanel();
    }
  }

  async function clearTeamMessages(name) {
    if (!name || local.clearing) return;
    const accepted = await window.BAA.ui?.confirm?.({
      danger: true,
      title: "清空团队沟通记录？",
      message: `将永久清空团队「${name}」的全部沟通记录，但保留团队和成员。`,
      confirmText: "确认清空",
      cancelText: "取消",
    });
    if (!accepted) return;
    local.clearing = true;
    local.error = "";
    renderPanel();
    try {
      const result = await fetchJson(
        `/api/session/${state.SID}/teams/${encodeURIComponent(name)}/messages`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: true }),
        },
      );
      window.BAA.ui?.toast?.(`已清空 ${result.cleared_messages || 0} 条团队沟通记录`, "ok");
      await refresh({ silent: true });
    } catch (error) {
      local.error = String(error.message || error);
    } finally {
      local.clearing = false;
      renderPanel();
    }
  }

  function teamHasRunningMembers(team) {
    return (team?.members || []).some(
      member => member.status === "running" || member.status === "queued"
    );
  }

  function isEvidenceRetentionError(error) {
    return String(error?.message || error || "").includes("默认保留");
  }

  async function requestTeamDelete(name, force = false) {
    return fetchJson(
      `/api/session/${state.SID}/teams/${encodeURIComponent(name)}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, force }),
      },
    );
  }

  async function dissolveTeam(name) {
    if (!name || local.deleting) return;
    const team = local.teams.find(item => item.name === name);
    if (teamHasRunningMembers(team)) {
      window.BAA.ui?.toast?.("团队成员仍在执行或排队，暂不能解散", "err");
      return;
    }
    const accepted = await window.BAA.ui?.confirm?.({
      danger: true,
      title: "解散团队？",
      message: `将先检查团队「${name}」是否含有委派结果、错误或质量复核证据；如有证据会要求二次确认后才强制删除。`,
      confirmText: "继续检查",
      cancelText: "取消",
    });
    if (!accepted) return;
    local.deleting = name;
    local.error = "";
    renderPanel();
    try {
      try {
        await requestTeamDelete(name, false);
      } catch (error) {
        if (!isEvidenceRetentionError(error)) throw error;
        local.deleting = "";
        renderPanel();
        const forced = await window.BAA.ui?.confirm?.({
          danger: true,
          title: "团队含复盘证据，确认强制解散？",
          message: `团队「${name}」已有委派结果、错误或质量复核记录。建议先查看 team_status 复盘；若确认不再需要这些证据，可强制删除。`,
          confirmText: "强制解散",
          cancelText: "保留团队",
        });
        if (!forced) return;
        local.deleting = name;
        local.error = "";
        renderPanel();
        await requestTeamDelete(name, true);
      }
      if (local.selected === name) {
        local.selected = "";
        local.selectedParticipant = "leader";
        local.team = null;
      }
      window.BAA.ui?.toast?.(`团队「${name}」已解散`, "ok");
      await refresh({ silent: true });
    } catch (error) {
      local.error = String(error.message || error);
      window.BAA.ui?.toast?.(local.error, "err");
    } finally {
      local.deleting = "";
      renderPanel();
    }
  }

  function renderPlainFallback() {
    if (!root) return;
    root.textContent = local.error || "团队面板正在加载...";
  }

  function renderPanel() {
    if (!hasVue) {
      renderPlainFallback();
      return;
    }
    const { h, render } = Vue;

    function renderHeader() {
      return h("div", { class: "teams-head" }, [
        h("div", { class: "teams-title-block" }, [
          h("div", { class: "modal-title" }, "团队"),
          h("div", { class: "teams-sub" }, "查看成员协作、Workflow 运行状态和材料交接。"),
          h("div", { class: "team-tabs", role: "tablist", "aria-label": "团队协作视图" }, [
            h("button", {
              class: local.activeView === "teams" ? "team-tab active" : "team-tab",
              type: "button",
              role: "tab",
              "aria-selected": local.activeView === "teams" ? "true" : "false",
              onClick: () => switchView("teams"),
            }, "团队成员"),
            h("button", {
              class: local.activeView === "workflow" ? "team-tab active" : "team-tab",
              type: "button",
              role: "tab",
              "aria-selected": local.activeView === "workflow" ? "true" : "false",
              onClick: () => switchView("workflow"),
            }, "Workflow"),
          ]),
        ]),
        h("div", { class: "teams-actions" }, [
          h("button", {
            class: "btn-sm btn-sm-ghost",
            type: "button",
            disabled: local.loading || local.workflowsLoading,
            onClick: () => local.activeView === "workflow"
              ? refreshWorkflows({ keepSelection: true })
              : refresh(),
          }, "刷新"),
          h("button", {
            class: "teams-close",
            type: "button",
            title: "关闭",
            onClick: () => {
              closePanelState();
              window.BAA.overlay.closeOverlay("ov-teams");
            },
          }, "×"),
        ]),
      ]);
    }

    function renderTeamList() {
      if (!local.teams.length) {
        return h("div", { class: "teams-empty" }, local.error || "还没有团队。可以让 Agent 创建一个 team 来拆分分析任务。");
      }
      return h("div", { class: "teams-list" }, local.teams.map(team => h("div", {
        key: team.name,
        class: local.selected === team.name ? "team-card active" : "team-card",
      }, [
        h("button", {
          class: "team-card-select",
          type: "button",
          onClick: () => selectTeam(team.name),
        }, [
          h("div", { class: "team-card-main" }, [
            h("strong", null, team.name),
            h("span", null, team.description || "无描述"),
          ]),
          h("div", { class: "team-card-meta" }, [
            h("span", null, `${team.member_count || 0} 成员`),
            h("span", null, `${team.message_count || 0} 消息`),
          ]),
        ]),
        h("button", {
          class: "team-card-dissolve",
          type: "button",
          disabled: local.deleting === team.name || teamHasRunningMembers(team),
          title: teamHasRunningMembers(team)
            ? "团队成员仍在执行或排队，暂不能解散"
            : `解散团队「${team.name}」`,
          onClick: () => dissolveTeam(team.name),
        }, local.deleting === team.name ? "解散中…" : "解散团队"),
      ])));
    }

    function setParticipant(id) {
      local.selectedParticipant = id || "leader";
      renderPanel();
    }

    function renderToolEvents(message) {
      const events = Array.isArray(message.tool_events) ? message.tool_events : [];
      if (!events.length) return null;
      return h("details", { class: "team-tool-flow" }, [
        h("summary", null, `工具调用流程 (${events.length})`),
        h("div", { class: "team-tool-list" }, events.map((event, index) => h("div", {
          key: `${event.tool || "tool"}-${index}`,
          class: event.status === "error" ? "team-tool-item error" : "team-tool-item",
        }, [
          h("div", { class: "team-tool-head" }, [
            h("span", null, event.status === "error" ? "✕" : "✓"),
            h("strong", null, event.tool || "tool"),
            event.elapsed_seconds != null ? h("small", null, `${event.elapsed_seconds}s`) : null,
          ]),
          Object.keys(event.args || {}).length
            ? h("pre", { class: "team-tool-args" }, JSON.stringify(event.args, null, 2))
            : null,
          event.result
            ? h("div", {
                class: "team-tool-result team-markdown",
                innerHTML: renderMarkdown(String(event.result)),
              })
            : null,
        ]))),
      ]);
    }

    function renderLeaderCard() {
      const unread = local.team?.lead_unread_messages || 0;
      return h("button", {
        key: "leader",
        class: isLeaderId(local.selectedParticipant) ? "team-member team-member-select active" : "team-member team-member-select",
        type: "button",
        onClick: () => setParticipant("leader"),
      }, [
        h("div", { class: "team-member-top" }, [
          h("strong", null, "Leader"),
          h("span", { class: "team-status team-status-lead" }, "负责人"),
        ]),
        h("div", { class: "team-member-role" }, "Team Leader"),
        h("div", { class: "team-member-intro" }, "团队负责人，接收成员交付结果、错误和关键进展。"),
        unread
          ? h("div", { class: "team-member-unread" }, `未读 ${unread}`)
          : null,
      ]);
    }

    function renderMembers() {
      const members = local.team?.members || [];
      if (!members.length) {
        return h("div", { class: "team-members" }, [renderLeaderCard()]);
      }
      return h("div", { class: "team-members" }, [
        renderLeaderCard(),
        ...members.map(member => h("button", {
        key: member.name,
        class: local.selectedParticipant === member.name ? "team-member team-member-select active" : "team-member team-member-select",
        type: "button",
        onClick: () => setParticipant(member.name),
      }, [
        h("div", { class: "team-member-top" }, [
          h("strong", null, member.name),
          h("span", { class: memberStatusClass(member.status) }, statusLabel(member.status)),
        ]),
        h("div", { class: "team-member-role" }, member.role || member.agent_id || "analyst"),
        member.instructions
          ? h("div", {
              class: "team-member-intro team-markdown",
              innerHTML: renderMarkdown(member.instructions),
            })
          : null,
        member.unread_messages
          ? h("div", { class: "team-member-unread" }, `未读 ${member.unread_messages}`)
          : null,
        member.last_active_at
          ? h("div", { class: "team-member-time" }, formatTime(member.last_active_at))
          : null,
        ])),
      ]);
    }

    function renderMessages() {
      const selected = local.selectedParticipant || "leader";
      const messages = (local.team?.recent_messages || []).filter(message => {
        if (isLeaderId(selected)) return isLeaderId(message.recipient) || isLeaderId(message.sender);
        return message.sender === selected || message.recipient === selected;
      });
      if (!messages.length) {
        return h("div", { class: "teams-empty compact" }, `${participantLabel(selected)} 暂无响应`);
      }
      return h("div", { class: "team-messages" }, messages.slice().reverse().map(message => h("div", {
        key: message.id || `${message.sender}-${message.created_at}`,
        class: [
          "team-message",
          message.read ? "read" : "",
          message.message_type === "assignment" ? "team-message-assignment" : "",
          message.message_type === "error" ? "team-message-error" : "",
        ].filter(Boolean).join(" "),
      }, [
        h("div", { class: "team-message-head" }, [
          h("span", null, `${participantLabel(message.sender)} → ${participantLabel(message.recipient)}`),
          h("small", null, formatTime(message.created_at)),
        ]),
        renderToolEvents(message),
        h("div", {
          class: "team-message-body team-markdown",
          innerHTML: renderMarkdown(message.message || ""),
        }),
      ])));
    }

    async function controlTeamPlan(plan, action) {
      if (!plan?.id || local.teamPlanActing) return;
      local.teamPlanActing = `${plan.id}:${action}`;
      renderPanel();
      try {
        const suffix = action === "workflow-draft" ? "workflow-draft" : `actions/${action}`;
        const data = await fetchJson(
          `/api/session/${state.SID}/team-plans/${encodeURIComponent(plan.id)}/${suffix}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ created_by: "teams_panel" }) },
        );
        const plans = await fetchTeamPlans(local.selected);
        local.teamPlans = plans.plans || [];
        if (action === "workflow-draft") {
          await refreshWorkflows({ silent: true, keepSelection: true });
          window.BAA.ui?.toast?.(`已创建 Workflow 草稿：${data.workflow?.name || plan.id}`, "ok");
        }
      } catch (error) {
        local.error = String(error.message || error);
        window.BAA.ui?.toast?.(local.error, "err");
      } finally {
        local.teamPlanActing = "";
        renderPanel();
      }
    }

    function requestTeamPlanExecution(plan) {
      const input = document.getElementById("msg-input");
      if (!input || !plan?.id) return;
      input.value = `执行动态计划 ${plan.id}。仅执行该已创建计划，不要新建或重复任务。`;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      window.BAA.ui?.toast?.("已填入执行请求，发送后由 Lead 启动已确认计划", "ok");
    }

    function requestTeamPlanRevision(plan) {
      const input = document.getElementById("msg-input");
      if (!input || !plan?.id) return;
      input.value = `根据动态计划 ${plan.id} 的质量复核意见，选择受影响任务并调用 team_delegate 的 review_plan_id 与 review_task_ids 定向重跑；保留已通过且不受依赖影响的任务，不要保存为 Workflow 草稿。`;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      window.BAA.ui?.toast?.("已填入补全请求，发送后由 Lead 依据复核意见重新派发", "ok");
    }

    function requestTeamTaskRetry(plan, task) {
      const input = document.getElementById("msg-input");
      if (!input || !plan?.id || !task?.id) return;
      input.value = `重试动态计划 ${plan.id} 中失败的任务 ${task.id}。仅重试该任务，不要重复已成功任务。`;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      window.BAA.ui?.toast?.("已填入重试请求，发送后由 Lead 重新派发该任务", "ok");
    }

    function dynamicPlanBudgetText(plan) {
      const budget = plan?.budget || {};
      const inputTokens = Number(budget.input_tokens || 0);
      const outputTokens = Number(budget.output_tokens || 0);
      const toolCalls = Number(budget.tool_calls || 0);
      const jobs = Number(budget.child_job_count || 0);
      if (!inputTokens && !outputTokens && !toolCalls && !jobs) return "等待成员执行用量";
      return `输入 ${inputTokens.toLocaleString()} · 输出 ${outputTokens.toLocaleString()} · ${toolCalls} 次工具 · ${jobs} 个子 Job · 成本未配置`;
    }

    function renderDynamicPlans() {
      const plans = local.teamPlans || [];
      if (!plans.length) return h("div", { class: "teams-empty compact" }, "对话中触发团队并行委派后，动态任务计划会显示在这里。");
      return h("div", { class: "team-plan-list" }, plans.slice(0, 10).map(plan => h("article", { class: "team-plan", key: plan.id }, [
        h("div", { class: "team-plan-head" }, [
          h("div", null, [h("strong", null, plan.goal || plan.id), h("span", null, `${plan.tasks?.length || 0} 个任务 · ${formatTime(plan.created_at)}`)]),
          h("span", { class: `team-plan-status ${plan.status}` }, plan.status),
        ]),
        h("div", { class: "team-plan-budget" }, dynamicPlanBudgetText(plan)),
        plan.review_status === "blocked" ? h("div", { class: "team-plan-review-blocked" }, `质量复核待修正${plan.review_summary ? `：${plan.review_summary}` : ""}`) : null,
        h("div", { class: "team-plan-tasks" }, (plan.tasks || []).map(task => h("div", { class: "team-plan-task", key: task.id }, [
          h("span", { class: `team-plan-task-dot ${task.status}` }),
          h("div", null, [
            h("strong", null, task.title || task.id),
            h("small", null, `${task.member_name}${task.depends_on?.length ? ` · 依赖 ${task.depends_on.join(", ")}` : ""}`),
            task.error ? h("small", { class: "team-plan-task-error" }, task.error) : null,
          ]),
          task.job_id ? h("div", { class: "team-plan-task-links" }, [
            h("button", {
              class: "workflow-job-link",
              type: "button",
              title: "在 Job 历史中查看此动态任务与交付物",
              onClick: () => openWorkflowJob(task.job_id),
            }, `Job ${String(task.job_id).slice(-6)}`),
            task.artifacts?.length ? h("span", null, `${task.artifacts.length} 个交付物`) : null,
          ]) : h("span", null, task.status),
          task.status === "failed" ? h("button", {
            class: "btn-sm btn-sm-ghost",
            type: "button",
            onClick: () => requestTeamTaskRetry(plan, task),
          }, "在对话中重试") : null,
        ]))),
        h("div", { class: "team-plan-actions" }, [
          plan.status === "planned" ? h("button", { class: "btn-sm btn-sm-primary", type: "button", onClick: () => requestTeamPlanExecution(plan) }, "在对话中执行") : null,
          plan.status === "needs_review" ? h("button", { class: "btn-sm btn-sm-primary", type: "button", onClick: () => requestTeamPlanRevision(plan) }, "按复核意见补全") : null,
          plan.status === "running" ? h("button", { class: "btn-sm btn-sm-danger", type: "button", onClick: () => controlTeamPlan(plan, "cancel") }, "请求终止") : null,
          plan.status === "completed" && !plan.workflow_draft_id ? h("button", { class: "btn-sm btn-sm-primary", type: "button", onClick: () => controlTeamPlan(plan, "workflow-draft") }, "保存为 Workflow 草稿") : null,
          plan.workflow_draft_id ? h("span", { class: "team-plan-saved" }, "已保存为草稿") : null,
        ]),
      ])));
    }

    function renderDetail() {
      if (local.loading && !local.team) return h("div", { class: "teams-empty" }, "正在读取团队状态...");
      if (local.error && !local.teams.length) return h("div", { class: "teams-error" }, local.error);
      if (!local.team) return h("div", { class: "teams-empty" }, "选择一个团队查看状态。");
      return h("div", { class: "team-detail" }, [
        h("div", { class: "team-detail-head" }, [
          h("div", null, [
            h("h3", null, local.team.name),
            h("p", null, local.team.description || "无描述"),
          ]),
          h("div", { class: "team-detail-actions" }, [
            h("div", { class: "team-lead-unread" }, `Leader 未读 ${local.team.lead_unread_messages || 0}`),
            h("button", {
              class: "btn-sm btn-sm-danger",
              type: "button",
              disabled: local.clearing || hasRunningMembers(),
              title: hasRunningMembers() ? "团队成员仍在执行或排队，暂不能清空" : "清空当前团队全部沟通记录",
              onClick: () => clearTeamMessages(local.team.name),
            }, local.clearing ? "清空中..." : "清空沟通记录"),
          ]),
        ]),
        h("div", { class: "team-section-title" }, "动态任务计划"),
        renderDynamicPlans(),
        h("div", { class: "team-section-title" }, "成员"),
        renderMembers(),
        h("div", { class: "team-section-title" }, `${participantLabel(local.selectedParticipant)} 响应`),
        renderMessages(),
      ]);
    }

    function renderWorkflowCreate() {
      const form = normalizedWorkflowCreate();
      if (!local.workflowCreateOpen) {
        return h("button", {
          class: "workflow-create-toggle",
          type: "button",
          onClick: () => {
            local.workflowCreateOpen = true;
            renderPanel();
          },
        }, "新建 Workflow");
      }
      return h("div", { class: "workflow-create" }, [
        h("div", { class: "workflow-create-head" }, [
          h("strong", null, "从模板创建"),
          h("button", {
            class: "btn-sm btn-sm-ghost",
            type: "button",
            disabled: local.workflowCreating,
            onClick: () => {
              local.workflowCreateOpen = false;
              renderPanel();
            },
          }, "收起"),
        ]),
        h("label", null, [
          h("span", null, "名称"),
          h("input", {
            value: form.name,
            disabled: local.workflowCreating,
            onInput: event => updateWorkflowCreate("name", event.target.value),
          }),
        ]),
        h("label", null, [
          h("span", null, "运行模式"),
          h("select", {
            value: form.mode,
            disabled: local.workflowCreating,
            onChange: event => {
              updateWorkflowCreate("mode", event.target.value);
              renderPanel();
            },
          }, [
            h("option", { value: "full_auto" }, "全自动"),
            h("option", { value: "key_approval" }, "关键审批"),
            h("option", { value: "exception_review" }, "异常复核"),
          ]),
        ]),
        h("p", { class: "workflow-create-hint" },
          form.mode === "key_approval"
            ? "复核完成后暂停，人工批准后生成报告。"
            : form.mode === "exception_review"
              ? "正常节点自动推进，失败时进入人工复核。"
              : "所有节点自动推进，审批边也自动通过。",
        ),
        h("label", null, [
          h("span", null, "输入字段"),
          h("input", {
            value: form.sourceKey,
            disabled: local.workflowCreating,
            spellcheck: "false",
            onInput: event => updateWorkflowCreate("sourceKey", event.target.value),
          }),
        ]),
        h("label", null, [
          h("span", null, "描述"),
          h("textarea", {
            rows: 3,
            value: form.description,
            disabled: local.workflowCreating,
            onInput: event => updateWorkflowCreate("description", event.target.value),
          }),
        ]),
        h("div", { class: "workflow-create-actions" }, [
          h("button", {
            class: "btn-sm btn-sm-primary",
            type: "button",
            disabled: local.workflowCreating,
            onClick: createWorkflowFromTemplate,
          }, local.workflowCreating ? "创建中..." : "创建并发布"),
        ]),
      ]);
    }

    function renderWorkflowList() {
      if (local.workflowsLoading && !local.workflows.length) {
        return h("div", { class: "teams-empty" }, "正在读取 Workflow...");
      }
      if (!local.workflows.length) {
        return h("div", { class: "teams-empty" }, "还没有 Workflow。创建或保存动态协作路径后会显示在这里。");
      }
      return h("div", { class: "workflow-list" }, local.workflows.map((workflow, index) => {
        const version = workflow.current_version || {};
        const graph = version.graph || workflow.draft_graph || {};
        const schema = version.input_schema || workflow.draft_input_schema || {};
        const requiredInputs = Array.isArray(schema.required) ? schema.required : [];
        const defaultInputs = Object.fromEntries(requiredInputs.map(key => [
          key,
          schema.properties?.[key]?.type === "string" ? "当前工作区数据" : {},
        ]));
        const inputValue = local.workflowInputs[workflow.id]
          ?? JSON.stringify(defaultInputs, null, 2);
        const published = Boolean(workflow.current_version_id);
        const expanded = Object.prototype.hasOwnProperty.call(local.workflowExpanded, workflow.id)
          ? local.workflowExpanded[workflow.id]
          : index === 0;
        const nodes = graph.nodes || [];
        const edges = graph.edges || [];
        const mode = graph.run_policy?.mode || "full_auto";
        const versionLabel = version.version_number
          ? `版本 ${version.version_number}`
          : published ? `版本 ${workflow.current_version_id.slice(-6)}` : "草稿";
        return h("article", {
          key: workflow.id,
          class: expanded ? "workflow-card expanded" : "workflow-card",
        }, [
          h("div", { class: "workflow-card-head" }, [
            h("div", { class: "workflow-card-title" }, [
              h("strong", null, workflow.name || workflow.id),
              h("div", { class: "workflow-card-meta" }, [
                h("span", { class: "workflow-mode" }, workflowModeLabel(mode)),
                h("span", null, versionLabel),
                h("span", null, `${nodes.length} 节点`),
                h("span", null, `${edges.length} 连线`),
              ]),
            ]),
            h("div", { class: "workflow-card-controls" }, [
              h("span", {
                class: published ? "workflow-status workflow-status-succeeded" : "workflow-status",
              }, published ? "已发布" : "未发布"),
              h("div", { class: "workflow-card-secondary" }, [
                h("button", {
                  class: "workflow-expand-btn",
                  type: "button",
                  title: expanded ? "收起流程详情" : "展开流程详情",
                  "aria-expanded": String(expanded),
                  onClick: () => {
                    local.workflowExpanded[workflow.id] = !expanded;
                    renderPanel();
                  },
                }, expanded ? "收起" : "展开"),
                h("button", {
                  class: "workflow-delete-btn",
                  type: "button",
                  title: "永久删除 Workflow 及其运行数据",
                  disabled: local.workflowDeleting === workflow.id,
                  onClick: () => deleteWorkflow(workflow),
                }, local.workflowDeleting === workflow.id ? "删除中" : "删除"),
              ]),
            ]),
          ]),
          expanded ? h("div", { class: "workflow-card-body" }, [
            workflow.description
              ? h("p", { class: "workflow-card-desc" }, workflow.description)
              : null,
            renderWorkflowBlueprint(workflow),
            h("div", { class: "workflow-input-head" }, [
              h("strong", null, "运行输入（JSON）"),
              h("small", null, requiredInputs.length
                ? `必填：${requiredInputs.join("、")}`
                : "无必填字段"),
            ]),
            h("textarea", {
              class: "workflow-inputs",
              rows: 4,
              spellcheck: "false",
              value: inputValue,
              placeholder: '{"source":"sales.csv"}',
              onInput: event => {
                local.workflowInputs[workflow.id] = event.target.value;
              },
            }),
            !published ? h("button", {
              class: "btn-sm btn-sm-primary workflow-start",
              type: "button",
              disabled: local.workflowCreating,
              onClick: () => publishSavedWorkflowDraft(workflow),
            }, local.workflowCreating ? "发布中..." : "审核后发布") : null,
            h("button", {
              class: "btn-sm btn-sm-primary workflow-start",
              type: "button",
              disabled: !published || local.workflowStarting === workflow.id,
              onClick: () => startWorkflow(workflow),
            }, local.workflowStarting === workflow.id ? "启动中..." : "启动 Workflow"),
          ]) : null,
        ]);
      }));
    }

    function renderWorkflowBlueprint(workflow) {
      const version = workflow?.current_version || {};
      const graph = version.graph || workflow?.draft_graph || {};
      const nodes = graph.nodes || [];
      const edges = graph.edges || [];
      if (!nodes.length) {
        return h("div", { class: "workflow-blueprint-empty" }, "未读取到流程定义");
      }
      const levels = workflowDagLevels(graph);
      const maxLevel = Math.max(0, ...[...levels.values()]);
      const stages = Array.from({ length: maxLevel + 1 }, (_, level) =>
        nodes.filter(node => (levels.get(String(node.node_id || "")) || 0) === level)
      ).filter(stage => stage.length);
      const labels = {
        inspect_data: "数据检查",
        analyze_metrics: "指标分析",
        analyze_anomalies: "异常分析",
        verify_findings: "结论复核",
        generate_report: "报告生成",
      };
      const edgeCounts = edges.reduce((counts, edge) => {
        const type = edge.type || "auto";
        counts[type] = (counts[type] || 0) + 1;
        return counts;
      }, {});
      const specialRules = edges.filter(edge => edge.type !== "auto");
      return h("section", { class: "workflow-blueprint" }, [
        h("div", { class: "workflow-blueprint-head" }, [
          h("strong", null, "流程结构"),
          h("small", null, `${stages.length} 个阶段`),
        ]),
        h("div", { class: "workflow-blueprint-stages" }, stages.map((stage, stageIndex) => h("div", {
          key: `stage-${stageIndex}`,
          class: "workflow-blueprint-stage",
        }, stage.map(node => {
          const nodeId = String(node.node_id || "");
          const outputs = Array.isArray(node.output_contract) ? node.output_contract : [];
          return h("div", {
            key: nodeId,
            class: "workflow-blueprint-node",
            title: `${nodeId}${outputs.length ? ` · 输出 ${outputs.join("、")}` : ""}`,
          }, [
            h("strong", null, labels[nodeId] || nodeId),
            h("span", null, outputs.length ? `${outputs.length} 项输出` : node.type || "agent"),
          ]);
        })))),
        h("div", { class: "workflow-blueprint-rules" }, [
          h("span", { class: "workflow-rule workflow-rule-primary" },
            `${workflowModeLabel(graph.run_policy?.mode)}执行`),
          edgeCounts.auto
            ? h("span", { class: "workflow-rule" }, `${edgeCounts.auto} 条自动流转`)
            : null,
          ...specialRules.map(edge => h("span", {
            key: edge.edge_id || `${edge.from_node}-${edge.to_node}-${edge.type}`,
            class: `workflow-rule workflow-rule-${edge.type}`,
          }, edge.type === "retry_loop"
            ? `返工至 ${labels[edge.to_node] || edge.to_node} · 最多 ${edge.max_iterations || 1} 次`
            : `${workflowEdgeLabel(edge.type)}后进入 ${labels[edge.to_node] || edge.to_node}`)),
        ]),
      ]);
    }

    function renderRunList() {
      if (local.workflowsLoading && !local.runs.length) {
        return h("div", { class: "teams-empty compact" }, "正在读取运行记录...");
      }
      if (!local.runs.length) {
        return h("div", { class: "teams-empty compact" }, "暂无 Workflow Run。");
      }
      return h("div", { class: "workflow-run-list" }, local.runs.map(run => {
        const workflow = workflowForRun(run);
        const active = local.selectedRun === run.id;
        return h("div", {
          key: run.id,
          class: active ? "workflow-run-row active" : "workflow-run-row",
        }, [
          h("button", {
            class: active ? "workflow-run-card active" : "workflow-run-card",
            type: "button",
            onClick: () => selectWorkflowRun(run.id),
          }, [
            h("div", { class: "workflow-run-card-main" }, [
              h("strong", null, workflow?.name || run.workflow_version_id || run.id),
              h("span", null, run.id),
            ]),
            h("div", { class: "workflow-run-card-meta" }, [
              h("span", { class: workflowStatusClass(run.status) }, workflowStatusLabel(run.status)),
              h("small", null, formatTime(run.started_at)),
            ]),
          ]),
          h("button", {
            class: "workflow-run-delete",
            type: "button",
            title: "永久删除本次运行及其数据",
            disabled: local.workflowRunDeleting === run.id,
            onClick: () => deleteWorkflowRun(run),
          }, local.workflowRunDeleting === run.id ? "删除中" : "删除"),
        ]);
      }));
    }

    function workflowOutputText(value) {
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value ?? "");
      }
    }

    async function copyWorkflowOutput(value) {
      try {
        await navigator.clipboard.writeText(workflowOutputText(value));
        window.BAA.ui?.toast?.("结果已复制", "ok");
      } catch (error) {
        window.BAA.ui?.toast?.(`复制失败：${error.message || error}`, "err");
      }
    }

    function renderWorkflowOutputValue(value, compact = false) {
      const text = workflowOutputText(value);
      if (typeof value === "string") {
        return h("div", {
          class: compact
            ? "workflow-output-content team-markdown compact"
            : "workflow-output-content team-markdown",
          innerHTML: renderMarkdown(text),
        });
      }
      return h("pre", {
        class: compact ? "workflow-output-json compact" : "workflow-output-json",
      }, text);
    }

    function renderRunOutputs(detail) {
      const entries = Object.entries(detail?.outputs || {});
      if (!entries.length) {
        return detail?.run?.status === "succeeded"
          ? h("section", { class: "workflow-final-output empty" }, [
              h("strong", null, "运行已完成，但流程未声明最终输出。"),
            ])
          : null;
      }
      const labels = {
        operating_report: "经营分析报告",
        report: "分析报告",
      };
      return h("section", { class: "workflow-final-output" }, [
        h("div", { class: "workflow-output-section-head" }, [
          h("div", null, [
            h("strong", null, "最终输出"),
            h("span", null, `${entries.length} 项结果`),
          ]),
        ]),
        ...entries.map(([key, value]) => h("div", {
          key,
          class: "workflow-output-field",
        }, [
          h("div", { class: "workflow-output-field-head" }, [
            h("div", null, [
              h("strong", null, labels[key] || key),
              h("small", null, key),
            ]),
            h("button", {
              class: "btn-sm btn-sm-ghost workflow-output-copy",
              type: "button",
              onClick: () => copyWorkflowOutput(value),
            }, "复制"),
          ]),
          renderWorkflowOutputValue(value),
        ])),
      ]);
    }

    function renderRunNodes(detail) {
      const nodes = detail?.nodes || [];
      const latestNodes = latestNodeRunsById(nodes);
      if (!nodes.length) {
        return h("div", { class: "teams-empty compact" }, "该 Run 暂无节点记录。");
      }
      return h("div", { class: "workflow-run-nodes" }, nodes.map(node => {
        const outputs = Object.entries(node.output || {});
        const canRetry = detail?.run?.status === "failed"
          && node.status === "failed"
          && latestNodes.get(node.node_id)?.id === node.id;
        return h("div", {
          key: node.id,
          class: "workflow-run-node",
        }, [
          h("div", { class: "workflow-run-node-head" }, [
            h("strong", null, node.node_id || node.id),
            h("span", { class: workflowStatusClass(node.status) }, workflowStatusLabel(node.status)),
          ]),
          h("div", { class: "workflow-node-meta" }, [
            h("span", null, `Agent ${node.agent_profile_id || "-"}`),
            node.job_id ? h("button", {
              class: "workflow-job-link",
              type: "button",
              title: "在 Job 历史中查看",
              onClick: () => openWorkflowJob(node.job_id),
            }, `Job ${node.job_id}`) : h("span", null, "Job -"),
            h("span", null, `Attempt ${node.attempt || 1}`),
          ]),
          node.error ? h("div", { class: "workflow-node-error" }, node.error) : null,
          canRetry ? h("div", { class: "workflow-node-actions" }, [
            h("button", {
              class: "btn-sm btn-sm-primary",
              type: "button",
              disabled: Boolean(local.workflowRetrying),
              onClick: () => retryWorkflowNode(node),
            }, local.workflowRetrying === node.id ? "重新派发中..." : "重试节点"),
          ]) : null,
          outputs.length ? h("details", { class: "workflow-node-output" }, [
            h("summary", null, `查看节点输出 · ${outputs.length} 项`),
            h("div", { class: "workflow-node-output-fields" }, outputs.map(([key, value]) =>
              h("div", { key, class: "workflow-node-output-field" }, [
                h("div", { class: "workflow-node-output-head" }, [
                  h("strong", null, key),
                  h("button", {
                    class: "btn-sm btn-sm-ghost",
                    type: "button",
                    onClick: event => {
                      event.preventDefault();
                      copyWorkflowOutput(value);
                    },
                  }, "复制"),
                ]),
                renderWorkflowOutputValue(value, true),
              ]),
            )),
          ]) : null,
        ]);
      }));
    }

    function renderRunEvents(detail) {
      const events = detail?.events || [];
      if (!events.length) {
        return h("div", { class: "teams-empty compact" }, "暂无事件。");
      }
      return h("div", { class: "workflow-events" }, events.slice(-80).reverse().map(event => h("div", {
        key: `${event.sequence}-${event.type}`,
        class: "workflow-event",
      }, [
        h("div", { class: "workflow-event-head" }, [
          h("strong", null, event.type || "event"),
          h("small", null, `#${event.sequence || ""} ${formatTime(event.created_at)}`),
        ]),
        h("pre", null, JSON.stringify(event, null, 2)),
      ])));
    }

    function renderWorkflowDag(detail) {
      const graph = detail?.graph || {};
      const nodes = graph.nodes || [];
      const edges = graph.edges || [];
      if (!nodes.length) return null;
      const latestRuns = latestNodeRunsById(detail?.nodes || []);
      const levels = workflowDagLevels(graph);
      const maxLevel = Math.max(0, ...[...levels.values()]);
      const columns = Math.min(maxLevel + 1, 6);
      return h("section", { class: "workflow-dag" }, [
        h("div", { class: "team-section-title" }, "流程图"),
        h("div", {
          class: "workflow-dag-map",
          style: { gridTemplateColumns: `repeat(${columns}, minmax(150px, 1fr))` },
        }, nodes.map(node => {
          const nodeId = String(node.node_id || "");
          const runNode = latestRuns.get(nodeId) || {};
          const status = runNode.status || "pending";
          const badges = [
            isPendingApprovalNode(detail, nodeId) ? "待审批" : "",
            isRetryTarget(graph, nodeId) ? "返工目标" : "",
            node.join_policy === "all_terminal" ? "分支汇合" : "",
            node.on_reject === "close_branch" ? "可关闭分支" : "",
          ].filter(Boolean);
          return h("div", {
            key: nodeId,
            class: `workflow-dag-node workflow-dag-node-${status}`,
            style: { gridColumn: String(Math.min((levels.get(nodeId) || 0) + 1, columns)) },
          }, [
            h("div", { class: "workflow-dag-node-head" }, [
              h("strong", null, nodeId),
              h("span", { class: workflowStatusClass(status) }, workflowStatusLabel(status)),
            ]),
            h("div", { class: "workflow-dag-node-meta" }, [
              h("span", null, node.type || "agent"),
              h("span", null, runNode.job_id ? `job ${String(runNode.job_id).slice(-6)}` : "未派发"),
              h("span", null, `i${runNode.iteration || 1}/a${runNode.attempt || 1}`),
            ]),
            badges.length ? h("div", { class: "workflow-dag-badges" }, badges.map(label => h("span", { key: label }, label))) : null,
          ]);
        })),
        edges.length ? h("div", { class: "workflow-dag-edges" }, edges.map(edge => h("div", {
          key: edge.edge_id || `${edge.from_node}-${edge.to_node}-${edge.type}`,
          class: "workflow-dag-edge-row",
        }, [
          h("span", null, edge.from_node || "-"),
          h("span", { class: workflowEdgeClass(edge.type) }, workflowEdgeLabel(edge.type)),
          h("span", null, edge.to_node || "-"),
          edge.max_iterations ? h("small", null, `max ${edge.max_iterations}`) : null,
        ]))) : null,
      ]);
    }

    function renderRunApprovals(detail) {
      const approvals = detail?.approvals || [];
      if (!approvals.length) return null;
      return h("section", { class: "workflow-approvals" }, [
        h("div", { class: "team-section-title" }, "审批任务"),
        ...approvals.map(approval => {
          const pending = approval.status === "pending";
          const sourceManifest = approvalManifest(detail, approval);
          if (pending) seedApprovalRevisionFields(approval, sourceManifest);
          const form = getApprovalForm(approval);
          const revisionFields = form.revisionFields || [];
          const commentRows = [
            approval.comment ? `意见：${approval.comment}` : "",
            approval.comments && Object.keys(approval.comments).length
              ? `结构化意见：${JSON.stringify(approval.comments)}`
              : "",
            approval.revised_artifact_manifest_id
              ? `修订 Manifest：${approval.revised_artifact_manifest_id}`
              : "",
          ].filter(Boolean);
          return h("div", {
            key: approval.id,
            class: pending ? "workflow-approval pending" : "workflow-approval",
          }, [
            h("div", { class: "workflow-approval-head" }, [
              h("div", null, [
                h("strong", null, approval.reason === "exception_review" ? "异常触发审批" : "关键节点审批"),
                h("span", null, approval.node_id || approval.node_run_id),
              ]),
              h("span", {
                class: pending
                  ? "workflow-status workflow-status-waiting_approval"
                  : "workflow-status workflow-status-succeeded",
              }, pending ? "待处理" : `已${approval.decision || "处理"}`),
            ]),
            h("div", { class: "workflow-approval-meta" }, [
              h("span", null, `mode ${approval.mode || "-"}`),
              h("span", null, `requested ${formatTime(approval.requested_at) || "-"}`),
              approval.artifact_manifest_id
                ? h("span", null, `manifest ${approval.artifact_manifest_id}`)
                : null,
            ]),
            !pending && commentRows.length
              ? h("div", { class: "workflow-approval-note" }, commentRows.join("\n"))
              : null,
            pending ? h("div", { class: "workflow-approval-form" }, [
              h("label", null, [
                h("span", null, "审批意见"),
                h("textarea", {
                  rows: 2,
                  value: form.comment,
                  disabled: local.workflowApproving === approval.id,
                  placeholder: "说明批准依据、重做要求或终止原因",
                  onInput: event => updateApprovalForm(approval, "comment", event.target.value),
                }),
              ]),
              h("div", { class: "workflow-approval-revision-head" }, [
                h("strong", null, "修订草稿"),
                h("div", { class: "workflow-approval-revision-actions" }, [
                  h("button", {
                    class: "btn-sm btn-sm-ghost",
                    type: "button",
                    disabled: !sourceManifest || local.workflowApproving === approval.id,
                    onClick: () => {
                      seedApprovalRevisionFields(approval, sourceManifest, true);
                      renderPanel();
                    },
                  }, "从 Manifest 重置"),
                  h("button", {
                    class: "btn-sm btn-sm-ghost",
                    type: "button",
                    disabled: local.workflowApproving === approval.id,
                    onClick: () => {
                      addApprovalRevisionField(approval);
                      renderPanel();
                    },
                  }, "添加字段"),
                ]),
              ]),
              revisionFields.length ? h("div", { class: "workflow-approval-fields" }, revisionFields.map((field, index) => h("div", {
                key: `${approval.id}-${index}-${field.source || field.key}`,
                class: "workflow-approval-field",
              }, [
                h("input", {
                  value: field.key,
                  disabled: local.workflowApproving === approval.id,
                  placeholder: "字段名",
                  onInput: event => updateApprovalRevisionField(approval, index, "key", event.target.value),
                }),
                h("textarea", {
                  rows: 2,
                  value: field.value,
                  disabled: local.workflowApproving === approval.id,
                  spellcheck: "false",
                  placeholder: "字段值，支持 JSON 或文本",
                  onInput: event => updateApprovalRevisionField(approval, index, "value", event.target.value),
                }),
                h("button", {
                  class: "btn-sm btn-sm-ghost",
                  type: "button",
                  disabled: local.workflowApproving === approval.id,
                  onClick: () => {
                    removeApprovalRevisionField(approval, index);
                    renderPanel();
                  },
                }, "移除"),
              ]))) : h("div", { class: "teams-empty compact" }, "该审批没有可内联的 Manifest 字段，可直接编辑 JSON。"),
              h("div", { class: "workflow-approval-revision" }, [
                h("label", null, [
                  h("span", null, "修订摘要"),
                  h("input", {
                    value: form.revisedSummary,
                    disabled: local.workflowApproving === approval.id,
                    placeholder: "用于 approve_with_changes 的修订说明",
                    onInput: event => updateApprovalForm(approval, "revisedSummary", event.target.value),
                  }),
                ]),
                h("label", null, [
                  h("span", null, "修订输出 JSON"),
                  h("textarea", {
                    rows: 4,
                    value: form.revisedOutputs,
                    disabled: local.workflowApproving === approval.id,
                    spellcheck: "false",
                    placeholder: '{"verification_report":"人工修订后的结论"}',
                    onInput: event => updateApprovalForm(approval, "revisedOutputs", event.target.value),
                  }),
                ]),
              ]),
            ]) : null,
            pending ? h("div", { class: "workflow-approval-actions" }, [
              h("button", {
                class: "btn-sm btn-sm-primary",
                type: "button",
                disabled: local.workflowApproving === approval.id,
                onClick: () => decideWorkflowApproval(approval, "approve"),
              }, "批准继续"),
              h("button", {
                class: "btn-sm btn-sm-primary",
                type: "button",
                disabled: local.workflowApproving === approval.id,
                onClick: () => decideWorkflowApproval(approval, "approve_with_changes"),
              }, "带修改批准"),
              h("button", {
                class: "btn-sm btn-sm-ghost",
                type: "button",
                disabled: local.workflowApproving === approval.id,
                onClick: () => decideWorkflowApproval(approval, "reject_and_retry"),
              }, "要求重做"),
              h("button", {
                class: "btn-sm btn-sm-danger",
                type: "button",
                disabled: local.workflowApproving === approval.id,
                onClick: () => decideWorkflowApproval(approval, "reject_and_stop"),
              }, "驳回终止"),
            ]) : null,
          ]);
        }),
      ]);
    }

    function renderRunMaterials(detail) {
      const manifests = detail?.manifests || [];
      const consumptions = detail?.consumptions || [];
      if (!manifests.length) {
        return h("div", { class: "teams-empty compact" }, "暂无材料 Manifest。");
      }
      return h("div", { class: "workflow-materials" }, [
        ...manifests.map(manifest => h("details", {
          key: manifest.id,
          class: "workflow-material",
        }, [
          h("summary", null, [
            h("span", null, `${manifest.kind || "manifest"} · ${manifest.items?.length || 0} 项`),
            h("small", null, manifest.id),
          ]),
          h("div", { class: "workflow-material-items" }, (manifest.items || []).map(item => h("div", {
            key: item.artifact_id || item.uri,
            class: "workflow-material-item",
          }, [
            h("strong", null, item.logical_name || item.name || item.artifact_id),
            h("span", null, item.uri || item.artifact_id || ""),
            item.source_tool ? h("small", null, `tool ${item.source_tool}`) : null,
            item.source_job_id ? h("small", null, `job ${item.source_job_id}`) : null,
            item.data_snapshot_id ? h("small", null, `snapshot ${item.data_snapshot_id}`) : null,
            item.sql_hash ? h("small", null, `sql ${item.sql_hash.slice(0, 12)}`) : null,
            item.tool_artifacts ? h("small", null, "workflow_artifact tool result") : null,
          ]))),
        ])),
        consumptions.length ? h("div", { class: "workflow-consumptions" }, [
          h("div", { class: "team-section-title" }, "消费关系"),
          ...consumptions.map(item => h("div", {
            key: item.id,
            class: "workflow-consumption",
          }, `${item.consumer_node_run_id} ← ${item.artifact_id} (${item.purpose || "material"})`)),
        ]) : null,
      ]);
    }

    function renderWorkflowKnowledgeCandidates(detail) {
      const candidates = detail?.knowledge_candidates || [];
      if (!candidates.length) return null;
      const typeLabel = {
        report_template: "报告模板",
        metric_sql: "指标 SQL",
      };
      return h("section", { class: "workflow-knowledge-candidates" }, [
        h("div", { class: "team-section-title" }, "知识入库候选"),
        ...candidates.map(candidate => {
          const pending = candidate.status === "pending";
          const deciding = local.workflowCandidateDeciding === candidate.id;
          return h("article", {
            class: `workflow-knowledge-candidate ${candidate.status || "pending"}`,
            key: candidate.id,
          }, [
            h("div", { class: "workflow-knowledge-candidate-head" }, [
              h("div", null, [
                h("strong", null, candidate.title || candidate.id),
                h("span", null, typeLabel[candidate.candidate_type] || candidate.candidate_type),
              ]),
              h("span", {
                class: candidate.status === "accepted"
                  ? "workflow-status workflow-status-succeeded"
                  : candidate.status === "rejected"
                    ? "workflow-status workflow-status-failed"
                    : "workflow-status workflow-status-waiting_approval",
              }, candidate.status === "accepted" ? "已入库" : candidate.status === "rejected" ? "已拒绝" : "待确认"),
            ]),
            h("div", { class: "workflow-knowledge-candidate-meta" }, [
              h("span", null, `Version ${String(candidate.workflow_version_id || "").slice(-8)}`),
              h("span", null, `Manifest ${String(candidate.source_manifest_id || "-").slice(-8)}`),
            ]),
            pending ? h("div", { class: "workflow-knowledge-candidate-actions" }, [
              h("button", {
                class: "btn-sm btn-sm-primary",
                type: "button",
                disabled: Boolean(local.workflowCandidateDeciding),
                onClick: () => decideWorkflowKnowledgeCandidate(candidate, "accept"),
              }, deciding ? "处理中..." : "接受入库"),
              h("button", {
                class: "btn-sm btn-sm-ghost",
                type: "button",
                disabled: Boolean(local.workflowCandidateDeciding),
                onClick: () => decideWorkflowKnowledgeCandidate(candidate, "reject"),
              }, "拒绝"),
            ]) : null,
          ]);
        }),
      ]);
    }

    function formatWorkflowDuration(seconds) {
      const value = Number(seconds) || 0;
      if (value < 60) return `${Math.round(value)} 秒`;
      if (value < 3600) return `${Math.round(value / 60)} 分钟`;
      return `${(value / 3600).toFixed(1)} 小时`;
    }

    function renderWorkflowMetricsDashboard() {
      const metrics = local.workflowMetrics;
      if (local.workflowMetricsLoading && !metrics) {
        return h("section", { class: "workflow-metrics" }, "正在汇总运行指标...");
      }
      if (!metrics) return null;
      const summary = metrics.summary || {};
      const versions = metrics.versions || [];
      const suggestions = local.workflowSuggestions || [];
      return h("section", { class: "workflow-metrics" }, [
        h("div", { class: "workflow-metrics-head" }, [
          h("div", null, [
            h("strong", null, "运行看板"),
            h("span", null, `${summary.workflow_version_count || 0} 个版本 · ${summary.run_count || 0} 次运行`),
          ]),
          h("span", { class: "workflow-metrics-audit" }, "基于 Run / Node / Artifact 审计数据"),
        ]),
        h("div", { class: "workflow-metric-grid" }, [
          h("div", null, [h("span", null, "成功率"), h("strong", null, `${Math.round((summary.success_rate || 0) * 100)}%`)]),
          h("div", null, [h("span", null, "输入 Token"), h("strong", null, Number(summary.input_tokens || 0).toLocaleString())]),
          h("div", null, [h("span", null, "输出 Token"), h("strong", null, Number(summary.output_tokens || 0).toLocaleString())]),
          h("div", null, [h("span", null, "成本"), h("strong", null, summary.estimated_cost == null ? "未配置价格" : String(summary.estimated_cost))]),
        ]),
        versions.length ? h("div", { class: "workflow-metric-versions" }, versions.map(version =>
          h("div", { class: "workflow-metric-version", key: version.workflow_version_id }, [
            h("div", null, [
              h("strong", null, `${version.workflow_name} · v${version.version_number || "-"}`),
              h("span", null, `${version.run_count} 次 · 平均 ${formatWorkflowDuration(version.avg_duration_seconds)}`),
            ]),
            h("span", { class: version.success_rate >= 0.9 ? "good" : "warn" }, `${Math.round((version.success_rate || 0) * 100)}% 成功`),
          ]),
        )) : h("div", { class: "workflow-metrics-empty" }, "运行后将显示版本成功率、时长和 Token 用量。"),
        suggestions.length ? h("div", { class: "workflow-suggestions" }, [
          h("div", { class: "team-section-title" }, "规则化优化建议"),
          ...suggestions.map(suggestion => h("div", { class: "workflow-suggestion", key: suggestion.id }, [
            h("div", null, [
              h("strong", null, suggestion.title),
              h("span", null, suggestion.rationale),
            ]),
            h("button", {
              class: "btn-sm btn-sm-ghost",
              type: "button",
              disabled: Boolean(local.workflowCreatingDraft),
              onClick: () => createWorkflowOptimizationDraft(suggestion),
            }, local.workflowCreatingDraft === suggestion.id ? "创建中..." : "创建优化草稿"),
          ])),
        ]) : null,
      ]);
    }

    function renderWorkflowDetail() {
      const detail = local.runDetail;
      if (!local.selectedRun) {
        return h("div", { class: "teams-empty" }, "选择一个 Workflow Run 查看节点、事件和材料。");
      }
      if (local.workflowsLoading && !detail) {
        return h("div", { class: "teams-empty" }, "正在读取运行详情...");
      }
      if (!detail?.run) {
        return h("div", { class: "teams-empty" }, "未找到运行详情。");
      }
      const run = detail.run;
      const pendingCandidateCount = (detail.knowledge_candidates || []).filter(
        item => item.status === "pending",
      ).length;
      return h("div", { class: "workflow-detail" }, [
        h("div", { class: "team-detail-head" }, [
          h("div", null, [
            h("h3", null, workflowForRun(run)?.name || "Workflow Run"),
            h("p", null, run.id),
          ]),
          h("div", { class: "team-detail-actions" }, [
            h("span", { class: workflowStatusClass(run.status) }, workflowStatusLabel(run.status)),
            run.status === "succeeded" && !(detail.templates || []).length ? h("button", {
              class: "btn-sm btn-sm-ghost",
              type: "button",
              disabled: local.workflowSavingTemplate === run.id,
              onClick: () => saveWorkflowTemplate(run),
            }, local.workflowSavingTemplate === run.id ? "保存中..." : "保存运行模板") : null,
            run.status === "succeeded" ? h("button", {
              class: "btn-sm btn-sm-ghost",
              type: "button",
              disabled: local.workflowGeneratingCandidates === run.id,
              onClick: () => pendingCandidateCount
                ? focusWorkflowKnowledgeCandidates()
                : generateWorkflowKnowledgeCandidates(run),
            }, local.workflowGeneratingCandidates === run.id
              ? "生成中..."
              : pendingCandidateCount
                ? `待入库 ${pendingCandidateCount} 项`
                : "生成入库候选") : null,
            run.status === "paused" ? h("button", {
              class: "btn-sm btn-sm-primary",
              type: "button",
              disabled: local.workflowResuming === run.id,
              onClick: () => resumeWorkflowRun(run.id),
            }, local.workflowResuming === run.id ? "恢复中..." : "恢复 Run") : null,
            h("button", {
              class: "btn-sm btn-sm-danger",
              type: "button",
              disabled: !isWorkflowActive(run.status) || local.workflowCanceling === run.id,
              onClick: () => cancelWorkflowRun(run.id),
            }, local.workflowCanceling === run.id ? "取消中..." : "取消 Run"),
          ]),
        ]),
        h("div", { class: "workflow-run-summary" }, [
          h("span", null, `Started ${formatTime(run.started_at) || "-"}`),
          h("span", null, `Finished ${formatTime(run.finished_at) || "-"}`),
          h("span", null, `By ${run.started_by || "-"}`),
        ]),
        renderRunOutputs(detail),
        h("div", { class: "workflow-detail-tabs" }, [
          renderWorkflowKnowledgeCandidates(detail),
          renderRunApprovals(detail),
          renderWorkflowDag(detail),          h("section", null, [
            h("div", { class: "team-section-title" }, "节点"),
            renderRunNodes(detail),
          ]),
          h("section", null, [
            h("div", { class: "team-section-title" }, "事件"),
            renderRunEvents(detail),
          ]),
          h("section", null, [
            h("div", { class: "team-section-title" }, "材料"),
            renderRunMaterials(detail),
          ]),
        ]),
      ]);
    }

    function renderWorkflowPanel() {
      return h("div", { class: "workflow-panel" }, [
        local.workflowsError
          ? h("div", { class: "teams-inline-error" }, local.workflowsError)
          : null,
        h("section", { class: "workflow-sidebar" }, [
          h("div", { class: "team-section-title" }, "创建 Workflow"),
          renderWorkflowCreate(),
          h("div", { class: "team-section-title" }, "已发布 Workflow"),
          renderWorkflowList(),
          h("div", { class: "team-section-title" }, "运行记录"),
          renderRunList(),
        ]),
        h("section", { class: "workflow-main" }, [
          renderWorkflowMetricsDashboard(),
          renderWorkflowDetail(),
        ]),
      ]);
    }

    render(h("div", { class: "teams-panel" }, [
      renderHeader(),
      local.error && local.teams.length
        ? h("div", { class: "teams-inline-error" }, local.error)
        : null,
      local.activeView === "workflow" ? renderWorkflowPanel() : h("div", { class: "teams-grid" }, [
        h("section", { class: "teams-sidebar" }, renderTeamList()),
        h("section", { class: "teams-main" }, renderDetail()),
      ]),
    ]), root);
  }

  function hasRunningMembers() {
    return teamHasRunningMembers(local.team);
  }

  function schedulePoll() {
    if (local.pollTimer) {
      clearTimeout(local.pollTimer);
      local.pollTimer = null;
    }
    const hasActiveWorkflow = local.runs.some(run => isWorkflowActive(run.status));
    if (!local.isOpen || (!hasRunningMembers() && !hasActiveWorkflow)) return;
    local.pollTimer = setTimeout(() => {
      local.pollTimer = null;
      Promise.allSettled([
        hasRunningMembers() ? refresh({ silent: true }) : Promise.resolve(),
        hasActiveWorkflow ? refreshWorkflows({ silent: true, keepSelection: true }) : Promise.resolve(),
      ]).catch(() => {});
    }, 2500);
  }

  function switchView(view) {
    local.activeView = view === "workflow" ? "workflow" : "teams";
    renderPanel();
    if (local.activeView === "workflow" && !local.workflows.length && !local.workflowsLoading) {
      refreshWorkflows({ keepSelection: true }).catch(() => {});
    }
  }

  async function selectWorkflowRun(runId) {
    if (!runId) return;
    local.selectedRun = runId;
    local.workflowsError = "";
    renderPanel();
    try {
      local.runDetail = await fetchWorkflowRun(runId);
    } catch (error) {
      local.workflowsError = String(error.message || error);
    }
    renderPanel();
  }

  async function refreshWorkflows(options = {}) {
    if (!state.SID) return;
    if (!options.silent) {
      local.workflowsLoading = true;
      local.workflowMetricsLoading = true;
      local.workflowsError = "";
      renderPanel();
    }
    try {
      const [workflowData, runData, metricData] = await Promise.all([
        fetchWorkflows(),
        fetchWorkflowRuns(),
        fetchWorkflowMetrics(),
      ]);
      local.workflows = workflowData.workflows || [];
      local.runs = runData.runs || [];
      local.workflowMetrics = metricData.metrics || null;
      local.workflowSuggestions = metricData.suggestions || [];
      if (!options.keepSelection || !local.runs.some(run => run.id === local.selectedRun)) {
        local.selectedRun = local.runs[0]?.id || "";
      }
      local.runDetail = local.selectedRun ? await fetchWorkflowRun(local.selectedRun) : null;
      local.workflowsError = "";
    } catch (error) {
      local.workflowsError = String(error.message || error);
    } finally {
      local.workflowsLoading = false;
      local.workflowMetricsLoading = false;
      renderPanel();
      schedulePoll();
    }
  }

  async function selectTeam(name) {
    if (!name) return;
    if (local.selected !== name) local.selectedParticipant = "leader";
    local.selected = name;
    local.error = "";
    renderPanel();
    try {
      const [data, planData] = await Promise.all([fetchTeam(name), fetchTeamPlans(name)]);
      local.team = data.team || null;
      local.teamPlans = planData.plans || [];
      const memberNames = new Set((local.team?.members || []).map(member => member.name));
      if (!isLeaderId(local.selectedParticipant) && !memberNames.has(local.selectedParticipant)) {
        local.selectedParticipant = "leader";
      }
    } catch (error) {
      local.error = String(error.message || error);
    }
    renderPanel();
  }

  async function refresh(options = {}) {
    if (!state.SID) return;
    if (!options.silent) {
      local.loading = true;
      local.error = "";
      renderPanel();
    }
    try {
      const data = await fetchTeams();
      local.teams = data.teams || [];
      if (!local.teams.some(team => team.name === local.selected)) {
        local.selected = local.teams[0]?.name || "";
        local.selectedParticipant = "leader";
      }
      if (local.selected) {
        const [status, planData] = await Promise.all([
          fetchTeam(local.selected),
          fetchTeamPlans(local.selected),
        ]);
        local.team = status.team || null;
        local.teamPlans = planData.plans || [];
        const memberNames = new Set((local.team?.members || []).map(member => member.name));
        if (!isLeaderId(local.selectedParticipant) && !memberNames.has(local.selectedParticipant)) {
          local.selectedParticipant = "leader";
        }
      } else {
        local.team = null;
        local.teamPlans = [];
        local.selectedParticipant = "leader";
      }
      local.error = "";
    } catch (error) {
      local.error = String(error.message || error);
      if (!options.silent) {
        local.teams = [];
        local.team = null;
        local.selected = "";
      }
    } finally {
      local.loading = false;
      renderPanel();
      schedulePoll();
    }
  }

  async function openPanel() {
    local.isOpen = true;
    window.BAA.overlay.openOverlay("ov-teams");
    await Promise.allSettled([
      refresh(),
      refreshWorkflows({ silent: true, keepSelection: true }),
    ]);
  }

  function closePanelState() {
    local.isOpen = false;
    if (local.pollTimer) {
      clearTimeout(local.pollTimer);
      local.pollTimer = null;
    }
  }

  function init() {
    renderPanel();
  }

export const teams = Object.freeze({
    init,
    openPanel,
    closePanelState,
    refresh,
    selectTeam,
    refreshWorkflows,
    selectWorkflowRun,
    decideWorkflowApproval,
    switchView,
    isOpen: () => local.isOpen,
    isAvailable: () => !!hasVue,
});
