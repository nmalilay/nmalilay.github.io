(function () {
  const STORAGE_PREFIX = "walkability-inline-editor:v2:";
  const ENABLE_KEY = "walkability-inline-editor:enabled";
  const DEFAULT_DEBOUNCE_MS = 400;
  const SELECTOR = [
    "main h1",
    "main h2",
    "main h3",
    "main h4",
    "main p",
    "main li",
    "main blockquote",
    "main figcaption",
    "footer p",
    "footer span",
  ].join(", ");

  const state = {
    enabled: localStorage.getItem(ENABLE_KEY) !== "0",
    blocks: {},
    mode: "local",
    clientId:
      window.crypto && typeof window.crypto.randomUUID === "function"
        ? window.crypto.randomUUID()
        : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    saveDebounceMs: DEFAULT_DEBOUNCE_MS,
    remoteReady: false,
    remoteError: null,
    focusedId: null,
    saveVersion: 0,
    lastAppliedRemoteAt: 0,
    supabase: null,
    channel: null,
    config: null,
  };

  let toolbar = null;
  let statusNode = null;
  let pillNode = null;
  let blurbNode = null;
  let mutationObserver = null;
  let saveTimer = null;

  function pagePath() {
    return window.location.pathname || "/";
  }

  function pageKey() {
    return `${STORAGE_PREFIX}${pagePath()}`;
  }

  function getConfig() {
    const cfg = window.__INLINE_EDITOR_SUPABASE__ || {};
    return {
      enabled: Boolean(cfg.enabled),
      url: String(cfg.url || "").trim(),
      anonKey: String(cfg.anonKey || "").trim(),
      schema: String(cfg.schema || "public").trim(),
      table: String(cfg.table || "site_content_blocks").trim(),
      realtime: cfg.realtime !== false,
      saveDebounceMs:
        Number.isFinite(Number(cfg.saveDebounceMs)) && Number(cfg.saveDebounceMs) > 0
          ? Number(cfg.saveDebounceMs)
          : DEFAULT_DEBOUNCE_MS,
    };
  }

  function loadLocalPayload() {
    try {
      const raw = localStorage.getItem(pageKey());
      if (!raw) return { blocks: {} };
      const payload = JSON.parse(raw);
      if (!payload || typeof payload !== "object") return { blocks: {} };
      return {
        blocks: payload.blocks && typeof payload.blocks === "object" ? payload.blocks : {},
        updatedAt: payload.updatedAt || null,
      };
    } catch (error) {
      console.warn("inline editor: failed to load local state", error);
      return { blocks: {} };
    }
  }

  function persistLocal(blocks) {
    const payload = {
      path: pagePath(),
      updatedAt: new Date().toISOString(),
      blocks,
    };
    localStorage.setItem(pageKey(), JSON.stringify(payload));
    state.blocks = blocks;
  }

  function escapeFilterValue(value) {
    return String(value).replaceAll(",", "\\,");
  }

  function collectBlocks() {
    const blocks = {};
    document.querySelectorAll("[data-inline-editable='1']").forEach((element) => {
      const id = element.dataset.editId;
      if (id) blocks[id] = element.innerHTML;
    });
    return blocks;
  }

  function buildId(element, index) {
    if (element.dataset.editId) return element.dataset.editId;
    const trail = [];
    let node = element;
    while (node && node !== document.body && node instanceof HTMLElement) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      const siblings = parent
        ? Array.from(parent.children).filter((child) => child.tagName === node.tagName)
        : [node];
      const siblingIndex = Math.max(0, siblings.indexOf(node));
      trail.unshift(`${tag}${siblingIndex}`);
      if (tag === "main" || tag === "footer") break;
      node = parent;
    }
    return trail.join("__") || `block-${index}`;
  }

  function isCandidate(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (!element.textContent || !element.textContent.trim()) return false;
    if (element.closest("header, nav, [data-inline-editor-toolbar='1']")) return false;
    return true;
  }

  function applyEditableState(element) {
    if (!(element instanceof HTMLElement)) return;
    if (state.enabled) {
      element.setAttribute("contenteditable", "true");
      element.setAttribute("spellcheck", "true");
      element.classList.add("inline-editor-enabled");
    } else {
      element.removeAttribute("contenteditable");
      element.classList.remove("inline-editor-enabled");
    }
  }

  function applyBlocksToDom(blocks, options) {
    const opts = options || {};
    Object.entries(blocks || {}).forEach(([id, html]) => {
      const element = document.querySelector(`[data-edit-id="${CSS.escape(id)}"]`);
      if (!element) return;
      const skipWhileFocused = opts.skipFocused !== false;
      if (skipWhileFocused && state.focusedId && state.focusedId === id) return;
      if (element.innerHTML !== html) {
        element.innerHTML = html;
      }
    });
  }

  function bindElement(element) {
    if (element.dataset.inlineEditorBound === "1") return;
    element.dataset.inlineEditorBound = "1";
    element.addEventListener("input", () => {
      setStatus(state.mode === "supabase" ? "Saving to Supabase..." : "Saving locally...");
      scheduleSave();
    });
    element.addEventListener("focus", () => {
      state.focusedId = element.dataset.editId || null;
      setStatus(state.mode === "supabase" ? "Editing live" : "Editing locally");
    });
    element.addEventListener("blur", () => {
      state.focusedId = null;
      queueSave(true);
    });
  }

  function hydratePage() {
    document.querySelectorAll(SELECTOR).forEach((element, index) => {
      if (!isCandidate(element)) return;
      if (!element.dataset.editId) element.dataset.editId = buildId(element, index);
      element.dataset.inlineEditable = "1";
      if (Object.prototype.hasOwnProperty.call(state.blocks, element.dataset.editId)) {
        if (element.innerHTML !== state.blocks[element.dataset.editId]) {
          element.innerHTML = state.blocks[element.dataset.editId];
        }
      }
      bindElement(element);
      applyEditableState(element);
    });
  }

  function setStatus(message) {
    if (statusNode) statusNode.textContent = message;
  }

  function updateToolbarMode() {
    if (pillNode) {
      pillNode.textContent = state.mode === "supabase" ? "Shared live" : "Local fallback";
    }
    if (blurbNode) {
      blurbNode.textContent =
        state.mode === "supabase"
          ? "Click body text to edit. Changes save to Supabase and sync across visitors on this page."
          : "Click body text to edit. Changes save in this browser. Enable Supabase in scripts/supabase_config.js for shared live editing.";
    }
  }

  async function copyJson() {
    const payload = {
      path: pagePath(),
      updatedAt: new Date().toISOString(),
      blocks: collectBlocks(),
    };
    const json = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setStatus("Copied JSON to clipboard");
    } catch (error) {
      console.warn("inline editor: clipboard write failed", error);
      window.prompt("Copy your edits JSON", json);
      setStatus("Used prompt fallback");
    }
  }

  async function upsertRemoteBlocks(blocks) {
    if (!state.supabase || !state.config) return;
    const rows = Object.entries(blocks).map(([blockId, html]) => ({
      path: pagePath(),
      block_id: blockId,
      html,
      client_id: state.clientId,
      updated_at: new Date().toISOString(),
    }));
    if (!rows.length) return;
    const { error } = await state.supabase
      .from(state.config.table)
      .upsert(rows, { onConflict: "path,block_id" });
    if (error) throw error;
  }

  async function flushSave() {
    window.clearTimeout(saveTimer);
    saveTimer = null;
    const version = ++state.saveVersion;
    const blocks = collectBlocks();
    persistLocal(blocks);
    if (state.mode !== "supabase" || !state.remoteReady) {
      setStatus("Saved locally");
      return;
    }
    try {
      await upsertRemoteBlocks(blocks);
      if (version === state.saveVersion) {
        setStatus("Saved to Supabase");
      }
    } catch (error) {
      console.error("inline editor: Supabase save failed", error);
      state.remoteError = error;
      setStatus("Supabase save failed; local copy kept");
    }
  }

  function scheduleSave() {
    queueSave(false);
  }

  function queueSave(immediate) {
    window.clearTimeout(saveTimer);
    if (immediate) {
      void flushSave();
      return;
    }
    saveTimer = window.setTimeout(() => {
      void flushSave();
    }, state.saveDebounceMs);
  }

  async function importJson() {
    let raw = "";
    try {
      raw = await navigator.clipboard.readText();
    } catch (error) {
      console.warn("inline editor: clipboard read failed", error);
    }
    if (!raw) raw = window.prompt("Paste edits JSON");
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      const blocks = parsed && typeof parsed === "object" && parsed.blocks ? parsed.blocks : parsed;
      if (!blocks || typeof blocks !== "object") throw new Error("Missing blocks");
      persistLocal(blocks);
      applyBlocksToDom(blocks, { skipFocused: false });
      hydratePage();
      if (state.mode === "supabase" && state.remoteReady) {
        await upsertRemoteBlocks(blocks);
        setStatus("Imported JSON and pushed live");
      } else {
        setStatus("Imported JSON locally");
      }
    } catch (error) {
      console.error("inline editor: import failed", error);
      window.alert("Could not parse pasted JSON.");
      setStatus("Import failed");
    }
  }

  function resetPage() {
    const message =
      state.mode === "supabase"
        ? "Reset this page to its original repo text in this browser? This does not delete Supabase content already saved."
        : "Reset all local edits on this page?";
    const confirmed = window.confirm(message);
    if (!confirmed) return;
    localStorage.removeItem(pageKey());
    window.location.reload();
  }

  function toggleEditing() {
    state.enabled = !state.enabled;
    localStorage.setItem(ENABLE_KEY, state.enabled ? "1" : "0");
    document.querySelectorAll("[data-inline-editable='1']").forEach(applyEditableState);
    const toggle = document.getElementById("inline-editor-toggle");
    if (toggle) toggle.textContent = state.enabled ? "Disable editing" : "Enable editing";
    setStatus(state.enabled ? "Editing enabled" : "Editing disabled");
  }

  function injectStyles() {
    if (document.getElementById("inline-editor-style")) return;
    const style = document.createElement("style");
    style.id = "inline-editor-style";
    style.textContent = `
      [data-inline-editable="1"] {
        transition: box-shadow 0.15s ease, background-color 0.15s ease;
      }

      [data-inline-editable="1"].inline-editor-enabled:hover {
        box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.2);
        background-color: rgba(255, 255, 255, 0.7);
        cursor: text;
      }

      [data-inline-editable="1"].inline-editor-enabled:focus {
        outline: none;
        box-shadow: 0 0 0 2px rgba(14, 165, 233, 0.35);
        background-color: rgba(255, 255, 255, 0.92);
      }

      .inline-editor-toolbar {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        width: min(380px, calc(100vw - 32px));
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.96);
        backdrop-filter: blur(12px);
        box-shadow: 0 18px 44px rgba(15, 23, 42, 0.18);
        padding: 14px;
        color: #1f2937;
        font: 500 13px/1.45 "Manrope", system-ui, sans-serif;
      }

      .inline-editor-toolbar h2 {
        margin: 0;
        font: 600 14px/1.2 "Sora", system-ui, sans-serif;
      }

      .inline-editor-toolbar p {
        margin: 8px 0 0;
        color: #475569;
      }

      .inline-editor-toolbar .status {
        margin-top: 8px;
        color: #64748b;
        font-size: 12px;
      }

      .inline-editor-toolbar .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }

      .inline-editor-toolbar button {
        appearance: none;
        border: 1px solid #cbd5e1;
        background: #ffffff;
        color: #1f2937;
        border-radius: 6px;
        padding: 7px 10px;
        font: inherit;
        cursor: pointer;
      }

      .inline-editor-toolbar button:hover {
        border-color: #0f172a;
      }

      .inline-editor-toolbar .pill {
        display: inline-block;
        margin-top: 8px;
        padding: 3px 8px;
        border-radius: 999px;
        background: #fff7ed;
        color: #c2410c;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
    `;
    document.head.appendChild(style);
  }

  function createToolbar() {
    if (toolbar) return;
    toolbar = document.createElement("div");
    toolbar.className = "inline-editor-toolbar";
    toolbar.dataset.inlineEditorToolbar = "1";
    toolbar.innerHTML = `
      <h2>Inline Text Editing</h2>
      <div class="pill" id="inline-editor-pill">Local fallback</div>
      <p id="inline-editor-blurb">Click body text to edit. Changes save in this browser. Enable Supabase in scripts/supabase_config.js for shared live editing.</p>
      <div class="status" id="inline-editor-status">Ready</div>
      <div class="actions">
        <button id="inline-editor-toggle" type="button">${state.enabled ? "Disable editing" : "Enable editing"}</button>
        <button id="inline-editor-copy" type="button">Copy JSON</button>
        <button id="inline-editor-import" type="button">Import JSON</button>
        <button id="inline-editor-reset" type="button">Reset page</button>
      </div>
    `;
    document.body.appendChild(toolbar);
    statusNode = toolbar.querySelector("#inline-editor-status");
    pillNode = toolbar.querySelector("#inline-editor-pill");
    blurbNode = toolbar.querySelector("#inline-editor-blurb");
    toolbar.querySelector("#inline-editor-toggle").addEventListener("click", toggleEditing);
    toolbar.querySelector("#inline-editor-copy").addEventListener("click", copyJson);
    toolbar.querySelector("#inline-editor-import").addEventListener("click", importJson);
    toolbar.querySelector("#inline-editor-reset").addEventListener("click", resetPage);
    updateToolbarMode();
  }

  function startObserver() {
    if (mutationObserver) mutationObserver.disconnect();
    mutationObserver = new MutationObserver(() => {
      hydratePage();
      applyBlocksToDom(state.blocks, { skipFocused: true });
    });
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  async function connectSupabase() {
    state.config = getConfig();
    state.saveDebounceMs = state.config.saveDebounceMs;
    if (!state.config.enabled || !state.config.url || !state.config.anonKey) {
      state.mode = "local";
      updateToolbarMode();
      setStatus("Supabase not configured; local editing only");
      return;
    }

    try {
      const moduleUrl = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
      const { createClient } = await import(moduleUrl);
      state.supabase = createClient(state.config.url, state.config.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const { data, error } = await state.supabase
        .from(state.config.table)
        .select("block_id, html, updated_at, client_id")
        .eq("path", pagePath());

      if (error) throw error;

      const remoteBlocks = {};
      (data || []).forEach((row) => {
        remoteBlocks[row.block_id] = row.html;
      });

      if (Object.keys(remoteBlocks).length) {
        state.blocks = remoteBlocks;
        persistLocal(remoteBlocks);
        applyBlocksToDom(remoteBlocks, { skipFocused: false });
        hydratePage();
      }

      state.mode = "supabase";
      state.remoteReady = true;
      state.remoteError = null;
      updateToolbarMode();
      setStatus("Connected to Supabase live editing");

      if (state.config.realtime) {
        const filter = `path=eq.${escapeFilterValue(pagePath())}`;
        state.channel = state.supabase
          .channel(`inline-editor:${pagePath()}`)
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: state.config.schema,
              table: state.config.table,
              filter,
            },
            (payload) => {
              const row = payload && payload.new ? payload.new : null;
              if (!row || !row.block_id) return;
              if (row.client_id && row.client_id === state.clientId) return;
              state.lastAppliedRemoteAt = Date.now();
              state.blocks[row.block_id] = row.html;
              persistLocal(state.blocks);
              applyBlocksToDom({ [row.block_id]: row.html }, { skipFocused: true });
              setStatus("Remote edit received");
            }
          )
          .subscribe((status) => {
            if (status === "SUBSCRIBED") {
              setStatus("Supabase realtime connected");
            }
          });
      }
    } catch (error) {
      console.error("inline editor: Supabase init failed", error);
      state.mode = "local";
      state.remoteReady = false;
      state.remoteError = error;
      updateToolbarMode();
      setStatus("Supabase unavailable; local editing only");
    }
  }

  function init() {
    const local = loadLocalPayload();
    state.blocks = local.blocks;
    state.config = getConfig();
    state.saveDebounceMs = state.config.saveDebounceMs;
    injectStyles();
    createToolbar();
    hydratePage();
    startObserver();
    window.setTimeout(() => {
      hydratePage();
      applyBlocksToDom(state.blocks, { skipFocused: false });
    }, 400);
    window.setTimeout(() => {
      hydratePage();
      applyBlocksToDom(state.blocks, { skipFocused: false });
    }, 1200);
    setStatus(state.enabled ? "Editing enabled" : "Editing disabled");
    void connectSupabase();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
