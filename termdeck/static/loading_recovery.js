(() => {
  const RECOVERY_ACTION_DELAY_MS = 8000;
  const SERVER_RESTART_POLL_MS = 700;
  const SERVER_RESTART_RELOAD_DELAY_MS = 1200;
  const loadingState = document.getElementById("initial-loading-state");
  const recovery = document.getElementById("initial-loading-recovery");
  const markdownButton = document.getElementById("initial-loading-markdown");
  const refreshButton = document.getElementById("initial-loading-refresh");
  const restartButton = document.getElementById("initial-loading-restart");
  const stopButton = document.getElementById("initial-loading-stop-terminals");
  const status = document.getElementById("initial-loading-recovery-status");
  if (!loadingState || !recovery || !markdownButton || !refreshButton || !restartButton || !stopButton || !status) return;

  window.setTimeout(() => {
    if (!loadingState.classList.contains("hidden")) recovery.classList.remove("hidden");
  }, RECOVERY_ACTION_DELAY_MS);

  const setActionsDisabled = (disabled) => {
    markdownButton.disabled = disabled;
    refreshButton.disabled = disabled;
    restartButton.disabled = disabled;
    stopButton.disabled = disabled;
  };

  markdownButton.addEventListener("click", () => {
    const app = window.__td;
    if (!app?.activeId) {
      status.textContent = "No terminal session is selected yet.";
      return;
    }
    if (!app.sessionSupportsTranscript()) {
      status.textContent = "Markdown transcript is unavailable for this terminal.";
      return;
    }
    app.setHistoryMode(true);
    app.finishInitialPageContentLoading(app.activeId);
  });

  refreshButton.addEventListener("click", () => location.reload());

  const reloadWhenServerReturns = () => {
    window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/projects?restart_probe=${Date.now()}`, { cache: "no-store" });
        if (response.ok) {
          location.reload();
          return;
        }
      } catch (error) {
        status.textContent = "TermDeck is restarting…";
      }
      reloadWhenServerReturns();
    }, SERVER_RESTART_POLL_MS);
  };

  restartButton.addEventListener("click", async () => {
    setActionsDisabled(true);
    status.textContent = "Restarting TermDeck; terminals will keep running…";
    try {
      const response = await fetch("/api/server/restart", { method: "POST" });
      if (!response.ok) throw new Error(`restart request failed (${response.status})`);
      window.setTimeout(reloadWhenServerReturns, SERVER_RESTART_RELOAD_DELAY_MS);
    } catch (error) {
      status.textContent = `Unable to restart TermDeck: ${error.message}`;
      setActionsDisabled(false);
    }
  });

  stopButton.addEventListener("click", async () => {
    const confirmed = await window.TermdeckDialogs.confirm("Stop every running terminal? Work currently in progress will be interrupted. Tabs, transcripts, and history remain available and can be restarted later.",
      { title: "Stop all terminals", confirmLabel: "Stop all", danger: true });
    if (!confirmed) return;
    setActionsDisabled(true);
    status.textContent = "Stopping running terminals…";
    try {
      const response = await fetch("/api/terminals/kill-all", { method: "POST" });
      if (!response.ok) throw new Error(`stop request failed (${response.status})`);
      const result = await response.json();
      const killed = Number(result.killed || 0);
      status.textContent = `Stopped ${killed} terminal${killed === 1 ? "" : "s"}; tabs and history were preserved.`;
      window.setTimeout(() => location.reload(), 900);
    } catch (error) {
      status.textContent = `Unable to stop terminals: ${error.message}`;
      setActionsDisabled(false);
    }
  });
})();
