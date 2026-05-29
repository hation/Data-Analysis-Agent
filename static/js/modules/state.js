// Centralized mutable state shared across modules.
// Other modules import via window.BAA.state; setters are exposed where cross-module writes are needed.
(function () {
  const state = {
    SID: null,
    srcConnected: false,
    srcName: "",
    srcHintKey: 'sidebar.hint.noconn',
    schemaText: "",
    isStreaming: false,
    activeCommand: "",
    slashPopupIndex: 0,
    tokenState: { promptTokens: 0, totalInput: 0, totalOutput: 0, contextWindow: null },
    modelConfigs: {},
    _streamReader: null,
    _editingCustomProvider: null,
    _previewData: null,
    _previewCache: {},
    _previewSid: null,
    _modalResizing: false,
  };

  window.BAA = window.BAA || {};
  window.BAA.state = state;
})();
