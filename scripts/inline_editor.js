(function () {
  "use strict";

  const CONFIG = window.__INLINE_EDITOR_SUPABASE__ || {};
  const PAGE_PATH = normalizePath(window.location.pathname || "/");
  const STORAGE_KEY = "inline-editor:" + PAGE_PATH;
  const CLIENT_KEY = "inline-editor:client-id";
  const MANIFEST_ID = "__dynamic_manifest__";
  const DEFAULT_MANIFEST = () => ({ containers: {} });
  const SAVE_DEBOUNCE_MS = Number(CONFIG.saveDebounceMs) > 0 ? Number(CONFIG.saveDebounceMs) : 400;
  const POLL_MS = 1500;
  const PLACEHOLDER_HTML = "<br>";
  const EDITABLE_SELECTOR = [
    "main h1",
    "main h2",
    "main h3",
    "main h4",
    "main h5",
    "main h6",
    "main p",
    "main li",
    "main blockquote",
    "main figcaption",
    "main dt",
    "main dd",
    "main span",
    "main a",
    "footer p",
    "footer span",
    "footer a",
  ].join(", ");
  const CONTAINER_SELECTOR = ["main section", "main article", "footer"].join(", ");

  const state = {
    enabled: true,
    mode: "local",
    remoteReady: false,
    blocks: {},
    manifest: DEFAULT_MANIFEST(),
    originalBlocks: {},
    editableMap: new Map(),
    containerMap: new Map(),
    slotMap: new Map(),
    dirtyBlocks: new Set(),
    dirtyManifest: false,
    activeContainerId: null,
    focusedBlockId: null,
    focusedElement: null,
    saveTimer: null,
    pollTimer: null,
    pollInFlight: false,
    applyingHydration: false,
    lastRemoteHash: "",
    ui: {},
  };

  const clientId = getOrCreateClientId();

  if (!document.body) {
    return;
  }

  injectStyles();
  void bootstrap();

  async function bootstrap() {
    registerContainers();
    registerStaticBlocks();
    buildToolbar();
    loadLocalSnapshot();
    renderDynamicBlocks();
    hydratePage({ skipFocused: false });
    applyEditableMode();
    attachDocumentHandlers();
    updateToolbar();

    if (hasRemoteConfig()) {
      const ok = await syncFromRemote({ initial: true });
      if (ok) {
        schedulePoll();
      }
    } else {
      setMode("local", "Supabase disabled");
    }
  }

  function normalizePath(pathname) {
    if (!pathname || pathname === "/index.html") {
      return "/";
    }
    return pathname;
  }

  function hasRemoteConfig() {
    return Boolean(CONFIG.enabled && CONFIG.url && CONFIG.anonKey && CONFIG.table);
  }

  function getOrCreateClientId() {
    try {
      const existing = window.localStorage.getItem(CLIENT_KEY);
      if (existing) {
        return existing;
      }
      const next = typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "client-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
      window.localStorage.setItem(CLIENT_KEY, next);
      return next;
    } catch (error) {
      return "client-" + Date.now();
    }
  }

  function registerContainers() {
    const nodes = Array.from(document.querySelectorAll(CONTAINER_SELECTOR));
    nodes.forEach((node) => {
      const containerId = "container-" + buildDomPathId(node);
      node.dataset.inlineContainerId = containerId;
      state.containerMap.set(containerId, node);
      if (!state.activeContainerId && node.tagName !== "FOOTER") {
        state.activeContainerId = containerId;
      }
    });
    if (!state.activeContainerId && nodes[0]) {
      state.activeContainerId = nodes[0].dataset.inlineContainerId;
    }
  }

  function registerStaticBlocks() {
    state.editableMap.clear();
    const nodes = collectEditableNodes();
    nodes.forEach((node) => {
      const blockId = buildDomPathId(node);
      const containerId = getContainerIdForNode(node);
      bindEditableNode(node, {
        blockId,
        containerId,
        dynamic: false,
      });
      if (!Object.prototype.hasOwnProperty.call(state.originalBlocks, blockId)) {
        state.originalBlocks[blockId] = node.innerHTML;
      }
      if (!Object.prototype.hasOwnProperty.call(state.blocks, blockId)) {
        state.blocks[blockId] = node.innerHTML;
      }
    });
  }

  function collectEditableNodes() {
    const candidates = Array.from(document.querySelectorAll(EDITABLE_SELECTOR));
    return candidates.filter((node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      if (node.closest("[data-inline-editor-ui]")) {
        return false;
      }
      if (!node.textContent || !node.textContent.trim()) {
        return false;
      }
      if (node.closest("header, nav")) {
        return false;
      }
      let parent = node.parentElement;
      while (parent) {
        if (parent.matches && parent.matches(EDITABLE_SELECTOR) && !parent.closest("[data-inline-editor-ui]")) {
          return false;
        }
        parent = parent.parentElement;
      }
      return true;
    });
  }

  function bindEditableNode(node, meta) {
    const blockId = meta.blockId;
    node.dataset.inlineId = blockId;
    node.dataset.inlineDynamic = meta.dynamic ? "true" : "false";
    node.dataset.inlineContainerId = meta.containerId || "";
    node.classList.add("ie-editable");
    node.spellcheck = true;
    node.tabIndex = 0;

    if (!node.dataset.inlineBound) {
      node.addEventListener("focus", onEditableFocus);
      node.addEventListener("blur", onEditableBlur);
      node.addEventListener("input", onEditableInput);
      node.addEventListener("keydown", onEditableKeydown);
      node.addEventListener("paste", onEditablePaste);
      node.addEventListener("click", onEditableClick);
      node.dataset.inlineBound = "true";
    }

    state.editableMap.set(blockId, {
      node,
      dynamic: meta.dynamic,
      containerId: meta.containerId || "",
      tagName: node.tagName.toLowerCase(),
    });
  }

  function onEditableFocus(event) {
    const node = event.currentTarget;
    if (!(node instanceof HTMLElement)) {
      return;
    }
    const blockId = node.dataset.inlineId || "";
    state.focusedBlockId = blockId;
    state.focusedElement = node;
    state.activeContainerId = getContainerIdForNode(node);
    if (node.innerHTML === PLACEHOLDER_HTML || isBlankHtml(node.innerHTML)) {
      state.applyingHydration = true;
      node.innerHTML = "";
      state.applyingHydration = false;
    }
    updateActiveContainer();
    updateToolbar();
  }

  function onEditableBlur(event) {
    const node = event.currentTarget;
    if (!(node instanceof HTMLElement)) {
      return;
    }
    normalizeEditableNode(node);
    const blockId = node.dataset.inlineId || "";
    const html = canonicalizeHtml(node.innerHTML);
    state.blocks[blockId] = html;
    markDirtyBlock(blockId);
    persistLocalSnapshot();
    if (state.focusedElement === node) {
      state.focusedElement = null;
      state.focusedBlockId = null;
    }
    updateToolbar();
  }

  function onEditableInput(event) {
    if (state.applyingHydration) {
      return;
    }
    const node = event.currentTarget;
    if (!(node instanceof HTMLElement)) {
      return;
    }
    const blockId = node.dataset.inlineId || "";
    state.blocks[blockId] = node.innerHTML;
    markDirtyBlock(blockId);
    persistLocalSnapshot();
  }

  function onEditableKeydown(event) {
    if (!state.enabled) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      insertLineBreak();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      const node = event.currentTarget;
      if (node instanceof HTMLElement) {
        node.blur();
      }
    }
  }

  function onEditablePaste(event) {
    if (!state.enabled) {
      return;
    }
    event.preventDefault();
    const text = event.clipboardData ? event.clipboardData.getData("text/plain") : "";
    insertPlainText(text);
  }

  function onEditableClick(event) {
    if (!state.enabled) {
      return;
    }
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("a")) {
      event.preventDefault();
    }
  }

  function attachDocumentHandlers() {
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const container = target.closest("[data-inline-container-id]");
      if (container instanceof HTMLElement) {
        state.activeContainerId = container.dataset.inlineContainerId || state.activeContainerId;
        updateActiveContainer();
        updateToolbar();
      }
    });
  }

  function getContainerIdForNode(node) {
    const container = node.closest("[data-inline-container-id]");
    if (container instanceof HTMLElement && container.dataset.inlineContainerId) {
      return container.dataset.inlineContainerId;
    }
    return state.activeContainerId || "";
  }

  function updateActiveContainer() {
    state.containerMap.forEach((node, containerId) => {
      node.classList.toggle("ie-active-container", containerId === state.activeContainerId && state.enabled);
    });
    state.slotMap.forEach((slot, containerId) => {
      slot.classList.toggle("ie-slot-active", containerId === state.activeContainerId && state.enabled);
    });
  }

  function normalizeEditableNode(node) {
    const html = canonicalizeHtml(node.innerHTML);
    state.applyingHydration = true;
    node.innerHTML = isBlankHtml(html) ? PLACEHOLDER_HTML : html;
    state.applyingHydration = false;
  }

  function canonicalizeHtml(html) {
    if (!html) {
      return PLACEHOLDER_HTML;
    }
    let next = String(html)
      .replace(/<div><br><\/div>/gi, "<br>")
      .replace(/<div>/gi, "")
      .replace(/<\/div>/gi, "<br>")
      .replace(/<p>/gi, "")
      .replace(/<\/p>/gi, "<br>")
      .replace(/&nbsp;/gi, " ")
      .trim();
    if (isBlankHtml(next)) {
      return PLACEHOLDER_HTML;
    }
    return next;
  }

  function isBlankHtml(html) {
    const temp = document.createElement("div");
    temp.innerHTML = html || "";
    const text = (temp.textContent || "").replace(/\u00a0/g, " ").trim();
    if (text) {
      return false;
    }
    const stripped = temp.innerHTML.replace(/<br\s*\/?>/gi, "").replace(/\s+/g, "");
    return stripped === "";
  }

  function insertLineBreak() {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) {
      return;
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const br = document.createElement("br");
    range.insertNode(br);
    range.setStartAfter(br);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function insertPlainText(text) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) {
      return;
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const fragment = document.createDocumentFragment();
    const parts = String(text).split(/\r?\n/);
    parts.forEach((part, index) => {
      if (index > 0) {
        fragment.appendChild(document.createElement("br"));
      }
      fragment.appendChild(document.createTextNode(part));
    });
    range.insertNode(fragment);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function buildToolbar() {
    const panel = document.createElement("aside");
    panel.className = "ie-toolbar";
    panel.dataset.inlineEditorUi = "true";

    const header = document.createElement("div");
    header.className = "ie-toolbar-header";

    const title = document.createElement("div");
    title.innerHTML = [
      '<div class="ie-toolbar-title">Live Website Editing</div>',
      '<div class="ie-toolbar-subtitle">Shared via Supabase</div>',
    ].join("");
    header.appendChild(title);

    const status = document.createElement("span");
    status.className = "ie-status-pill";
    header.appendChild(status);

    const meta = document.createElement("div");
    meta.className = "ie-toolbar-meta";

    const sectionLabel = document.createElement("div");
    sectionLabel.className = "ie-meta-line";
    meta.appendChild(sectionLabel);

    const note = document.createElement("div");
    note.className = "ie-meta-line";
    meta.appendChild(note);

    const actions = document.createElement("div");
    actions.className = "ie-toolbar-actions";

    const toggleButton = createToolbarButton("Disable editing", () => {
      state.enabled = !state.enabled;
      applyEditableMode();
      updateToolbar();
    });
    actions.appendChild(toggleButton);

    const syncButton = createToolbarButton("Sync now", () => {
      void syncFromRemote({ initial: false, force: true });
    });
    actions.appendChild(syncButton);

    const addParagraphButton = createToolbarButton("Add paragraph", () => {
      addDynamicBlock("p");
    });
    actions.appendChild(addParagraphButton);

    const addHeadingButton = createToolbarButton("Add heading", () => {
      addDynamicBlock("h3");
    });
    actions.appendChild(addHeadingButton);

    const addNoteButton = createToolbarButton("Add note", () => {
      addDynamicBlock("blockquote");
    });
    actions.appendChild(addNoteButton);

    const utilities = document.createElement("div");
    utilities.className = "ie-toolbar-utilities";

    const copyButton = createToolbarButton("Copy JSON", () => {
      void copySnapshot();
    }, "secondary");
    utilities.appendChild(copyButton);

    const importButton = createToolbarButton("Import JSON", () => {
      importSnapshot();
    }, "secondary");
    utilities.appendChild(importButton);

    const resetButton = createToolbarButton("Reload remote", () => {
      clearLocalSnapshot();
      void syncFromRemote({ initial: true, force: true });
    }, "secondary");
    utilities.appendChild(resetButton);

    panel.appendChild(header);
    panel.appendChild(meta);
    panel.appendChild(actions);
    panel.appendChild(utilities);
    document.body.appendChild(panel);

    state.ui.toolbar = panel;
    state.ui.status = status;
    state.ui.sectionLabel = sectionLabel;
    state.ui.note = note;
    state.ui.toggleButton = toggleButton;
  }

  function createToolbarButton(label, onClick, variant) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = variant === "secondary" ? "ie-button ie-button-secondary" : "ie-button";
    button.textContent = label;
    button.dataset.inlineEditorUi = "true";
    button.addEventListener("click", onClick);
    return button;
  }

  function updateToolbar() {
    if (!state.ui.toolbar) {
      return;
    }
    state.ui.status.textContent = state.mode === "shared" ? "Shared live" : "Local fallback";
    state.ui.status.dataset.mode = state.mode;
    state.ui.toggleButton.textContent = state.enabled ? "Disable editing" : "Enable editing";
    state.ui.sectionLabel.textContent = "Target section: " + getContainerLabel(state.activeContainerId);
    if (state.mode === "shared") {
      state.ui.note.textContent = "Everyone sees saved changes. Poll interval: " + (POLL_MS / 1000).toFixed(1) + "s";
    } else {
      state.ui.note.textContent = "Remote unavailable. Changes are cached in this browser until Supabase reconnects.";
    }
  }

  function setMode(mode, note) {
    state.mode = mode;
    state.remoteReady = mode === "shared";
    if (state.ui.note && note) {
      state.ui.note.textContent = note;
    }
    updateToolbar();
  }

  function applyEditableMode() {
    state.editableMap.forEach((meta) => {
      if (!(meta.node instanceof HTMLElement)) {
        return;
      }
      meta.node.contentEditable = state.enabled ? "true" : "false";
      meta.node.classList.toggle("ie-editable-enabled", state.enabled);
    });

    state.slotMap.forEach((slot) => {
      slot.classList.toggle("ie-slot-hidden", !state.enabled);
    });

    updateActiveContainer();
  }

  function createSlot(containerId) {
    const container = state.containerMap.get(containerId);
    if (!container) {
      return null;
    }
    let slot = state.slotMap.get(containerId);
    if (slot && slot.isConnected) {
      return slot;
    }

    slot = document.createElement("div");
    slot.className = "ie-slot";
    slot.dataset.inlineEditorUi = "true";
    slot.dataset.inlineSlotFor = containerId;

    const controls = document.createElement("div");
    controls.className = "ie-slot-controls";

    const label = document.createElement("span");
    label.className = "ie-slot-label";
    label.textContent = "Add live text to this section";
    controls.appendChild(label);

    controls.appendChild(createSlotButton("Paragraph", () => addDynamicBlock("p", containerId)));
    controls.appendChild(createSlotButton("Heading", () => addDynamicBlock("h3", containerId)));
    controls.appendChild(createSlotButton("Note", () => addDynamicBlock("blockquote", containerId)));

    const blocks = document.createElement("div");
    blocks.className = "ie-slot-blocks";

    slot.appendChild(controls);
    slot.appendChild(blocks);
    container.appendChild(slot);
    state.slotMap.set(containerId, slot);
    return slot;
  }

  function createSlotButton(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ie-slot-button";
    button.dataset.inlineEditorUi = "true";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function renderDynamicBlocks() {
    removeStaleDynamicEntries();

    state.containerMap.forEach((container, containerId) => {
      const slot = createSlot(containerId);
      if (!slot) {
        return;
      }
      const host = slot.querySelector(".ie-slot-blocks");
      if (!(host instanceof HTMLElement)) {
        return;
      }

      host.innerHTML = "";
      const entries = Array.isArray(state.manifest.containers[containerId])
        ? state.manifest.containers[containerId]
        : [];

      entries.forEach((entry, index) => {
        if (!entry || !entry.id || !entry.tag) {
          return;
        }
        const wrapper = document.createElement("div");
        wrapper.className = "ie-dynamic-wrapper";
        wrapper.dataset.inlineEditorUi = "true";
        wrapper.dataset.dynamicId = entry.id;
        wrapper.dataset.containerId = containerId;

        const controls = document.createElement("div");
        controls.className = "ie-dynamic-controls";
        controls.appendChild(createDynamicControl("Up", () => moveDynamicBlock(containerId, entry.id, -1)));
        controls.appendChild(createDynamicControl("Down", () => moveDynamicBlock(containerId, entry.id, 1)));
        controls.appendChild(createDynamicControl("Duplicate", () => duplicateDynamicBlock(containerId, entry.id)));
        controls.appendChild(createDynamicControl("Delete", () => deleteDynamicBlock(containerId, entry.id)));

        const editable = document.createElement(entry.tag);
        editable.className = "ie-editable ie-dynamic-block";
        editable.innerHTML = Object.prototype.hasOwnProperty.call(state.blocks, entry.id)
          ? state.blocks[entry.id]
          : defaultDynamicHtml(entry.tag);

        bindEditableNode(editable, {
          blockId: entry.id,
          containerId,
          dynamic: true,
        });

        wrapper.appendChild(controls);
        wrapper.appendChild(editable);
        host.appendChild(wrapper);

        if (index === entries.length - 1) {
          wrapper.classList.add("ie-dynamic-wrapper-last");
        }
      });

      slot.classList.toggle("ie-slot-has-blocks", entries.length > 0);
      slot.classList.toggle("ie-slot-hidden", !state.enabled);
    });

    hydratePage({ skipFocused: true });
    applyEditableMode();
  }

  function createDynamicControl(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ie-control-button";
    button.dataset.inlineEditorUi = "true";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function removeStaleDynamicEntries() {
    Array.from(state.editableMap.entries()).forEach(([blockId, meta]) => {
      if (meta.dynamic) {
        state.editableMap.delete(blockId);
      }
    });
  }

  function addDynamicBlock(tagName, preferredContainerId) {
    const containerId = preferredContainerId || state.activeContainerId || Array.from(state.containerMap.keys())[0];
    if (!containerId) {
      return;
    }
    if (!Array.isArray(state.manifest.containers[containerId])) {
      state.manifest.containers[containerId] = [];
    }
    const blockId = "dyn-" + (typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now() + "-" + Math.random().toString(36).slice(2, 8));
    state.manifest.containers[containerId].push({
      id: blockId,
      tag: tagName,
    });
    state.blocks[blockId] = defaultDynamicHtml(tagName);
    markDirtyBlock(blockId);
    markDirtyManifest();
    renderDynamicBlocks();
    persistLocalSnapshot();
    state.activeContainerId = containerId;
    updateActiveContainer();
    updateToolbar();

    window.setTimeout(() => {
      const meta = state.editableMap.get(blockId);
      if (meta && meta.node instanceof HTMLElement) {
        meta.node.focus();
        placeCursorAtEnd(meta.node);
        meta.node.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }, 30);
  }

  function moveDynamicBlock(containerId, blockId, delta) {
    const entries = state.manifest.containers[containerId];
    if (!Array.isArray(entries)) {
      return;
    }
    const index = entries.findIndex((entry) => entry.id === blockId);
    if (index === -1) {
      return;
    }
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= entries.length) {
      return;
    }
    const nextEntries = entries.slice();
    const tmp = nextEntries[index];
    nextEntries[index] = nextEntries[nextIndex];
    nextEntries[nextIndex] = tmp;
    state.manifest.containers[containerId] = nextEntries;
    markDirtyManifest();
    renderDynamicBlocks();
    persistLocalSnapshot();
  }

  function duplicateDynamicBlock(containerId, blockId) {
    const entries = state.manifest.containers[containerId];
    if (!Array.isArray(entries)) {
      return;
    }
    const index = entries.findIndex((entry) => entry.id === blockId);
    if (index === -1) {
      return;
    }
    const source = entries[index];
    const duplicateId = "dyn-" + (typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now() + "-" + Math.random().toString(36).slice(2, 8));
    entries.splice(index + 1, 0, {
      id: duplicateId,
      tag: source.tag,
    });
    state.blocks[duplicateId] = state.blocks[blockId] || defaultDynamicHtml(source.tag);
    markDirtyBlock(duplicateId);
    markDirtyManifest();
    renderDynamicBlocks();
    persistLocalSnapshot();
  }

  function deleteDynamicBlock(containerId, blockId) {
    const entries = state.manifest.containers[containerId];
    if (!Array.isArray(entries)) {
      return;
    }
    state.manifest.containers[containerId] = entries.filter((entry) => entry.id !== blockId);
    state.blocks[blockId] = PLACEHOLDER_HTML;
    markDirtyBlock(blockId);
    markDirtyManifest();
    renderDynamicBlocks();
    persistLocalSnapshot();
  }

  function defaultDynamicHtml(tagName) {
    if (tagName === "h3") {
      return "New heading";
    }
    if (tagName === "blockquote") {
      return "New note";
    }
    return "New paragraph";
  }

  function placeCursorAtEnd(node) {
    const selection = window.getSelection();
    if (!selection) {
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function markDirtyBlock(blockId) {
    state.dirtyBlocks.add(blockId);
    scheduleSave();
  }

  function markDirtyManifest() {
    state.dirtyManifest = true;
    scheduleSave();
  }

  function scheduleSave() {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(() => {
      void flushSaves();
    }, SAVE_DEBOUNCE_MS);
  }

  async function flushSaves() {
    persistLocalSnapshot();
    if (!hasRemoteConfig()) {
      setMode("local", "Supabase disabled");
      return;
    }
    const rows = [];

    state.dirtyBlocks.forEach((blockId) => {
      rows.push({
        path: PAGE_PATH,
        block_id: blockId,
        html: state.blocks[blockId] || PLACEHOLDER_HTML,
        client_id: clientId,
      });
    });

    if (state.dirtyManifest) {
      rows.push({
        path: PAGE_PATH,
        block_id: MANIFEST_ID,
        html: JSON.stringify(state.manifest),
        client_id: clientId,
      });
    }

    if (!rows.length) {
      return;
    }

    try {
      await upsertRemoteRows(rows);
      state.dirtyBlocks.clear();
      state.dirtyManifest = false;
      setMode("shared", "Everyone sees saved changes. Poll interval: " + (POLL_MS / 1000).toFixed(1) + "s");
    } catch (error) {
      setMode("local", "Remote save failed: " + error.message);
    }
  }

  function hydratePage(options) {
    const skipFocused = Boolean(options && options.skipFocused);
    state.editableMap.forEach((meta, blockId) => {
      const node = meta.node;
      if (!(node instanceof HTMLElement) || !node.isConnected) {
        return;
      }
      if (skipFocused && node === state.focusedElement) {
        return;
      }
      const nextHtml = Object.prototype.hasOwnProperty.call(state.blocks, blockId)
        ? state.blocks[blockId]
        : state.originalBlocks[blockId] || PLACEHOLDER_HTML;
      const normalized = canonicalizeHtml(nextHtml);
      if (canonicalizeHtml(node.innerHTML) === normalized) {
        return;
      }
      state.applyingHydration = true;
      node.innerHTML = isBlankHtml(normalized) ? PLACEHOLDER_HTML : normalized;
      state.applyingHydration = false;
    });
  }

  function loadLocalSnapshot() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (parsed && parsed.blocks && typeof parsed.blocks === "object") {
        state.blocks = Object.assign({}, state.originalBlocks, parsed.blocks);
      }
      if (parsed && parsed.manifest) {
        state.manifest = normalizeManifest(parsed.manifest);
      }
    } catch (error) {
      console.warn("inline_editor local load failed", error);
    }
  }

  function persistLocalSnapshot() {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          blocks: state.blocks,
          manifest: state.manifest,
          updatedAt: new Date().toISOString(),
        })
      );
    } catch (error) {
      console.warn("inline_editor local save failed", error);
    }
  }

  function clearLocalSnapshot() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.warn("inline_editor clear failed", error);
    }
  }

  async function copySnapshot() {
    const payload = JSON.stringify(
      {
        path: PAGE_PATH,
        blocks: state.blocks,
        manifest: state.manifest,
      },
      null,
      2
    );
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(payload);
      return;
    }
    window.prompt("Copy the editor JSON", payload);
  }

  function importSnapshot() {
    const raw = window.prompt("Paste editor JSON");
    if (!raw) {
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return;
      }
      if (parsed.blocks && typeof parsed.blocks === "object") {
        Object.keys(parsed.blocks).forEach((blockId) => {
          state.blocks[blockId] = parsed.blocks[blockId];
          markDirtyBlock(blockId);
        });
      }
      if (parsed.manifest) {
        state.manifest = normalizeManifest(parsed.manifest);
        markDirtyManifest();
      }
      renderDynamicBlocks();
      hydratePage({ skipFocused: false });
      persistLocalSnapshot();
    } catch (error) {
      window.alert("Invalid JSON");
    }
  }

  function normalizeManifest(manifest) {
    const next = DEFAULT_MANIFEST();
    if (!manifest || typeof manifest !== "object" || !manifest.containers || typeof manifest.containers !== "object") {
      return next;
    }
    Object.keys(manifest.containers).forEach((containerId) => {
      if (!state.containerMap.has(containerId)) {
        return;
      }
      const entries = Array.isArray(manifest.containers[containerId]) ? manifest.containers[containerId] : [];
      next.containers[containerId] = entries
        .filter((entry) => entry && typeof entry.id === "string" && typeof entry.tag === "string")
        .map((entry) => ({
          id: entry.id,
          tag: sanitizeDynamicTag(entry.tag),
        }));
    });
    return next;
  }

  function sanitizeDynamicTag(tagName) {
    if (tagName === "h3" || tagName === "blockquote") {
      return tagName;
    }
    return "p";
  }

  function getContainerLabel(containerId) {
    const node = containerId ? state.containerMap.get(containerId) : null;
    if (!(node instanceof HTMLElement)) {
      return "first section";
    }
    const heading = node.querySelector(":scope > h1, :scope > h2, :scope > h3");
    if (heading && heading.textContent) {
      return heading.textContent.trim();
    }
    if (node.id) {
      return node.id;
    }
    return node.tagName.toLowerCase();
  }

  function sanitizeKey(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  }

  function buildDomPathId(node) {
    const segments = [];
    let current = node;
    while (current instanceof HTMLElement) {
      const tag = current.tagName.toLowerCase();
      segments.unshift(tag + getSiblingIndexByTag(current));
      if (tag === "main" || tag === "footer") {
        break;
      }
      current = current.parentElement;
    }
    return segments.join("__");
  }

  function getSiblingIndexByTag(node) {
    let index = 0;
    let current = node.previousElementSibling;
    while (current) {
      if (current.tagName === node.tagName) {
        index += 1;
      }
      current = current.previousElementSibling;
    }
    return index;
  }

  function schedulePoll() {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = window.setTimeout(async () => {
      await syncFromRemote({ initial: false, force: false });
      schedulePoll();
    }, POLL_MS);
  }

  async function syncFromRemote(options) {
    if (!hasRemoteConfig() || state.pollInFlight) {
      return state.remoteReady;
    }
    state.pollInFlight = true;
    try {
      const rows = await fetchRemoteRows();
      const hash = JSON.stringify(rows.map((row) => [row.block_id, row.html]));
      if (!options.force && !options.initial && hash === state.lastRemoteHash) {
        setMode("shared", "Everyone sees saved changes. Poll interval: " + (POLL_MS / 1000).toFixed(1) + "s");
        return true;
      }
      state.lastRemoteHash = hash;

      const incoming = {
        blocks: Object.assign({}, state.originalBlocks),
        manifest: DEFAULT_MANIFEST(),
      };

      rows.forEach((row) => {
        if (row.block_id === MANIFEST_ID) {
          try {
            incoming.manifest = normalizeManifest(JSON.parse(row.html || "{}"));
          } catch (error) {
            incoming.manifest = DEFAULT_MANIFEST();
          }
          return;
        }
        incoming.blocks[row.block_id] = row.html || PLACEHOLDER_HTML;
      });

      if (!state.dirtyManifest || options.initial) {
        state.manifest = incoming.manifest;
      }

      Object.keys(incoming.blocks).forEach((blockId) => {
        if (state.dirtyBlocks.has(blockId) && !options.initial) {
          return;
        }
        state.blocks[blockId] = incoming.blocks[blockId];
      });

      if (options.initial && rows.length === 0) {
        state.blocks = Object.assign({}, state.originalBlocks);
        state.manifest = DEFAULT_MANIFEST();
      }

      renderDynamicBlocks();
      hydratePage({ skipFocused: true });
      persistLocalSnapshot();
      setMode("shared", "Everyone sees saved changes. Poll interval: " + (POLL_MS / 1000).toFixed(1) + "s");
      return true;
    } catch (error) {
      setMode("local", "Remote unavailable: " + error.message);
      return false;
    } finally {
      state.pollInFlight = false;
    }
  }

  async function fetchRemoteRows() {
    const url = new URL("rest/v1/" + CONFIG.table, ensureTrailingSlash(CONFIG.url));
    url.searchParams.set("select", "path,block_id,html,client_id,updated_at");
    url.searchParams.set("path", "eq." + PAGE_PATH);
    url.searchParams.set("order", "block_id.asc");

    const response = await window.fetch(url.toString(), {
      method: "GET",
      headers: buildHeaders(),
    });

    if (!response.ok) {
      throw new Error("read " + response.status);
    }
    return response.json();
  }

  async function upsertRemoteRows(rows) {
    const url = new URL("rest/v1/" + CONFIG.table, ensureTrailingSlash(CONFIG.url));
    url.searchParams.set("on_conflict", "path,block_id");

    const response = await window.fetch(url.toString(), {
      method: "POST",
      headers: buildHeaders({
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify(rows),
    });

    if (!response.ok) {
      throw new Error("write " + response.status);
    }
  }

  function ensureTrailingSlash(value) {
    return String(value).endsWith("/") ? String(value) : String(value) + "/";
  }

  function buildHeaders(extra) {
    return Object.assign(
      {
        apikey: CONFIG.anonKey,
        Authorization: "Bearer " + CONFIG.anonKey,
        "Content-Type": "application/json",
      },
      extra || {}
    );
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.dataset.inlineEditorUi = "true";
    style.textContent = [
      ".ie-toolbar{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:min(420px,calc(100vw - 24px));padding:14px;border:1px solid rgba(15,23,42,.12);background:rgba(255,255,255,.96);backdrop-filter:blur(16px);box-shadow:0 20px 50px rgba(15,23,42,.14);font-family:ui-sans-serif,system-ui,sans-serif;color:#0f172a;border-radius:14px;}",
      ".ie-toolbar-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}",
      ".ie-toolbar-title{font-size:13px;font-weight:700;letter-spacing:.02em;}",
      ".ie-toolbar-subtitle,.ie-meta-line{font-size:12px;color:#475569;line-height:1.45;}",
      ".ie-toolbar-meta{display:grid;gap:4px;margin-top:10px;}",
      ".ie-status-pill{display:inline-flex;align-items:center;padding:4px 8px;border-radius:999px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;background:#d1fae5;color:#065f46;}",
      ".ie-status-pill[data-mode='local']{background:#fee2e2;color:#991b1b;}",
      ".ie-toolbar-actions,.ie-toolbar-utilities{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}",
      ".ie-button,.ie-slot-button,.ie-control-button{appearance:none;border:1px solid rgba(15,23,42,.12);background:#0f172a;color:#fff;padding:7px 10px;border-radius:10px;font-size:12px;font-weight:600;cursor:pointer;}",
      ".ie-button-secondary,.ie-control-button{background:#fff;color:#0f172a;}",
      ".ie-slot-button{background:#fff;color:#0f172a;}",
      ".ie-slot{margin-top:14px;padding:12px;border:1px dashed rgba(15,23,42,.18);background:rgba(248,250,252,.85);border-radius:12px;}",
      ".ie-slot-hidden{display:none;}",
      ".ie-slot-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}",
      ".ie-slot-label{font-size:12px;font-weight:700;color:#334155;margin-right:6px;}",
      ".ie-slot-blocks{display:grid;gap:12px;margin-top:12px;}",
      ".ie-active-container{outline:2px solid rgba(37,99,235,.14);outline-offset:6px;}",
      ".ie-slot-active{border-color:rgba(37,99,235,.38);background:rgba(239,246,255,.88);}",
      ".ie-editable-enabled{cursor:text;min-height:1.2em;outline:none;}",
      ".ie-editable-enabled:hover{box-shadow:inset 0 0 0 1px rgba(37,99,235,.26);background:rgba(239,246,255,.32);}",
      ".ie-editable-enabled:focus{box-shadow:inset 0 0 0 2px rgba(37,99,235,.48);background:rgba(239,246,255,.5);}",
      ".ie-dynamic-wrapper{display:grid;gap:8px;padding:10px;border:1px solid rgba(15,23,42,.1);background:#fff;border-radius:12px;}",
      ".ie-dynamic-controls{display:flex;flex-wrap:wrap;gap:6px;}",
      ".ie-dynamic-block{margin:0;}",
      "@media (max-width: 720px){.ie-toolbar{left:12px;right:12px;width:auto;bottom:12px;}}",
    ].join("");
    document.head.appendChild(style);
  }
})();
