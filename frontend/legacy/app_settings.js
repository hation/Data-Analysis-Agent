// Compatibility application settings rendered as a Vue island.
import { state as appState } from "../core/runtime.js";
import { uiRegistry } from "../core/ui-registry.js";
import { chatStream } from "../features/chat-stream.js";

  const Vue = window.Vue;
  const root = document.getElementById("app-settings-root");
  const PROMPT_SUGGESTION_KEY = "baa_prompt_suggestion_enabled";
  const TEAMS_KEY = "baa_teams_enabled";
  const AUTO_MATCH_SKILL_KEY = "baa_auto_match_skill";

  const DEFAULT_HOOKS_TEXT = JSON.stringify({
    enabled: true,
    allow_command_hooks: false,
    hooks: [],
  }, null, 2);
  const HOOK_EVENTS = [
    "startup",
    "session_start",
    "user_prompt_submit",
    "turn_start",
    "turn_end",
    "tool_call",
    "pre_tool_use",
    "post_tool_use",
    "permission_request",
    "subagent_start",
    "subagent_stop",
    "pre_compact",
    "post_compact",
    "stop",
    "error",
  ];
  const LIFECYCLE_AUDIT_LABELS = {
    session_registered: "会话登记",
    session_soft_deleted: "会话软删除",
    session_trash_reclaimed: "回收站清理",
    session_trash_restored: "会话恢复",
    artifact_registered: "产物登记",
  };

  function _enabledFromStorage() {
    return localStorage.getItem(PROMPT_SUGGESTION_KEY) !== "0";
  }

  function _teamsEnabledFromStorage() {
    return localStorage.getItem(TEAMS_KEY) === "1";
  }

  function _autoMatchSkillFromStorage() {
    return localStorage.getItem(AUTO_MATCH_SKILL_KEY) !== "0";
  }

  function setPromptSuggestionEnabled(enabled) {
    appState.promptSuggestionEnabled = !!enabled;
    localStorage.setItem(PROMPT_SUGGESTION_KEY, appState.promptSuggestionEnabled ? "1" : "0");
    if (!appState.promptSuggestionEnabled) {
      chatStream.clearPromptSuggestion();
    }
    if (uiState) {
      uiState.promptSuggestionEnabled = appState.promptSuggestionEnabled;
      draw();
    }
  }

  function setTeamsEnabled(enabled) {
    appState.teamsEnabled = !!enabled;
    localStorage.setItem(TEAMS_KEY, appState.teamsEnabled ? "1" : "0");
    if (uiState) {
      uiState.teamsEnabled = appState.teamsEnabled;
      draw();
    }
  }

  function setAutoMatchSkill(enabled) {
    appState.autoMatchSkill = !!enabled;
    localStorage.setItem(AUTO_MATCH_SKILL_KEY, appState.autoMatchSkill ? "1" : "0");
    if (uiState) {
      uiState.autoMatchSkill = appState.autoMatchSkill;
      draw();
    }
  }

  let uiState = null;
  let draw = () => {};

  function toast(message, type = "") {
    uiRegistry.toast?.(message, type);
  }

  async function parseHooksJson() {
    try {
      return JSON.parse(uiState.hooksText || "{}");
    } catch (error) {
      uiState.hooksStatus = `JSON 格式错误：${error.message || error}`;
      uiState.hooksStatusType = "error";
      draw();
      return null;
    }
  }

  async function loadHooks() {
    if (!uiState) return;
    uiState.hooksLoading = true;
    uiState.hooksStatus = "";
    draw();
    try {
      const resp = await fetch("/api/hooks");
      const data = await resp.json();
      uiState.hooksText = JSON.stringify(data.settings || JSON.parse(DEFAULT_HOOKS_TEXT), null, 2);
      uiState.hooksStatus = data.ok ? "Hooks 配置已加载。" : (data.error || "Hooks 配置存在错误。");
      uiState.hooksStatusType = data.ok ? "ok" : "error";
    } catch (error) {
      uiState.hooksStatus = `加载失败：${error.message || error}`;
      uiState.hooksStatusType = "error";
    } finally {
      uiState.hooksLoading = false;
      draw();
    }
  }

  async function validateHooks() {
    const raw = await parseHooksJson();
    if (!raw) return false;
    uiState.hooksLoading = true;
    draw();
    try {
      const resp = await fetch("/api/hooks/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(raw),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) throw new Error(data.error || "校验失败");
      uiState.hooksText = JSON.stringify(data.settings || raw, null, 2);
      uiState.hooksStatus = "校验通过。";
      uiState.hooksStatusType = "ok";
      toast("Hooks 校验通过");
      return true;
    } catch (error) {
      uiState.hooksStatus = `校验失败：${error.message || error}`;
      uiState.hooksStatusType = "error";
      return false;
    } finally {
      uiState.hooksLoading = false;
      draw();
    }
  }

  async function saveHooks() {
    const raw = await parseHooksJson();
    if (!raw) return;
    uiState.hooksLoading = true;
    draw();
    try {
      const resp = await fetch("/api/hooks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(raw),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) throw new Error(data.error || "保存失败");
      uiState.hooksText = JSON.stringify(data.settings || raw, null, 2);
      uiState.hooksStatus = "已保存，下一轮对话生效。";
      uiState.hooksStatusType = "ok";
      toast("Hooks 已保存");
    } catch (error) {
      uiState.hooksStatus = `保存失败：${error.message || error}`;
      uiState.hooksStatusType = "error";
    } finally {
      uiState.hooksLoading = false;
      draw();
    }
  }

  async function testHooks() {
    const raw = await parseHooksJson();
    if (!raw) return;
    uiState.hooksLoading = true;
    draw();
    try {
      const resp = await fetch("/api/hooks/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: uiState.testEvent || "turn_start",
          settings: raw,
          context: {
            session_id: "preview",
            turn_id: "preview-turn",
            tool_name: "query_data",
            tool_args: { sql: "SELECT 1" },
            message: "测试 Hooks",
          },
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) throw new Error(data.error || "测试失败");
      uiState.hooksStatus = JSON.stringify(data, null, 2);
      uiState.hooksStatusType = "ok";
    } catch (error) {
      uiState.hooksStatus = `测试失败：${error.message || error}`;
      uiState.hooksStatusType = "error";
    } finally {
      uiState.hooksLoading = false;
      draw();
    }
  }

  function renderSwitch(checked, onChange) {
    return Vue.h("span", { class: "app-setting-switch" }, [
      Vue.h("input", {
        type: "checkbox",
        checked,
        onChange: event => onChange(event.target.checked),
      }),
      Vue.h("span", { "aria-hidden": "true" }),
    ]);
  }


  async function downloadBgeModel() {
    uiState.bgeDownloading = true;
    uiState.bgeStatus = "";
    draw();
    try {
      const resp = await fetch("/api/system/bge-model/download", { method: "POST" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) throw new Error(data.error || "download failed");
      uiState.bgeInstalled = true;
      uiState.bgeNeural = !!data.neural_active;
      uiState.bgeStatus = data.neural_active
        ? ""
        : "download-done";
      uiState.bgeStatusType = "ok";
      toast("BGE \u6a21\u578b\u4e0b\u8f7d\u5b8c\u6210\uff0c\u8bed\u4e49\u68c0\u7d22\u5df2\u542f\u7528");
    } catch (e) {
      uiState.bgeStatus = String(e.message || e);
      uiState.bgeStatusType = "error";
    } finally {
      uiState.bgeDownloading = false;
      draw();
    }
  }

  function applyEmbedInfo(data) {
    uiState.embedMode = data.mode || uiState.embedMode || "auto";
    uiState.embedActive = data.active || "hash";
    uiState.embedDim = Number(data.dim || 384);
    uiState.embedModel = data.model || "";
    uiState.embedCloudUrl = data.cloud_url || "";
    uiState.embedCloudAvailable = !!data.cloud_available;
    uiState.embedCloudConfigured = !!data.cloud_configured;
    uiState.embedCloudStatus = data.cloud_status || (data.cloud_available ? "available" : "unavailable");
    uiState.embedLocalAvailable = !!data.local_available;
    if ("installed" in data) uiState.bgeInstalled = !!data.installed;
    uiState.bgeNeural = "neural_active" in data
      ? !!data.neural_active
      : uiState.embedActive !== "hash";
  }

  async function loadEmbedMode() {
    if (!uiState) return;
    try {
      const resp = await fetch("/api/system/embed-mode");
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) throw new Error(data.error || "嵌入模式加载失败");
      applyEmbedInfo(data);
      if (data.init_error) {
        uiState.bgeStatus = `模型初始化失败：${data.init_error}`;
        uiState.bgeStatusType = "error";
      }
    } catch (error) {
      uiState.bgeStatus = `模式加载失败：${error.message || error}`;
      uiState.bgeStatusType = "error";
    } finally {
      draw();
    }
  }

  async function loadCloudConfig() {
    if (!uiState) return;
    try {
      const resp = await fetch("/api/system/embed-cloud-config");
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) throw new Error(data.error || "云端配置加载失败");
      uiState.cloudUrl = data.url || "";
      uiState.cloudModel = data.model || "bge-large-zh";
      uiState.cloudTokenConfigured = !!data.token_configured;
    } catch (error) {
      uiState.bgeStatus = `云端配置加载失败：${error.message || error}`;
      uiState.bgeStatusType = "error";
    } finally {
      draw();
    }
  }

  async function saveCloudConfig(test = false, clearToken = false) {
    if (!uiState || uiState.cloudSaving) return;
    const url = String(uiState.cloudUrl || "").trim();
    const model = String(uiState.cloudModel || "").trim();
    const token = String(uiState.cloudToken || "").trim();
    if (!url || !model) {
      uiState.bgeStatus = "请填写云端 URL 和模型名。";
      uiState.bgeStatusType = "error";
      draw();
      return;
    }
    if (test && !token && !uiState.cloudTokenConfigured && !clearToken) {
      uiState.bgeStatus = "测试连接前请填写 Bearer Token。";
      uiState.bgeStatusType = "error";
      draw();
      return;
    }
    uiState.cloudSaving = true;
    uiState.bgeStatus = test ? "正在保存并测试云端连接…" : "正在保存云端配置…";
    uiState.bgeStatusType = "ok";
    draw();
    try {
      const body = { url, model, test, clear_token: clearToken };
      if (token) body.token = token;
      const resp = await fetch("/api/system/embed-cloud-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) throw new Error(data.error || "云端配置保存失败");
      uiState.cloudUrl = data.url || url;
      uiState.cloudModel = data.model || model;
      uiState.cloudToken = "";
      uiState.cloudTokenConfigured = !!data.token_configured;
      uiState.embedCloudAvailable = !!data.test?.available;
      uiState.bgeStatus = data.test?.available
        ? `云端连接成功：${data.test.model}，${data.test.dim} 维。`
        : clearToken
          ? "云端凭据已清除。"
          : "云端配置已保存。";
      uiState.bgeStatusType = "ok";
      if (test) await loadEmbedMode();
      toast(data.test?.available ? "云端 Embedding 连接成功" : "云端配置已保存");
    } catch (error) {
      uiState.embedCloudAvailable = false;
      uiState.bgeStatus = `${test ? "连接测试" : "保存"}失败：${error.message || error}`;
      uiState.bgeStatusType = "error";
    } finally {
      uiState.cloudSaving = false;
      draw();
    }
  }

  async function clearCloudToken() {
    if (!uiState?.cloudTokenConfigured) return;
    const accepted = await window.BAA.ui?.confirm?.({
      title: "清除云端凭据",
      message: "清除后云端 Embedding 将不可用，自动模式会降级到本地模型。",
      danger: true,
    });
    if (accepted) await saveCloudConfig(false, true);
  }

  async function setEmbedMode(mode) {
    if (!uiState || uiState.embedSwitching) return;
    uiState.embedSwitching = true;
    uiState.bgeStatus = "正在切换嵌入模式…";
    uiState.bgeStatusType = "ok";
    draw();
    try {
      const resp = await fetch("/api/system/embed-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) throw new Error(data.error || "嵌入模式切换失败");
      applyEmbedInfo(data);
      const fallback = data.active === "hash" && mode !== "hash";
      uiState.bgeStatus = fallback
        ? `已选择 ${mode}，但当前回退到 Hash；请检查模型或云端连接。`
        : `已切换为 ${mode}，请重建向量库以统一已有文档向量。`;
      uiState.bgeStatusType = fallback ? "error" : "ok";
      toast("嵌入模式已切换");
    } catch (error) {
      uiState.bgeStatus = `切换失败：${error.message || error}`;
      uiState.bgeStatusType = "error";
      await loadEmbedMode();
    } finally {
      uiState.embedSwitching = false;
      draw();
    }
  }

  async function rebuildEmbeddings() {
    if (!uiState || uiState.embedRebuilding) return;
    const accepted = await window.BAA.ui?.confirm?.({
      title: "重建知识库向量",
      message: "将检查文档、结构化知识和 Skill，仅重建内容或模型发生变化的向量。",
      danger: false,
    });
    if (!accepted) return;
    uiState.embedRebuilding = true;
    uiState.bgeStatus = "正在重建知识库向量…";
    uiState.bgeStatusType = "ok";
    draw();
    try {
      const resp = await fetch("/api/system/embed-rebuild", { method: "POST" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) throw new Error(data.error || "向量重建失败");
      uiState.bgeStatus = `向量缓存已同步：文档分块 ${Number(data.document_chunks || 0)}、结构化知识 ${Number(data.structured_records || 0)}、Skill ${Number(data.skills || 0)}。`;
      uiState.bgeStatusType = "ok";
      toast("知识库向量重建完成");
    } catch (error) {
      uiState.bgeStatus = `重建失败：${error.message || error}`;
      uiState.bgeStatusType = "error";
    } finally {
      uiState.embedRebuilding = false;
      draw();
    }
  }

  function renderGeneral() {
    return Vue.h("section", { class: "app-settings-panel" }, [
      Vue.h("div", { class: "app-settings-section-title" }, "助手体验"),
      Vue.h("label", { class: "app-setting-row" }, [
        Vue.h("span", { class: "app-setting-copy" }, [
          Vue.h("strong", null, "Prompt Suggestion"),
          Vue.h("span", null, "AI 回复完成后，在输入框中以浅色提示下一步可能要问的问题。"),
        ]),
        renderSwitch(uiState.promptSuggestionEnabled, setPromptSuggestionEnabled),
      ]),
      Vue.h("label", { class: "app-setting-row" }, [
        Vue.h("span", { class: "app-setting-copy" }, [
          Vue.h("strong", null, "Teams"),
          Vue.h("span", null, "开启后 Agent 会自动构建轻量分析团队并委派子任务，以更多 token 换取准确度和速度。默认关闭。"),
        ]),
        renderSwitch(uiState.teamsEnabled, setTeamsEnabled),
      ]),
      Vue.h("label", { class: "app-setting-row" }, [
        Vue.h("span", { class: "app-setting-copy" }, [
          Vue.h("strong", null, "自动匹配 Skill"),
          Vue.h("span", null, "开启后 Agent 会根据用户提问自动检索并激活匹配的分析 Skill（SWOT、漏斗等）。关闭后仅可通过 / 命令手动激活。默认开启。"),
        ]),
        renderSwitch(uiState.autoMatchSkill, setAutoMatchSkill),
      ]),
    ]);
  }

  function renderModel() {
    const installed = uiState.bgeInstalled;
    const downloading = uiState.bgeDownloading;
    const switching = uiState.embedSwitching;
    const rebuilding = uiState.embedRebuilding;
    const cloudBusy = uiState.cloudSaving;
    const statusText = uiState.bgeStatus;
    const statusType = uiState.bgeStatusType;
    const mode = uiState.embedMode || "auto";
    const active = uiState.embedActive || "hash";
    const dim = uiState.embedDim || 384;
    const embedModel = uiState.embedModel || "";
    const cloudOk = uiState.embedCloudAvailable;
    const cloudConfigured = uiState.embedCloudConfigured;
    const cloudLabel = cloudOk ? "连接正常" : cloudConfigured ? "已配置" : "未连接";
    const localOk = uiState.embedLocalAvailable;

    const modeOptions = [
      { key: "auto", label: "自动", detail: "云端优先，失败后使用本地，再降级 Hash" },
      { key: "cloud", label: "云端", detail: "强制使用 BGE-large-zh 1024维" },
      { key: "local", label: "本地", detail: "强制使用 BGE-small-zh 512维" },
      { key: "hash", label: "Hash", detail: "384维零依赖降级模式" },
    ];
    const activeLabel = active === "cloud" ? "云端" : active === "local" ? "本地" : "Hash";
    const btnLabel = downloading ? "下载中…" : installed ? "重新下载" : "下载本地模型";
    const tokenPlaceholder = uiState.cloudTokenConfigured
      ? "已配置；留空将保留原 Token"
      : "输入 Bearer Token";

    return Vue.h("section", { class: "app-settings-panel model-settings-panel" }, [
      Vue.h("header", { class: "embed-settings-head" }, [
        Vue.h("div", null, [
          Vue.h("h3", null, "语义检索模型"),
          Vue.h("p", null, "配置云端与本地 Embedding，并选择知识库和 Skill 检索使用的后端。"),
        ]),
        Vue.h("div", { class: "embed-active-state", title: embedModel }, [
          Vue.h("span", null, "当前运行"),
          Vue.h("strong", null, `${activeLabel} · ${dim}维`),
        ]),
      ]),

      Vue.h("div", { class: "embed-provider-grid" }, [
        Vue.h("section", { class: "embed-provider-section" }, [
          Vue.h("div", { class: "embed-provider-head" }, [
            Vue.h("div", null, [
              Vue.h("strong", null, "本地模型"),
              Vue.h("span", null, "BGE-small-zh-v1.5 · 512维"),
            ]),
            Vue.h("span", { class: `bge-badge ${localOk ? "bge-badge-ok" : "bge-badge-warn"}` },
              localOk ? "可用" : "不可用"),
          ]),
          Vue.h("p", { class: "embed-provider-copy" }, "离线运行，无需网络；首次使用需下载约 91 MB 模型文件。"),
          Vue.h("button", {
            class: "btn-sm btn-sm-ghost embed-provider-action",
            type: "button",
            disabled: downloading,
            onClick: downloadBgeModel,
          }, btnLabel),
        ]),

        Vue.h("section", { class: "embed-provider-section embed-cloud-section" }, [
          Vue.h("div", { class: "embed-provider-head" }, [
            Vue.h("div", null, [
              Vue.h("strong", null, "云端服务"),
              Vue.h("span", null, "OpenAI 兼容 /v1/embeddings · 1024维"),
            ]),
            Vue.h("span", { class: `bge-badge ${cloudOk ? "bge-badge-ok" : "bge-badge-warn"}` },
              cloudLabel),
          ]),
          Vue.h("form", {
            class: "embed-cloud-form",
            onSubmit: event => { event.preventDefault(); saveCloudConfig(false); },
          }, [
            Vue.h("label", { class: "embed-config-field embed-config-field-wide" }, [
              Vue.h("span", null, "服务 URL"),
              Vue.h("input", {
                type: "url",
                value: uiState.cloudUrl,
                placeholder: "https://embed.example.com",
                onInput: event => { uiState.cloudUrl = event.target.value; },
              }),
            ]),
            Vue.h("label", { class: "embed-config-field" }, [
              Vue.h("span", null, "模型名"),
              Vue.h("input", {
                type: "text",
                value: uiState.cloudModel,
                placeholder: "bge-large-zh",
                onInput: event => { uiState.cloudModel = event.target.value; },
              }),
            ]),
            Vue.h("label", { class: "embed-config-field" }, [
              Vue.h("span", null, uiState.cloudTokenConfigured ? "Bearer Token · 已配置" : "Bearer Token"),
              Vue.h("input", {
                type: "password",
                autocomplete: "new-password",
                value: uiState.cloudToken,
                placeholder: tokenPlaceholder,
                onInput: event => { uiState.cloudToken = event.target.value; },
              }),
            ]),
            Vue.h("div", { class: "embed-cloud-actions" }, [
              uiState.cloudTokenConfigured ? Vue.h("button", {
                class: "btn-sm btn-sm-ghost embed-clear-credential",
                type: "button",
                disabled: cloudBusy,
                onClick: clearCloudToken,
              }, "清除凭据") : null,
              Vue.h("span", { class: "embed-actions-spacer" }),
              Vue.h("button", {
                class: "btn-sm btn-sm-ghost",
                type: "submit",
                disabled: cloudBusy,
              }, cloudBusy ? "处理中…" : "保存"),
              Vue.h("button", {
                class: "btn-sm btn-sm-primary",
                type: "button",
                disabled: cloudBusy,
                onClick: () => saveCloudConfig(true),
              }, cloudBusy ? "测试中…" : "保存并测试"),
            ]),
          ]),
        ]),
      ]),

      Vue.h("section", { class: "embed-mode-section" }, [
        Vue.h("div", { class: "embed-section-heading" }, [
          Vue.h("strong", null, "运行模式"),
          Vue.h("span", null, "切换后建议重建已有文档向量"),
        ]),
        Vue.h("div", { class: "embed-mode-control", role: "group", "aria-label": "嵌入模式" },
          modeOptions.map(option => Vue.h("button", {
            class: `embed-mode-option${mode === option.key ? " active" : ""}`,
            type: "button",
            disabled: switching,
            title: option.detail,
            onClick: () => setEmbedMode(option.key),
          }, [
            Vue.h("strong", null, option.label),
            Vue.h("span", null, option.key === "auto" ? "推荐" : option.key === "cloud" ? "1024维" : option.key === "local" ? "512维" : "384维"),
          ]))
        ),
        Vue.h("p", { class: "embed-mode-description" },
          modeOptions.find(option => option.key === mode)?.detail || ""),
        Vue.h("div", { class: "embed-capability-row" }, [
          Vue.h("span", { class: `bge-badge ${active !== "hash" ? "bge-badge-ok" : "bge-badge-warn"}` }, `${activeLabel} ${dim}维`),
          Vue.h("span", { class: `bge-badge ${cloudOk ? "bge-badge-ok" : "bge-badge-warn"}` }, cloudOk ? "云端可用" : cloudConfigured ? "云端已配置" : "云端不可用"),
          Vue.h("span", { class: `bge-badge ${localOk ? "bge-badge-ok" : "bge-badge-warn"}` }, localOk ? "本地可用" : "本地不可用"),
        ]),
      ]),

      Vue.h("section", { class: "embed-rebuild-section" }, [
        Vue.h("div", { class: "embed-section-heading" }, [
          Vue.h("strong", null, "向量库"),
          Vue.h("span", null, "仅同步内容或模型发生变化的知识与 Skill"),
        ]),
        Vue.h("button", {
          class: "btn-sm btn-sm-ghost",
          type: "button",
          disabled: rebuilding,
          onClick: rebuildEmbeddings,
        }, rebuilding ? "重建中…" : "重建向量库"),
      ]),

      statusText
        ? Vue.h("div", { class: `embed-status-message embed-status-${statusType}`, role: "status" }, statusText)
        : null,
    ]);
  }
  function renderHooks() {
    const hint = "示例条件：tool == 'query_data' && args.sql contains 'DROP'";
    return Vue.h("section", { class: "app-settings-panel app-hooks-panel" }, [
      Vue.h("div", { class: "app-settings-section-title" }, "Hooks"),
      Vue.h("div", { class: "app-hooks-toolbar" }, [
        Vue.h("button", { class: "btn-sm btn-sm-ghost", type: "button", disabled: uiState.hooksLoading, onClick: loadHooks }, "重新加载"),
        Vue.h("button", { class: "btn-sm btn-sm-ghost", type: "button", disabled: uiState.hooksLoading, onClick: validateHooks }, "校验"),
        Vue.h("button", { class: "btn-sm btn-sm-primary", type: "button", disabled: uiState.hooksLoading, onClick: saveHooks }, "保存"),
      ]),
      Vue.h("p", { class: "app-hooks-hint" }, "支持标准事件别名：SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PermissionRequest / SubagentStart / SubagentStop / PreCompact / PostCompact / Stop。保存后会规范化为 snake_case。"),
      Vue.h("textarea", {
        class: "app-hooks-editor",
        spellcheck: "false",
        value: uiState.hooksText,
        onInput: event => { uiState.hooksText = event.target.value; },
      }),
      Vue.h("div", { class: "app-hooks-test-row" }, [
        Vue.h("select", {
          class: "app-hooks-select",
          value: uiState.testEvent,
          onChange: event => { uiState.testEvent = event.target.value; draw(); },
        }, HOOK_EVENTS.map(event =>
          Vue.h("option", { value: event }, event)
        )),
        Vue.h("button", { class: "btn-sm btn-sm-ghost", type: "button", disabled: uiState.hooksLoading, onClick: testHooks }, "测试运行"),
        Vue.h("span", { class: "app-hooks-hint-inline" }, hint),
      ]),
      uiState.hooksStatus
        ? Vue.h("pre", { class: `app-hooks-status app-hooks-status-${uiState.hooksStatusType}` }, uiState.hooksStatus)
        : null,
    ]);
  }

  async function loadLifecycle() {
    if (!uiState || uiState.lifecycleLoading) return;
    uiState.lifecycleLoading = true;
    uiState.lifecycleStatus = "正在读取存储信息…";
    draw();
    try {
      const [settingsResponse, reportResponse, trashResponse, artifactTrashResponse, uploadTrashResponse, previewResponse, referencesResponse, uploadsResponse, workspaceResponse, auditResponse] = await Promise.all([
        fetch("/api/lifecycle/settings"),
        fetch("/api/lifecycle/report"),
        fetch("/api/lifecycle/session-trash"),
        fetch("/api/lifecycle/artifact-trash"),
        fetch("/api/lifecycle/upload-trash"),
        fetch("/api/lifecycle/artifacts/preview"),
        fetch("/api/lifecycle/artifacts/references/preview"),
        fetch("/api/lifecycle/uploads/preview"),
        fetch("/api/lifecycle/workspaces/preview"),
        fetch("/api/lifecycle/audit?limit=50"),
      ]);
      const settingsData = await settingsResponse.json();
      const reportData = await reportResponse.json();
      const trashData = await trashResponse.json();
      const artifactTrashData = await artifactTrashResponse.json();
      const uploadTrashData = await uploadTrashResponse.json();
      const previewData = await previewResponse.json();
      const referencesData = await referencesResponse.json();
      const uploadsData = await uploadsResponse.json();
      const workspaceData = await workspaceResponse.json();
      const auditData = await auditResponse.json();
      if (!settingsResponse.ok || !settingsData.ok) throw new Error(settingsData.error || "读取生命周期设置失败");
      if (!reportResponse.ok || !reportData.ok) throw new Error(reportData.error || "读取存储统计失败");
      if (!trashResponse.ok || !trashData.ok) throw new Error(trashData.error || "读取会话回收站失败");
      if (!artifactTrashResponse.ok || !artifactTrashData.ok) throw new Error(artifactTrashData.error || "读取产物回收站失败");
      if (!uploadTrashResponse.ok || !uploadTrashData.ok) throw new Error(uploadTrashData.error || "读取上传回收站失败");
      if (!previewResponse.ok || !previewData.ok) throw new Error(previewData.error || "读取产物扫描失败");
      if (!referencesResponse.ok || !referencesData.ok) throw new Error(referencesData.error || "读取产物引用失败");
      if (!uploadsResponse.ok || !uploadsData.ok) throw new Error(uploadsData.error || "读取上传分类失败");
      if (!workspaceResponse.ok || !workspaceData.ok) throw new Error(workspaceData.error || "读取工作区存储失败");
      if (!auditResponse.ok || !auditData.ok) throw new Error(auditData.error || "读取生命周期审计失败");
      uiState.lifecycleRetentionPreset = settingsData.settings?.retention_preset || uiState.lifecycleRetentionPreset;
      uiState.lifecycleRetentionCustomDays = settingsData.settings?.retention_custom_days ?? uiState.lifecycleRetentionCustomDays;
      uiState.lifecycleReport = reportData.report;
      uiState.lifecycleTrash = trashData.items || [];
      uiState.lifecycleArtifactTrash = artifactTrashData.items || [];
      uiState.lifecycleUploadTrash = uploadTrashData.items || [];
      uiState.lifecyclePreview = previewData.preview || null;
      uiState.lifecycleReferencePreview = referencesData.preview || null;
      uiState.lifecycleUploadsPreview = uploadsData.preview || null;
      uiState.lifecycleWorkspacePreview = workspaceData.preview || null;
      uiState.lifecycleAudit = auditData.items || [];
      uiState.lifecycleStatus = "";
    } catch (error) {
      uiState.lifecycleStatus = `读取失败：${error.message || error}`;
    } finally {
      uiState.lifecycleLoading = false;
      draw();
    }
  }

  function lifecycleRetentionDaysValue() {
    if (!uiState) return 30;
    if (uiState.lifecycleRetentionPreset === "forever") return null;
    if (["7", "14"].includes(uiState.lifecycleRetentionPreset)) {
      return Number(uiState.lifecycleRetentionPreset);
    }
    return Number(uiState.lifecycleRetentionCustomDays);
  }

  async function saveLifecycleSettings() {
    if (!uiState) return;
    const response = await fetch("/api/lifecycle/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        retention_preset: uiState.lifecycleRetentionPreset,
        retention_custom_days: uiState.lifecycleRetentionCustomDays,
      }),
    });
    const data = await parseLifecycleResponse(response, "保存生命周期设置失败");
    uiState.lifecycleRetentionPreset = data.settings.retention_preset;
    uiState.lifecycleRetentionCustomDays = data.settings.retention_custom_days;
  }

  async function setLifecycleRetentionPreset(value) {
    if (!uiState) return;
    uiState.lifecycleRetentionPreset = value;
    uiState.lifecycleStatus = "正在保存保留策略…";
    draw();
    try {
      await saveLifecycleSettings();
      uiState.lifecycleStatus = "保留策略已保存。";
    } catch (error) {
      uiState.lifecycleStatus = `保存失败：${error.message || error}`;
    } finally {
      draw();
    }
  }

  async function saveLifecycleSettingsFromUi() {
    if (!uiState) return;
    uiState.lifecycleStatus = "正在保存保留策略…";
    draw();
    try {
      await saveLifecycleSettings();
      uiState.lifecycleStatus = "保留策略已保存。";
    } catch (error) {
      uiState.lifecycleStatus = `保存失败：${error.message || error}`;
    } finally {
      draw();
    }
  }

  async function reclaimLifecycle() {
    if (!uiState || uiState.lifecycleReclaiming) return;
    const retentionDays = lifecycleRetentionDaysValue();
    if (retentionDays === null) {
      uiState.lifecycleStatus = "当前选择永久保留，会话回收站不会过期清理。";
      draw();
      return;
    }
    if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650) {
      uiState.lifecycleStatus = "自定义保留天数必须是 0 到 3650 的整数";
      draw();
      return;
    }
    const accepted = await window.BAA.ui?.confirm?.({
      title: "永久清理过期会话",
      message: `将永久清理已在会话回收站保留超过 ${retentionDays} 天的文件。此操作不可恢复。`,
      danger: true,
    });
    if (!accepted) return;
    uiState.lifecycleReclaiming = true;
    uiState.lifecycleStatus = "正在清理…";
    draw();
    try {
      const response = await fetch("/api/lifecycle/session-trash/reclaim", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retention_days: retentionDays }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "清理失败");
      uiState.lifecycleStatus = `已清理 ${data.summary.groups || 0} 组、${data.summary.files || 0} 个文件。`;
      await loadLifecycle();
    } catch (error) {
      uiState.lifecycleStatus = `清理失败：${error.message || error}`;
    } finally {
      uiState.lifecycleReclaiming = false;
      draw();
    }
  }

  async function restoreLifecycle(trashId) {
    if (!uiState) return;
    uiState.lifecycleStatus = "正在恢复会话…";
    draw();
    try {
      const response = await fetch(`/api/lifecycle/session-trash/${encodeURIComponent(trashId)}/restore`, { method: "POST" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "恢复失败");
      uiState.lifecycleStatus = `已恢复 ${data.summary.restored.length} 个会话文件。`;
      await loadLifecycle();
    } catch (error) {
      uiState.lifecycleStatus = `恢复失败：${error.message || error}`;
      draw();
    }
  }

  async function parseLifecycleResponse(response, fallbackMessage) {
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      if (response.status === 404) {
        throw new Error("生命周期接口未加载，请重启应用后再试");
      }
      throw new Error(fallbackMessage || `接口返回异常：HTTP ${response.status}`);
    }
    if (!response.ok || !data.ok) {
      throw new Error(data.error || fallbackMessage || `请求失败：HTTP ${response.status}`);
    }
    return data;
  }

  async function recycleUnregisteredArtifact(item) {
    if (!uiState || uiState.lifecycleRecyclingKey) return;
    const filename = item.filename || "未命名产物";
    const accepted = await window.BAA.ui?.confirm?.({
      title: "移入产物回收站？",
      message: `将把历史产物「${filename}」移入受控回收站。它不会立即物理删除，但历史会话或报告里引用它时可能无法打开。`,
      danger: true,
    });
    if (!accepted) return;
    const key = `${item.type || ""}:${item.relative_path || filename}`;
    uiState.lifecycleRecyclingKey = key;
    uiState.lifecycleStatus = "正在移动历史产物…";
    draw();
    try {
      const response = await fetch("/api/lifecycle/artifacts/unregistered/recycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: item.type, relative_path: item.relative_path }),
      });
      const data = await parseLifecycleResponse(response, "移动历史产物失败");
      uiState.lifecycleStatus = `已将 ${data.summary.filename || filename} 移入产物回收站。`;
      await loadLifecycle();
    } catch (error) {
      uiState.lifecycleStatus = `移动失败：${error.message || error}`;
      draw();
    } finally {
      uiState.lifecycleRecyclingKey = "";
      draw();
    }
  }

  async function recycleRegisteredArtifact(item) {
    if (!uiState || uiState.lifecycleRecyclingKey) return;
    const filename = item.filename || item.id || "已登记产物";
    const accepted = await window.BAA.ui?.confirm?.({
      title: "回收已登记产物？",
      message: `将把「${filename}」移入产物回收站。当前只允许未发现引用的 chart/export/report 候选，且不会立即物理删除。`,
      danger: true,
    });
    if (!accepted) return;
    const key = `registered:${item.id || filename}`;
    uiState.lifecycleRecyclingKey = key;
    uiState.lifecycleStatus = "正在移动已登记产物…";
    draw();
    try {
      const response = await fetch("/api/lifecycle/artifacts/registered/recycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifact_id: item.id }),
      });
      const data = await parseLifecycleResponse(response, "移动已登记产物失败");
      uiState.lifecycleStatus = `已将 ${data.summary.filename || filename} 移入产物回收站。`;
      await loadLifecycle();
    } catch (error) {
      uiState.lifecycleStatus = `移动失败：${error.message || error}`;
      draw();
    } finally {
      uiState.lifecycleRecyclingKey = "";
      draw();
    }
  }

  async function recycleUploadCandidate(item) {
    if (!uiState || uiState.lifecycleRecyclingKey) return;
    const filename = item.filename || "上传文件";
    const category = item.category || "unknown_uploads";
    const accepted = await window.BAA.ui?.confirm?.({
      title: "移入上传回收站？",
      message: `将把「${filename}」移入上传回收站。仅允许未知上传或 Excel 解析缓存，知识库与已登记上传不会被处理。`,
      danger: true,
    });
    if (!accepted) return;
    const key = `upload:${item.relative_path || filename}`;
    uiState.lifecycleRecyclingKey = key;
    uiState.lifecycleStatus = "正在移动上传文件…";
    draw();
    try {
      const response = await fetch("/api/lifecycle/uploads/recycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, relative_path: item.relative_path }),
      });
      const data = await parseLifecycleResponse(response, "移动上传文件失败");
      uiState.lifecycleStatus = `已将 ${data.summary.filename || filename} 移入上传回收站。`;
      await loadLifecycle();
    } catch (error) {
      uiState.lifecycleStatus = `移动失败：${error.message || error}`;
      draw();
    } finally {
      uiState.lifecycleRecyclingKey = "";
      draw();
    }
  }

  async function restoreArtifactTrash(trashId) {
    if (!uiState || uiState.lifecycleArtifactBusyKey) return;
    uiState.lifecycleArtifactBusyKey = trashId;
    uiState.lifecycleStatus = "正在恢复产物…";
    draw();
    try {
      const response = await fetch(`/api/lifecycle/artifact-trash/${encodeURIComponent(trashId)}/restore`, { method: "POST" });
      const data = await parseLifecycleResponse(response, "恢复产物失败");
      uiState.lifecycleStatus = `已恢复 ${data.summary.restored.length} 个产物。`;
      await loadLifecycle();
    } catch (error) {
      uiState.lifecycleStatus = `恢复产物失败：${error.message || error}`;
      draw();
    } finally {
      uiState.lifecycleArtifactBusyKey = "";
      draw();
    }
  }

  async function reclaimArtifactTrash() {
    if (!uiState || uiState.lifecycleArtifactReclaiming) return;
    const retentionDays = lifecycleRetentionDaysValue();
    if (retentionDays === null) {
      uiState.lifecycleStatus = "当前选择永久保留，产物回收站不会过期清理。";
      draw();
      return;
    }
    if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650) {
      uiState.lifecycleStatus = "自定义保留天数必须是 0 到 3650 的整数";
      draw();
      return;
    }
    const accepted = await window.BAA.ui?.confirm?.({
      title: "永久清理过期产物",
      message: `将永久清理已在产物回收站保留超过 ${retentionDays} 天的文件。此操作不可恢复。`,
      danger: true,
    });
    if (!accepted) return;
    uiState.lifecycleArtifactReclaiming = true;
    uiState.lifecycleStatus = "正在清理产物回收站…";
    draw();
    try {
      const response = await fetch("/api/lifecycle/artifact-trash/reclaim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retention_days: retentionDays }),
      });
      const data = await parseLifecycleResponse(response, "清理产物回收站失败");
      uiState.lifecycleStatus = `已清理 ${data.summary.groups || 0} 组、${data.summary.files || 0} 个产物文件。`;
      await loadLifecycle();
    } catch (error) {
      uiState.lifecycleStatus = `清理产物失败：${error.message || error}`;
      draw();
    } finally {
      uiState.lifecycleArtifactReclaiming = false;
      draw();
    }
  }

  async function clearSessionTrash() {
    if (!uiState || uiState.lifecycleReclaiming) return;
    const accepted = await window.BAA.ui?.confirm?.({
      title: "清空会话回收站？",
      message: "将永久删除会话回收站中的所有项目。此操作不可恢复。",
      danger: true,
    });
    if (!accepted) return;
    uiState.lifecycleReclaiming = true;
    uiState.lifecycleStatus = "正在清空会话回收站…";
    draw();
    try {
      const response = await fetch("/api/lifecycle/session-trash/reclaim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retention_days: 0 }),
      });
      const data = await parseLifecycleResponse(response, "清空会话回收站失败");
      uiState.lifecycleStatus = `已清空 ${data.summary.groups || 0} 组、${data.summary.files || 0} 个会话文件。`;
      await loadLifecycle();
    } catch (error) {
      uiState.lifecycleStatus = `清空会话失败：${error.message || error}`;
      draw();
    } finally {
      uiState.lifecycleReclaiming = false;
      draw();
    }
  }

  async function clearArtifactTrash() {
    if (!uiState || uiState.lifecycleArtifactReclaiming) return;
    const accepted = await window.BAA.ui?.confirm?.({
      title: "清空产物回收站？",
      message: "将永久删除产物回收站中的所有项目，并同步清理已登记产物记录。此操作不可恢复。",
      danger: true,
    });
    if (!accepted) return;
    uiState.lifecycleArtifactReclaiming = true;
    uiState.lifecycleStatus = "正在清空产物回收站…";
    draw();
    try {
      const response = await fetch("/api/lifecycle/artifact-trash/reclaim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retention_days: 0 }),
      });
      const data = await parseLifecycleResponse(response, "清空产物回收站失败");
      uiState.lifecycleStatus = `已清空 ${data.summary.groups || 0} 组、${data.summary.files || 0} 个产物文件。`;
      await loadLifecycle();
    } catch (error) {
      uiState.lifecycleStatus = `清空产物失败：${error.message || error}`;
      draw();
    } finally {
      uiState.lifecycleArtifactReclaiming = false;
      draw();
    }
  }

  async function restoreUploadTrash(trashId) {
    if (!uiState || uiState.lifecycleUploadBusyKey) return;
    uiState.lifecycleUploadBusyKey = trashId;
    uiState.lifecycleStatus = "正在恢复上传文件…";
    draw();
    try {
      const response = await fetch(`/api/lifecycle/upload-trash/${encodeURIComponent(trashId)}/restore`, { method: "POST" });
      const data = await parseLifecycleResponse(response, "恢复上传文件失败");
      uiState.lifecycleStatus = `已恢复 ${data.summary.restored.length} 个上传文件。`;
      await loadLifecycle();
    } catch (error) {
      uiState.lifecycleStatus = `恢复上传失败：${error.message || error}`;
      draw();
    } finally {
      uiState.lifecycleUploadBusyKey = "";
      draw();
    }
  }

  async function clearUploadTrash() {
    if (!uiState || uiState.lifecycleUploadReclaiming) return;
    const accepted = await window.BAA.ui?.confirm?.({
      title: "清空上传回收站？",
      message: "将永久删除上传回收站中的所有项目。此操作不可恢复。",
      danger: true,
    });
    if (!accepted) return;
    uiState.lifecycleUploadReclaiming = true;
    uiState.lifecycleStatus = "正在清空上传回收站…";
    draw();
    try {
      const response = await fetch("/api/lifecycle/upload-trash/reclaim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retention_days: 0 }),
      });
      const data = await parseLifecycleResponse(response, "清空上传回收站失败");
      uiState.lifecycleStatus = `已清空 ${data.summary.groups || 0} 组、${data.summary.files || 0} 个上传文件。`;
      await loadLifecycle();
    } catch (error) {
      uiState.lifecycleStatus = `清空上传失败：${error.message || error}`;
      draw();
    } finally {
      uiState.lifecycleUploadReclaiming = false;
      draw();
    }
  }

  function formatLifecycleBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let size = bytes; let index = -1;
    do { size /= 1024; index += 1; } while (size >= 1024 && index < units.length - 1);
    return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`;
  }

  function lifecycleAuditLabel(event) {
    return LIFECYCLE_AUDIT_LABELS[event] || event || "unknown";
  }

  function lifecycleAuditDetails(item) {
    const details = [];
    if (item.session_id) details.push(`会话 ${item.session_id}`);
    if (item.artifact_id) details.push(`产物 ${item.artifact_id}`);
    if (item.type) details.push(`类型 ${item.type}`);
    if (item.workspace_id) details.push(`Workspace ${item.workspace_id}`);
    if (Number.isFinite(Number(item.size_bytes))) details.push(formatLifecycleBytes(item.size_bytes));
    if (Number.isFinite(Number(item.files))) details.push(`${item.files} 个文件`);
    if (Number.isFinite(Number(item.bytes))) details.push(formatLifecycleBytes(item.bytes));
    if (Number.isFinite(Number(item.groups))) details.push(`${item.groups} 组`);
    if (Number.isFinite(Number(item.retention_days))) details.push(`保留 ${item.retention_days} 天`);
    if (Array.isArray(item.deleted) && item.deleted.length) details.push(`删除 ${item.deleted.length} 项`);
    if (Array.isArray(item.restored) && item.restored.length) details.push(`恢复 ${item.restored.length} 项`);
    if (Array.isArray(item.failed) && item.failed.length) details.push(`失败 ${item.failed.length} 项`);
    return details.join(" · ");
  }

  function renderStorage() {
    const report = uiState.lifecycleReport || { locations: {}, total_files: 0, total_bytes: 0 };
    const items = uiState.lifecycleTrash || [];
    const artifactTrash = uiState.lifecycleArtifactTrash || [];
    const uploadTrash = uiState.lifecycleUploadTrash || [];
    const preview = uiState.lifecyclePreview || { unknown_files: [], unknown_bytes: 0, missing_registered_ids: [] };
    const referencePreview = uiState.lifecycleReferencePreview || { registered: 0, referenced: 0, unreferenced: 0, missing: 0, unreferenced_samples: [], missing_samples: [], reference_sources: 0 };
    const unknownFiles = Array.isArray(preview.unknown_files) ? preview.unknown_files : [];
    const missingRegistered = Array.isArray(preview.missing_registered_ids) ? preview.missing_registered_ids : [];
    const unreferencedRegistered = Array.isArray(referencePreview.unreferenced_samples) ? referencePreview.unreferenced_samples : [];
    const missingRegisteredSamples = Array.isArray(referencePreview.missing_samples) ? referencePreview.missing_samples : [];
    const uploadsPreview = uiState.lifecycleUploadsPreview || { categories: {}, samples: [], cache_samples: [], missing_registered_upload_ids: [] };
    const uploadCategories = uploadsPreview.categories || {};
    const unknownUploadSamples = Array.isArray(uploadsPreview.samples) ? uploadsPreview.samples : [];
    const cacheUploadSamples = Array.isArray(uploadsPreview.cache_samples) ? uploadsPreview.cache_samples : [];
    const workspacePreview = uiState.lifecycleWorkspacePreview || { workspaces: [], total_bytes: 0 };
    const workspaceItems = Array.isArray(workspacePreview.workspaces) ? workspacePreview.workspaces : [];
    const auditAll = Array.isArray(uiState.lifecycleAudit) ? uiState.lifecycleAudit : [];
    const audit = uiState.lifecycleAuditFilter === "all" ? auditAll : auditAll.filter(item => String(item.event || "").includes(uiState.lifecycleAuditFilter));
    const locations = report.locations || {};
    const uploads = locations.uploads || { files: 0, bytes: 0 };
    const retentionDays = lifecycleRetentionDaysValue();
    const retentionForever = retentionDays === null;
    const customRetentionInvalid = !retentionForever && (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650);
    const isExpiredTrash = item => {
      if (retentionForever || customRetentionInvalid) return false;
      const deletedAt = Date.parse(item.deleted_at || "");
      if (!Number.isFinite(deletedAt)) return false;
      return Date.now() - deletedAt >= retentionDays * 86400000;
    };
    const expiredTrash = items.filter(isExpiredTrash);
    const expiredArtifactTrash = artifactTrash.filter(isExpiredTrash);
    const expiredTrashBytes = expiredTrash.reduce((total, item) => total + Number(item.bytes || 0), 0);
    const expiredArtifactTrashBytes = expiredArtifactTrash.reduce((total, item) => total + Number(item.bytes || 0), 0);
    const trashBytes = items.reduce((total, item) => total + Number(item.bytes || 0), 0);
    const artifactTrashBytes = artifactTrash.reduce((total, item) => total + Number(item.bytes || 0), 0);
    const uploadTrashBytes = uploadTrash.reduce((total, item) => total + Number(item.bytes || 0), 0);
    const metricCards = [
      { label: "目录总占用", value: formatLifecycleBytes(report.total_bytes), note: `${report.total_files || 0} 个文件 · 不是可清理量`, tone: "primary" },
      { label: "会话回收站", value: formatLifecycleBytes(trashBytes), note: retentionForever ? `${items.length} 组 · 永久保留` : `${items.length} 组 · ${expiredTrash.length} 组已过期`, tone: expiredTrash.length ? "danger" : "muted" },
      { label: "产物回收站", value: formatLifecycleBytes(artifactTrashBytes), note: retentionForever ? `${artifactTrash.length} 项 · 永久保留` : `${artifactTrash.length} 项 · ${expiredArtifactTrash.length} 项已过期`, tone: expiredArtifactTrash.length ? "danger" : "muted" },
      { label: "上传回收站", value: formatLifecycleBytes(uploadTrashBytes), note: `${uploadTrash.length} 项 · 可恢复`, tone: uploadTrash.length ? "warn" : "muted" },
      { label: "已登记产物", value: String(referencePreview.registered || 0), note: `${referencePreview.unreferenced || 0} 个候选 · ${referencePreview.missing || 0} 个缺失`, tone: referencePreview.unreferenced ? "warn" : "muted" },
      { label: "历史产物待识别", value: formatLifecycleBytes(preview.unknown_bytes), note: `${unknownFiles.length} 个 · charts / exports`, tone: unknownFiles.length ? "warn" : "muted" },
      { label: "上传文件", value: formatLifecycleBytes(uploads.bytes), note: `${uploads.files || 0} 个 · ${uploadCategories.unknown_uploads?.files || 0} 个待识别`, tone: "protected" },
    ];

    const section = (title, description, actions, children, extraClass = "") => Vue.h("section", { class: `lifecycle-card ${extraClass}` }, [
      Vue.h("div", { class: "lifecycle-section-heading" }, [
        Vue.h("div", null, [
          Vue.h("div", { class: "app-settings-section-title" }, title),
          description ? Vue.h("p", { class: "lifecycle-copy lifecycle-card-copy" }, description) : null,
        ]),
        actions ? Vue.h("div", { class: "lifecycle-preview-actions" }, Array.isArray(actions) ? actions : [actions]) : null,
      ]),
      ...children,
    ]);

    const previewList = (caption, rows, renderRow, emptyText = "暂无数据") => rows.length
      ? Vue.h("div", { class: "lifecycle-preview-list" }, [
        Vue.h("div", { class: "lifecycle-list-caption" }, caption),
        ...rows.map(renderRow),
      ])
      : Vue.h("div", { class: "lifecycle-empty lifecycle-empty-compact" }, emptyText);

    const uploadCandidateRow = (item, index) => {
      const key = `upload:${item.relative_path || item.filename || index}`;
      const recycling = uiState.lifecycleRecyclingKey === key;
      return Vue.h("div", { class: "lifecycle-preview-item", key }, [
        Vue.h("span", { title: item.relative_path || item.filename || "" }, item.filename || "上传文件"),
        Vue.h("div", { class: "lifecycle-preview-actions" }, [
          Vue.h("small", null, formatLifecycleBytes(item.size_bytes)),
          Vue.h("button", { class: "btn-sm btn-sm-danger", type: "button", disabled: recycling || uiState.lifecycleLoading, onClick: () => recycleUploadCandidate(item) }, recycling ? "移动中…" : "删除"),
        ]),
      ]);
    };

    const recycleBinRow = (item, restoreFn, busyKey, labelFallback) => Vue.h("div", { class: "lifecycle-trash-item", key: item.id }, [
      Vue.h("div", null, [
        Vue.h("strong", null, item.filename || item.source_filename || labelFallback),
        Vue.h("small", null, `${item.deleted_at || ""} · ${item.category || item.type || `${item.files || 0} 个`} · ${formatLifecycleBytes(item.bytes)} · ${isExpiredTrash(item) ? "已过期" : "可恢复"}`),
      ]),
      Vue.h("button", { class: "btn-sm btn-sm-ghost", type: "button", disabled: busyKey === item.id, onClick: () => restoreFn(item.id) }, busyKey === item.id ? "恢复中…" : "恢复"),
    ]);

    const recycleBin = (title, rows, clearAction, clearBusy, restoreFn, busyKey, labelFallback, extraActions = []) => section(
      title,
      "可恢复；一键删除会永久清空该回收站。",
      [
        ...extraActions,
        Vue.h("button", { class: "btn-sm btn-sm-danger", type: "button", disabled: clearBusy || !rows.length, title: rows.length ? `永久删除${title}全部项目` : `${title}为空`, onClick: clearAction }, "一键删除"),
      ],
      [rows.length ? Vue.h("div", { class: "lifecycle-trash-list" }, rows.map(item => recycleBinRow(item, restoreFn, busyKey, labelFallback))) : Vue.h("div", { class: "lifecycle-empty" }, `${title}为空`)],
      "lifecycle-card-recycle",
    );

    const protectedRows = [
      ...Object.entries(locations).map(([name, value]) => [name, `${value.files || 0} 个 · ${formatLifecycleBytes(value.bytes)}`]),
      ...workspaceItems.map(item => [item.name, item.db_exists ? `${formatLifecycleBytes(item.db_bytes)} · ${item.active_lease_count ? "任务使用中" : "已保护"}` : "未发现 DuckDB 文件"]),
    ];

    const uploadCategoryRows = [
      ["registered_uploads", "已登记上传"],
      ["knowledge", "知识库数据"],
      ["parsed_excel_cache", "Excel 解析缓存"],
      ["unknown_uploads", "未知上传"],
    ];

    return Vue.h("section", { class: "app-settings-panel lifecycle-panel lifecycle-redesigned" }, [
      Vue.h("div", { class: "lifecycle-hero lifecycle-hero-redesigned" }, [
        Vue.h("div", null, [
          Vue.h("div", { class: "lifecycle-kicker" }, "Storage lifecycle"),
          Vue.h("div", { class: "app-settings-section-title lifecycle-title" }, "本地数据存储"),
          Vue.h("p", { class: "lifecycle-copy" }, "把本地文件分成可回收、需确认和受保护三类。回收站支持恢复；永久删除必须手动确认。"),
        ]),
        Vue.h("button", { class: "btn-sm btn-sm-primary", type: "button", disabled: uiState.lifecycleLoading, onClick: loadLifecycle }, uiState.lifecycleLoading ? "刷新中…" : "刷新统计"),
      ]),

      Vue.h("div", { class: "lifecycle-metric-grid" }, metricCards.map(card => Vue.h("div", { class: `lifecycle-metric-card lifecycle-metric-${card.tone}`, key: card.label }, [
        Vue.h("span", null, card.label),
        Vue.h("strong", null, card.value),
        Vue.h("small", null, card.note),
      ]))),

      section("保留策略", "控制会话、产物和上传回收站的过期清理口径；一键删除会忽略保留期并永久清空对应回收站。", [
        Vue.h("label", { class: "lifecycle-retention-field" }, [
          Vue.h("span", null, "保留策略"),
          Vue.h("select", { class: "lifecycle-retention-select", value: uiState.lifecycleRetentionPreset, onChange: event => setLifecycleRetentionPreset(event.target.value) }, [
            Vue.h("option", { value: "7" }, "7 天"),
            Vue.h("option", { value: "14" }, "14 天"),
            Vue.h("option", { value: "forever" }, "永久"),
            Vue.h("option", { value: "custom" }, "自定义"),
          ]),
          uiState.lifecycleRetentionPreset === "custom" ? Vue.h("input", { class: "lifecycle-days", type: "number", min: 0, max: 3650, value: uiState.lifecycleRetentionCustomDays, onInput: event => { uiState.lifecycleRetentionCustomDays = event.target.value; draw(); }, onChange: saveLifecycleSettingsFromUi }) : null,
        ]),
        Vue.h("button", { class: "btn-sm btn-sm-danger", type: "button", disabled: uiState.lifecycleReclaiming || retentionForever || customRetentionInvalid || !expiredTrash.length, title: retentionForever ? "当前选择永久保留，不会清理会话回收站" : customRetentionInvalid ? "自定义天数需为 0 到 3650 的整数" : expiredTrash.length ? "永久删除超过保留策略的会话回收站文件" : "当前没有过期的会话回收站文件", onClick: reclaimLifecycle }, retentionForever ? "永久保留会话" : `清理过期会话 · ${formatLifecycleBytes(expiredTrashBytes)}`),
      ], [uiState.lifecycleStatus ? Vue.h("div", { class: "lifecycle-status" }, uiState.lifecycleStatus) : null]),

      Vue.h("div", { class: "lifecycle-two-column" }, [
        section("可清理候选", "这些项目可以手动移入回收站。未知不等于垃圾；删除前请看文件名和来源。", null, [
          Vue.h("div", { class: "lifecycle-subsection" }, [
            Vue.h("div", { class: "lifecycle-inline-title" }, "Uploads"),
            Vue.h("div", { class: "lifecycle-location-list" }, uploadCategoryRows.map(([key, label]) => {
              const value = uploadCategories[key] || { files: 0, bytes: 0 };
              return Vue.h("div", { class: "lifecycle-row", key }, [Vue.h("span", null, label), Vue.h("span", null, `${value.files || 0} 个 · ${formatLifecycleBytes(value.bytes)}`)]);
            })),
            previewList(`未知上传前 ${Math.min(20, unknownUploadSamples.length)} 项`, unknownUploadSamples, uploadCandidateRow, "没有未知上传"),
            previewList(`Excel 解析缓存前 ${Math.min(20, cacheUploadSamples.length)} 项`, cacheUploadSamples, uploadCandidateRow, "没有 Excel 解析缓存"),
          ]),
          Vue.h("div", { class: "lifecycle-subsection" }, [
            Vue.h("div", { class: "lifecycle-inline-title" }, "历史 charts / exports"),
            Vue.h("p", { class: "lifecycle-copy" }, `发现 ${unknownFiles.length} 个未登记历史产物（${formatLifecycleBytes(preview.unknown_bytes)}），已登记但缺失 ${missingRegistered.length} 个。`),
            previewList(`未登记历史产物前 ${Math.min(20, unknownFiles.length)} 项`, unknownFiles.slice(0, 20), (item, index) => {
              const key = `${item.type || "artifact"}:${item.relative_path || item.filename || index}`;
              const recycling = uiState.lifecycleRecyclingKey === key;
              return Vue.h("div", { class: "lifecycle-preview-item", key }, [
                Vue.h("span", { title: item.relative_path || item.filename || "" }, `${item.type || "unknown"} · ${item.filename || "未命名产物"}`),
                Vue.h("div", { class: "lifecycle-preview-actions" }, [
                  Vue.h("small", null, formatLifecycleBytes(item.size_bytes)),
                  Vue.h("button", { class: "btn-sm btn-sm-danger", type: "button", disabled: recycling || uiState.lifecycleLoading, onClick: () => recycleUnregisteredArtifact(item) }, recycling ? "移动中…" : "删除"),
                ]),
              ]);
            }, "没有未登记历史产物"),
          ]),
          Vue.h("div", { class: "lifecycle-subsection" }, [
            Vue.h("div", { class: "lifecycle-inline-title" }, "已登记产物引用"),
            Vue.h("p", { class: "lifecycle-copy" }, `扫描 ${referencePreview.reference_sources || 0} 个会话文件：已登记 ${referencePreview.registered || 0} 个，发现引用 ${referencePreview.referenced || 0} 个，未发现引用 ${referencePreview.unreferenced || 0} 个，文件缺失 ${referencePreview.missing || 0} 个。`),
            previewList(`未发现引用前 ${Math.min(20, unreferencedRegistered.length)} 项`, unreferencedRegistered, (item, index) => {
              const key = `registered:${item.id || index}`;
              const recycling = uiState.lifecycleRecyclingKey === key;
              return Vue.h("div", { class: "lifecycle-preview-item", key }, [
                Vue.h("span", { title: item.id || item.filename || "" }, `${item.type || "artifact"} · ${item.filename || item.id || "未命名产物"}`),
                Vue.h("div", { class: "lifecycle-preview-actions" }, [
                  Vue.h("small", null, formatLifecycleBytes(item.size_bytes)),
                  ["chart", "export", "report"].includes(item.type) ? Vue.h("button", { class: "btn-sm btn-sm-danger", type: "button", disabled: recycling || uiState.lifecycleLoading, onClick: () => recycleRegisteredArtifact(item) }, recycling ? "移动中…" : "回收") : null,
                ]),
              ]);
            }, "没有未发现引用的已登记产物"),
            previewList(`缺失记录前 ${Math.min(20, missingRegisteredSamples.length)} 项`, missingRegisteredSamples, (item, index) => Vue.h("div", { class: "lifecycle-preview-item", key: `${item.id || index}` }, [
              Vue.h("span", { title: item.id || item.filename || "" }, `${item.type || "artifact"} · ${item.filename || item.id || "缺失产物"}`),
              Vue.h("small", null, formatLifecycleBytes(item.size_bytes)),
            ]), "没有缺失的已登记产物"),
          ]),
        ]),

        section("数据统计", "展示各类本地数据的占用情况。知识库请通过知识库管理删除，Workspace 请通过工作区流程删除。", Vue.h("span", { class: "lifecycle-badge lifecycle-badge-protected" }, "分类统计"), [
          Vue.h("div", { class: "lifecycle-location-list" }, protectedRows.map(([label, value]) => Vue.h("div", { class: "lifecycle-row", key: label }, [Vue.h("span", null, label), Vue.h("span", null, value)]))),
        ], "lifecycle-card-stats"),
      ]),

      section("回收站", "回收站里的项目可恢复；一键删除会永久清空对应回收站。", null, [
        Vue.h("div", { class: "lifecycle-recycle-grid" }, [
          recycleBin("上传回收站", uploadTrash, clearUploadTrash, uiState.lifecycleUploadReclaiming, restoreUploadTrash, uiState.lifecycleUploadBusyKey, "已回收上传"),
          recycleBin("产物回收站", artifactTrash, clearArtifactTrash, uiState.lifecycleArtifactReclaiming, restoreArtifactTrash, uiState.lifecycleArtifactBusyKey, "已回收产物", [
            Vue.h("button", { class: "btn-sm btn-sm-danger", type: "button", disabled: uiState.lifecycleArtifactReclaiming || retentionForever || customRetentionInvalid || !expiredArtifactTrash.length, onClick: reclaimArtifactTrash }, retentionForever ? "永久保留产物" : `清理过期 · ${formatLifecycleBytes(expiredArtifactTrashBytes)}`),
          ]),
          recycleBin("会话回收站", items, clearSessionTrash, uiState.lifecycleReclaiming, restoreLifecycle, "", "已删除会话"),
        ]),
      ]),

      section("生命周期记录", "记录最近的登记、回收、恢复和清理操作；API 会隐藏本地绝对路径。", [
        Vue.h("select", { class: "lifecycle-retention-select", value: uiState.lifecycleAuditFilter, onChange: event => { uiState.lifecycleAuditFilter = event.target.value; draw(); } }, [
          Vue.h("option", { value: "all" }, "全部"),
          Vue.h("option", { value: "session" }, "会话"),
          Vue.h("option", { value: "artifact" }, "产物"),
          Vue.h("option", { value: "reclaim" }, "清理"),
        ]),
        Vue.h("button", { class: "btn-sm btn-sm-ghost", type: "button", disabled: uiState.lifecycleLoading, onClick: loadLifecycle }, "刷新"),
      ], [audit.length ? Vue.h("div", { class: "lifecycle-audit-list" }, audit.map((item, index) => {
        const detail = lifecycleAuditDetails(item);
        return Vue.h("div", { class: "lifecycle-audit-item", key: `${item.at || ""}-${item.event || index}` }, [
          Vue.h("div", { class: "lifecycle-audit-main" }, [
            Vue.h("span", null, lifecycleAuditLabel(item.event)),
            detail ? Vue.h("em", null, detail) : null,
          ]),
          Vue.h("small", null, item.at || ""),
        ]);
      })) : Vue.h("div", { class: "lifecycle-empty" }, "暂无生命周期记录")]),
    ]);
  }
  function renderApp() {
    if (!root) return;
    const tabs = [
      ["general", "通用"],
      ["model", "模型"],
      ["hooks", "Hooks"],
      ["storage", "存储"],
    ];
    Vue.render(Vue.h("div", { class: "app-settings-layout" }, [
      Vue.h("aside", { class: "app-settings-nav", "aria-label": "Settings sections" }, tabs.map(([id, label]) =>
        Vue.h("button", {
          class: `app-settings-nav-item${uiState.tab === id ? " active" : ""}`,
          type: "button",
          onClick: () => { uiState.tab = id; draw(); if (id === "storage") loadLifecycle(); },
        }, label)
      )),
      uiState.tab === "storage" ? renderStorage()
        : uiState.tab === "hooks" ? renderHooks()
        : uiState.tab === "model" ? renderModel()
        : renderGeneral(),
    ]), root);
  }

  function init() {
    appState.promptSuggestionEnabled = _enabledFromStorage();
    appState.teamsEnabled = _teamsEnabledFromStorage();
    appState.autoMatchSkill = _autoMatchSkillFromStorage();
    if (!root || !Vue?.h || !Vue?.render || !Vue?.reactive) return;
    uiState = Vue.reactive({
      tab: "general",
      promptSuggestionEnabled: appState.promptSuggestionEnabled,
      teamsEnabled: appState.teamsEnabled,
      autoMatchSkill: appState.autoMatchSkill,
      hooksText: DEFAULT_HOOKS_TEXT,
      hooksStatus: "",
      hooksStatusType: "ok",
      hooksLoading: false,
      testEvent: "turn_start",
      bgeInstalled: false,
      bgeNeural: false,
      bgeDownloading: false,
      bgeStatus: "",
      bgeStatusType: "ok",
      embedMode: "auto",
      embedActive: "hash",
      embedDim: 384,
      embedModel: "",
      embedCloudUrl: "",
      embedCloudAvailable: false,
      embedCloudConfigured: false,
      embedCloudStatus: "unavailable",
      embedLocalAvailable: false,
      embedSwitching: false,
      embedRebuilding: false,
      cloudUrl: "https://embed.zafer-liu-product.xyz",
      cloudModel: "bge-large-zh",
      cloudToken: "",
      cloudTokenConfigured: false,
      cloudSaving: false,
      lifecycleReport: null,
      lifecycleTrash: [],
      lifecycleArtifactTrash: [],
      lifecycleUploadTrash: [],
      lifecycleLoading: false,
      lifecycleReclaiming: false,
      lifecycleArtifactReclaiming: false,
      lifecycleUploadReclaiming: false,
      lifecycleArtifactBusyKey: "",
      lifecycleUploadBusyKey: "",
      lifecycleRecyclingKey: "",
      lifecycleRetentionPreset: "custom",
      lifecycleRetentionCustomDays: 30,
      lifecycleStatus: "",
      lifecyclePreview: null,
      lifecycleReferencePreview: null,
      lifecycleUploadsPreview: null,
      lifecycleWorkspacePreview: null,
      lifecycleAudit: [],
      lifecycleAuditFilter: "all",
    });
    draw = renderApp;
    draw();
    loadHooks();
    loadEmbedMode();
    loadCloudConfig();
  }

  document.addEventListener("DOMContentLoaded", init);

  export {
    init,
    setPromptSuggestionEnabled,
    setTeamsEnabled,
    setAutoMatchSkill,
    loadHooks,
    validateHooks,
    saveHooks,
    testHooks,
    loadEmbedMode,
    setEmbedMode,
    rebuildEmbeddings,
    loadCloudConfig,
    saveCloudConfig,
    clearCloudToken,
  };
