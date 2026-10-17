class TermdeckLoadingRecoveryController {
  static RECOVERY_ACTION_DELAY_MS = 8000;
  static SERVER_RESTART_POLL_MS = 700;
  static SERVER_RESTART_RELOAD_DELAY_MS = 1200;

  constructor() {
    this.loadingState = document.getElementById("initial-loading-state");
    this.recovery = document.getElementById("initial-loading-recovery");
    this.markdownButton = document.getElementById("initial-loading-markdown");
    this.loginButton = document.getElementById("initial-loading-login");
    this.refreshButton = document.getElementById("initial-loading-refresh");
    this.restartButton = document.getElementById("initial-loading-restart");
    this.stopButton = document.getElementById("initial-loading-stop-terminals");
    this.status = document.getElementById("initial-loading-recovery-status");
    this.recoveryTimer = 0;
    // Hidden by hand, it stays hidden until loading ends: offline it would otherwise sit over the
    // page for as long as the outage lasts. The next stall after that shows it again.
    this.dismissed = false;
    document.body.appendChild(this.recovery);
    this.loginButton.classList.toggle("hidden", location.protocol !== "https:");
    document.getElementById("initial-loading-recovery-close").addEventListener("click", this.dismiss.bind(this));
    this.markdownButton.addEventListener("click", this.switchToTranscript.bind(this));
    this.loginButton.addEventListener("click", this.signInAgain.bind(this));
    this.refreshButton.addEventListener("click", this.refreshPage.bind(this));
    this.restartButton.addEventListener("click", this.restartServer.bind(this));
    this.stopButton.addEventListener("click", this.stopTerminals.bind(this));
    this.schedule();
  }

  isLoading() {
    const app = window.__td;
    const transcriptPending = app?.historyOpen && app.activeFileKey === null && !app.historyLoaded;
    const connectionWarning = document.getElementById("mobile-connection-warning");
    return !this.loadingState.classList.contains("hidden") || transcriptPending ||
      !connectionWarning.classList.contains("hidden");
  }

  schedule() {
    if (this.dismissed || this.recoveryTimer || !this.recovery.classList.contains("hidden")) return;
    this.recoveryTimer = window.setTimeout(this.showRecoveryIfLoading.bind(this),
      TermdeckLoadingRecoveryController.RECOVERY_ACTION_DELAY_MS);
  }

  showRecoveryIfLoading() {
    this.recoveryTimer = 0;
    if (!this.isLoading()) return;
    this.show();
  }

  show() {
    if (this.dismissed) return;
    this.markdownButton.classList.toggle("hidden", !!window.__td?.historyOpen);
    this.recovery.classList.remove("hidden");
  }

  dismiss() {
    this.dismissed = true;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = 0;
    this.recovery.classList.add("hidden");
  }

  finish() {
    if (this.isLoading()) return;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = 0;
    this.dismissed = false;
    this.recovery.classList.add("hidden");
    this.status.textContent = "";
  }

  setActionsDisabled(disabled) {
    for (const button of [this.markdownButton, this.refreshButton,
      this.restartButton, this.stopButton]) button.disabled = disabled;
  }

  switchToTranscript() {
    const app = window.__td;
    if (!app?.activeId) {
      this.status.textContent = "No terminal session is selected yet.";
      return;
    }
    if (!app.sessionSupportsTranscript()) {
      this.status.textContent = "Transcript is unavailable for this terminal.";
      return;
    }
    app.setHistoryMode(true);
    this.markdownButton.classList.add("hidden");
  }

  signInAgain() {
    const loginUrl = new URL("/_remote/login", location.origin);
    loginUrl.searchParams.set("return_to", `${location.pathname}${location.search}${location.hash}`);
    location.assign(loginUrl.href);
  }

  refreshPage() {
    location.reload();
  }

  async reloadWhenServerReturns() {
    try {
      const response = await fetch(`/api/projects?restart_probe=${Date.now()}`, { cache: "no-store" });
      if (response.ok) {
        this.refreshPage();
        return;
      }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      this.status.textContent = "TermDeck is restarting…";
    }
    window.setTimeout(this.reloadWhenServerReturns.bind(this),
      TermdeckLoadingRecoveryController.SERVER_RESTART_POLL_MS);
  }

  async restartServer() {
    this.setActionsDisabled(true);
    this.status.textContent = "Restarting TermDeck; terminals will keep running…";
    try {
      const response = await fetch("/api/server/restart", { method: "POST" });
      if (!response.ok) {
        this.status.textContent = `Unable to restart TermDeck (${response.status}). Try signing in again.`;
        this.setActionsDisabled(false);
        return;
      }
      window.setTimeout(this.reloadWhenServerReturns.bind(this),
        TermdeckLoadingRecoveryController.SERVER_RESTART_RELOAD_DELAY_MS);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      this.status.textContent = `Unable to restart TermDeck: ${error.message}`;
      this.setActionsDisabled(false);
    }
  }

  async stopTerminals() {
    const confirmed = await window.TermdeckDialogs.confirm("Stop every running terminal? Work currently in progress will be interrupted. Tabs, transcripts, and history remain available and can be restarted later.",
      { title: "Stop all terminals", confirmLabel: "Stop all", danger: true });
    if (!confirmed) return;
    this.setActionsDisabled(true);
    this.status.textContent = "Stopping running terminals…";
    try {
      const response = await fetch("/api/terminals/kill-all", { method: "POST" });
      if (!response.ok) {
        this.status.textContent = `Unable to stop terminals (${response.status}).`;
        this.setActionsDisabled(false);
        return;
      }
      const result = await response.json();
      const killed = Number(result.killed || 0);
      this.status.textContent = `Stopped ${killed} terminal${killed === 1 ? "" : "s"}; tabs and history were preserved.`;
      window.setTimeout(this.refreshPage.bind(this), 900);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      this.status.textContent = `Unable to stop terminals: ${error.message}`;
      this.setActionsDisabled(false);
    }
  }
}

window.TermdeckLoadingRecovery = new TermdeckLoadingRecoveryController();
