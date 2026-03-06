(function () {
  const STORAGE_PREFIX = "walkability-inline-editor:v1:";
  const ENABLE_KEY = "walkability-inline-editor:enabled";
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
  };

  let toolbar = null;
  let statusNode = null;
  let mutationObserver = null;
  let saveTimer = null;

  function pageKey() {
    return `${STORAGE_PREFIX}${window.location.pathname || "/"}`;
  }

  function loadBlocks() {
    try {
      const raw = localStorage.getItem(pageKey());
      if (!raw) return {};
      const payload = JSON.parse(raw);
      return payload && typeof payload === "object" && payload.blocks ? payload.blocks : {};
    } catch (error) {
      console.warn("inline editor: failed to load local state", error);
      return {};
    }
  }

  function saveBlocks() {
    const payload = {
      path: window.location.pathname || "/",
      updatedAt: new Date().toISOString(),
      blocks: collectBlocks(),
    };
    localStorage.setItem(pageKey(), JSON.stringify(payload));
    state.blocks = payload.blocks;
    setStatus("Saved locally");
  }

  function scheduleSave() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveBlocks, 120);
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

  function bindElement(element) {
    if (element.dataset.inlineEditorBound === "1") return;
    element.dataset.inlineEditorBound = "1";
    element.addEventListener("input", scheduleSave);
    element.addEventListener("blur", saveBlocks);
    element.addEventListener("focus", () => setStatus("Editing locally"));
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

  async function copyJson() {
    const payload = {
      path: window.location.pathname || "/",
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
      state.blocks = blocks;
      localStorage.setItem(
        pageKey(),
        JSON.stringify({
          path: window.location.pathname || "/",
          updatedAt: new Date().toISOString(),
          blocks,
        })
      );
      hydratePage();
      setStatus("Imported JSON");
    } catch (error) {
      console.error("inline editor: import failed", error);
      window.alert("Could not parse pasted JSON.");
      setStatus("Import failed");
    }
  }

  function resetPage() {
    const confirmed = window.confirm("Reset all local edits on this page?");
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
        width: min(360px, calc(100vw - 32px));
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
      <div class="pill">Local only</div>
      <p>Click body text to edit. Changes save in this browser. Use JSON copy/import to share edits with teammates.</p>
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
    toolbar.querySelector("#inline-editor-toggle").addEventListener("click", toggleEditing);
    toolbar.querySelector("#inline-editor-copy").addEventListener("click", copyJson);
    toolbar.querySelector("#inline-editor-import").addEventListener("click", importJson);
    toolbar.querySelector("#inline-editor-reset").addEventListener("click", resetPage);
  }

  function startObserver() {
    if (mutationObserver) mutationObserver.disconnect();
    mutationObserver = new MutationObserver(() => {
      hydratePage();
    });
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function init() {
    state.blocks = loadBlocks();
    injectStyles();
    createToolbar();
    hydratePage();
    startObserver();
    window.setTimeout(hydratePage, 400);
    window.setTimeout(hydratePage, 1200);
    setStatus(state.enabled ? "Editing enabled" : "Editing disabled");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
