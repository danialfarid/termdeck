"use strict";
// PlannerEditor — owns the one open description editor at a time: mounts the
// chosen rich editor, autosaves every 5s, warns on unload while dirty, and
// drives fullscreen. App code calls open()/close()/flush() and provides an
// onSave(markdown) callback. Exposes window.PlannerEditor.

(function () {
  const { MOUNTS } = window.EditorLoaders;
  const EDITORS = ["milkdown", "tiptap", "toast", "easymde"];
  const LABELS = { milkdown: "Milkdown", tiptap: "TipTap", toast: "Toast UI", easymde: "EasyMDE" };
  const AUTOSAVE_MS = 5000;
  const LS = "termdeckNotebookEditor";

  let chosen = localStorage.getItem(LS) || "milkdown";
  let active = null; // { host, getMd, onSave, lastSaved, timer, bu }

  function getEditor() { return chosen; }
  function setEditor(key) { if (EDITORS.includes(key)) { chosen = key; localStorage.setItem(LS, key); } }
  function isOpen() { return !!active; }
  function getMarkdown() { return active ? active.getMd() : null; }
  function isDirty() { return !!(active && active.getMd() !== active.lastSaved); }
  // has the user actually changed the content since the editor mounted? (compared
  // to the editor's own normalized initial output, so reformatting ≠ "edited")
  function isEdited() { return !!(active && active.getMd() !== active.initial); }

  // mount the chosen editor into `host`; a plain textarea is the offline fallback
  async function open(host, initialMd, { onSave }) {
    closeNow();
    host.classList.remove("tui-fallback");
    const ta = document.createElement("textarea");
    ta.className = "notes-area sn-edit-big";
    ta.placeholder = "Quick notes… Markdown supported.";
    ta.value = initialMd;
    host.appendChild(ta);
    let getMd = () => ta.value;
    try {
      getMd = await MOUNTS[chosen](host, initialMd);
      ta.style.display = "none";
    } catch (e) {
      host.classList.add("tui-fallback"); // CDN blocked — keep the textarea
    }
    // baseline = the editor's own initial markdown (may be normalized vs initialMd),
    // so isDirty/isEdited don't false-positive from on-load reformatting
    let baseline = initialMd;
    try { baseline = getMd(); } catch (e) { /* keep initialMd */ }
    active = { host, getMd, onSave, lastSaved: baseline, initial: baseline };
    active.timer = setInterval(() => { tick(); }, AUTOSAVE_MS);
    active.bu = (e) => {
      if (!isDirty()) return;
      e.preventDefault();
      e.returnValue = "You have edits that haven’t saved yet.";
      return e.returnValue;
    };
    window.addEventListener("beforeunload", active.bu);
    return active;
  }

  // persist the current markdown; captures the value synchronously so callers
  // may render() / tear down right after without awaiting.
  function flush() {
    if (!active || !isDirty()) return Promise.resolve();
    const md = active.getMd();
    const p = Promise.resolve(active.onSave(md));
    active.lastSaved = md;
    return p;
  }
  async function tick() { try { await flush(); } catch (e) { /* keep editing; retry next tick */ } }

  function closeNow() {
    if (!active) return;
    clearInterval(active.timer);
    window.removeEventListener("beforeunload", active.bu);
    active = null;
    exitFullscreen(); // never leave body.editor-fs-lock (unscrollable page) behind
  }
  // flush (capturing the value now) then tear down
  function close() { const p = flush(); closeNow(); return p; }

  function toggleFullscreen() {
    if (!active) return;
    const wrap = active.host.closest(".sn-editor") || active.host;
    const on = wrap.classList.toggle("editor-fullscreen");
    document.body.classList.toggle("editor-fs-lock", on);
  }
  function exitFullscreen() {
    const fs = document.querySelector(".editor-fullscreen");
    if (!fs) return false;
    fs.classList.remove("editor-fullscreen");
    document.body.classList.remove("editor-fs-lock");
    return true;
  }

  window.PlannerEditor = {
    EDITORS, LABELS, getEditor, setEditor, open, close, closeNow, flush,
    isOpen, isDirty, isEdited, getMarkdown, toggleFullscreen, exitFullscreen,
  };
})();
