// In-app replacements for window.confirm / alert / prompt.
//
// Native dialogs are blocking, unstyled, unplaceable, and on some browsers carry a "prevent this page
// from creating more dialogs" checkbox that can silently disable every later prompt. Every surface here
// -- TermDeck, FileDeck, and the recovery page -- shares this module so a confirmation looks and behaves
// the same everywhere, including on pages that do not load TermDeck's own stylesheet.
//
// The only native dialog deliberately left in place is the browser's own beforeunload prompt, which a
// page cannot draw itself.
(function attachDialogs(global) {
  const STYLE_ID = "td-modal-styles";
  // Uses TermDeck's palette variables where they exist and falls back to literals where they do not, so
  // the same markup renders correctly on FileDeck and the recovery page.
  const CSS = `
.td-modal-backdrop { position: fixed; inset: 0; z-index: 100000; display: flex; align-items: flex-start;
  justify-content: center; padding: min(16vh, 150px) 18px 18px;
  background: color-mix(in srgb, #000 50%, transparent); backdrop-filter: blur(2px); }
.td-modal { width: min(520px, calc(100vw - 36px)); max-height: calc(100vh - 60px); overflow: auto;
  padding: 15px; border: 1px solid var(--active-border, #4a4a4a); border-radius: 8px;
  box-shadow: 0 18px 55px #0009; background: var(--panel, #1e1e1e); color: var(--text, #e6e6e6); }
.td-modal-title { margin-bottom: 6px; font: 700 calc(var(--ui-font-size, 12px) + 2px)/1.3 Menlo, monospace;
  color: var(--text, #e6e6e6); }
.td-modal-message { margin-bottom: 12px; color: var(--dim, #a0a0a0);
  font: var(--ui-font-size, 12px)/1.45 Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.td-modal-field { display: flex; flex-direction: column; gap: 5px; margin-top: 11px; }
.td-modal-field input { width: 100%; box-sizing: border-box; padding: 8px 9px;
  border: 1px solid var(--border, #3a3a3a); border-radius: 5px; outline: none;
  background: var(--bg, #141414); color: var(--text, #e6e6e6);
  font: var(--code-font-size, 12px)/1.45 Menlo, monospace; }
.td-modal-field input:focus { border-color: var(--accent, #5ccfe6);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #5ccfe6) 18%, transparent); }
.td-modal-actions { display: flex; justify-content: flex-end; gap: 7px; margin-top: 15px; }
.td-modal-actions button { min-width: 78px; min-height: 29px; padding: 3px 10px;
  border: 1px solid var(--border, #3a3a3a); border-radius: 5px; background: var(--panel2, #262626);
  color: var(--text, #e6e6e6); cursor: pointer; font: var(--ui-font-size, 12px)/1.2 Menlo, monospace; }
.td-modal-actions button.primary { border-color: var(--accent, #5ccfe6); background: var(--accent, #5ccfe6); color: #fff; }
.td-modal-actions button.danger { border-color: #c55454; background: #a73d3d; color: #fff; }
`;

  const ensureStyles = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  };

  // One dialog at a time. Native dialogs serialised by blocking the thread; these do not, and code paths
  // that fired two in a row (a confirm followed by its failure alert) would otherwise stack them.
  let pending = Promise.resolve();

  const open = ({ title, message, defaultValue = null, confirmLabel = "OK", cancelLabel = "Cancel",
                  danger = false, hideCancel = false }) => new Promise((resolve) => {
    ensureStyles();
    const backdrop = document.createElement("div");
    backdrop.className = "td-modal-backdrop";
    const form = document.createElement("form");
    form.className = "td-modal";
    form.setAttribute("role", "dialog");
    form.setAttribute("aria-modal", "true");
    if (title) {
      const heading = document.createElement("div");
      heading.className = "td-modal-title";
      heading.textContent = title;
      form.appendChild(heading);
    }
    if (message) {
      const body = document.createElement("div");
      body.className = "td-modal-message";
      body.textContent = message;
      form.appendChild(body);
    }
    let input = null;
    if (defaultValue !== null) {
      const field = document.createElement("label");
      field.className = "td-modal-field";
      input = document.createElement("input");
      input.type = "text";
      input.value = defaultValue;
      input.spellcheck = false;
      field.appendChild(input);
      form.appendChild(field);
    }
    const actions = document.createElement("div");
    actions.className = "td-modal-actions";
    if (!hideCancel) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = cancelLabel;
      cancel.onclick = () => close(null);
      actions.appendChild(cancel);
    }
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = danger ? "danger" : "primary";
    submit.textContent = confirmLabel;
    actions.appendChild(submit);
    form.appendChild(actions);
    backdrop.appendChild(form);

    const previouslyFocused = document.activeElement;
    const close = (value) => {
      document.removeEventListener("keydown", onKeyDown, true);
      backdrop.remove();
      // Terminals and editors lose focus to the dialog; hand it back so typing resumes where it was.
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        requestAnimationFrame(() => { try { previouslyFocused.focus(); } catch { /* gone */ } });
      }
      resolve(value);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close(null);
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      close(input ? input.value : true);
    };
    backdrop.onmousedown = (event) => { if (event.target === backdrop) close(null); };
    // Capture phase: the terminal and editor keymaps also listen for Escape.
    document.addEventListener("keydown", onKeyDown, true);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => (input || submit).focus());
  });

  const queue = (options) => {
    const run = pending.then(() => open(options));
    pending = run.catch(() => {});
    return run;
  };

  global.TermdeckDialogs = {
    // Resolves true/false. `danger` paints the confirm button red for destructive actions.
    confirm(message, { title = "Confirm", confirmLabel = "OK", cancelLabel = "Cancel", danger = false } = {}) {
      return queue({ title, message, confirmLabel, cancelLabel, danger }).then((value) => value === true);
    },
    // Resolves when dismissed. Callers that do not care may drop the promise.
    alert(message, { title = "TermDeck", confirmLabel = "OK" } = {}) {
      return queue({ title, message, confirmLabel, hideCancel: true }).then(() => undefined);
    },
    // Resolves the entered string, or null when cancelled -- same contract as window.prompt.
    prompt(message, defaultValue = "", { title = "", confirmLabel = "OK" } = {}) {
      return queue({ title: title || message, message: title ? message : "",
                     defaultValue: String(defaultValue ?? ""), confirmLabel })
        .then((value) => (typeof value === "string" ? value : null));
    },
  };
})(window);
