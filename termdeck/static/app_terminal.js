// Split from app.js (2026-08-26): terminal views, replay, the tall-scroll engine, repaint/repair.
// Same class, split across files: this attaches methods to TermdeckApp.prototype, and
// index.html loads the app_*.js files after app.js and before app_boot.js.
Object.assign(TermdeckApp.prototype, {


  ensureView(id) {
    if (this.views.has(id)) return this.views.get(id);
    const container = document.createElement("div");
    container.className = "term-container initializing";
    // Tall-terminal-probe worktree only: xterm.js has no concept of scrolling within an oversized
    // "current screen" -- its own viewport only becomes scrollable once content has genuinely scrolled
    // into real backscroll (baseY > 0). Confirmed directly: with rows forced to 1000, term.scrollToBottom()
    // and term.scrollLines(200) both left viewportY pinned at 0, and .xterm-viewport measured
    // maxScrollTop=0 even with the cursor 200+ rows below the visible fold. Real TermDeck never hits this
    // (sessions stay around 30-50 rows, matching the visible area exactly, so there's nothing to scroll).
    // The fix used here sidesteps xterm's scroll model entirely instead of fighting it: `inner` (not
    // `container`) is what gets passed to term.open() and is what FitAddon measures, and its height is set
    // to the real pixel height of FORCE_ROWS rows. xterm therefore just sees an ordinary, fully-fitting,
    // very tall terminal -- nothing about its rendering or internal scroll logic is unusual. `container`
    // stays the normal small visible area (unchanged everywhere else in this file: layout, visibility
    // checks, resize observers) but now has native CSS overflow-y scrolling, so the browser's own
    // scrollbar/wheel/trackpad handling -- not xterm's -- is what moves through the tall inner content.
    const inner = document.createElement("div");
    inner.className = "term-inner";
    container.appendChild(inner);
    this.$("terminal-area").appendChild(container);
    // "wheel" specifically, not "scroll": confirmed live that a generic "scroll" event cannot be trusted
    // to mean the user acted -- xterm repositions its hidden input textarea to track the cursor (for IME
    // candidate-window placement), and while that textarea stays focused, the browser's own "keep the
    // focused element in view" behavior fires ordinary "scroll" events on this container with no user
    // input and no code of TermDeck's involved. Traced live: that contamination created a feedback loop --
    // one write's post-check reads a scrollTop the browser had already nudged, concludes the user must be
    // following, and every write after that keeps genuinely following, silently overriding a deliberate
    // scroll-away. A wheel/trackpad gesture is a real user action the browser's own auto-scroll can never
    // synthesize, so it's the only signal trusted here.
    //
    // Debounced, not a single deferred frame: a single rAF was tried first and was still too early for a
    // large wheel delta, which Chrome answers with a multi-frame smooth-scroll animation -- confirmed
    // live, that one-frame check read scrollTop before the animation had gone anywhere, computed "still
    // near the cursor", and never re-checked once the animation actually finished moving it away.
    // Debouncing on "no further wheel events for 150ms" is correct regardless of whether a given browser
    // animates the scroll or applies it instantly.
    let tallWheelSettleTimer = 0;
    container.addEventListener("wheel", (event) => {
      const wheelView = this.views.get(id);
      if (wheelView) {
        wheelView.tallUserScrollIntentPending = true;
        // Stopping the follow has to be IMMEDIATE, and cannot wait for the debounce below. A streaming
        // agent delivers a write every ~20-50ms, and each write while following snaps back to the bottom
        // -- so a scroll-up was being undone within a frame or two, long before the 150ms settle fired,
        // and the settle then measured a position already dragged back to the bottom and concluded the
        // user still wanted to follow. Measured: scrolling up during active output left following=true
        // with scrollTop pinned to the ceiling across 12 consecutive samples, i.e. it was impossible to
        // read anything while the agent worked. Scrolling UP is unambiguous on its own, so it takes
        // effect on the spot; only the decision to RESUME following needs the settled position, which is
        // what the debounce below still handles.
        if (event.deltaY < 0) {
          wheelView.tallFollowing = false;
          wheelView.tallUserBottomReturnCeiling = null;
        } else if (wheelView.tallMaxScrollTop != null &&
                   container.scrollTop + event.deltaY >= wheelView.tallMaxScrollTop - TALL_BOTTOM_TOLERANCE_PX) {
          wheelView.tallUserBottomReturnCeiling = wheelView.tallMaxScrollTop;
        }
        // Writes must not fight an in-progress gesture either: while the wheel is still moving, the
        // not-following branch of drainTerminalWrites would keep restoring an anchor captured before
        // this gesture started, which reads as the view refusing to scroll.
        wheelView.tallWheelActiveUntil = Date.now() + 250;
      }
      clearTimeout(tallWheelSettleTimer);
      tallWheelSettleTimer = setTimeout(() => {
        const view = this.views.get(id);
        if (!view) return;
        view.tallWheelActiveUntil = 0;
        view.tallScrollActiveUntil = 0;
        this.tallUpdateMaxScrollTop(view);
        view.tallUserScrollIntentPending = false;
        this.tallApplySettledScroll(view);
      }, 150);
    }, { passive: true });
    // A hard ceiling, not an intent signal -- unlike the "wheel" listener above, this one never decides
    // anything about the user, it just enforces tallMaxScrollTop (see its own comment) whenever a scroll
    // lands past it, however that scroll happened: native or programmatic, deliberate or the browser's own
    // focus-driven auto-scroll.
    //
    // Deferred until scrolling stops, though, because clamping cannot win an argument with a scroll source
    // that is still running. Dragging the scrollbar thumb is one: the browser re-derives scrollTop from the
    // held pointer every frame, so an immediate clamp was overwritten and re-clamped frame after frame,
    // which reads as the text tearing between two positions at once. Waiting for a short quiet period
    // means the drag simply wins while it lasts and gets clamped once, cleanly, on release. Nothing is
    // lost by waiting: the wheel handler below already refuses to overshoot in the first place, so this
    // path only ever sees drags and programmatic jumps.
    let tallClampTimer = 0;
    const scheduleTallSettle = () => {
      const watching = this.views.get(id);
      if (!watching || watching.closed) return;
      // Remember where the settle was scheduled from, so the callback can tell whether the view is
      // actually still. Events alone are not enough to know that: our own writes are skipped as echoes
      // below, and the browser coalesces bursts, so a gesture can keep moving while this listener hears
      // nothing -- and a settle that fires mid-gesture is exactly the clamp that tears the view.
      watching.tallSettleWatchTop = container.scrollTop;
      clearTimeout(tallClampTimer);
      tallClampTimer = setTimeout(() => {
        const settled = this.views.get(id);
        if (!settled || settled.closed) return;
        // A held pointer is the one case a quiet period cannot detect: holding the thumb still IS quiet,
        // right up until a clamp perturbs it, and then the browser re-derives scrollTop from the pointer
        // that is still down and undoes the clamp -- which fires another settle, forever. Measured as a
        // steady ~150ms pulse while the thumb was held at the bottom. So while any pointer is down on
        // this terminal, nothing here moves the view; release re-runs this once.
        if (settled.tallPointerHeld) return;
        if (Math.abs(container.scrollTop - (settled.tallSettleWatchTop || 0)) > 2) {
          scheduleTallSettle();   // moved since scheduling: still in flight, wait for real quiet
          return;
        }
        const applyUserScrollIntent = settled.tallUserScrollIntentPending === true;
        settled.tallScrollActiveUntil = 0;
        // Refresh the ceiling from the buffer as it is NOW, before enforcing it. It is otherwise only
        // recomputed on writes, so a value latched from a mid-repaint cursor on a session that then goes
        // idle is permanent -- and the clamp below enforces the stale number against every attempt to
        // scroll to content that sits beyond it ("the bottom of the screen is in the middle, and it
        // keeps bringing me back up"). A user gesture is exactly the moment a stale ceiling must not
        // win; the update's own guards (replay, blank-region, shrink hold) still apply.
        this.tallUpdateMaxScrollTop(settled);
        if (settled.tallMaxScrollTop != null &&
            container.scrollTop > settled.tallMaxScrollTop + TALL_OVERSHOOT_DEADZONE_PX) {
          this.tallSetScrollTop(settled, settled.tallMaxScrollTop);
        }
        if (applyUserScrollIntent) {
          settled.tallUserScrollIntentPending = false;
          this.tallApplySettledScroll(settled);
        }
      }, TALL_SCROLL_SETTLE_MS);
    };
    // Pointer-held tracking. Registered on the container in capture so a scrollbar interaction counts,
    // and released from the window because the pointerup can land anywhere once a drag is under way.
    const releaseTallPointer = () => {
      const view = this.views.get(id);
      window.removeEventListener("pointerup", releaseTallPointer, true);
      window.removeEventListener("pointercancel", releaseTallPointer, true);
      if (!view || view.closed) return;
      view.tallPointerHeld = false;
      const rememberedBottom = view.tallUserBottomReturnCeiling;
      if (view.tallMaxScrollTop != null &&
          container.scrollTop >= view.tallMaxScrollTop - TALL_BOTTOM_TOLERANCE_PX) {
        view.tallUserBottomReturnCeiling = view.tallMaxScrollTop;
      } else if (rememberedBottom != null &&
                 container.scrollTop < rememberedBottom - TALL_BOTTOM_TOLERANCE_PX) {
        view.tallUserBottomReturnCeiling = null;
      }
      view.tallUserScrollIntentPending = true;
      view.tallScrollActiveUntil = Date.now() + TALL_SCROLL_ACTIVE_MS;
      scheduleTallSettle();       // now that it is released, let it settle exactly once
    };
    container.addEventListener("pointerdown", () => {
      const view = this.views.get(id);
      if (!view || view.closed) return;
      view.tallPointerHeld = true;
      view.tallUserScrollIntentPending = true;
      window.addEventListener("pointerup", releaseTallPointer, true);
      window.addEventListener("pointercancel", releaseTallPointer, true);
    }, { capture: true, passive: true });
    container.addEventListener("scroll", () => {
      const view = this.views.get(id);
      if (!view || view.closed) return;
      this.updateTerminalHistoryMoreButton(view);
      // Our own scrolls must not read as the user scrolling, or following would flip on every write.
      // Matching on value ALONE is wrong: the user scrolling to the bottom lands on exactly the ceiling
      // we last set ourselves, so a real gesture was being discarded as an echo -- which is what left the
      // pinned viewport stale and the newest lines unreachable. Track whether a write is actually waiting
      // for its scroll event instead of using a timing window that can swallow a real move to that value.
      const echoOfOurOwnWrite = view.tallProgrammaticScrollPending &&
        container.scrollTop === view.tallLastProgrammaticTop;
      view.tallProgrammaticScrollPending = false;
      if (echoOfOurOwnWrite) return;
      if (view.tallUserScrollIntentPending && view.tallMaxScrollTop != null &&
          container.scrollTop >= view.tallMaxScrollTop - TALL_BOTTOM_TOLERANCE_PX) {
        view.tallUserBottomReturnCeiling = view.tallMaxScrollTop;
      }
      // Marks a gesture as in progress. Writes check this and leave the view completely alone while it is
      // set: a scrollbar drag or an autoscroll keeps producing scroll events, and a write that re-asserts
      // the follow position in the middle of one is what tears the text between two positions.
      if (view.tallUserScrollIntentPending) {
        view.tallScrollActiveUntil = Date.now() + TALL_SCROLL_ACTIVE_MS;
      }
      // The scroll position is the buffer position in this mode, so it has to be honoured immediately
      // rather than waiting for the gesture to settle -- the rendered window is what makes the scroll
      // visible at all.
      this.tallSyncBufferToScroll(view);
      scheduleTallSettle();
    }, { passive: true });
    const term = new Terminal({
      fontSize: this.scaledSettingSize("terminal_font_size"), fontFamily: '"SF Mono", Menlo, monospace', letterSpacing: -0.2, theme: this.terminalDisplayTheme(),
      // scrollOnUserInput must be off: it scrolls xterm's own viewport to the buffer bottom on every
      // keystroke, but that viewport is DERIVED from the container's scroll position in this layout
      // (tallSyncBufferToScroll), so each key bounced it down a row and the sync pulled it back -- both
      // frames painted, a visible jitter on every key press whenever any scrollback existed. The typing
      // key handler resumes following through the container instead, which is the surface that scrolls.
      scrollOnUserInput: false,
      scrollback: 20000, cursorBlink: true, macOptionIsMeta: true, allowProposedApi: true,
    });
    const fit = new FitAddon.FitAddon();
    const terminalFindAddon = new SearchAddon.SearchAddon({ highlightLimit: TERMINAL_FIND_HIGHLIGHT_LIMIT });
    term.loadAddon(fit);
    if (terminalFindAddon) term.loadAddon(terminalFindAddon);
    // The other half of taking xterm out of the scroll chain (style.css's overflow-y:hidden on
    // .xterm-viewport is the first half, and on its own does nothing here). xterm does not rely on that
    // element's CSS overflow to scroll -- it registers its own non-passive "wheel" listener and drives the
    // buffer directly, so the CSS rule alone left the measured two-stage behavior completely unchanged.
    // Returning false from this hook is xterm's supported way to say "ignore this wheel event", which
    // leaves the browser to scroll the one remaining scrollable ancestor: .term-container.
    //
    // Unconditional, including on the alternate screen. In a normal terminal xterm translates wheel into
    // arrow keys there, which is right because the alt screen is exactly one screenful with nothing to
    // scroll over -- but that premise does not survive 1000 forced rows. A full-screen app here paints a
    // 1000-row UI of which .term-container shows ~37, so the wheel's first job is moving the viewport
    // over what the app already painted, which only the container can do. Measured: `seq 1 500 | less`
    // painted all 500 lines at once into rows 499-998; letting xterm keep the wheel would have left ~963
    // painted rows unreachable by mouse.
    //
    // Known tradeoff, not an oversight: for content that overflows even 1000 rows (`seq 1 5000 | less`),
    // the app does still have somewhere to scroll, and the wheel no longer tells it so -- paging past the
    // painted rows needs the keyboard. Bridging the container's bottom edge back into arrow keys the way
    // the normal screen bridges into scrollback would fix that, but it needs the app-cursor-keys mode off
    // xterm's private coreService to pick the right escape sequence, so it is left alone here.
    //
    // The one exception is a fullscreen_tui agent on its alternate screen: its pty is viewport-sized
    // (see fullscreenTuiPtyRows), so the container has nothing to scroll over and the app itself owns
    // scrolling -- the wheel must reach it. Letting xterm process the event does that on either path:
    // with mouse tracking on it reports the wheel to the pty, without it the alternate screen turns
    // wheel into arrow keys. Gated on the alternate screen so the launching shell's ordinary output
    // still scrolls through the container.
    term.attachCustomWheelEventHandler(() =>
      term.buffer.active.type === "alternate" &&
      !!this.agentSpec(this.session(id)?.agent_kind)?.fullscreen_tui);
    term.open(inner);
    // Real cell height is only known once xterm has measured the font, which happens synchronously inside
    // open(). The row count is an explicit pixel height rather than something derived from the container
    // (the FitAddon-based approach tried earlier) because it has to stay fixed across every later resize
    // -- if it tracked the container's height the way a normal terminal does, this collapses straight back
    // to the problem being solved.
    //
    // Height and renderer are chosen together by tallRowPlan (see it for the arithmetic). WebGL backs the
    // terminal with one drawing buffer sized to the FULL terminal, so an over-tall terminal does not fail
    // loudly -- it silently corrupts, which is what the solid-black screen at 1000 rows was. So the WebGL
    // mode takes the tallest height the GPU can back and the DOM mode, which has no texture limit at all,
    // is what buys the full 1000 rows.
    const cellHeight = term._core?._renderService?.dimensions?.css?.cell?.height || 17;
    const targetRowPlan = this.tallRowPlan(cellHeight);
    // The webgl cold prime (replay at DOM height, then resize down) is disabled: a claude recording is
    // made at the pty's height, and its output only ever SCROLLS when the cursor reaches the terminal's
    // last row -- replayed into a much taller terminal the cursor never gets there, so every repaint
    // overwrites in place and only the final screen survives. Measured on a real 9.5MB recording: 548
    // rows of history through the 4000-row prime, 20,000+ rows replayed directly at the webgl height.
    // The prime machinery is kept below but never engaged.
    const claudeWebglColdPrime = false;
    const rowPlan = claudeWebglColdPrime ? { rows: TALL_ROWS_DOM, webgl: false } : targetRowPlan;

    inner.style.height = `${Math.round(rowPlan.rows * cellHeight)}px`;
    if (rowPlan.webgl) this.enableWebglRenderer(term);
    term.registerLinkProvider({ provideLinks: (y, cb) => this.providePathLinks(term, id, y, cb) });
    const view = { sessionId: id, container, term, fit, terminalFindAddon, tallRows: rowPlan.rows,
                   terminalFindResultIndex: -1,
                   terminalFindResultCount: 0, terminalFindResultListener: null,
                   tallWebgl: rowPlan.webgl,
                   claudeWebglColdPrimePending: claudeWebglColdPrime,
                   claudeWebglColdPrimeTargetRows: claudeWebglColdPrime ? targetRowPlan.rows : 0,
                   claudeWebglColdPrimeStartedAt: 0, claudeWebglColdPrimeLastOutputAt: 0,
                   claudeWebglColdPrimeTimer: 0, claudeWebglColdPrimeCompleting: false,
                   ws: null, closed: false, everConnected: false, awaitingSnapshot: true,
                   replaying: false, pasting: false, suppressReconnect: false, cliTitle: null, pinBottomUntil: 0,
                   programmaticScrollUntil: 0, programmaticScrollGeneration: 0, scrollSettleTimer: 0,
                   reconnectTimer: 0, settleFrame: 0, viewportRepairFrame: 0, needsViewportRepair: false,
                   resizeRepairTimer: 0, outputQueue: [], outputQueueBytes: 0, outputWriteInFlight: false,
                   outputWriteGeneration: 0, inactiveOutputDeferred: false, inactiveOutputDrainTimer: 0,
                   connectAfterOutputDrain: false,
                   layoutObserver: null, scrollObserver: null, visibilityObserver: null,
                   layoutFitRetryTimer: 0, layoutFitRetryCount: 0,
                   keepBottom: true, manualScroll: false, manualScrollGeneration: 0, manualScrollReleaseTimer: 0,
                   wasAtBottom: true, scrollMode: "follow", v2Programmatic: false, v2FitFrame: 0,
                   userScrollIntent: false,
                   v2InitialFitPending: true, v2InitialFitFrame: 0, hiddenOutputPending: false, v2ViewportSyncFrame: 0,
                   forceResizeAfterFit: true, initialSnapshotPainted: false,
                   suppressResizeToServer: false, resyncResizeRepairPending: false,
                   hiddenAt: 0, lastShownAt: 0,
                   tailRepairTimer: 0, tailRepairConfirmTimer: 0,
                   activationRepairFrame: 0, tailRepairSignature: "", lastRenderRepairAt: 0,
                   renderedRows: [], renderedViewportY: null, renderedCols: 0, renderedTermRows: 0,
                   renderRepairArmed: true, renderObserver: null,
                   viewportAnchorRestore: null, viewportAnchorRestoreTimer: 0,
                   lastSentCols: null, lastSentRows: null, settleWatchdogTimers: [],
                   tallGeometrySettleTimer: 0, tallGeometrySettleAt: 0,
                   preserveRowsFromBottom: 0, reconnectReset: false,
                   promptDraft: this.session(id)?.draft || "", markdownPromptDraft: this.markdownPromptDraftForSession(id),
                   promptPaste: false, promptEscape: "", promptEditing: false,
                   promptSubmitting: false, promptSubmitEntered: false, promptSubmitTimer: 0,
                   promptSubmissionReflowGuardUntil: 0, promptSubmissionReflowGuardTimer: 0,
                   attentionScreenDetectionSuppressed: false,
                   reconnectAfterClose: false, claudeInitialReplayCheckTimer: 0,
                   initialCodexRepaintTimer: 0, initialCodexRepaintWatchdogTimer: 0,
                   claudeInitialReplayRecoveryAttempted: false,
                   claudeStatusRowRefreshTimer: 0, historyModelRefreshTimer: 0, lastClaudeStatusRowRefreshAt: 0,
                   codexFocusRefreshFrame: 0,
                   promptQueue: this.markdownPromptQueueForSession(id), promptQueueEditIndex: null, promptQueueDispatching: false,
                   promptDraftSyncPending: false, promptDraftSyncTimer: 0, promptDraftSyncDebounceTimer: 0,
                   pendingDraftSync: null, pendingTerminalDraft: null, pendingAgentPaste: "", pendingAgentPasteTimer: 0,
                   pendingAgentPasteStartedAt: 0, pendingAgentPasteReadyAt: 0, pendingAgentPasteExpectedTitle: "",
                   pendingAgentPasteRequireComposer: false, lastTerminalOutputAt: 0,
                   promptEditVersion: 0, promptSubmitVersion: -1,
                   mobileImeTextareaBaseline: null, mobileImeTextareaDeadline: 0, mobileTextareaCleanupTimer: 0,
                   disposeMobileTextareaStabilizer: null };
    view.terminalFindResultListener = terminalFindAddon?.onDidChangeResults((result) => this.updateTerminalFindResultCount(view, result)) || null;
    view.mobileSelectionChangeObserver = term.onSelectionChange(() => this.scheduleSelectionActions());
    this.installMobileTerminalLongPressSelection(view);
    this.installMobileTerminalTextareaStabilizer(view);
    const releaseManualScrollWhenStable = () => {
      clearTimeout(view.manualScrollReleaseTimer);
      const generation = view.manualScrollGeneration;
      view.manualScrollReleaseTimer = setTimeout(() => {
        view.manualScrollReleaseTimer = 0;
        if (view.closed || !view.manualScroll || generation !== view.manualScrollGeneration) return;
        const atBottom = this.terminalAtBottom(view);
        if (!atBottom) {
          view.wasAtBottom = false;
          view.keepBottom = false;
          view.pinBottomUntil = 0;
          return;
        }
        // A wheel event can be delivered before xterm has updated its native
        // viewport. Only leave manual mode after the position remains at the
        // bottom long enough for that layout/reflow to settle.
        view.manualScroll = false;
        view.wasAtBottom = true;
        view.keepBottom = true;
      }, 180);
    };
    const markV2Preserve = () => {
      if (!this.isTerminalScrollV2()) return;
      this.cancelTerminalViewportRestore(view);
      // Wheel/scrollbar intent arrives before xterm publishes onScroll().
      // Preserve immediately so a live output callback in that gap cannot
      // pull the viewport back to the prompt.
      view.v2Programmatic = false;
      view.userScrollIntent = true;
      view.scrollMode = "preserve";
    };
    const markManualScroll = () => {
      if (this.isTerminalScrollV2()) {
        markV2Preserve();
        return;
      }
      // wheel fires before the browser moves the native xterm viewport, so
      // checking terminalAtBottom() here can still report the old bottom
      // position and leave auto-follow enabled.  Any wheel gesture is an
      // explicit request to browse, regardless of its current position.
      view.pinBottomUntil = 0;
      view.keepBottom = false;
      view.manualScroll = true;
      view.manualScrollGeneration += 1;
      view.wasAtBottom = false;
      releaseManualScrollWhenStable();
      if (view.settleFrame) {
        cancelAnimationFrame(view.settleFrame);
        view.settleFrame = 0;
      }
      if (view.viewportRepairFrame) {
        cancelAnimationFrame(view.viewportRepairFrame);
        view.viewportRepairFrame = 0;
      }
      view.needsViewportRepair = false;
      clearTimeout(view.scrollSettleTimer);
      view.scrollSettleTimer = 0;
    };
    view.renderObserver = term.onRender(({ start, end }) => this.recordTerminalRenderedRows(view, start, end));
    this.refreshTerminal(view);
    container.addEventListener("focusin", () => this.scheduleCodexFocusTailRefresh(view));
    // Capture before xterm's wheel handler so the first wheel after a tab
    // switch cannot be mistaken for an automatic bottom-follow scroll.
    container.addEventListener("wheel", markManualScroll, { passive: true, capture: true });
    container.addEventListener("paste", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cd = e.clipboardData || window.clipboardData;
      const files = cd && cd.files && cd.files.length ? [...cd.files] : [];
      if (files.length) { this.uploadAndInsert(view, files); return; }
      const text = cd && (cd.getData("text/plain") || cd.getData("text"));
      if (!text || !view.ws || view.ws.readyState !== WebSocket.OPEN) return;
      // Pasting is real input, so it returns to the prompt the way typing does -- the Cmd+V chord itself
      // is ignored by the key handler above (it cannot tell paste from copy), so this is where it lands.
      view.tallFollowing = true;
      this.scrollTallContainerToCursor(view);
      this.sendTrackedInput(view, this.terminalPastePayload(view, text));
    }, true);
    container.addEventListener("dragover", (e) => { e.preventDefault(); container.classList.add("drag-over"); });
    container.addEventListener("dragleave", (e) => { if (e.target === container) container.classList.remove("drag-over"); });
    container.addEventListener("drop", (e) => {
      e.preventDefault();
      container.classList.remove("drag-over");
      const files = e.dataTransfer && e.dataTransfer.files ? [...e.dataTransfer.files] : [];
      if (files.length) this.uploadAndInsert(view, files);
    });
    term.onTitleChange((t) => {
      const title = t.trim();
      if (!title || title === view.cliTitle) return;
      view.cliTitle = title;
      const s = this.session(id);
      // The backend status stream is authoritative for processing. Do not
      // mark a session active merely because its xterm title was replayed
      // when the user selected the tab.
      if (s) s.cli_title = title;
      const titleEl = this.sessionTitleEls.get(id);
      if (titleEl && s) titleEl.textContent = this.titlePresentation(s).text;
      this.updateProcessingState(id, !!s && this.titlePresentation(s).spinning);
      if (id === this.activeId) this.renderTopbar();
    });
    term.attachCustomKeyEventHandler((e) => {
      // xterm's PageUp/Home family scrolls its viewport without a wheel or
      // scrollbar pointer event. Treat those as an explicit browse action so
      // a pending output/layout repair cannot pull the terminal back down.
      if (e.type === "keydown" && ["PageUp", "PageDown", "Home", "End"].includes(e.key)) {
        if (this.isTerminalScrollV2()) markV2Preserve();
        else markManualScroll();
      }
      // Typing means the user is done reading whatever they scrolled up to look at, so resume following
      // -- otherwise they type blind into a prompt that is somewhere off-screen. xterm's own
      // scrollOnUserInput cannot do this here: it scrolls xterm's viewport, which is not the surface
      // being scrolled any more (see the tall-container comments above).
      //
      // A real KeyboardEvent is the signal, NOT sendInput/onData. onData carries far more than typing:
      // xterm answers terminal queries (DSR/DA) through it, and with the modes an agent CLI enables it
      // also emits focus-in/out and mouse reports there. An agent working produces a steady stream of
      // those, so resuming follow from onData meant the view snapped to the bottom continuously while
      // output streamed, making it impossible to read anything scrolled back. This handler only ever
      // sees genuine key events. PageUp/Home above are deliberately excluded by ordering: they browse
      // rather than type, and the block above has already marked them as such.
      //
      // "Typing" excludes Cmd chords and bare modifier presses. Cmd+C is the case that matters: copying
      // means the user has scrolled back, selected something, and is reading it -- scrolling to the prompt
      // there throws away the very thing they are copying. Cmd never reaches the shell anyway, so a Cmd
      // chord is never terminal input. Ctrl and Alt deliberately still count: on this platform those DO
      // produce terminal input (Ctrl+C interrupts, Alt+B/F move by word), so they are real typing.
      // Pasting is real input too, but arrives on the paste listener rather than here.
      const tallTypingKey = e.type === "keydown" && !e.metaKey &&
        !["PageUp", "PageDown", "Home", "End"].includes(e.key) &&
        !["Shift", "Meta", "Control", "Alt", "CapsLock"].includes(e.key);
      if (tallTypingKey) {
        const tallView = this.views.get(id);
        if (tallView) {
          const wasFollowing = tallView.tallFollowing !== false;
          tallView.tallFollowing = true;
          if (!wasFollowing) this.scrollTallContainerToCursor(tallView);
        }
      }
      return this.handleTerminalEditingKeys(view, e);
    });
    term.onData((data) => {
      const normalizedInput = this.normalizeMobileTerminalInput(view, data);
      if (normalizedInput) this.sendTrackedInput(view, normalizedInput);
    });
    term.onResize(({ cols, rows }) => {
      if (!view.suppressResizeToServer) this.sendResize(view, cols, rows);
    });
    term.onScroll(() => {
      if (!view.container.classList.contains("visible")) return;
      this.updateTerminalHistoryMoreButton(view);
      if (this.isTerminalScrollV2()) {
        if (!view.v2Programmatic) {
          if (this.xtermAtBottom(view)) {
            view.scrollMode = "follow";
            view.userScrollIntent = false;
          } else if (view.userScrollIntent) {
            view.scrollMode = "preserve";
          }
          this.scheduleTerminalTailRepair(view);
        }
        return;
      }
      // xterm can emit its internal scroll event before the browser updates
      // .xterm-viewport.scrollTop. Keep the manual-scroll lock until the
      // delayed stability check sees the user's real position.
      if (view.manualScroll) {
        if (this.terminalAtBottom(view)) releaseManualScrollWhenStable();
        return;
      }
      // scrollToBottom() can emit before xterm has committed the matching DOM
      // scroll position. Do not let that stale event turn off following and
      // strand the live prompt one viewport above the bottom. Manual wheel,
      // scrollbar, and keyboard browsing increment the generation first, so
      // they still leave follow mode immediately.
      if (Date.now() < view.programmaticScrollUntil
          && view.programmaticScrollGeneration === view.manualScrollGeneration) {
        view.wasAtBottom = true;
        view.keepBottom = true;
        return;
      }
      const atBottom = this.terminalAtBottom(view);
      view.wasAtBottom = atBottom;
      view.keepBottom = atBottom;
      if (!view.keepBottom) view.pinBottomUntil = 0;
    });
    const viewport = container.querySelector(".xterm-viewport");
    if (viewport) {
      viewport.addEventListener("pointerdown", (event) => {
        const rect = viewport.getBoundingClientRect();
        const scrollbarEdge = Math.max(18, viewport.offsetWidth - viewport.clientWidth + 4);
        const onScrollbar = event.clientX >= rect.right - scrollbarEdge;
        const touchScroll = event.pointerType && event.pointerType !== "mouse";
        if (onScrollbar || touchScroll) {
          if (this.isTerminalScrollV2()) markV2Preserve();
          else markManualScroll();
        }
      }, { passive: true });
    }
    const scrollArea = container.querySelector(".xterm-scroll-area");
    if (scrollArea) {
      view.scrollObserver = new ResizeObserver(() => {
        if (!view.container.classList.contains("visible") || view.closed) return;
        if (this.isTerminalScrollV2()) return;
        if (view.keepBottom || Date.now() < view.pinBottomUntil) this.scheduleViewportSettle(view);
      });
      view.scrollObserver.observe(scrollArea);
    }
    view.layoutObserver = new ResizeObserver(() => {
      if (!this.terminalSurfaceAvailableForFit(view)) return;
      if (this.isTerminalScrollV2()) {
        this.scheduleV2Fit(view);
        return;
      }
      const rect = view.container.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) return;
      this.tallFit(view);
      const { cols, rows } = view.term;
      if (cols >= 2 && rows >= 2) this.sendResize(view, cols, rows);
      if (view.keepBottom || Date.now() < view.pinBottomUntil) this.scheduleViewportSettle(view);
    });
    view.layoutObserver.observe(container);
    // xterm suspends its renderer while the container is display:none and resumes from its own
    // IntersectionObserver, so every refresh issued between activation and that resume is dropped.
    // Output written while hidden therefore sits in the buffer unpainted until some later redraw.
    // Repainting from a second observer on the same element covers it in either callback order:
    // after xterm resumes this paints directly, before it the refresh is folded into xterm's resume.
    view.visibilityObserver = new IntersectionObserver((entries) => {
      if (!entries[entries.length - 1].isIntersecting || view.closed) return;
      this.refreshTerminal(view);
    }, { threshold: 0 });
    view.visibilityObserver.observe(container);
    this.views.set(id, view);
    return view;
  },


  startClaudeWebglColdPrime(view) {
    if (!view?.claudeWebglColdPrimePending || view.claudeWebglColdPrimeStartedAt) return;
    const now = Date.now();
    view.claudeWebglColdPrimeStartedAt = now;
    view.claudeWebglColdPrimeLastOutputAt = now;
    this.scheduleClaudeWebglColdPrimeCompletion(view);
  },


  noteClaudeWebglColdPrimeOutput(view) {
    if (!view?.claudeWebglColdPrimePending || !view.claudeWebglColdPrimeStartedAt) return;
    view.claudeWebglColdPrimeLastOutputAt = Date.now();
    this.scheduleClaudeWebglColdPrimeCompletion(view);
  },


  scheduleClaudeWebglColdPrimeCompletion(view) {
    clearTimeout(view?.claudeWebglColdPrimeTimer);
    if (!view?.claudeWebglColdPrimePending || !view.claudeWebglColdPrimeStartedAt || view.closed ||
        !view.container.classList.contains("visible") || this.historyOpen || this.activeFileKey !== null ||
        view.sessionId !== this.activeId) return;
    const now = Date.now();
    const quietReadyAt = Math.max(view.claudeWebglColdPrimeStartedAt + CLAUDE_WEBGL_COLD_PRIME_MIN_MS,
      view.claudeWebglColdPrimeLastOutputAt + CLAUDE_WEBGL_COLD_PRIME_IDLE_MS);
    const deadline = view.claudeWebglColdPrimeStartedAt + CLAUDE_WEBGL_COLD_PRIME_MAX_MS;
    const delay = Math.max(0, Math.min(quietReadyAt, deadline) - now);
    view.claudeWebglColdPrimeTimer = setTimeout(() => this.completeClaudeWebglColdPrime(view), delay);
  },


  completeClaudeWebglColdPrime(view) {
    view.claudeWebglColdPrimeTimer = 0;
    if (!view.claudeWebglColdPrimePending || view.claudeWebglColdPrimeCompleting || view.closed ||
        !view.container.classList.contains("visible") || this.historyOpen || this.activeFileKey !== null ||
        view.sessionId !== this.activeId) return;
    const now = Date.now();
    const beforeDeadline = now < view.claudeWebglColdPrimeStartedAt + CLAUDE_WEBGL_COLD_PRIME_MAX_MS;
    const minimumElapsed = now >= view.claudeWebglColdPrimeStartedAt + CLAUDE_WEBGL_COLD_PRIME_MIN_MS;
    const outputQuiet = now >= view.claudeWebglColdPrimeLastOutputAt + CLAUDE_WEBGL_COLD_PRIME_IDLE_MS;
    if ((beforeDeadline && (!minimumElapsed || !outputQuiet)) || view.awaitingSnapshot || view.replaying ||
        view.outputWriteInFlight || view.outputQueue.length) {
      view.claudeWebglColdPrimeTimer = setTimeout(
        () => this.completeClaudeWebglColdPrime(view), CLAUDE_WEBGL_COLD_PRIME_RETRY_MS);
      return;
    }
    view.claudeWebglColdPrimeCompleting = true;
    const buffer = view.term.buffer.active;
    const screenStart = Number(buffer.baseY || 0);
    const screenEnd = Math.min(buffer.length, screenStart + view.term.rows);
    let lastContentRow = Number(buffer.cursorY || 0);
    for (let row = screenEnd - 1; row >= screenStart; row -= 1) {
      if (!buffer.getLine(row)?.translateToString(true).trim()) continue;
      lastContentRow = row - screenStart;
      break;
    }
    view.term.write(`\x1b[${Math.max(1, lastContentRow + 1)};1H`, () => this.finishClaudeWebglColdPrime(view));
  },


  finishClaudeWebglColdPrime(view) {
    if (!view.claudeWebglColdPrimePending || view.closed) return;
    clearTimeout(view.claudeWebglColdPrimeTimer);
    view.claudeWebglColdPrimeTimer = 0;
    const targetRows = Math.max(2, Number(view.claudeWebglColdPrimeTargetRows || 0));
    const cols = Math.max(2, view.term.cols);
    const repaintAfterFullClaudeReplay = view.fullClaudeRawReplayConnection === true;
    view.fullClaudeRawReplayConnection = false;
    view.claudeWebglColdPrimePending = false;
    view.claudeWebglColdPrimeCompleting = false;
    view.claudeInitialReplayRecoveryAttempted = true;
    view.suppressResizeToServer = true;
    view.tallRows = targetRows;
    view.term.resize(cols, targetRows);
    view.tallWebgl = this.enableWebglRenderer(view.term);
    if (!view.tallWebgl) {
      view.tallRows = TALL_ROWS_DOM;
      view.term.resize(cols, TALL_ROWS_DOM);
    }
    view.suppressResizeToServer = false;
    this.tallApplyGeometry(view);
    this.tallUpdateMaxScrollTop(view);
    if (view.tallFollowing !== false) this.scrollTallContainerToCursor(view);
    this.refreshTerminalAppearance(view);
    this.sendResize(view, view.term.cols, view.term.rows, true, repaintAfterFullClaudeReplay);
    if (repaintAfterFullClaudeReplay && view.ws?.readyState === WebSocket.OPEN) {
      view.term.write("\x1b[2J\x1b[H", () => {
        if (!view.closed && view.ws?.readyState === WebSocket.OPEN) {
          view.ws.send(JSON.stringify({ type: "repaint" }));
        }
      });
    }
  },


  prepareTerminalForFirstPaint(view) {
    if (!this.terminalSurfaceAvailableForFit(view)) return false;
    const rect = view.container.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return false;
    this.tallFit(view);
    this.refreshTerminalAppearance(view);
    view.container.classList.remove("initializing");
    return true;
  },


  connect(id, view) {
    if (view.closed) return;
    if (view.outputWriteInFlight || view.outputQueue.length) {
      view.connectAfterOutputDrain = true;
      this.drainTerminalWrites(view, true);
      return;
    }
    view.connectAfterOutputDrain = false;
    if (this.isTerminalScrollV2() && !view.userScrollIntent) {
      view.scrollMode = "follow";
      view.preserveRowsFromBottom = 0;
    }
    // A reconnect that lands with less than a screen of scrollback gets one more chance to restore: the
    view.suppressReconnect = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const hasPopulatedBuffer = view.everConnected && !view.closed && view.term?.buffer?.active?.baseY > 0;
    // A fresh client has no trustworthy terminal screen after a server restart. Ask the live agent to
    // repaint it; a reconnect that already has a populated xterm buffer can skip the SIGWINCH nudge.
    const agentKindForReplay = this.session(id)?.agent_kind;
    const screenRepaint = hasPopulatedBuffer || this.agentBehavior(agentKindForReplay)?.skipAttachScreenRepaint ? 0 : 1;
    const haveBuffer = hasPopulatedBuffer ? 1 : 0;
    const fullClaudeRawReplay = !hasPopulatedBuffer && this.agentSpec(agentKindForReplay)?.records_raw_replay ? 1 : 0;
    // repaint_preserved_buffer is deliberately not sent: it only ever meant "this client restored a
    // client-side snapshot, so make the agent repaint over it", and that snapshot path is gone. The
    // server defaults the flag to false when the parameter is absent.
    const ws = new WebSocket(`${proto}://${location.host}/ws/${id}?screen_repaint=${screenRepaint}&have_buffer=${haveBuffer}&full_claude_raw_replay=${fullClaudeRawReplay}`);
    ws.binaryType = "arraybuffer";
    view.fullClaudeRawReplayConnection = fullClaudeRawReplay === 1;
    view.preserveBufferOnReconnect = haveBuffer === 1;
    view.awaitingSnapshot = true;
    view.replaying = false;
    view.needsViewportRepair = false;
    view.outputWriteGeneration += 1;
    view.outputQueue = [];
    view.outputQueueBytes = 0;
    view.inactiveOutputDeferred = false;
    view.lastSentCols = null;
    view.lastSentRows = null;
    ws.onopen = () => {
      view.reconnectReset = view.everConnected;
      view.attachActivitySuppressedUntil = Date.now() + TERMINAL_ATTACH_ACTIVITY_SUPPRESSION_MS;
      // Ask for a repaint if nothing shows up. This cannot hang off a message: when the server has no
      // saved scrollback -- exactly the case after it restarts -- there is no message at all, so a check
      // driven by incoming data never runs and the pane stays blank forever. A timer fires either way.
      clearTimeout(view.blankRepaintTimer);
      view.blankRepaintTimer = setTimeout(() => this.requestRepaintIfBlank(view), TALL_BLANK_REPAINT_MS);
      if (view.everConnected) {
        view.replaying = true;
        if (!this.isTerminalScrollV2()) {
          if (view.keepBottom && !view.manualScroll) view.pinBottomUntil = Date.now() + 8000;
          else view.pinBottomUntil = 0;
        }
      }
      view.everConnected = true;
      this.detectTerminalAttentionFromBuffer(view);
      if (this.isTerminalScrollV2()) {
        if (id === this.activeId) {
          this.scheduleV2Fit(view);
          if (view.scrollMode === "follow") this.scrollTerminalV2ToBottom(view);
        }
      } else if (id === this.activeId && view.keepBottom && !view.manualScroll) {
        this.fitActive();
        view.keepBottom = true;
        view.pinBottomUntil = Date.now() + 8000;
        this.scrollTerminalToBottom(view);
        this.scheduleViewportSettle(view);
      }
      // FitAddon may have run before the websocket opened, so xterm's
      // onResize callback could not send the resulting dimensions to the
      // PTY. Always send the currently fitted size once the socket is ready.
      if (view.term.cols >= 2 && view.term.rows >= 2) {
        this.sendResize(view, view.term.cols, view.term.rows, false,
          view.claudeWebglColdPrimePending && view.fullClaudeRawReplayConnection);
      }
      this.flushPromptSync(view);
      this.dispatchNextMarkdownPrompt(view);
      if (view.pendingAgentPaste) this.schedulePendingAgentPaste(view, AGENT_PASTE_RETRY_DELAY_MS);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") { this.handleControl(id, view, JSON.parse(e.data)); return; }
      view.lastTerminalOutputAt = Date.now();
      this.noteClaudeWebglColdPrimeOutput(view);
      if (view.pendingAgentPaste) this.schedulePendingAgentPaste(view, AGENT_PASTE_OUTPUT_QUIET_MS);
      // xterm's buffer continues to process output while an inactive tab is
      // display:none, but its browser viewport has zero height. Remember that
      // state so activation can synchronize the now-visible scrollbar through
      // xterm's public scroll API, rather than a DOM scroll listener or PTY
      // resize/reflow.
      if (!view.container.classList.contains("visible")) view.hiddenOutputPending = true;
      if (!view.awaitingSnapshot && !view.replaying) view.attentionScreenDetectionSuppressed = false;
      if (!view.awaitingSnapshot && !view.replaying && Date.now() >= (view.attachActivitySuppressedUntil || 0)) {
        this.touchSessionActivity(id);
      }
      if (view.awaitingSnapshot) {
        if (view.reconnectReset && e.data.byteLength > 0 && !view.preserveBufferOnReconnect) {
          view.term.reset();
          this.tallResetScrollState(view);
        }
        const snapshotScrollGeneration = view.manualScrollGeneration;
        const v2 = this.isTerminalScrollV2();
        const followSnapshot = v2 ? view.scrollMode === "follow" : view.keepBottom && !view.manualScroll;
        view.awaitingSnapshot = false;
        view.replaying = true;
        if (!v2) {
          if (followSnapshot) view.pinBottomUntil = Date.now() + 8000;
          else view.pinBottomUntil = 0;
        }
        // The server sends the saved scrollback first, then starts streaming
        // the live PTY queue. Keep the first live frame out of xterm until
        // its asynchronous snapshot write has completed. Otherwise a busy
        // agent can change the scroll-area height mid-replay and leave the
        // final terminal rows outside the native scrollbar range.
        this.queueTerminalWrite(view, new Uint8Array(e.data), () => {
          this.refreshTerminal(view);
          view.replaying = false;
          // The replayed recording can carry paints from earlier pty sizes; a fullscreen_tui app
          // will never touch the rows below its current screen again, so blank them now.
          this.clearFullscreenTuiCanvasBelow(view);
          // Replay finished, so the cursor finally describes the real screen: take the geometry and the
          // follow position from it once, rather than from every intermediate frame.
          this.tallUpdateMaxScrollTop(view);
          if (view.tallFollowing !== false) this.scrollTallContainerToCursor(view);
          // An empty screen is the one case that genuinely needs the agent to repaint: after a server
          // restart there is no saved scrollback to replay, so nothing arrives and the pane would just
          // stay blank. Asking only here keeps the attach-time repaint off in the common case, where the
          // buffer already holds the screen and repainting is what causes the flicker.
          const initialRepaintRequested = this.requestRepaintIfBlank(view);
          if (initialRepaintRequested) {
            clearTimeout(view.initialCodexRepaintTimer);
            clearTimeout(view.initialCodexRepaintWatchdogTimer);
            view.initialCodexRepaintTimer = 0;
            view.initialCodexRepaintWatchdogTimer = 0;
            view.initialCodexRepaintPending = true;
            view.initialCodexRepaintStartedAt = Date.now();
            view.initialCodexRepaintOutputSeen = false;
            this.scheduleInitialCodexRepaintCompletion(view);
          } else {
            this.finishInitialPageContentLoading(id);
          }
          this.schedulePendingAgentPaste(view);
          if (v2 && view.container.classList.contains("visible")) {
            const firstSnapshot = !view.initialSnapshotPainted;
            view.initialSnapshotPainted = true;
            view.forceResizeAfterFit = !firstSnapshot;
            this.scheduleV2Fit(view);
          } else if (view.resyncResizeRepairPending && view.container.classList.contains("visible")) {
            view.resyncResizeRepairPending = false;
            this.scheduleTerminalResizeRepair(view);
          }
          const canFollowSnapshot = v2
            ? followSnapshot && view.scrollMode === "follow"
            : followSnapshot && snapshotScrollGeneration === view.manualScrollGeneration && view.keepBottom && !view.manualScroll;
          if (canFollowSnapshot) {
            if (v2) {
              view.scrollMode = "follow";
              this.scheduleV2Fit(view);
              this.scrollTerminalV2ToBottom(view);
            } else {
              view.keepBottom = true;
              view.pinBottomUntil = Date.now() + 5000;
              // A terminal that changed while its saved scrollback was being
              // replayed can have a DOM scrollbar at its apparent maximum with
              // xterm's final row geometry still stale. Defer one bounded
              // refit until that initial stream has drained.
              view.needsViewportRepair = true;
              this.scheduleViewportSettle(view);
            }
          } else if (v2 && view.reconnectReset) {
            // A reconnect's replay rebuilt the buffer from scratch (view.term.reset() in ws.onopen),
            // so the pre-reset absolute viewportY this tab had is meaningless now -- restore using the
            // rows-from-bottom offset captured before that reset instead. Without this, xterm's own
            // write()-time auto-follow (a freshly reset buffer starts "at the bottom" trivially, so it
            // naturally tracks the incoming replay) lands the view at the bottom of the FULL replayed
            // content regardless of where the user actually was, which showed up as a scrolled-up tab
            // jumping toward the top once the buffer regrew past the small early size where an
            // earlier bug (now fixed) had frozen the viewport.
            this.scrollTerminalV2ToLine(view, Math.max(0, view.term.buffer.active.baseY - (view.preserveRowsFromBottom || 0)));
          } else if (!v2) {
            view.pinBottomUntil = 0;
          }
        });
        return;
      }
      const followOutput = this.isTerminalScrollV2() ? false : view.keepBottom || Date.now() < view.pinBottomUntil;
      const outputScrollGeneration = view.manualScrollGeneration;
      this.queueTerminalWrite(view, new Uint8Array(e.data), () => {
        if (this.isTerminalScrollV2()) {
          if (view.scrollMode === "follow") this.scrollTerminalV2ToBottom(view);
          return;
        }
        if (followOutput && outputScrollGeneration === view.manualScrollGeneration &&
            view.keepBottom && !view.manualScroll) {
          view.keepBottom = true;
          clearTimeout(view.scrollSettleTimer);
          view.scrollSettleTimer = setTimeout(() => {
            if (view.keepBottom || Date.now() < view.pinBottomUntil) this.scheduleViewportSettle(view);
          }, 250);
        }
      });
    };
    ws.onclose = () => {
      clearTimeout(view.claudeWebglColdPrimeTimer);
      view.claudeWebglColdPrimeTimer = 0;
      if (view.claudeWebglColdPrimePending) {
        view.claudeWebglColdPrimeStartedAt = 0;
        view.claudeWebglColdPrimeLastOutputAt = 0;
        view.claudeWebglColdPrimeCompleting = false;
      }
      const reconnectAfterClose = view.reconnectAfterClose;
      view.reconnectAfterClose = false;
      view.ws = null;
      if (reconnectAfterClose) view.suppressReconnect = false;
      if (reconnectAfterClose && !view.closed && id === this.activeId && this.activeFileKey === null &&
          !this.session(id)?.dormant) {
        this.connect(id, view);
        return;
      }
      if (!view.closed && !view.suppressReconnect && id === this.activeId && this.activeFileKey === null &&
          !this.session(id)?.dormant) {
        clearTimeout(view.reconnectTimer);
        view.reconnectTimer = setTimeout(() => {
          view.reconnectTimer = 0;
          this.connect(id, view);
        }, RECONNECT_MS);
      }
    };
    view.ws = ws;
  },


  handleTerminalEditingKeys(view, e) {
    if (e.type !== "keydown") return true;
    if (this.isDesktopTerminalSelectInputEvent(e)) {
      e.preventDefault();
      this.selectActiveTerminalInputText();
      return false;
    }
    if (this.isDesktopTerminalSelectAllEvent(e)) {
      e.preventDefault();
      this.selectActiveTerminalText();
      return false;
    }
    if (this.handleCodexCommandTranscriptShortcut(e, view)) return false;
    if (this.tryAppShortcut(e)) return false;
    if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.sendTrackedInput(view, "\x1b\r");
      return false;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "v") {
      e.preventDefault();
      navigator.clipboard.readText()
        .then((text) => { if (text) this.sendTrackedInput(view, this.terminalPastePayload(view, text)); })
        .catch(() => { this.$("status-name").textContent = "clipboard blocked — use ⌘V (allow clipboard in site settings for ⌃V)"; });
      return false;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "c" && view.term.hasSelection()) {
      e.preventDefault();
      const text = view.term.getSelection();
      this.recordSelectionCopyHistory(text);
      void this.copyTextToClipboard(text);
      return false;
    }
    if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      const key = e.key.toLowerCase();
      if (key === "c" && view.term.hasSelection()) {
        e.preventDefault();
        const text = view.term.getSelection();
        this.recordSelectionCopyHistory(text);
        void this.copyTextToClipboard(text);
        return false;
      }
      if (key === "v") return true;
      if (key === "backspace") { e.preventDefault(); this.sendTrackedInput(view, "\x15"); return false; }
      if (key === "arrowleft") { e.preventDefault(); this.sendTrackedInput(view, "\x01"); return false; }
      if (key === "arrowright") { e.preventDefault(); this.sendTrackedInput(view, "\x05"); return false; }
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      if (e.key === "Backspace") { e.preventDefault(); this.sendTrackedInput(view, "\x1b\x7f"); return false; }
      if (e.key === "ArrowLeft") { e.preventDefault(); this.sendTrackedInput(view, "\x1bb"); return false; }
      if (e.key === "ArrowRight") { e.preventDefault(); this.sendTrackedInput(view, "\x1bf"); return false; }
    }
    return true;
  },


  handleControl(id, view, msg) {
    if (msg.type === "terminal_reset") {
      view.scrollMode = "follow";
      view.userScrollIntent = false;
      view.manualScroll = false;
      view.keepBottom = true;
      view.preserveRowsFromBottom = 0;
      view.needsViewportRepair = false;
      this.tallResetScrollState(view);
      return;
    }
    if (msg.type === "resize_rejected") {
      const restoreFollowingPosition = view.scrollMode === "follow" && view.tallFollowing !== false;
      const terminalSizeChanged = view.term.cols !== msg.cols || view.term.rows !== msg.rows;
      // Another window already owns this terminal's size. Stop pushing ours -- a pty has one size, and
      // two windows disagreeing means one of them renders at a width its screen does not have, wrapping
      // lines and painting redraws over themselves. Adopt the real size so this window renders correctly
      // too, and offer the swap explicitly rather than taking it.
      view.suppressResizeToServer = true;
      view.sizeOwnedElsewhere = { cols: msg.cols, rows: msg.rows };
      if (terminalSizeChanged) {
        try { view.term.resize(msg.cols, msg.rows); } catch (resizeError) { /* geometry not ready yet */ }
      }
      if (view.claudeWebglColdPrimePending) {
        clearTimeout(view.claudeWebglColdPrimeTimer);
        view.claudeWebglColdPrimeTimer = 0;
        view.claudeWebglColdPrimePending = false;
        view.claudeWebglColdPrimeCompleting = false;
        view.tallRows = Math.max(2, Number(msg.rows || view.term.rows));
        const webglRows = Math.max(2, Number(view.claudeWebglColdPrimeTargetRows || 0));
        view.tallWebgl = view.tallRows <= webglRows && this.enableWebglRenderer(view.term);
      }
      if (restoreFollowingPosition && terminalSizeChanged) {
        view.tallMaxScrollTop = null;
        view.tallCeilingShrinkSince = null;
        view.tallInnerHeight = 0;
        view.tallShrinkTarget = null;
      }
      this.tallApplyGeometry(view);
      this.tallUpdateMaxScrollTop(view);
      if (restoreFollowingPosition) {
        view.tallFollowing = true;
        this.scrollTallContainerToCursor(view);
      }
      this.updateSizeOwnershipIndicator(view);
      return;
    }
    if (msg.type === "exit") {
      if (msg.dormant) {
        view.suppressReconnect = true;
        if (view.ws) view.ws.close();
      }
      view.term.write(`\r\n\x1b[2m[termdeck] process exited (${msg.code})\x1b[0m\r\n`);
      if (this.isTerminalScrollV2()) {
        if (view.scrollMode === "follow") this.scrollTerminalV2ToBottom(view);
      } else {
        view.pinBottomUntil = Date.now() + 5000;
      }
    } else if (msg.type === "draft") {
      const incomingDraft = String(msg.draft || "");
      if (view.promptDraftSyncPending && incomingDraft !== view.promptDraft) return;
      view.promptDraftSyncPending = false;
      clearTimeout(view.promptDraftSyncTimer);
      view.promptDraftSyncTimer = 0;
      if (view.promptSubmitting) {
        return;
      }
      if (!view.promptEditing) {
        view.promptDraft = incomingDraft;
        this.showPromptDraft(view);
      }
      return;
    } else if (msg.type === "prompt_submitted") {
      const submissionIsCurrent = view.promptSubmitVersion === view.promptEditVersion;
      if (submissionIsCurrent) {
        view.promptDraft = "";
        view.pendingDraftSync = null;
        view.pendingTerminalDraft = null;
        view.promptDraftSyncPending = false;
        clearTimeout(view.promptDraftSyncTimer);
        view.promptDraftSyncTimer = 0;
      }
      view.promptSubmitting = false;
      view.promptSubmitEntered = false;
      clearTimeout(view.promptSubmitTimer);
      if (submissionIsCurrent) {
        this.showPromptDraft(view);
        if (this.historyOpen && id === this.activeId) this.$("history-prompt").focus();
      }
      return;
    } else if (msg.type === "agent_session") {
      // Session discovery is asynchronous and can arrive while the user is
      // reading older output. It must not turn that event into an implicit
      // scroll-to-bottom.
      if (this.isTerminalScrollV2()) {
        if (view.scrollMode === "follow") this.scrollTerminalV2ToBottom(view);
      } else if (!view.manualScroll && view.keepBottom) {
        view.pinBottomUntil = Date.now() + 4000;
        this.scrollTerminalToBottom(view);
      }
    } else if (msg.type === "processing") {
      this.applySessionStatus({ session_id: id, processing: !!msg.processing });
      return;
    }
    this.refresh();
  },


  sendInput(view, data) {
    const session = this.session(view.sessionId);
    if (data) view.attentionScreenDetectionSuppressed = true;
    if (session?.needs_attention) {
      session.needs_attention = false;
      this.attentionServerStates.set(view.sessionId, false);
      this.clearSessionAttention(view.sessionId);
    }
    if (data) this.touchSessionActivity(view.sessionId);
    if (view.replaying && QUERY_RESPONSE_RE.test(data)) return;
    if (view.ws && view.ws.readyState === WebSocket.OPEN) {
      view.ws.send(JSON.stringify({ type: "input", data }));
    }
  },


  isImageAttachmentFile(file) {
    return !!file && (IMAGE_ATTACHMENT_MIME_RE.test(String(file.type || "")) ||
      IMAGE_ATTACHMENT_EXTENSION_RE.test(String(file.name || "")));
  },


  historyImageFilesFromDataTransfer(dataTransfer) {
    if (!dataTransfer) return [];
    const files = [];
    const seen = new Set();
    const addFile = (file) => {
      if (!this.isImageAttachmentFile(file) || seen.has(file)) return;
      seen.add(file);
      files.push(file);
    };
    for (const item of dataTransfer.items || []) {
      if (item.kind === "file") addFile(item.getAsFile());
    }
    for (const file of dataTransfer.files || []) addFile(file);
    return files;
  },


  insertHistoryAttachmentPaths(view, paths, selection = null, append = false) {
    if (!view || !this.historyOpen || this.activeFileKey !== null || !paths.length) return;
    const prompt = this.$("history-prompt");
    const value = prompt.value;
    const start = append ? value.length : Math.max(0, Math.min(value.length,
      Number(selection?.start ?? prompt.selectionStart ?? value.length)));
    const end = append ? value.length : Math.max(start, Math.min(value.length,
      Number(selection?.end ?? prompt.selectionEnd ?? start)));
    const text = paths.map((path) => (/\s/.test(path) ? `'${path}'` : path)).join(" ");
    const before = value.slice(0, start);
    const after = value.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = after && /^\s/.test(after) ? "" : " ";
    this.persistMarkdownPromptDraft(view, `${before}${prefix}${text}${suffix}${after}`);
    this.showPromptDraft(view);
    prompt.focus();
    const cursor = before.length + prefix.length + text.length + suffix.length;
    prompt.setSelectionRange(cursor, cursor);
  },


  async insertHistoryAttachmentFiles(view, files) {
    if (!view || !this.historyOpen || this.activeFileKey !== null || !files.length) return;
    const prompt = this.$("history-prompt");
    const selection = { start: prompt.selectionStart, end: prompt.selectionEnd };
    const paths = await this.uploadFiles(files);
    if (!paths.length) {
      this.$("status-name").textContent = "image upload failed";
      return;
    }
    this.insertHistoryAttachmentPaths(view, paths, selection);
    this.$("status-name").textContent = `inserted ${paths.length} image${paths.length === 1 ? "" : "s"}`;
  },


  async uploadFiles(files) {
    this.$("status-name").textContent = `uploading ${files.length} file${files.length === 1 ? "" : "s"}…`;
    const paths = [];
    for (const file of files) {
      const form = new FormData();
      form.append("file", file, file.name || "pasted");
      try {
        const res = await fetch("/api/upload", { method: "POST", body: form });
        if (res.ok) paths.push((await res.json()).path);
      } catch (err) {
        // skip failed upload
      }
    }
    return paths;
  },


  async uploadAndInsert(view, files) {
    const paths = await this.uploadFiles(files);
    if (!paths.length) { this.$("status-name").textContent = "upload failed"; return; }
    const text = paths.map((p) => (/\s/.test(p) ? `'${p}'` : p)).join(" ") + " ";
    if (view.ws && view.ws.readyState === WebSocket.OPEN) {
      this.sendTrackedInput(view, this.terminalPastePayload(view, text));
    }
    this.$("status-name").textContent = `inserted ${paths.length} path${paths.length === 1 ? "" : "s"}`;
    view.term.focus();
  },


  async attachToHistory() {
    const view = this.views.get(this.activeId);
    if (!view || this.activeFileKey !== null || !this.historyOpen) return;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = async () => {
      if (!input.files.length) return;
      const paths = await this.uploadFiles([...input.files]);
      if (!paths.length) { this.$("status-name").textContent = "upload failed"; return; }
      this.insertHistoryAttachmentPaths(view, paths, null, true);
      this.$("status-name").textContent = `inserted ${paths.length} path${paths.length === 1 ? "" : "s"}`;
    };
    input.click();
  },


  async attachToActive() {
    const view = this.views.get(this.activeId);
    if (!view || this.activeFileKey !== null) return;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => { if (input.files.length) this.uploadAndInsert(view, [...input.files]); };
    input.click();
  },


  terminalPageCanResize() {
    return document.visibilityState === "visible" && document.hasFocus();
  },


  // A fullscreen_tui agent (opencode) must see the real visible height. On the tall canvas it
  // top-anchors the conversation and bottom-anchors the composer, so the ~200-row blank gap
  // between them is what fills the visible window (measured: "hi" and its reply painted at the
  // top of a 253-row screen, viewport parked on the cursor at the bottom). The canvas stays
  // tall; only the pty is viewport-sized, so the TUI lays out inside the top of the canvas and
  // the cursor-following viewport parks right on it. Returns 0 while layout is unmeasured.
  fullscreenTuiPtyRows(view) {
    if (!this.agentSpec(this.session(view.sessionId)?.agent_kind)?.fullscreen_tui) return null;
    const cellHeight = view.term._core?._renderService?.dimensions?.css?.cell?.height;
    const height = view.container.clientHeight;
    if (!cellHeight || !height) return 0;
    return Math.max(2, Math.floor(height / cellHeight));
  },


  // Everything below a fullscreen_tui app's last row must stay blank. The app diff-paints on the
  // assumption that a real terminal cropped those rows on shrink and grew blank ones on expand, but
  // this canvas is taller than the pty and keeps whatever an earlier size painted there -- measured:
  // boot-era paints lingering hundreds of rows below the app, which a viewport-rows increase would
  // expose inside the UI because the app "knows" grown rows are blank and never paints them.
  clearFullscreenTuiCanvasBelow(view) {
    const rows = this.fullscreenTuiPtyRows(view);
    if (!rows || view.replaying || rows >= view.term.rows) return;
    // DECSC/DECRC around an absolute move + erase-below, so the app's cursor stays put.
    view.term.write(`\x1b7\x1b[${rows + 1};1H\x1b[J\x1b8`);
  },


  sendResize(view, cols, rows, resend = false, takeOwnership = false) {
    if (this.sidebarResizeInProgress || view.suppressResizeToServer || !this.terminalPageCanResize() ||
        view.closed || view.sessionId !== this.activeId || !view.container.classList.contains("visible") ||
        this.activeFileKey !== null || this.historyOpen) return;
    const tuiRows = this.fullscreenTuiPtyRows(view);
    if (tuiRows === 0) return;              // no measured height yet; a later resize will land
    if (tuiRows != null) rows = tuiRows;
    if (view.ws && view.ws.readyState === WebSocket.OPEN &&
        (resend || view.lastSentCols !== cols || view.lastSentRows !== rows)) {
      const tuiRowsChanged = tuiRows != null && view.lastSentRows !== rows;
      view.lastSentCols = cols;
      view.lastSentRows = rows;
      view.ws.send(JSON.stringify({ type: "resize", cols, rows, force: takeOwnership }));
      if (tuiRowsChanged) this.clearFullscreenTuiCanvasBelow(view);
      if (view.claudeWebglColdPrimePending && rows === TALL_ROWS_DOM) this.startClaudeWebglColdPrime(view);
    }
  },


  // Reusable diagnostic utility, not called from anywhere by default -- wire it into a new suspect code
  // path when needed. Keeps the last DEBUG_SNAPSHOT_LIMIT {trigger, ts, buf, dom} entries per view. buf
  // is xterm's own logical buffer tail (what SHOULD be on screen); dom is the actually-painted rows. If
  // they ever disagree, that is a termdeck repaint bug; if buf itself changes content across snapshots
  // with cols unchanged, the CLI genuinely redrew differently -- the two rule each other in or out.
  // Opt-in diagnostic session recorder, off by default.
  //
  // The faults left in this app are intermittent, live in the browser rather than the server, and are
  // reported in prose ("it keeps pushing the composer down") long after the state that caused them is
  // gone. This records a session instead: what the user did, what the app did in response, and what the
  // geometry looked like throughout, batched to /api/debug/diagnostics and appended to one file per
  // recording under diagnostics/ in the data dir. Hand that file over with a bug report.
  //
  // While OFF it costs nothing: no interval, no listeners, no wrappers -- every hook is installed on
  // start and removed on stop, so the only cost in normal use is one boolean check that never runs
  // because nothing calls into it. Recording is deliberately visible (see the badge): a tool that
  // watches the UI should never be running unnoticed.
  //
  // Deliberately NOT recorded: terminal output and typed input. A terminal carries credentials and
  // private source, and a log meant to be shared must not. Sizes, row counts and timings only.
  diagnosticsRecording() { return !!this.diagState; },


  toggleDiagnosticsRecorder() {
    if (this.diagState) this.stopDiagnosticsRecorder();
    else this.startDiagnosticsRecorder();
    return this.diagnosticsRecording();
  },


  // One entry point for everything below. Cheap and safe to call from anywhere: when not recording it
  // is a single truthiness test, and it never throws into its caller.
  diagLog(kind, data) {
    const state = this.diagState;
    if (!state) return;
    try {
      state.pending.push({ t: Date.now() - state.startedAt, kind, ...data });
      state.count += 1;
      if (state.pending.length >= 200) this.flushDiagnostics();
      if (state.count % 25 === 0) this.updateDiagnosticsBadge();
    } catch { /* a diagnostic must never break the thing it is diagnosing */ }
  },


  startDiagnosticsRecorder() {
    if (this.diagState) return;
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const state = { id, startedAt: Date.now(), pending: [], count: 0, faults: 0, samples: [], undo: [] };
    this.diagState = state;
    this.showDiagnosticsBadge();

    // --- what the user did, and what the app decided -------------------------------------------------
    // Wrapping methods on the instance keeps the instrumentation in one place instead of scattering log
    // calls through the app, and makes "stop" a genuine restore rather than a disabled flag.
    const wrap = (name, describe) => {
      const original = this[name];
      if (typeof original !== "function") return;
      this[name] = (...args) => {
        this.diagLog(name, describe ? describe.apply(this, args) || {} : {});
        return original.apply(this, args);
      };
      state.undo.push(() => { this[name] = original; });
    };
    wrap("activate", (id) => ({ session: String(id || "").slice(0, 12) }));
    wrap("setSideView", (view) => ({ view }));
    wrap("applySettings", () => ({}));
    wrap("scrollTallContainerToCursor", (view, settled) => ({ settled: !!settled, top: Math.round(view?.container?.scrollTop ?? -1) }));
    wrap("tallSetScrollTop", (view, value) => ({ to: Math.round(value), from: Math.round(view?.container?.scrollTop ?? -1) }));
    wrap("tallUpdateMaxScrollTop", (view) => ({ ceiling: view?.tallMaxScrollTop }));
    wrap("runKeybindingAction", (actionId) => ({ actionId }));
    wrap("toggleHistory", () => ({}));

    // Follow/park transitions, which is the decision most of these reports come down to.
    const origSettle = this.tallApplySettledScroll?.bind(this);
    if (origSettle) {
      this.tallApplySettledScroll = (view) => {
        const before = view?.tallFollowing;
        const result = origSettle(view);
        if (view && before !== view.tallFollowing) {
          this.diagLog("follow", { from: String(before), to: String(view.tallFollowing), ...this.diagGeometry(view) });
        }
        return result;
      };
      state.undo.push(() => { this.tallApplySettledScroll = origSettle; });
    }

    // --- things that go wrong on their own ------------------------------------------------------------
    const onError = (event) => this.diagLog("error", {
      message: String(event.message || event.reason || "").slice(0, 300),
      source: String(event.filename || "").split("/").pop(), line: event.lineno });
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onError);
    state.undo.push(() => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onError);
    });

    // --- raw input, as shape only ---------------------------------------------------------------------
    const onWheel = (event) => this.diagLog("wheel", { dy: Math.round(event.deltaY) });
    const onPointer = (event) => this.diagLog("pointerdown", { target: (event.target?.className || "").toString().slice(0, 40) });
    const onVisibility = () => this.diagLog("visibility", { hidden: document.hidden });
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    window.addEventListener("pointerdown", onPointer, { capture: true, passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    state.undo.push(() => {
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("pointerdown", onPointer, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
    });

    // --- periodic geometry, plus the scroll-fault detector ---------------------------------------------
    let sinkSince = 0, sinkFlagged = 0;
    state.timer = window.setInterval(() => {
      const view = this.views.get(this.activeId);
      if (!view || view.closed || !view.term || !view.container.clientHeight) return;
      if (!view.container.classList.contains("visible")) return;
      const geometry = this.diagGeometry(view);
      if (!geometry) return;
      const prev = state.samples[state.samples.length - 1];
      state.samples.push(geometry);
      if (state.samples.length > 40) state.samples.shift();
      // Heartbeat, so a log always has context even when nothing is flagged.
      if (state.count % 20 === 0 || !prev) this.diagLog("geometry", geometry);
      if (!prev || prev.session !== geometry.session || geometry.gesture) { sinkSince = 0; return; }
      // Content escaping below a STATIONARY view: the composer sinking as the agent writes. A moving
      // view is just scrolling -- see tools/scroll-tests/symptom_detector.cjs.
      if (geometry.rowsBelow > 2 && geometry.rowsBelow > prev.rowsBelow && geometry.top === prev.top) {
        if (!sinkSince) sinkSince = Date.now();
        if (Date.now() - sinkSince > 1500 && !sinkFlagged) {
          sinkFlagged = 1;
          state.faults += 1;
          this.diagLog("FAULT.sinking", { detail: `${geometry.rowsBelow} rows below the fold, following=${geometry.following}`,
                                          window: state.samples.slice() });
          this.updateDiagnosticsBadge();
        }
      } else if (geometry.rowsBelow <= 2) { sinkSince = 0; sinkFlagged = 0; }
    }, 250);

    state.flushTimer = window.setInterval(() => this.flushDiagnostics(), 3000);
    this.diagLog("start", { ua: navigator.userAgent, screen: `${window.innerWidth}x${window.innerHeight}`,
                            dpr: window.devicePixelRatio, settings: this.diagSettingsSummary() });
  },


  stopDiagnosticsRecorder() {
    const state = this.diagState;
    if (!state) return;
    this.diagLog("stop", { events: state.count, faults: state.faults,
                           seconds: Math.round((Date.now() - state.startedAt) / 1000) });
    clearInterval(state.timer);
    clearInterval(state.flushTimer);
    for (const undo of state.undo.reverse()) { try { undo(); } catch { /* restore the rest anyway */ } }
    const pending = this.flushDiagnostics(true);
    this.diagState = null;
    this.diagBadge?.remove();
    this.diagBadge = null;
    const relative = `diagnostics/${state.id}.jsonl`;
    this.$("status-name").textContent =
      `diagnostics saved: ${relative} (${state.count} events, ${state.faults} fault${state.faults === 1 ? "" : "s"})`;
    // A recording nobody can find is a recording nobody sends. The dialog waits on the final flush --
    // offering to open a file the server has not finished writing reads as a bug.
    void Promise.resolve(pending).then(() => this.showDiagnosticsSavedDialog(state, relative));
    return relative;
  },


  async showDiagnosticsSavedDialog(state, relative) {
    // The absolute path comes back on every write, so the last one is already known -- no extra
    // round trip, and nothing to get wrong about where the data directory lives.
    const absolute = this.diagLastPath || relative;
    const seconds = Math.round((Date.now() - state.startedAt) / 1000);
    const summary = `Recorded ${state.count} events over ${seconds}s` +
      (state.faults ? `, including ${state.faults} detected fault${state.faults === 1 ? "" : "s"}.` : ".") +
      `\n\nSaved to:\n${absolute}\n\nAttach this file to the bug report. It contains actions, app state ` +
      `and geometry only -- no terminal output and no typed input.`;
    const open = await uiConfirm(summary, { title: "Diagnostics recording saved",
                                            confirmLabel: "Open file", cancelLabel: "Close" });
    if (!open) return;
    const directory = absolute.slice(0, absolute.lastIndexOf("/"));
    const name = absolute.slice(absolute.lastIndexOf("/") + 1);
    if (!await this.openFileExternally(directory, name)) {
      await uiAlert(`Could not open it from here. The file is at:\n${absolute}`,
                    { title: "Diagnostics recording", confirmLabel: "OK" });
    }
  },


  flushDiagnostics(final = false) {
    const state = this.diagState;
    if (!state || (!state.pending.length && !final)) return;
    const events = state.pending;
    state.pending = [];
    return fetch("/api/debug/diagnostics", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: state.id, events }),
      keepalive: final,          // a final flush has to survive the page going away
    }).then((response) => response.json())
      .then((result) => { if (result?.path) this.diagLastPath = result.path; })
      .catch(() => { /* losing a batch must not stop the recording */ });
  },


  // Everything that decides where the view sits, in one shape. Sizes and counts only -- never content.
  diagGeometry(view) {
    const buffer = view.term.buffer.active;
    const cell = view.term._core?._renderService?.dimensions?.css?.cell?.height;
    if (!cell) return null;
    const windowTop = view.container.scrollTop - view.term.element.offsetTop;
    const first = buffer.viewportY + Math.floor(windowTop / cell);
    const last = buffer.viewportY + Math.floor((windowTop + view.container.clientHeight - 1) / cell);
    const cursor = (buffer.baseY || 0) + buffer.cursorY;
    let lastContent = cursor;
    for (let row = Math.min(buffer.length - 1, cursor + 400); row > cursor; row -= 1) {
      if (buffer.getLine(row)?.translateToString(true).trim()) { lastContent = row; break; }
    }
    const now = Date.now();
    return {
      session: String(this.activeId || "").slice(0, 12), agent: this.session(this.activeId)?.agent_kind,
      top: Math.round(view.container.scrollTop), ceiling: view.tallMaxScrollTop,
      nativeMax: Math.round(view.container.scrollHeight - view.container.clientHeight),
      following: view.tallFollowing, pinned: view.tallPinnedViewportY, anchor: view.tallAnchorRow,
      replaying: !!view.replaying, queued: view.outputQueue?.length || 0,
      elTop: view.term.element.offsetTop, cell: Math.round(cell * 10) / 10,
      viewportY: buffer.viewportY, baseY: buffer.baseY, len: buffer.length,
      cursor, first, last, lastContent, rowsBelow: lastContent - last,
      gesture: !!view.tallPointerHeld ||
        now < Math.max(view.tallWheelActiveUntil || 0, view.tallScrollActiveUntil || 0) + 1500,
    };
  },


  diagSettingsSummary() {
    const s = this.settings || {};
    return { tall_webgl: s.tall_webgl, terminal_font_size: s.terminal_font_size,
             tree_font_size: s.tree_font_size, bottom_font_size: s.bottom_font_size,
             history_mode: s.history_mode, theme: s.theme };
  },


  // Plain, non-interactive, and impossible to miss: recording must never be a thing you forgot is on.
  showDiagnosticsBadge() {
    if (this.diagBadge) return;
    const badge = document.createElement("div");
    badge.id = "diagnostics-badge";
    badge.title = "Recording diagnostics. Stop from the maintenance menu (click the CPU/memory readout).";
    Object.assign(badge.style, {
      position: "fixed", bottom: "6px", left: "50%", transform: "translateX(-50%)", zIndex: "99999",
      font: "11px -apple-system, system-ui, sans-serif", letterSpacing: ".3px",
      color: "#ffd7d7", background: "rgba(150, 40, 45, .92)", border: "1px solid rgba(255,120,120,.5)",
      borderRadius: "10px", padding: "3px 10px", pointerEvents: "none",
    });
    document.body.appendChild(badge);
    this.diagBadge = badge;
    this.updateDiagnosticsBadge();
  },


  updateDiagnosticsBadge() {
    const state = this.diagState;
    if (!this.diagBadge || !state) return;
    const seconds = Math.round((Date.now() - state.startedAt) / 1000);
    this.diagBadge.textContent = `● REC diagnostics · ${seconds}s · ${state.count} events` +
      (state.faults ? ` · ${state.faults} fault${state.faults === 1 ? "" : "s"}` : "");
  },



  captureDebugSnapshot(view, trigger) {
    if (!view || view.closed) return;
    view.debugSnapshots = view.debugSnapshots || [];
    view.debugSnapshots.push({
      trigger, ts: Date.now(), cols: view.term.cols, rows: view.term.rows,
      buf: this.terminalBufferVisibleTailLines(view, 15),
      dom: this.terminalRenderedTailLines(view, 15),
    });
    if (view.debugSnapshots.length > TERMINAL_DEBUG_SNAPSHOT_LIMIT) view.debugSnapshots.shift();
  },


  // Small top-right corner panel, INVISIBLE by default: a header (collapse toggle) plus a collapsed,
  // empty body kept as reusable scaffolding for a future terminal-rendering investigation. Deliberately
  // NOT wired to any automatic capture/logging -- an earlier version accumulated visible blur/focus/
  // resize chatter once its original investigation was fixed (reported as noise, stripped back out),
  // and a later "guarded" A/B toggle here showed no observable difference from the shipped default.
  // The body (this.debugOverlay.stats/.diff)
  // stays empty until something explicitly writes into it. To reactivate for a NEW investigation: set
  // box.style.display = "block", write into this.debugOverlay.stats/.diff, and wire
  // this.captureDebugSnapshot(view, "label") into whatever new code path is under suspicion -- see this
  // file's git history around 2026-08-02 for a fuller buffer-vs-rendered-DOM differ and an A/B select
  // to copy the pattern from, not to revive verbatim.
  installTerminalSizeDebugOverlay() {
    const box = document.createElement("div");
    box.id = "td-debug-size-overlay";
    Object.assign(box.style, {
      position: "fixed", top: "4px", right: "4px", zIndex: 99999, display: "none", color: "#0f0",
      background: "rgba(0,0,0,0.9)", padding: "4px 8px", borderRadius: "4px", cursor: "text",
      userSelect: "text", WebkitUserSelect: "text", maxWidth: "44vw", maxHeight: "70vh", overflow: "auto",
    });
    const header = document.createElement("div");
    Object.assign(header.style, {
      font: "11px/1.4 ui-monospace, monospace", cursor: "pointer", userSelect: "none",
      WebkitUserSelect: "none", display: "flex", justifyContent: "space-between", gap: "8px",
    });
    const title = document.createElement("span");
    title.textContent = "td-debug";
    const toggle = document.createElement("span");
    let collapsed = true;
    const body = document.createElement("div");
    const applyCollapsed = () => {
      body.style.display = collapsed ? "none" : "";
      toggle.textContent = collapsed ? "▸ expand" : "▾ collapse";
    };
    toggle.addEventListener("click", () => { collapsed = !collapsed; applyCollapsed(); });
    header.append(title, toggle);
    header.addEventListener("click", (e) => { if (e.target === header || e.target === title) { collapsed = !collapsed; applyCollapsed(); } });
    const stats = document.createElement("div");
    Object.assign(stats.style, { font: "11px/1.4 ui-monospace, monospace", whiteSpace: "pre" });
    const diff = document.createElement("div");
    Object.assign(diff.style, { font: "9.5px/1.3 ui-monospace, monospace", whiteSpace: "pre", marginTop: "4px", color: "#8f8" });
    body.append(stats, diff);
    box.append(header, body);
    applyCollapsed();
    document.body.appendChild(box);
    this.debugOverlay = { box, stats, diff };
  },


  scrollActiveToBottom() {
    if (this.activeFileKey !== null) return;
    const view = this.views.get(this.activeId);
    if (!view) return;
    if (this.isTerminalScrollV2()) {
      view.scrollMode = "follow";
      this.scrollTerminalV2ToBottom(view);
      // Also drive the tall container: scrollTerminalV2ToBottom only moves xterm's own viewport, which is
      // no longer the surface being scrolled, so on its own this button did nothing at all here.
      view.tallFollowing = true;
      if (view.tallMaxScrollTop != null) this.scrollTallContainerToCursor(view);
      else this.tallSetScrollTop(view, view.container.scrollHeight);
      this.scheduleV2Fit(view);
      view.term.focus();
      return;
    }
    view.keepBottom = true;
    view.pinBottomUntil = Date.now() + 5000;
    this.scrollTerminalToBottom(view);
    this.scheduleViewportSettle(view);
    view.term.focus();
  },


  repaintActiveTerminalDisplay() {
    const id = this.activeId;
    const view = this.views.get(id);
    if (!view || this.activeFileKey !== null || this.historyOpen || !this.session(id)) return;
    if (this.terminalTailRenderMismatch(view)) {
      view.renderRepairArmed = true;
      if (this.repairTerminalRenderIfStale(view)) {
        this.$("status-name").textContent = "Terminal display repainted";
        return;
      }
    }
    this.refreshTerminalAppearance(view, true);
    if (!view.ws || view.ws.readyState !== WebSocket.OPEN) return;
    const anchor = this.captureTerminalViewportAnchor(view, { preserveFollow: true, restoreAfterDeadline: true });
    this.beginTerminalViewportRestore(view, anchor);
    view.ws.send(JSON.stringify({ type: "repaint" }));
    this.$("status-name").textContent = "requesting terminal repaint…";
  },


  scrollHistoryToBottom() {
    if (!this.historyOpen || this.activeFileKey !== null) return;
    const body = this.$("history-body");
    if (!body) return;
    body.scrollTop = body.scrollHeight;
    this.$("history-prompt")?.focus();
  },


  scrollActiveSurfaceToBottom() {
    if (this.historyOpen) this.scrollHistoryToBottom();
    else this.scrollActiveToBottom();
  },


  scheduleTerminalResizeRepair(view) {
    if (!view || view.closed || !view.container.classList.contains("visible")) return;
    view.forceResizeAfterFit = true;
    this.scheduleTerminalLayoutFit();
    clearTimeout(view.resizeRepairTimer);
    view.resizeRepairTimer = setTimeout(() => {
      view.resizeRepairTimer = 0;
      if (view.closed || !view.container.classList.contains("visible") || view.sessionId !== this.activeId) return;
      view.forceResizeAfterFit = true;
      this.scheduleTerminalLayoutFit();
    }, 420);
  },


  resyncActiveTerminal() {
    if (this.activeFileKey !== null || this.historyOpen || !this.activeId) return;
    const view = this.views.get(this.activeId);
    if (!view || view.closed) return;
    // Resync is also the manual escape hatch for terminals whose prompt or
    // wrapped output was painted against stale dimensions. Treat the button
    // like a sidebar resize so FitAddon remeasures the visible terminal,
    // repaints it, and sends the corrected PTY size.
    const v2 = this.isTerminalScrollV2();
    if (v2) view.scrollMode = "follow";
    else {
      view.keepBottom = true;
      view.pinBottomUntil = Date.now() + 8000;
    }
    view.term.reset();
    this.tallResetScrollState(view);
    // V2 mode gets its repaint trigger for free once the forced reconnect below actually delivers a
    // snapshot (connect()'s post-replay callback), the same path a plain page refresh goes through --
    // scheduling it again here, before that reconnect has even started, used to race it and could nudge
    // an empty buffer instead of the real one. Legacy mode has no equivalent hook, so it still needs
    // this scheduled directly.
    if (!v2) {
      view.resyncResizeRepairPending = true;
      this.scheduleTerminalResizeRepair(view);
    }
    view.suppressResizeToServer = true;
    view.sizeOwnedElsewhere = null;
    this.updateSizeOwnershipIndicator(view);
    this.applySettings({ fitTerminals: false });
    this.tallFit(view);
    const takeoverCols = view.term.cols;
    const takeoverRows = this.fullscreenTuiPtyRows(view) || view.term.rows;
    this.$("status-name").textContent = "resyncing terminal…";
    // Explicit user action, so this is the one place allowed to take the size from another window.
    view.suppressResizeToServer = false;
    if (view.ws && view.ws.readyState === WebSocket.OPEN && takeoverCols >= 2 && takeoverRows >= 2) {
      view.ws.send(JSON.stringify({ type: "resize", cols: takeoverCols, rows: takeoverRows, force: true }));
    }
    const ws = view.ws;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    } else {
      clearTimeout(view.reconnectTimer);
      view.reconnectTimer = 0;
      this.connect(this.activeId, view);
    }
  },


  terminalAtBottom(view) {
    if (this.isTerminalScrollV2()) return this.xtermAtBottom(view);
    if (!view || !view.term) return false;
    const buffer = view.term.buffer.active;
    const viewport = view.container.querySelector(".xterm-viewport");
    if (!viewport) return buffer.viewportY >= buffer.baseY - 1;
    // The browser position is the authoritative position for the native
    // scrollbar. xterm's buffer viewport can lag it by a frame during a fit or
    // resize; requiring both made a real bottom position look non-bottom and
    // caused the follow-bottom state to fight the user's scrolling.
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const domAtBottom = maxScrollTop - viewport.scrollTop <= 2;
    return domAtBottom;
  },


  terminalAtTop(view, topTolerance = 2) {
    if (!view || view.closed || !view.term) return false;
    if (this.isTerminalScrollV2()) return Number(view.container.scrollTop || 0) <= topTolerance;
    const viewport = view.container.querySelector(".xterm-viewport");
    return viewport ? viewport.scrollTop <= topTolerance : Number(view.term.buffer.active.viewportY || 0) <= 0;
  },


  terminalHasScrollableHistory(view) {
    if (!view || view.closed || !view.term) return false;
    const buffer = view.term.buffer.active;
    return Number(buffer.baseY || 0) > 0 || Number(buffer.length || 0) > Number(view.term.rows || 0) ||
      view.container.scrollHeight - view.container.clientHeight > 2;
  },


  updateTerminalHistoryMoreButton(view = this.views.get(this.activeId)) {
    const button = this.$("terminal-history-more");
    if (!button) return;
    const session = view ? this.session(view.sessionId) : null;
    const eligible = !!view && view.sessionId === this.activeId && !this.historyOpen && this.activeFileKey === null &&
      !this.vscodeMode && !this.nativeVscodeMode && this.sessionSupportsTranscript(session) &&
      view.everConnected && !view.awaitingSnapshot && !view.replaying &&
      this.terminalHasScrollableHistory(view);
    if (!eligible) {
      button.classList.add("hidden");
      return;
    }
    const alreadyVisible = !button.classList.contains("hidden");
    const visible = this.terminalAtTop(view, alreadyVisible ? 24 : 2);
    if (view.tallPointerHeld && alreadyVisible && visible) return;
    button.classList.toggle("hidden", !visible);
  },


  isTerminalScrollV2() {
    // Desktop terminals always use xterm's buffer-owned scrolling. The VS Code
    // integration remains separate and continues to use its native surface.
    return !this.vscodeMode;
  },


  xtermAtBottom(view) {
    if (!view?.term) return false;
    const buffer = view.term.buffer.active;
    return buffer.viewportY >= buffer.baseY;
  },


  scrollTerminalV2ToBottom(view) {
    if (!view || view.closed) return;
    view.userScrollIntent = false;
    view.scrollMode = "follow";
    view.v2Programmatic = true;
    // The tall layout owns xterm's viewport: it is DERIVED from the container's scroll position
    // (tallSyncBufferToScroll), never forced to the buffer's own bottom. Forcing it here fought that
    // derivation on every write -- scrollToBottom pushed the viewport down a row, the write callback's
    // sync pulled it straight back, and both states painted: a visible one-row jitter on each keystroke
    // whenever any scrollback existed (baseY > 0) while the content still fit the viewport. Captured
    // live with a stack recorder on a fresh codex tab (baseY 1, viewportY bouncing 0->1->0 per key).
    this.tallSyncBufferToScroll(view);
    queueMicrotask(() => {
      if (!view.closed) view.v2Programmatic = false;
    });
  },


  // Restoring a "preserve" position needs the same v2Programmatic guard scrollTerminalV2ToBottom
  // already uses: term.onScroll re-derives scrollMode from wherever the terminal ends up on every
  // scroll it sees, including one this function itself triggers -- without the guard, that immediate
  // self-triggered onScroll can flip scrollMode right back to "follow"/"preserve" based on the
  // now-current position, one write-callback race away from stomping the caller's intended value
  // before this function's own caller gets a chance to set it explicitly afterward.
  scrollTerminalV2ToLine(view, line) {
    if (!view || view.closed) return;
    view.v2Programmatic = true;
    view.term.scrollToLine(line);
    queueMicrotask(() => {
      if (!view.closed) view.v2Programmatic = false;
    });
  },


  normalizeTerminalViewportAnchorText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, "");
  },


  captureTerminalViewportAnchor(view, options = {}) {
    const preserveFollow = Boolean(options.preserveFollow);
    const restoreAfterDeadline = Boolean(options.restoreAfterDeadline);
    const atBottom = this.xtermAtBottom(view);
    if (!view || view.closed || !this.agentBehavior(this.session(view.sessionId)?.agent_kind)?.viewportAnchor ||
        (!preserveFollow && (view.scrollMode === "follow" || atBottom))) return null;
    const buffer = view.term.buffer.active;
    const viewportY = Math.max(0, Number(buffer.viewportY || 0));
    const visibleRows = Math.min(TERMINAL_VIEWPORT_ANCHOR_ROWS, Math.max(1, Number(view.term.rows || 1)));
    const normalizedRows = [];
    for (let offset = 0; offset < visibleRows; offset++) {
      const line = buffer.getLine(viewportY + offset);
      normalizedRows.push(this.normalizeTerminalViewportAnchorText(line ? line.translateToString(true) : ""));
    }
    const candidates = [];
    for (let start = 0; start < normalizedRows.length; start++) {
      let text = "";
      for (let offset = start; offset < normalizedRows.length && text.length < TERMINAL_VIEWPORT_ANCHOR_MAX_CHARS; offset++) {
        text += normalizedRows[offset];
      }
      text = text.slice(0, TERMINAL_VIEWPORT_ANCHOR_MAX_CHARS);
      const alphaNumericCount = (text.match(/[A-Za-z0-9]/g) || []).length;
      if (text.length >= TERMINAL_VIEWPORT_ANCHOR_MIN_CHARS && alphaNumericCount >= 12) {
        candidates.push({ text, rowOffset: start });
      }
    }
    if (!candidates.length && !(preserveFollow && atBottom)) return null;
    candidates.sort((left, right) => left.rowOffset - right.rowOffset || right.text.length - left.text.length);
    return {
      candidates: candidates.slice(0, 6),
      rowsFromBottom: Math.max(0, Number(buffer.baseY || 0) - viewportY),
      restoreAtBottom: preserveFollow && atBottom,
      restoreAfterDeadline,
      redrawSeen: false,
      escapeMatchLength: 0,
      deadline: 0,
    };
  },


  beginTerminalViewportRestore(view, anchor) {
    if (!anchor || !view || view.closed) return false;
    if (!view.viewportAnchorRestore) view.viewportAnchorRestore = anchor;
    view.viewportAnchorRestore.deadline = Date.now() + TERMINAL_VIEWPORT_RESTORE_TIMEOUT_MS;
    this.scheduleTerminalViewportRestore(view, TERMINAL_VIEWPORT_RESTORE_IDLE_MS);
    return true;
  },


  cancelTerminalViewportRestore(view) {
    if (!view) return;
    clearTimeout(view.viewportAnchorRestoreTimer);
    view.viewportAnchorRestoreTimer = 0;
    view.viewportAnchorRestore = null;
  },


  noteTerminalViewportRestoreOutput(view, data) {
    const anchor = view?.viewportAnchorRestore;
    if (!anchor || anchor.redrawSeen) return;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const eraseScrollback = [0x1b, 0x5b, 0x33, 0x4a];
    let matched = anchor.escapeMatchLength || 0;
    for (const byte of bytes) {
      if (byte === eraseScrollback[matched]) matched += 1;
      else matched = byte === eraseScrollback[0] ? 1 : 0;
      if (matched !== eraseScrollback.length) continue;
      anchor.redrawSeen = true;
      matched = 0;
      break;
    }
    anchor.escapeMatchLength = matched;
  },


  terminalViewportAnchorTarget(view, anchor) {
    const buffer = view.term.buffer.active;
    let text = "";
    const rowStarts = [];
    for (let row = 0; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      const normalized = this.normalizeTerminalViewportAnchorText(line ? line.translateToString(true) : "");
      if (!normalized) continue;
      rowStarts.push({ offset: text.length, row });
      text += normalized;
    }
    if (!text || !rowStarts.length) return null;
    let best = null;
    for (const candidate of anchor.candidates) {
      let offset = text.indexOf(candidate.text);
      let matches = 0;
      while (offset >= 0 && matches < 64) {
        const row = this.terminalViewportRowForTextOffset(rowStarts, offset);
        const expectedRowsFromBottom = Math.max(0, anchor.rowsFromBottom - candidate.rowOffset);
        const score = Math.abs((Number(buffer.baseY || 0) - row) - expectedRowsFromBottom);
        if (!best || score < best.score || (score === best.score && candidate.text.length > best.length)) {
          best = { line: Math.max(0, row - candidate.rowOffset), score, length: candidate.text.length };
        }
        matches += 1;
        offset = text.indexOf(candidate.text, offset + 1);
      }
    }
    return best?.line ?? null;
  },


  terminalViewportRowForTextOffset(rowStarts, offset) {
    let low = 0, high = rowStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (rowStarts[middle].offset <= offset) low = middle;
      else high = middle - 1;
    }
    return rowStarts[low].row;
  },


  scheduleTerminalViewportRestore(view, delay = TERMINAL_VIEWPORT_RESTORE_IDLE_MS) {
    const anchor = view?.viewportAnchorRestore;
    if (!anchor || view.closed) return;
    clearTimeout(view.viewportAnchorRestoreTimer);
    const remaining = Math.max(0, anchor.deadline - Date.now());
    view.viewportAnchorRestoreTimer = setTimeout(() => {
      view.viewportAnchorRestoreTimer = 0;
      this.restoreTerminalViewportAnchor(view);
    }, Math.min(delay, remaining));
  },


  restoreTerminalViewportAnchor(view) {
    const anchor = view?.viewportAnchorRestore;
    if (!anchor || view.closed) return;
    const expired = Date.now() >= anchor.deadline;
    if (!anchor.redrawSeen) {
      if (!expired || !anchor.restoreAfterDeadline) {
        if (expired) this.cancelTerminalViewportRestore(view);
        else this.scheduleTerminalViewportRestore(view);
        return;
      }
    }
    if (!expired && (view.outputWriteInFlight || view.outputQueue.length)) {
      this.scheduleTerminalViewportRestore(view);
      return;
    }
    if (anchor.restoreAtBottom) {
      view.scrollMode = "follow";
      this.scrollTerminalV2ToBottom(view);
      this.cancelTerminalViewportRestore(view);
      return;
    }
    const target = this.terminalViewportAnchorTarget(view, anchor);
    if (target !== null) {
      view.scrollMode = "preserve";
      this.scrollTerminalV2ToLine(view, target);
      this.cancelTerminalViewportRestore(view);
      return;
    }
    if (!expired) {
      this.scheduleTerminalViewportRestore(view);
      return;
    }
    view.scrollMode = "preserve";
    view.userScrollIntent = true;
    this.scrollTerminalV2ToLine(view, Math.max(0, view.term.buffer.active.baseY - anchor.rowsFromBottom));
    this.cancelTerminalViewportRestore(view);
  },


  scheduleV2Fit(view, options = {}) {
    const forceResize = !!options.force;
    if (!this.terminalSurfaceAvailableForFit(view)) return;
    if (this.shouldDeferPromptReflowFit(view)) return;
    if (view.v2FitFrame && forceResize) {
      cancelAnimationFrame(view.v2FitFrame);
      view.v2FitFrame = 0;
    }
    if (view.v2FitFrame) return;
    view.v2FitFrame = requestAnimationFrame(() => {
      view.v2FitFrame = 0;
      if (!this.terminalSurfaceAvailableForFit(view)) return;
      if (this.shouldDeferPromptReflowFit(view)) return;
      const rect = view.container.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) {
        const retryLimit = forceResize ? TERMINAL_V2_FIT_RETRY_LIMIT : 12;
        const retryDelay = forceResize ? TERMINAL_V2_FIT_RETRY_DELAY_MS : 60;
        if (!view.layoutFitRetryTimer && view.layoutFitRetryCount < retryLimit) {
          view.layoutFitRetryCount += 1;
          view.layoutFitRetryTimer = setTimeout(() => {
            view.layoutFitRetryTimer = 0;
            if (this.terminalSurfaceAvailableForFit(view)) this.scheduleV2Fit(view, options);
          }, retryDelay);
        }
        return;
      }
      view.layoutFitRetryCount = 0;
      clearTimeout(view.layoutFitRetryTimer);
      view.layoutFitRetryTimer = 0;
      const beforeCols = view.term.cols, beforeRows = view.term.rows;
      const rowsFromBottom = view.term.buffer.active.baseY - view.term.buffer.active.viewportY;
      // FitAddon is the public xterm sizing mechanism. v2 never writes to
      // .xterm-viewport or .xterm-scroll-area; xterm owns its scrollbar.
      const viewportAnchor = this.captureTerminalViewportAnchor(view);
      this.tallFit(view);
      view.container.classList.remove("initializing");
      const terminalSizeChanged = view.term.cols !== beforeCols || view.term.rows !== beforeRows;
      if (terminalSizeChanged) this.beginTerminalViewportRestore(view, viewportAnchor);
      if (view.scrollMode !== "follow" && terminalSizeChanged) {
        this.scrollTerminalV2ToLine(view, Math.max(0, view.term.buffer.active.baseY - rowsFromBottom));
      }
      // A terminal may have been painted while its container was hidden or
      // at its pre-flex width. Refresh after the settled fit so the canvas
      // and text colors are repainted together with the final geometry.
      const hasPaintedInitialSnapshot = view.initialSnapshotPainted;
      const forceResizeThisFrame = hasPaintedInitialSnapshot && (forceResize || view.forceResizeAfterFit);
      if (!hasPaintedInitialSnapshot) view.forceResizeAfterFit = false;
      view.forceResizeAfterFit = false;
      this.refreshTerminalAppearance(view, forceResizeThisFrame);
      // A height-only change never alters the tall terminal's own cols/rows, so term.onResize stays
      // silent -- but a fullscreen_tui pty is sized from the container height, so its capped rows can
      // change with no other resize signal. Re-send whenever the cap drifted from what the pty has.
      const tuiRowsDrifted = (this.fullscreenTuiPtyRows(view) ?? view.lastSentRows) !== view.lastSentRows;
      if ((forceResizeThisFrame || tuiRowsDrifted) && view.term.cols >= 2 && view.term.rows >= 2) {
        this.sendResize(view, view.term.cols, view.term.rows, forceResizeThisFrame);
      }
      if (view.scrollMode === "follow") this.scrollTerminalV2ToBottom(view);
    });
  },


  scheduleInitialV2Fit(view) {
    if (!view || view.closed || !view.v2InitialFitPending || view.v2InitialFitFrame ||
        !view.container.classList.contains("visible")) return;
    // A new xterm is opened while its container is display:none. Its first
    // activation can therefore fit against the pre-layout width; settle once
    // more after the browser has committed the newly-visible terminal area.
    view.v2InitialFitPending = false;
    view.v2InitialFitFrame = requestAnimationFrame(() => {
      view.v2InitialFitFrame = requestAnimationFrame(() => {
        view.v2InitialFitFrame = 0;
        if (view.closed || !view.container.classList.contains("visible")) return;
        this.scheduleV2Fit(view);
      });
    });
  },


  scheduleV2ViewportSync(view) {
    if (!view || view.closed || view.v2ViewportSyncFrame || !view.hiddenOutputPending ||
        !view.container.classList.contains("visible")) return;
    if (view.outputWriteInFlight || view.outputQueue.length || view.replaying || view.awaitingSnapshot ||
        !view.container.clientHeight || !view.term._core?._renderService?.dimensions?.css?.cell?.height) {
      view.v2ViewportSyncFrame = requestAnimationFrame(() => {
        view.v2ViewportSyncFrame = 0;
        this.scheduleV2ViewportSync(view);
      });
      return;
    }
    this.tallUpdateMaxScrollTop(view, true);
    view.hiddenOutputPending = false;
    if (view.scrollMode === "follow") {
      this.scrollTerminalV2ToBottom(view);
      if (view.tallFollowing !== false) this.scrollTallContainerToCursor(view);
      return;
    }
    const buffer = view.term.buffer.active;
    const target = buffer.viewportY;
    if (buffer.baseY <= 0) return;
    const nudge = target < buffer.baseY ? target + 1 : Math.max(0, target - 1);
    if (nudge === target) return;
    view.v2Programmatic = true;
    view.term.scrollToLine(nudge);
    view.term.scrollToLine(target);
    queueMicrotask(() => {
      if (!view.closed) view.v2Programmatic = false;
    });
  },


  scrollTerminalToBottom(view) {
    if (this.isTerminalScrollV2()) {
      this.scrollTerminalV2ToBottom(view);
      return;
    }
    clearTimeout(view.manualScrollReleaseTimer);
    view.manualScrollReleaseTimer = 0;
    view.manualScroll = false;
    view.wasAtBottom = true;
    view.programmaticScrollUntil = Date.now() + 1000;
    view.programmaticScrollGeneration = view.manualScrollGeneration;
    view.term.scrollToBottom();
    const viewport = view.container.querySelector(".xterm-viewport");
    if (viewport) {
      // Assign the maximum scrollTop, rather than scrollHeight.  The latter
      // is clamped by the browser but can leave xterm one viewport short while
      // its row geometry is being updated.
      viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    }
  },


  refreshTerminal(view) {
    if (!view || view.term.rows < 1) return;
    view.term.refresh(0, view.term.rows - 1);
  },


  scheduleCodexFocusTailRefresh(view) {
    if (!view || view.closed || view.codexFocusRefreshFrame || !this.agentBehavior(this.session(view.sessionId)?.agent_kind)?.focusTailRefresh) return;
    view.codexFocusRefreshFrame = requestAnimationFrame(() => {
      view.codexFocusRefreshFrame = requestAnimationFrame(() => {
        view.codexFocusRefreshFrame = 0;
        if (view.closed || this.activeId !== view.sessionId || this.historyOpen || this.activeFileKey !== null ||
            !view.container.classList.contains("visible")) return;
        const lastRow = Math.max(0, view.term.rows - 1);
        view.term.refresh(Math.max(0, lastRow - 5), lastRow);
      });
    });
  },


  normalizeTerminalTailLine(line) {
    return String(line || "").replace(/\u00a0/g, " ").replace(/\s+$/g, "");
  },


  terminalBufferVisibleTailLines(view, count = TERMINAL_TAIL_REPAIR_LINES) {
    const buffer = view?.term?.buffer?.active;
    if (!buffer || typeof buffer.getLine !== "function") return [];
    const rows = Math.max(1, Number(view.term.rows || 1));
    const viewportY = Math.max(0, Number(buffer.viewportY || 0));
    const start = Math.max(0, viewportY + rows - count);
    const end = viewportY + rows;
    const lines = [];
    for (let index = start; index < end; index++) {
      const line = buffer.getLine(index);
      lines.push(this.normalizeTerminalTailLine(line ? line.translateToString(true) : ""));
    }
    return lines;
  },


  recordTerminalRenderedRows(view, start, end) {
    const buffer = view?.term?.buffer?.active;
    if (!buffer || typeof buffer.getLine !== "function") return;
    const viewportY = Math.max(0, Number(buffer.viewportY || 0));
    const rows = Math.max(1, Number(view.term.rows || 1));
    const cols = Math.max(1, Number(view.term.cols || 1));
    if (view.renderedViewportY !== viewportY || view.renderedCols !== cols || view.renderedTermRows !== rows) {
      view.renderedRows = new Array(rows).fill(null);
      view.renderedViewportY = viewportY;
      view.renderedCols = cols;
      view.renderedTermRows = rows;
    }
    const first = Math.max(0, Number(start || 0));
    const last = Math.min(rows - 1, Number.isFinite(Number(end)) ? Number(end) : first);
    for (let row = first; row <= last; row++) {
      const line = buffer.getLine(viewportY + row);
      view.renderedRows[row] = this.normalizeTerminalTailLine(line ? line.translateToString(true) : "");
    }
  },


  terminalRenderedTailLines(view, count = TERMINAL_TAIL_REPAIR_LINES) {
    const rows = [...(view?.container?.querySelectorAll(".xterm-rows > div") || [])];
    if (rows.length) return rows.slice(-count).map((row) => this.normalizeTerminalTailLine(row.textContent || ""));
    const buffer = view?.term?.buffer?.active;
    if (!buffer || view.renderedViewportY !== Math.max(0, Number(buffer.viewportY || 0)) ||
        view.renderedCols !== view.term.cols || view.renderedTermRows !== view.term.rows) return [];
    const rendered = view.renderedRows.slice(Math.max(0, view.term.rows - count));
    return rendered.some((line) => line === null) ? [] : rendered;
  },


  parseCssColor(value) {
    const color = String(value || "").trim().toLowerCase();
    let match = color.match(/^#([0-9a-f]{3})$/i);
    if (match) {
      return match[1].split("").map((part) => Number.parseInt(part + part, 16)).concat(1);
    }
    match = color.match(/^#([0-9a-f]{6})$/i);
    if (match) {
      return [
        Number.parseInt(match[1].slice(0, 2), 16),
        Number.parseInt(match[1].slice(2, 4), 16),
        Number.parseInt(match[1].slice(4, 6), 16),
        1,
      ];
    }
    match = color.match(/^rgba?\(([^)]+)\)$/i);
    if (!match) return null;
    const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
    if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
    return [parts[0], parts[1], parts[2], Number.isFinite(parts[3]) ? parts[3] : 1];
  },


  colorDistance(left, right) {
    if (!left || !right) return Number.POSITIVE_INFINITY;
    const dr = left[0] - right[0];
    const dg = left[1] - right[1];
    const db = left[2] - right[2];
    return Math.sqrt((dr * dr) + (dg * dg) + (db * db));
  },


  terminalRenderedTailLooksInvisible(view, expected, rendered) {
    const rows = [...(view?.container?.querySelectorAll(".xterm-rows > div") || [])].slice(-expected.length);
    if (!rows.length || !expected.some((line) => line.trim())) return false;
    const screen = view.container.querySelector(".xterm-screen") || view.container;
    const computedBackground = this.parseCssColor(window.getComputedStyle(screen).backgroundColor);
    const themeBackground = this.parseCssColor(this.termTheme().background);
    const background = computedBackground && computedBackground[3] > 0 ? computedBackground : themeBackground;
    let compared = 0;
    let invisible = 0;
    for (let index = 0; index < expected.length; index++) {
      if (!expected[index].trim()) continue;
      compared += 1;
      const row = rows[index];
      const renderedLine = rendered[index] || "";
      if (!row || !renderedLine.trim()) {
        invisible += 1;
        continue;
      }
      const spans = [...row.querySelectorAll("span")].filter((span) => String(span.textContent || "").trim());
      const samples = spans.length ? spans : [row];
      const rowVisible = samples.some((sample) => {
        const style = window.getComputedStyle(sample);
        const opacity = Number.parseFloat(style.opacity);
        if (style.visibility === "hidden" || style.display === "none" || opacity === 0) return false;
        const foreground = this.parseCssColor(style.color);
        if (!foreground || foreground[3] === 0) return false;
        const sampleBackground = this.parseCssColor(style.backgroundColor);
        const effectiveBackground = sampleBackground && sampleBackground[3] > 0 ? sampleBackground : background;
        return !effectiveBackground || this.colorDistance(foreground, effectiveBackground) >= 12;
      });
      if (!rowVisible) invisible += 1;
    }
    return compared > 0 && invisible > 0;
  },


  terminalTailRenderMismatch(view) {
    const visibleRows = Math.max(1, Number(view.term.rows || 1));
    const expected = this.terminalBufferVisibleTailLines(view, visibleRows);
    const rendered = this.terminalRenderedTailLines(view, visibleRows);
    if (!expected.length || expected.length !== rendered.length) return false;
    let compared = 0;
    for (let index = 0; index < expected.length; index++) {
      const expectedLine = expected[index];
      if (!expectedLine.trim()) continue;
      compared += 1;
      if (expectedLine !== rendered[index]) return true;
    }
    view.tailRepairSignature = expected.join("\n");
    return (compared > 0 && !rendered.some((line) => line.trim())) ||
      this.terminalRenderedTailLooksInvisible(view, expected, rendered);
  },


  terminalRenderMismatchSnapshot(view) {
    if (!this.terminalTailRenderMismatch(view)) return null;
    const visibleRows = Math.max(1, Number(view.term.rows || 1));
    return {
      viewportY: Number(view.term.buffer.active.viewportY || 0), cols: view.term.cols, rows: view.term.rows,
      expected: this.terminalBufferVisibleTailLines(view, visibleRows).join("\n"),
      rendered: this.terminalRenderedTailLines(view, visibleRows).join("\n"),
    };
  },


  sameTerminalRenderMismatch(left, right) {
    return !!left && !!right && left.viewportY === right.viewportY && left.cols === right.cols && left.rows === right.rows &&
      left.expected === right.expected && left.rendered === right.rendered;
  },


  repairTerminalRenderIfStale(view) {
    if (!this.terminalSurfaceAvailableForFit(view)) return false;
    if (this.shouldDeferPromptReflowFit(view)) return false;
    if (!this.terminalTailRenderMismatch(view)) {
      view.renderRepairArmed = true;
      return false;
    }
    if (!view.renderRepairArmed) return false;
    view.renderRepairArmed = false;
    const restoreLine = view.term.buffer.active.viewportY;
    // Captured as an OFFSET, not the absolute index above: a cols change reflows the whole buffer
    // (every wrapped line can re-wrap into a different number of rows), so restoreLine can point at
    // entirely different content once that happens. An earlier attempt just skipped restoring
    // anything in that case, assuming xterm's own resize()/reflow keeps the viewport sensibly
    // positioned on its own -- ground-truth testing (window.__td) showed that assumption was wrong,
    // reflow can leave viewportY at 0 outright. "N rows above the latest line" survives a reflow the
    // same way it survives a reconnect-driven buffer reset (see the leaving-view capture in
    // activate() and the reconnect restore in connect()'s ws.onmessage).
    const restoreRowsFromBottom = view.term.buffer.active.baseY - restoreLine;
    const follow = view.scrollMode === "follow";
    const renderService = view.term._core?._renderService;
    if (renderService?._isPaused && typeof renderService._handleIntersectionChange === "function") {
      renderService._handleIntersectionChange({ isIntersecting: true, intersectionRatio: 1 });
      this.refreshTerminal(view);
      if (follow) this.scrollTerminalV2ToBottom(view);
      else this.scrollTerminalV2ToLine(view, Math.min(restoreLine, view.term.buffer.active.baseY));
      return true;
    }
    // A stale-looking render is not always a paint problem: the terminal's own cols/rows can be wrong for
    // its actual container width (a sibling's DOM change, a still-settling flex pass) without ever having
    // gone through a resize event. fit() re-measures the container and calls term.resize() when that
    // differs, which repaints AND corrects wrapping in one pass. Re-check the mismatch afterward — a pure
    // paint glitch (fit is a no-op) still needs the appearance refresh below.
    const beforeCols = view.term.cols, beforeRows = view.term.rows;
    const viewportAnchor = this.captureTerminalViewportAnchor(view);
    this.tallFit(view);
    if (view.term.cols !== beforeCols || view.term.rows !== beforeRows) {
      this.beginTerminalViewportRestore(view, viewportAnchor);
      if (view.term.cols >= 2 && view.term.rows >= 2) this.sendResize(view, view.term.cols, view.term.rows, true);
      if (!this.terminalTailRenderMismatch(view)) {
        if (follow) this.scrollTerminalV2ToBottom(view);
        else this.scrollTerminalV2ToLine(view, Math.max(0, view.term.buffer.active.baseY - restoreRowsFromBottom));
        return true;
      }
    }
    if (this.agentBehavior(this.session(view.sessionId)?.agent_kind)?.repaintRestoreScroll) {
      this.refreshTerminalAppearance(view, true);
      if (follow) this.scrollTerminalV2ToBottom(view);
      else this.scrollTerminalV2ToLine(view, Math.min(restoreLine, view.term.buffer.active.baseY));
      return true;
    }
    this.refreshTerminalAppearance(view, true);
    if (follow) this.scrollTerminalV2ToBottom(view);
    else this.scrollTerminalV2ToLine(view, Math.min(restoreLine, view.term.buffer.active.baseY));
    return true;
  },


  shouldForceTerminalActivationReflow(view) {
    if (!view || view.closed || !this.isTerminalScrollV2() ||
        !view.container.classList.contains("visible")) return false;
    return view.initialSnapshotPainted && view.forceResizeAfterFit;
  },


  // Re-measures and force-resends a terminal's size at several points after it becomes active,
  // bypassing sendResize's own dedup each time. Layout can still be settling well past the existing
  // single-shot activation fit (fonts, a sidebar mid-resize, a flex pass waiting on another panel),
  // and there is otherwise no retry for a resize the server silently dropped or a program never fully
  // redrew for. This is the same "keep re-measuring and re-sending until it's right" behavior a manual
  // drag-resize gets for free from a live ResizeObserver stream — just scoped to the active terminal
  // and self-terminating instead of a standing timer.
  scheduleActiveTerminalSettleWatchdog(view) {
    this.clearActiveTerminalSettleWatchdog(view);
    if (!this.isTerminalScrollV2() || !this.terminalSurfaceAvailableForFit(view)) return;
    for (const delay of TERMINAL_ACTIVE_SETTLE_DELAYS_MS) {
      view.settleWatchdogTimers.push(setTimeout(() => {
        if (!this.terminalSurfaceAvailableForFit(view)) return;
        if (this.shouldDeferPromptReflowFit(view)) return;
        const beforeCols = view.term.cols, beforeRows = view.term.rows;
        const viewportAnchor = this.captureTerminalViewportAnchor(view);
        this.tallFit(view);
        const colsChanged = view.term.cols !== beforeCols || view.term.rows !== beforeRows;
        if (colsChanged) this.beginTerminalViewportRestore(view, viewportAnchor);
        if (colsChanged && view.term.cols >= 2 && view.term.rows >= 2) this.sendResize(view, view.term.cols, view.term.rows);
        if (colsChanged || this.terminalTailRenderMismatch(view)) {
          this.repairTerminalRenderIfStale(view);
        }
      }, delay));
    }
  },


  clearActiveTerminalSettleWatchdog(view) {
    if (!view) return;
    for (const timer of view.settleWatchdogTimers) clearTimeout(timer);
    view.settleWatchdogTimers = [];
  },


  scheduleTerminalTailRepair(view) {
    if (!view || view.closed || view.tailRepairTimer || view.tailRepairConfirmTimer ||
        !view.container.classList.contains("visible") || !this.isTerminalScrollV2() ||
        !this.agentBehavior(this.session(view.sessionId)?.agent_kind)?.tailRepair || !this.terminalSurfaceAvailableForFit(view)) return;
    view.tailRepairTimer = setTimeout(() => {
      view.tailRepairTimer = 0;
      if (!this.terminalSurfaceAvailableForFit(view)) return;
      const candidate = this.terminalRenderMismatchSnapshot(view);
      if (!candidate) {
        view.renderRepairArmed = true;
        return;
      }
      view.tailRepairConfirmTimer = setTimeout(() => {
        view.tailRepairConfirmTimer = 0;
        if (!this.terminalSurfaceAvailableForFit(view)) return;
        const confirmed = this.terminalRenderMismatchSnapshot(view);
        if (!this.sameTerminalRenderMismatch(candidate, confirmed)) {
          if (!confirmed) view.renderRepairArmed = true;
          else this.scheduleTerminalTailRepair(view);
          return;
        }
        if (Date.now() - view.lastRenderRepairAt < TERMINAL_RENDER_REPAIR_COOLDOWN_MS) return;
        view.renderRepairArmed = true;
        if (this.repairTerminalRenderIfStale(view)) view.lastRenderRepairAt = Date.now();
      }, TERMINAL_RENDER_CONFIRM_DELAY_MS);
    }, TERMINAL_RENDER_CHECK_INTERVAL_MS);
  },


  scheduleTerminalActivationRepair(view, options = {}) {
    if (!view || view.activationRepairFrame || !this.terminalSurfaceAvailableForFit(view)) return;
    if (!this.isTerminalScrollV2()) return;
    const generation = view.outputWriteGeneration;
    const forceReflow = !!options.forceReflow;
    view.activationRepairFrame = requestAnimationFrame(() => {
      view.activationRepairFrame = requestAnimationFrame(() => {
        view.activationRepairFrame = 0;
        if (!this.terminalSurfaceAvailableForFit(view)) return;
        if (view.outputWriteInFlight && generation !== view.outputWriteGeneration) return;
        const repaired = this.repairTerminalRenderIfStale(view);
        if (repaired) return;
        if (forceReflow) {
          view.forceResizeAfterFit = true;
          this.scheduleV2Fit(view);
        }
      });
    });
  },


  queueTerminalWrite(view, data, afterWrite = null) {
    if (!view || view.closed) return;
    view.outputQueue.push({ data, afterWrite, generation: view.outputWriteGeneration });
    view.outputQueueBytes += Number(data?.byteLength ?? data?.length ?? 0);
    this.drainTerminalWrites(view);
  },


  detectTerminalAttentionFromBuffer(view) {
    if (!view || view.closed || !this.agentBehavior(this.session(view.sessionId)?.agent_kind)?.attentionScreenDetection || !view.term) return;
    if (view.attentionScreenDetectionSuppressed) return;
    const buffer = view.term.buffer.active;
    const firstRow = Math.max(0, Number(buffer.baseY || 0) - 2);
    const lastRow = Math.min(buffer.length, firstRow + view.term.rows + 4);
    const text = [];
    for (let row = firstRow; row < lastRow; row += 1) {
      const line = buffer.getLine(row);
      if (line) text.push(line.translateToString(true));
    }
    const normalized = text.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
    if (!TERMINAL_ATTENTION_TEXT_MARKERS.every((marker) => normalized.includes(marker))) return;
    const session = this.session(view.sessionId);
    if (!session || session.needs_attention) return;
    session.needs_attention = true;
    this.attentionServerStates.set(view.sessionId, true);
    if (this.processingStates.get(view.sessionId)) this.updateProcessingState(view.sessionId, false);
    this.triggerSessionAttention(view.sessionId);
  },


  // Tall-terminal-probe worktree only: xterm's own "follow" scroll mode is driven by baseY (how much has
  // scrolled into real backscroll), which stays 0 here since nothing ever scrolls off a 1000-row screen in
  // normal use. Cursor row is the equivalent signal in this model. Mirrors the standard terminal UX every
  // other terminal already has: auto-follow new output, but stop the moment the user scrolls away to read
  // something earlier, and resume once they scroll back near the bottom themselves.
  //
  // Deliberately NOT a "scroll" event listener tracking a persistent follow flag: xterm repositions its
  // hidden input textarea to track the cursor (for IME candidate-window placement), and while focused that
  // can itself trigger the browser's own "keep the focused element in view" auto-scroll -- confirmed live,
  // that fired a real "scroll" event with no code of mine involved, which corrupted a flag-based follow
  // state (traced: it silently flipped follow back on after the user had deliberately scrolled away, so
  // the very next line of output yanked them back down). Comparing scroll position against the cursor
  // FRESH, at both ends of each write, is immune to that: it only reacts to what changed within the write.
  // The cursor itself sits inside the input box, but Claude/Codex both draw a closing border plus a
  // status line (model/cost, "shift+tab to cycle", token counts, ...) below it -- real content the
  // cursor's own row doesn't account for, so following cursorY alone clips those rows out of view.
  // Bounded to a fixed 12-row lookahead below the cursor rather than a full-buffer scan: real trailing
  // decoration is always a handful of rows, never hundreds, so this stays O(12) per write regardless of
  // how tall the forced buffer is -- no scan of the other ~988 rows that can't matter here.
  //
  // buffer.getLine(y) takes an ABSOLUTE row index (0 = the very first row ever written, scrollback
  // included), but cursorY is relative to the current viewport top (viewportY, which tracks baseY here --
  // see the earlier scroll note above term.open()). They only coincide while baseY is still 0. Confirmed
  // live on a long-running session: at baseY=1584, getLine(cursorY) landed on unrelated leftover content
  // ("  526") while getLine(baseY+cursorY) landed on the real prompt row ("❯ ") -- every getLine() call
  // here has to add baseY back in, or this silently reads the wrong rows the moment a session outlives
  // one screenful of real scrollback. The returned row stays viewport-relative (i.e. still in cursorY's
  // frame), because that's what the pixel math both callers do needs.
  tallEffectiveBottomRow(view) {
    const buffer = view.term.buffer.active;
    const baseY = buffer.baseY || 0;
    const cursorY = buffer.cursorY;
    let last = cursorY;
    // Follows DENSE content below the cursor however far it extends -- a popup like Claude's slash menu
    // paints its whole option list there, well past any fixed window -- but stops at a run of blank rows.
    // The gap allowance is what still protects against a mid-repaint cursor: a blank-walk leaves nothing
    // dense below the cursor, so the scan ends immediately, while a menu has no blank runs at all. The
    // cost is bounded by the content itself: one gap's worth of rows past the last real line.
    const limit = buffer.length - 1 - baseY;
    let blankRun = 0;
    for (let row = cursorY + 1; row <= limit && blankRun <= 12; row += 1) {
      if (buffer.getLine(baseY + row)?.translateToString(true).trim()) {
        last = row;
        blankRun = 0;
      } else {
        blankRun += 1;
      }
    }
    return last;
  },


  // Where a following view belongs: the content bottom at the bottom edge -- unless that would push the
  // cursor's row off the top of the screen. Claude's slash menu is the case that needs the cap: on this
  // forced-height terminal it paints its full command list, well over a hundred rows below the composer,
  // and following the content bottom put the composer ~90 rows above the fold with nothing to bring it
  // back on an idle tab (the ceiling only shrinks on writes, and an open menu writes nothing). The
  // composer may ride up to the top of the screen, never past it; the menu rows that do not fit are cut
  // at the bottom and stay reachable by scrolling, because the CEILING is deliberately not capped.
  tallFollowCursorCap(view, cellHeight) {
    const buffer = view.term.buffer.active;
    const baseRows = Number(buffer.baseY || 0);
    return Math.max(0, (baseRows + Number(buffer.cursorY || 0) - TALL_FOLLOW_CURSOR_TOP_MARGIN_ROWS) *
      cellHeight);
  },


  tallFollowTarget(view, cellHeight) {
    // Same frame as the ceiling: absolute over the buffer when the scroll box spans it, rendered-window
    // relative otherwise -- see tallUpdateMaxScrollTop.
    const buffer = view.term.buffer.active;
    const baseRows = Number(buffer.baseY || 0);
    const bottomTarget = Math.max(0, (baseRows + this.tallEffectiveBottomRow(view) + 1) * cellHeight -
      view.container.clientHeight);
    return Math.min(bottomTarget, this.tallFollowCursorCap(view, cellHeight));
  },


  // `userSettled` marks a placement that ends a user gesture rather than reacting to output. The
  // difference matters only between the cursor cap and the ceiling -- a popup's overflow: a user who
  // scrolled down there chose that position and a settle must not drag them back up to the cap, while a
  // write means the TUI changed under an open popup (filtered, closed, printed) and snapping back to
  // the capped position is exactly the behavior that keeps the composer in view.
  scrollTallContainerToCursor(view, userSettled = false) {
    if (!view || view.closed || view.tallMaxScrollTop == null) return;
    // The newest line is the bottom of the box. The buffer viewport is derived from the scroll
    // position rather than forced to baseY: the box ends at the content bottom, so a screen shorter
    // than the viewport puts scrollback in the visible span above it, and a rendered window parked at
    // baseY would leave that span blank. Reaching the bottom also ends the parked state completely --
    // pin, anchor and marker -- for the same reason the other branch clears them: following and
    // parked are mutually exclusive, and a stale pin is what the release gate flags.
    view.tallPinnedViewportY = null;
    view.tallAnchorRow = null;
    this.tallReleaseAnchorMarker(view);
    const wholeCell = view.term._core?._renderService?.dimensions?.css?.cell?.height;
    // Capped so the cursor's row stays on screen -- see tallFollowTarget.
    const capPx = wholeCell ? Math.max(0, this.tallFollowCursorCap(view, wholeCell)) : Infinity;
    // A TUI that deletes earlier lines (Codex folding commands into "Ran 2", Claude rewriting its
    // output) moves the composer's row UP in one write. The damped ceiling holds its old value for a
    // while by design, so without this the view stood still, the composer floated up the screen, and
    // only the damper's late shrink snapped it back to the bottom -- a visible float-then-snap on
    // every fold. A cursor that moved up at least two rows since the last placement is that fold, not
    // the one-row flicker of a redrawing composer, so the shrink is applied at once: the ceiling is
    // fast-forwarded past its damper (which otherwise also makes the drive-down rule below shove the
    // glued view straight back to the stale value) and the view moves with the composer in the same
    // write. One-row moves stay with the damper on purpose.
    let glueFold = false;
    if (!userSettled && wholeCell) {
      const previousCursorPx = view.tallFollowCursorPx;
      glueFold = !view.replaying && !view.awaitingSnapshot &&
        previousCursorPx != null && capPx <= previousCursorPx - 2 * wholeCell &&
        !this.tallCursorRegionMostlyBlank(view);
      view.tallFollowCursorPx = capPx;
      if (glueFold) {
        // A write callback can land mid-redraw (the attach repaint walks the cursor high through the
        // frame it rebuilds), and that instant is indistinguishable from a real fold -- acting on it
        // put the view at the top or middle of the page on a tab switch, permanently when the redraw's
        // completion was the last write. Rather than trying to tell the two apart, any glue gets one
        // re-placement after the dust settles: a real fold re-confirms and nothing moves, a mid-redraw
        // misfire finds the regrown bottom and drives back down.
        clearTimeout(view.tallGlueRecheckTimer);
        view.tallGlueRecheckTimer = setTimeout(() => {
          view.tallGlueRecheckTimer = 0;
          if (view.closed || view.tallFollowing === false) return;
          this.tallUpdateMaxScrollTop(view);
          this.scrollTallContainerToCursor(view);
        }, TALL_GLUE_RECHECK_MS);
      }
      if (glueFold) {
        const baseRows = Number(view.term.buffer.active.baseY || 0);
        const undampedBottom = Math.max(0, (baseRows + this.tallEffectiveBottomRow(view) + 1) *
          wholeCell - view.container.clientHeight);
        if (undampedBottom < view.tallMaxScrollTop) {
          view.tallMaxScrollTop = undampedBottom;
          view.tallCeilingShrinkSince = null;
        }
      }
    }
    const wholeTarget = Math.min(view.tallMaxScrollTop, capPx);
    let wholeTop = view.container.scrollTop;
    const codexCollapseSettling = Date.now() < Number(view.codexCollapseSettleUntil || 0);
    if (glueFold && wholeTop > wholeTarget) {
      this.tallSetScrollTop(view, wholeTarget);
      wholeTop = view.container.scrollTop;
    }
    if (userSettled) {
      if (wholeTop < wholeTarget) this.tallSetScrollTop(view, wholeTarget);
      else if (wholeTop > view.tallMaxScrollTop + TALL_OVERSHOOT_DEADZONE_PX) {
        this.tallSetScrollTop(view, view.tallMaxScrollTop);
      }
    } else if (wholeTop < wholeTarget) {
      this.tallSetScrollTop(view, wholeTarget);
    } else if (wholeTop > capPx && !codexCollapseSettling) {
      // The cursor's row is above the visible top: this is the one case a write may pull the view UP
      // (a popup taller than the screen just opened under the composer). A cursor that is merely
      // higher than usual but still on screen is NOT one -- a TUI repaint walks the cursor through the
      // frame it is redrawing, and pty chunking can land a write callback mid-repaint, so chasing
      // every transient cursor position bounced the view up and down under ordinary typing.
      this.tallSetScrollTop(view, wholeTarget);
    } else if (wholeTop > capPx) {
      this.scheduleTallGeometrySettle(view, view.codexCollapseSettleUntil - Date.now());
    } else if (wholeTop > view.tallMaxScrollTop + (wholeCell || TALL_OVERSHOOT_DEADZONE_PX)) {
      // A WRITE-driven placement corrects past-the-ceiling rests beyond ONE row, not the gesture
      // deadzone: the deadzone exists so a user's small overshoot is not visibly snapped back, but
      // here nobody is touching the view (gestures are guarded out above) -- the ceiling shrank
      // underneath a following view, e.g. a response finished and its streaming UI folded while the
      // tab was elsewhere. Left alone, the view rested up to a deadzone past the content with blank
      // rows below it, looking parked mid-page while claiming to follow. The single row of grace is
      // for a composer that settles one row shorter after a redraw -- correcting that 21px is itself
      // the jutter jump_on_shrink pins down.
      this.tallSetScrollTop(view, view.tallMaxScrollTop);
    }
    view.tallFollowTop = Math.max(wholeTarget, Math.min(view.container.scrollTop, view.tallMaxScrollTop));
    // Re-baseline the follow-break guard even when no scroll was needed. That guard (see
    // drainTerminalWrites) parks a following view when scrollTop has drifted from where this code last
    // PUT it, and tallSetScrollTop is the only thing that records that place -- so every branch above
    // that decides "already correct, nothing to do" used to leave the baseline at whatever it was
    // before the user scrolled away. The very next write then measured the view against a position it
    // had legitimately left long ago, declared that something had moved it, and parked it silently.
    // Captured in a diagnostics recording: follow re-engaged at the bottom with no scroll write, and
    // by the next sample it was parked again with scrollTop untouched, the composer sinking from there.
    this.tallNoteFollowBaseline(view);
    this.tallSyncBufferToScroll(view);
  },


  // The place a following view was last deliberately left, for the follow-break guard to measure drift
  // against. Recorded on every placement, including the ones that move nothing: "the view is already
  // where it belongs" is exactly as much a placement as scrolling it there, and only recording the
  // latter let a stale baseline park a view that had not moved at all.
  tallNoteFollowBaseline(view) {
    if (!view || view.closed) return;
    view.tallLastProgrammaticTop = Math.round(view.container.scrollTop);
    view.tallProgrammaticAt = performance.now();
  },


  // Every piece of tall-scroll state is derived from buffer contents, so all of it is meaningless the
  // moment term.reset() throws that buffer away -- and none of it resets itself. tallMaxScrollTop is the
  // damaging one: a restarted session repaints maybe 30 rows, but the ceiling left over from the previous
  // (much longer) session still points hundreds of rows down, and since the follow logic drives straight
  // to that ceiling, the view opens parked in blank space far below the new content with the composer out
  // of sight. container.scrollTop needs clearing for the same reason -- a DOM scroll offset survives
  // term.reset() untouched -- and tallFollowing goes back to true because a rebuilt buffer has no "the
  // user scrolled away to read something" to preserve.
  tallResetScrollState(view) {
    if (!view) return;
    this.cancelTallGeometrySettle(view);
    view.tallMaxScrollTop = null;
    view.tallAnchorRow = null;
    view.tallPinnedViewportY = null;
    view.tallFollowTop = null;
    view.tallFollowing = true;
    view.tallUserBottomReturnCeiling = null;
    view.codexCollapseSettleUntil = 0;
    this.tallReleaseAnchorMarker(view);
    this.tallSetScrollTop(view, 0);
  },


  cancelTallGeometrySettle(view) {
    if (!view) return;
    clearTimeout(view.tallGeometrySettleTimer);
    view.tallGeometrySettleTimer = 0;
    view.tallGeometrySettleAt = 0;
  },


  scheduleTallGeometrySettle(view, delay) {
    if (!view || view.closed) return;
    const settleDelay = Math.max(0, Number(delay) || 0);
    const settleAt = Date.now() + settleDelay;
    if (view.tallGeometrySettleTimer && view.tallGeometrySettleAt <= settleAt) return;
    this.cancelTallGeometrySettle(view);
    view.tallGeometrySettleAt = settleAt;
    view.tallGeometrySettleTimer = setTimeout(() => {
      view.tallGeometrySettleTimer = 0;
      view.tallGeometrySettleAt = 0;
      if (view.closed || view.replaying || !view.container.classList.contains("visible")) return;
      const userScrolling = view.tallPointerHeld ||
        Date.now() < Math.max(view.tallWheelActiveUntil || 0, view.tallScrollActiveUntil || 0);
      if (userScrolling) {
        this.scheduleTallGeometrySettle(view, TALL_SCROLL_SETTLE_MS);
        return;
      }
      const following = view.tallFollowing !== false;
      this.tallUpdateMaxScrollTop(view, true);
      if (following && view.tallFollowing !== false) {
        this.scrollTallContainerToCursor(view);
        this.tallApplyGeometry(view);
      }
    }, settleDelay);
  },


  // Markers live in the terminal's buffer and are updated on every trim, so a stale one is both a leak
  // and a wrong answer. Released everywhere the anchor it belongs to is dropped.
  tallReleaseAnchorMarker(view) {
    if (!view || !view.tallAnchorMarker) return;
    try { view.tallAnchorMarker.dispose(); } catch { /* already gone with its buffer */ }
    view.tallAnchorMarker = null;
    view.tallAnchorGap = null;
  },


  // Every scroll this code performs goes through here so the "scroll" listener can tell our own moves
  // from the user's. Timing cannot do it: scroll events are delivered asynchronously, so any time window
  // either misses our own move or swallows a real one landing in the same frame. Remembering the exact
  // value we asked for is precise.
  tallSetScrollTop(view, value) {
    if (!view || view.closed) return;
    const target = Math.max(0, Math.round(value));
    view.tallLastProgrammaticTop = target;
    // Skip a write that changes nothing: it only adds scroll-event noise for the listener to sort out.
    if (Math.abs(view.container.scrollTop - target) > 1) {
      view.tallProgrammaticScrollPending = true;
      view.container.scrollTop = target;
    }
  },


  // The single place that decides "parked, or following the output?" -- for a scroll from ANY source.
  // This used to be wheel-only, which silently excluded the two ways of scrolling that emit no wheel
  // events: dragging the scrollbar thumb, and middle-click autoscroll. Neither ever cleared
  // tallFollowing, so every write snapped the view back to the prompt underneath the gesture (the
  // tearing), and neither ever restored xterm's pinned viewport on the way back down, which left the
  // newest lines unreachable with the container already sitting at its ceiling.
  tallApplySettledScroll(view) {
    if (!view || view.closed) return;
    // Two ways to count as at the bottom, and the second is not optional: at the ceiling as it stands, OR
    // still exactly where the last follow placed the view, with only the ceiling having moved since. A
    // working agent grows the ceiling every few frames, so a view nobody has touched falls "behind" it
    // through no action of the user's -- captured live on a tab switch into a streaming session at 172px
    // (8 rows) short, which parked the view and left it stuck behind the output until something else
    // happened to set following again (typing does, which is why typing appeared to fix it). The grace
    // applies only while the view still believes it is following: a real scroll-up clears that on the spot
    // in the wheel handler, and a scrollbar drag lands nowhere near the last follow position, so neither
    // can be mistaken for this.
    const ceiling = view.tallMaxScrollTop;
    const scrollTop = view.container.scrollTop;
    const returnedToReachedBottom = view.tallUserBottomReturnCeiling != null &&
      scrollTop >= view.tallUserBottomReturnCeiling - TALL_BOTTOM_TOLERANCE_PX;
    view.tallUserBottomReturnCeiling = null;
    // Deliberately NOT "near the content bottom counts as at it": a wider window here was tried for the
    // stale-ceiling-after-fold case and it swallowed slow wheel-ups -- the first few notches move less
    // than any near-window, so the settle re-followed and snapped the reader straight back to the
    // bottom. The fold glue in scrollTallContainerToCursor fast-forwards the stale ceiling at the
    // source now, so the tight tolerance can stay tight.
    const atBottom = ceiling == null ||
      scrollTop >= ceiling - TALL_BOTTOM_TOLERANCE_PX ||
      returnedToReachedBottom ||
      (view.tallFollowing !== false && view.tallFollowTop != null &&
        scrollTop >= view.tallFollowTop - TALL_BOTTOM_TOLERANCE_PX);
    view.tallFollowing = atBottom;
    // Reaching the bottom has to undo the parked state completely, xterm's viewport included: while
    // parked it sits deliberately short of baseY, and a stale pin there is precisely what made the last
    // lines unreachable. scrollTallContainerToCursor restores it and clears the pin.
    if (atBottom) {
      view.scrollMode = "follow";
      view.userScrollIntent = false;
      this.scrollTallContainerToCursor(view, true);
    } else {
      view.scrollMode = "preserve";
      view.userScrollIntent = true;
      this.tallCaptureAnchorRow(view);
    }
  },


  // What the user is reading is a LINE, not a pixel offset, and in this layout those are not the same
  // thing. Canvas row N renders buffer row viewportY + N, and xterm keeps viewportY pinned to baseY here
  // (its own viewport never moves, ours does), so every line that overflows the forced row count and
  // pushes into scrollback slides the entire canvas up underneath a fixed scrollTop. Measured while
  // parked mid-history with output streaming: scrollTop held at exactly 17212 the whole time while
  // viewportY went 401 -> 1603, so the line under the viewport drifted from "1222" to "3022" -- the view
  // never jumped, but 1200 lines scrolled past under it. Anchoring to an absolute buffer row and
  // recomputing scrollTop from it each write is what actually holds a line still.
  tallCaptureAnchorRow(view) {
    if (!view || view.closed) return;
    const cellHeight = view.term._core?._renderService?.dimensions?.css?.cell?.height;
    if (!cellHeight) { view.tallAnchorRow = null; view.tallPinnedViewportY = null; return; }
    const buffer = view.term.buffer.active;
    const viewportY = Number(buffer.viewportY || 0);
    // scrollTop is an absolute buffer offset in this layout -- adding viewportY on top double-counted
    // the scrollback the viewport shows and produced anchors past the end of the buffer (captured live:
    // anchor 11237 on a 5814-row buffer, a marker that no trim could ever move).
    const anchorRow = Math.max(0, Math.min(Number(buffer.length || 1) - 1,
      Math.round(view.container.scrollTop / cellHeight)));
    view.tallAnchorRow = anchorRow;
    view.tallPinnedViewportY = viewportY;
    // A row index only means something until the scrollback fills. From then on every new line trims one
    // off the start and renumbers the entire buffer, so an index quietly begins pointing at newer and
    // newer content -- reproduced with a reader parked three pages up, scrollTop never moving, and the
    // line under them travelling from "history 3793" all the way to "chunk 394". It never showed up with
    // line-at-a-time output because that takes far longer to reach the cap, which is exactly why it read
    // as "only when it prints big chunks". A marker is xterm's own handle on a LINE rather than an index:
    // it is carried along by trimming, and disposes itself if the line is finally dropped.
    this.tallReleaseAnchorMarker(view);
    const fromCursor = anchorRow - (Number(buffer.baseY || 0) + Number(buffer.cursorY || 0));
    view.tallAnchorMarker = view.term.registerMarker(fromCursor) || null;
    view.tallAnchorGap = anchorRow - viewportY;
  },


  // Holds the anchored line by keeping xterm's viewport where it was, rather than letting it slide and
  // then correcting scrollTop to compensate. Correcting after the fact was accurate -- the anchored line
  // sat on the same pixel row in 871 of 872 sampled frames -- but ruinously expensive: xterm only leaves
  // its viewport alone while it believes it is scrolled up, and here it never was (our container did the
  // scrolling, so viewportY stayed glued to baseY). Every line of new output therefore advanced viewportY,
  // which remaps every rendered row to a different buffer row and forces the DOM renderer to rebuild all
  // 1000 of them, plus a compensating scrollTop write. Measured over 9s of line-by-line output while
  // parked: 107 viewport shifts and 221 scrollTop writes -- the source of the visible jitter.
  //
  // Putting the viewport back once is all it takes, because that leaves viewportY < baseY, which is
  // exactly xterm's own "the user has scrolled up" state -- from then on xterm declines to auto-scroll
  // and holds the position itself, for free, and the new output lands on rows outside the rendered window
  // so there is nothing to repaint at all. The steady state costs one integer comparison per write.
  tallHoldAnchorRow(view) {
    if (!view || view.closed || view.tallPinnedViewportY == null) return;
    const marker = view.tallAnchorMarker;
    // Absolute coordinates make this hold a different job. The content under a fixed scrollTop only
    // changes when trimming renumbers the buffer, so the marker's movement is exactly the correction
    // scrollTop needs -- and with no trimming, nothing moves at all. What DOES go wrong without this
    // branch: xterm auto-scrolls its own viewport to the bottom on output, the geometry pass then
    // positions the rendered window there, and the window walks down the box write after write while
    // scrollTop stands still -- observed live as the content sliding down toward the prompt under a
    // parked reader. Re-deriving the viewport from the scroll position (the same mapping every user
    // scroll uses) puts the window back and renders the history rows the visible span actually needs.
    const cellHeight = view.term._core?._renderService?.dimensions?.css?.cell?.height;
    if (!cellHeight) return;
    if (marker && !marker.isDisposed && view.tallAnchorRow != null) {
      const drift = Number(marker.line || 0) - view.tallAnchorRow;
      if (drift !== 0) {
        view.tallAnchorRow = Number(marker.line || 0);
        this.tallSetScrollTop(view, Math.max(0, view.container.scrollTop + drift * cellHeight));
      }
    } else if (marker && marker.isDisposed) {
      // The anchored line was trimmed away; hold the index the reader is at instead.
      this.tallReleaseAnchorMarker(view);
      view.tallAnchorRow = Math.round(view.container.scrollTop / cellHeight);
    }
    this.tallSyncBufferToScroll(view);
  },


  // `inner` (see term.open() below) is always a full FORCE_ROWS tall in CSS regardless of how much of it
  // actually has content -- that's what lets xterm treat it as an ordinary, fully-fitting terminal (see
  // that comment). But it means the browser's own native max-scroll lets the user wheel/trackpad straight
  // past the real content into however many hundred rows of permanently blank space remain below the
  // prompt, with nothing to stop them -- unlike a normal terminal, where there's simply nothing past the
  // prompt to scroll into. tallMaxScrollTop tracks where the real content currently ends (reusing
  // tallCursorRegionMostlyBlank's gate, so it never latches onto a mid-padding position either -- see that
  // comment) and the "scroll" listener below enforces it as a hard ceiling, independent of whether the
  // view is currently following. Updating it even while not following matters: content keeps growing while
  // the user has scrolled away to read history, and the ceiling has to grow with it, or scrolling back down
  // later would stop short of the actual new bottom.
  tallUpdateMaxScrollTop(view, settling = false) {
    // A replay is not a stream of finished screens. Reattaching replays the saved buffer and the agent
    // repaints over it, so the cursor lands wherever each escape sequence leaves it -- and deriving the
    // content bottom from that cursor makes the bottom, and the view chasing it, lurch. Measured on a
    // real tab switch into a busy Codex session: the ceiling went 5386 -> 10804 -> 16831 -> 3769 -> 9901
    // -> 1669 -> 20212 within about 350ms, eight visible positions, two of them backwards. None of those
    // intermediate values described the screen the user was about to see; the replay's completion handler
    // settles it once from the finished screen, which is the only value that means anything.
    if (view.replaying) return;
    // Switching between the normal and alternate screens replaces the entire visible surface, so any
    // "the user scrolled away to read something" state from the old one is meaningless against the new
    // one -- without this reset, opening a pager after having scrolled up would inherit tallFollowing
    // false and strand the view. Note this deliberately does NOT special-case where to scroll on the
    // alternate screen: following the cursor turns out to be right there too, because a full-screen app
    // leaves its cursor where its content is. Measured live, `seq 1 500 | less` bottom-aligns -- it
    // paints lines 1-500 into rows 499-998 with "(END)" on row 999 and parks the cursor there, so rows
    // 0-498 are genuinely blank and following the cursor to the bottom is exactly right. (An earlier
    // pass here forced row 0 on entering the alternate screen, on the strength of a probe that read rows
    // 0-39 and saw blanks; the probe was reading a region the viewport was never showing.)
    const alternate = view.term.buffer.active.type === "alternate";
    if (alternate !== view.tallOnAlternateScreen) {
      view.tallOnAlternateScreen = alternate;
      view.tallFollowing = true;
    }
    // The blank-region guard skips a frame caught mid-redraw, but it must never be able to block this
    // permanently: an agent's own UI legitimately leaves blank rows above its composer, and how many
    // depends on the window height, so at some sizes every frame looks "mid-redraw". Measured at
    // 1728x1080: all 446 attempts were skipped, the ceiling was never established at all, and the view
    // sat at the very top with ~950 rows below the fold. So it may delay an update, never the first
    // value, and never more than a few in a row.
    if (!settling && this.tallCursorRegionMostlyBlank(view)) {
      view.tallBlankSkips = (view.tallBlankSkips || 0) + 1;
      if (view.tallMaxScrollTop != null && view.tallBlankSkips <= TALL_MAX_BLANK_SKIPS) {
        this.scheduleTallGeometrySettle(view, TALL_SCROLL_SETTLE_MS);
        return false;
      }
    }
    view.tallBlankSkips = 0;
    const cellHeight = view.term._core?._renderService?.dimensions?.css?.cell?.height;
    if (!cellHeight || !view.container.clientHeight) return;
    // tallEffectiveBottomRow, not raw cursorY: picks up the closing border + status line Claude/Codex
    // draw below the input box (see that function's comment), so the boundary lands past them instead of
    // clipping them out of view. In whole-buffer mode the scroll position is absolute over the buffer,
    // so the bottom counts the scrollback above the screen too; otherwise the container spans only the
    // rendered window and the bottom stays in its frame.
    const baseRows = Number(view.term.buffer.active.baseY || 0);
    const bottomPx = (baseRows + this.tallEffectiveBottomRow(view) + 1) * cellHeight;
    const next = Math.max(0, bottomPx - view.container.clientHeight);
    // Hard bound, enforced at once: no state of the CURRENT buffer can justify a ceiling past its last
    // line, so a stored value beyond that is stale by construction -- typically left over from a longer
    // buffer that a reconnect has since replaced. Waiting out the shrink hold for one of these pins the
    // view past the end of the content in the meantime (captured live: ceiling 31981 on a 799-row
    // buffer, the visible window ~400 rows past the newest line, output "pushing the content up" through
    // a blank screen).
    const boundRows = Number(view.term.buffer.active.length || 0);
    const hardMax = Math.max(0, boundRows * cellHeight - view.container.clientHeight);
    let current = view.tallMaxScrollTop;
    if (current != null && current > hardMax) {
      current = hardMax;
      view.tallMaxScrollTop = hardMax;
    }
    // Growing is applied at once; shrinking has to hold first, for the same reason the scrollable height
    // does (see tallApplyGeometry). While following, the view is driven to this value, so a bottom that
    // dips for a frame during an agent's repaint drags the view backwards -- the residual upward jump
    // still visible on a tab switch after the replay guard above. Real shrinkage still lands, just after
    // it has proved itself rather than on the first frame that suggests it. What has to prove itself is
    // the BOUND, not one exact value: a streaming session moves the content bottom on every write, so
    // requiring the same number twice in a row reset the hold forever and a stale-large ceiling never
    // came down at all.
    if (current == null || next >= current) {
      view.tallMaxScrollTop = next;
      view.tallCeilingShrinkSince = null;
      this.cancelTallGeometrySettle(view);
    } else {
      if (view.tallCeilingShrinkSince == null) view.tallCeilingShrinkSince = Date.now();
      const shrinkReadyAt = Math.max(view.tallCeilingShrinkSince + TALL_SHRINK_SETTLE_MS,
        Number(view.codexCollapseSettleUntil || 0));
      if (Date.now() >= shrinkReadyAt) {
        view.tallMaxScrollTop = next;
        view.tallCeilingShrinkSince = null;
        this.cancelTallGeometrySettle(view);
      } else {
        this.scheduleTallGeometrySettle(view, shrinkReadyAt - Date.now());
      }
    }
    this.tallApplyGeometry(view);
  },


  // A snapshot/session-attach redraw pushes "rows" blank rows past the cursor before clearing and
  // repainting -- invisible on a normal ~40-row terminal. Forced to 1000 rows, that same trick walks the
  // cursor through up to 1000 blank rows before the redraw actually lands, and dtach/websocket framing
  // splits it across many writes, so a write's callback can fire with the cursor sitting wherever this
  // particular chunk's blank run happened to end, well before the matching clear+redraw chunk arrives.
  // Confirmed live (instrumented scrollTallContainerToCursor across a real reconnect): a mid-sequence
  // write landed at cursorY=995, and naively following it scrolled the container there for over a
  // second before the next write (real content, cursorY=161) corrected it -- a real, visible "scrolled
  // past the bottom, prompt pushed far up" glitch.
  //
  // Two things this can't be detected from: the escape sequence isn't consistent (confirmed live: one
  // reconnect used bare "\r\n" pairs, another used repeated "\x1b[2K\x1b[1B" erase-line+cursor-down --
  // whatever a given TUI's redraw path happens to use to advance a blank row), and the buffer row at the
  // cursor isn't reliably blank either -- it can carry a stray glyph ghosted there from an earlier,
  // differently-sized frame that a later redraw never revisited (confirmed live: row 995 held a lone
  // "❯ " left over from a prior render). What's reliable is the shape of the neighborhood: real settled
  // content is dense (a live conversation has text on most nearby rows); a cursor mid-blank-run sits in a
  // stretch that's almost entirely empty except for whatever stale ghosts happen to be scattered through
  // it. Requiring most of a screenful above the cursor to be blank catches this regardless of which
  // escape sequence produced it, and a false trigger costs nothing -- it just skips one write's follow,
  // and the very next write (arriving momentarily) reliably has a trustworthy cursor to follow instead.
  tallCursorRegionMostlyBlank(view) {
    const buffer = view.term.buffer.active;
    const baseY = buffer.baseY || 0;
    const row = buffer.cursorY;
    const start = Math.max(0, row - 20);
    let blank = 0;
    let total = 0;
    for (let r = start; r <= row; r += 1) {
      total += 1;
      // getLine() is absolute, cursorY is viewport-relative -- see tallEffectiveBottomRow's comment.
      if (!buffer.getLine(baseY + r)?.translateToString(true).trim()) blank += 1;
    }
    return total > 0 && blank / total >= 0.7;
  },


  drainTerminalWrites(view, force = false) {
    if (!view || view.closed || view.outputWriteInFlight) return;
    if (view.inactiveOutputDrainTimer) {
      if (!force) return;
      clearTimeout(view.inactiveOutputDrainTimer);
      view.inactiveOutputDrainTimer = 0;
    }
    if (!view.outputQueue.length) return;
    const inactive = !view.container.classList.contains("visible");
    const deferInactive = this.deferInactiveTerminalOutputEnabled() && inactive && !force;
    if (deferInactive && view.outputQueueBytes < INACTIVE_TERMINAL_OUTPUT_MAX_BYTES) {
      view.inactiveOutputDeferred = true;
      return;
    }
    const boundedCatchUp = this.deferInactiveTerminalOutputEnabled() && view.inactiveOutputDeferred && !force;
    // One write per batch, not per websocket frame. A streaming agent delivers ~50 frames/sec, and each
    // write schedules its own xterm refresh plus the follow-up chain below, so writing frame-by-frame paid
    // that cost ~50x/sec. Only consecutive same-generation items are merged: a reconnect bumps the
    // generation and its output must not be fused with the previous connection's.
    const generation = view.outputQueue[0].generation;
    const batch = [];
    let total = 0;
    while (view.outputQueue.length && view.outputQueue[0].generation === generation &&
           (!boundedCatchUp || total < INACTIVE_TERMINAL_OUTPUT_BATCH_BYTES)) {
      const item = view.outputQueue.shift();
      batch.push(item);
      const itemBytes = Number(item.data?.byteLength ?? item.data?.length ?? 0);
      view.outputQueueBytes = Math.max(0, view.outputQueueBytes - itemBytes);
      total += itemBytes;
    }
    view.outputWriteInFlight = true;
    // view.tallFollowing (default true; only ever changed by the "wheel" listener in ensureView) is the
    // sole source of truth for whether to follow -- NOT a fresh per-write scrollTop comparison, which was
    // tried first and had a real feedback-loop bug: the browser's own scroll-into-view drift (see that
    // listener's comment) could make one write's check read a contaminated position, which then locked
    // "following" on for every write after it.
    const following = view.tallFollowing !== false;
    for (const item of batch) {
      this.noteTerminalViewportRestoreOutput(view, item.data);
    }
    let payload;
    if (batch.length === 1) {
      payload = batch[0].data;
    } else {
      payload = new Uint8Array(total);
      let offset = 0;
      for (const item of batch) { payload.set(item.data, offset); offset += item.data.length; }
    }
    const codexCommandCollapse = !!this.agentBehavior(this.session(view.sessionId)?.agent_kind)?.commandCollapse &&
      !view.replaying && !view.awaitingSnapshot && this.terminalPayloadContainsBytes(payload, CODEX_COMMAND_COLLAPSE_BYTES);
    const codexCommandCollapseAnchor = codexCommandCollapse ? this.captureCodexCommandCollapseAnchor(view, following) : null;
    if (codexCommandCollapse) {
      view.codexCollapseSettleUntil = Date.now() + CODEX_COLLAPSE_SHRINK_SETTLE_MS;
    }
    view.term.write(payload, () => {
      // Always release the writer. A reconnect invalidates the old callback's
      // UI work but must not strand the new connection's queued output.
      view.outputWriteInFlight = false;
      const live = !view.closed && generation === view.outputWriteGeneration;
      if (live) {
        for (const item of batch) {
          if (item.afterWrite) item.afterWrite();
        }
      }
      if (live) {
        this.restoreCodexCommandCollapseAnchor(view, codexCommandCollapseAnchor);
        // Kept up to date regardless of following (see tallUpdateMaxScrollTop's comment) -- it no-ops on
        // a mid-padding write (see tallCursorRegionMostlyBlank's comment), which also means
        // scrollTallContainerToCursor below correctly leaves scrollTop alone for that one cycle instead
        // of following a bogus position: the very next write (the real redraw) fires this callback again
        // with a trustworthy cursor.
        this.tallUpdateMaxScrollTop(view);
        this.updateTerminalHistoryMoreButton(view);
        // Any gesture in flight -- wheel, scrollbar drag, autoscroll -- owns the view until it settles.
        const userScrolling = view.tallPointerHeld ||
          Date.now() < Math.max(view.tallWheelActiveUntil || 0, view.tallScrollActiveUntil || 0);
        if (!view.container.clientHeight) {
          // A backgrounded tab is display:none, and a hidden element reports scrollTop 0 no matter where
          // it was left. Every check below reads that position, so running them while hidden compares a
          // real remembered offset against a fake zero: the follow-break test measured 20212px of
          // "movement" nobody made, cleared following, and anchored the view mid-history. The damage was
          // invisible until the tab was next looked at and the agent printed something -- which is the
          // "switch away, come back, and it sits in the middle" report. Nothing here is decidable while
          // the pane has no height, so nothing is decided; the state is left exactly as the tab was.
        } else if (userScrolling) {
          // Deliberately nothing: the settle handler decides where this lands.
        } else if (following && view.tallLastProgrammaticTop != null &&
                   Math.abs(view.container.scrollTop - view.tallLastProgrammaticTop) > TALL_FOLLOW_BREAK_PX) {
          // Following, but the view is no longer where this code last put it: something moved it and the
          // scroll event saying so has not been delivered yet. Scroll events are asynchronous, so a
          // gesture's first frames land before any suppression is in place -- measured as a 3-frame burst
          // that yanked the view from the top back to the bottom the instant a drag began.
          //
          // Compared against our own last position, NOT against the ceiling: the ceiling moves down as
          // output arrives, so on a fresh terminal (container at 0, ceiling jumping to thousands) a
          // ceiling comparison reads ordinary growth as "the user scrolled away" and parks the terminal
          // at the top, never following again. Measured exactly that way. The distance from where we put
          // it only changes when something else moves it.
          view.tallFollowing = false;
          this.tallCaptureAnchorRow(view);
        } else if (following) {
          this.scrollTallContainerToCursor(view);
        } else {
          // Holds the anchored LINE still (see tallHoldAnchorRow), which also absorbs the browser's own
          // scroll-into-view drift -- the user should never see the view move while they have deliberately
          // scrolled away to read something. The anchor it defends is captured by the settle handler once
          // the gesture ends, which is why the branch above yields while one is still running.
          this.tallHoldAnchorRow(view);
        }
      }
      if (live) this.detectTerminalAttentionFromBuffer(view);
      if (live && view.needsViewportRepair && !view.outputQueue.length &&
          view.container.classList.contains("visible")) {
        view.needsViewportRepair = false;
        this.repairTerminalViewport(view);
      }
      if (live) this.scheduleHistoryTerminalModelRefresh(view);
      if (live) this.scheduleClaudeStatusRowRefresh(view);
      if (live) this.scheduleTerminalTailRepair(view);
      if (live) this.scheduleTerminalViewportRestore(view);
      if (live && view.initialCodexRepaintPending) {
        view.initialCodexRepaintOutputSeen = true;
        this.scheduleInitialCodexRepaintCompletion(view);
      }
      if (view.closed) return;
      if (!view.outputQueue.length) {
        view.inactiveOutputDeferred = false;
        if (view.connectAfterOutputDrain && !view.ws) {
          view.connectAfterOutputDrain = false;
          this.connect(view.sessionId, view);
          return;
        }
      }
      if (boundedCatchUp && view.outputQueue.length) {
        view.inactiveOutputDrainTimer = setTimeout(() => {
          view.inactiveOutputDrainTimer = 0;
          this.drainTerminalWrites(view);
        }, 0);
      } else {
        this.drainTerminalWrites(view, force);
      }
    });
  },


  scheduleClaudeStatusRowRefresh(view) {
    if (!view || view.closed || view.claudeStatusRowRefreshTimer || !this.agentBehavior(this.session(view.sessionId)?.agent_kind)?.statusRowRefresh ||
        !view.container.classList.contains("visible") || view.scrollMode !== "follow" || !this.xtermAtBottom(view)) return;
    const elapsed = Date.now() - view.lastClaudeStatusRowRefreshAt;
    const delay = Math.max(0, CLAUDE_STATUS_ROW_REFRESH_INTERVAL_MS - elapsed);
    view.claudeStatusRowRefreshTimer = setTimeout(() => {
      view.claudeStatusRowRefreshTimer = 0;
      if (view.closed || !this.agentBehavior(this.session(view.sessionId)?.agent_kind)?.statusRowRefresh ||
          !view.container.classList.contains("visible") || view.scrollMode !== "follow" || !this.xtermAtBottom(view)) return;
      view.lastClaudeStatusRowRefreshAt = Date.now();
      const lastRow = Math.max(0, view.term.rows - 1);
      view.term.refresh(Math.max(0, lastRow - 2), lastRow);
    }, delay);
  },


  scheduleHistoryTerminalModelRefresh(view) {
    if (!view || view.closed || view.historyModelRefreshTimer || !this.historyOpen ||
        view.sessionId !== this.activeId || this.activeFileKey !== null) return;
    view.historyModelRefreshTimer = setTimeout(() => {
      view.historyModelRefreshTimer = 0;
      if (view.closed || !this.historyOpen || view.sessionId !== this.activeId || this.activeFileKey !== null) return;
      this.renderHistoryModel(this.session(view.sessionId), this.historyTurnsBySession.get(view.sessionId) || this.historyTurns);
    }, 180);
  },


  repairTerminalViewport(view) {
    // Do this only after an initial replay has drained and only while output
    // following is active. The older generic viewport scroll listener caused
    // this same repair to race a user's first wheel gesture after tab switch.
    if (!view || view.closed || view.manualScroll || !view.keepBottom || view.viewportRepairFrame ||
        !view.container.classList.contains("visible")) return;
    const generation = view.manualScrollGeneration;
    view.viewportRepairFrame = requestAnimationFrame(() => {
      view.viewportRepairFrame = requestAnimationFrame(() => {
        view.viewportRepairFrame = 0;
        if (view.closed || view.manualScroll || generation !== view.manualScrollGeneration ||
            !view.keepBottom || !view.container.classList.contains("visible") || !this.terminalAtBottom(view)) return;
        this.tallFit(view);
        this.refreshTerminal(view);
        const { cols, rows } = view.term;
        if (cols >= 2 && rows >= 2) this.sendResize(view, cols, rows);
        this.scrollTerminalToBottom(view);
      });
    });
  },


  refreshTerminalAppearance(view, forceResize = false) {
    if (!view || !view.term) return;
    view.term.options.theme = this.terminalDisplayTheme(view);
    if (typeof view.term.clearTextureAtlas === "function") view.term.clearTextureAtlas();
    const renderService = view.term._core?._renderService;
    const allowForcedRendererReset = forceResize;
    if (allowForcedRendererReset && renderService) {
      if (typeof renderService.clear === "function") renderService.clear();
      if (typeof renderService.handleResize === "function") renderService.handleResize(view.term.cols, view.term.rows);
      else if (view.term._core?.resize) view.term._core.resize(view.term.cols, view.term.rows);
    }
    this.refreshTerminal(view);
  },


  scheduleViewportSettle(view) {
    if (this.isTerminalScrollV2()) {
      if (view?.scrollMode === "follow") this.scrollTerminalV2ToBottom(view);
      return;
    }
    if (view.settleFrame) cancelAnimationFrame(view.settleFrame);
    view.settleFrame = requestAnimationFrame(() => {
      view.settleFrame = requestAnimationFrame(() => {
        view.settleFrame = 0;
        if (!view.manualScroll && (view.keepBottom || Date.now() < view.pinBottomUntil)) {
          view.keepBottom = true;
          this.scrollTerminalToBottom(view);
          const atBottom = this.terminalAtBottom(view);
          if (!atBottom || Date.now() < view.pinBottomUntil) {
            clearTimeout(view.scrollSettleTimer);
            view.scrollSettleTimer = setTimeout(() => {
              if (!view.manualScroll && (view.keepBottom || Date.now() < view.pinBottomUntil)) {
                this.scheduleViewportSettle(view);
              }
            }, 250);
          }
        }
      });
    });
  },


  fitActive() {
    if (this.nativeVscodeMode) return;
    const view = this.views.get(this.activeId);
    if (!this.terminalSurfaceAvailableForFit(view)) return;
    if (this.isTerminalScrollV2()) {
      this.scheduleV2Fit(view);
      this.scheduleV2ViewportSync(view);
      return;
    }
    const rect = view.container.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    this.tallFit(view);
    view.container.classList.remove("initializing");
    this.refreshTerminal(view);
    const { cols, rows } = view.term;
    if (cols < 2 || rows < 2) return;
    this.sendResize(view, cols, rows);
    if (view.keepBottom || Date.now() < view.pinBottomUntil) this.scheduleViewportSettle(view);
  },


  destroyView(id, view) {
    view.closed = true;
    view.renderObserver?.dispose();
    this.clearActiveTerminalSettleWatchdog(view);
    clearTimeout(view.manualScrollReleaseTimer);
    clearTimeout(view.scrollSettleTimer);
    clearTimeout(view.resizeRepairTimer);
    clearTimeout(view.tailRepairTimer);
    clearTimeout(view.tailRepairConfirmTimer);
    clearTimeout(view.claudeInitialReplayCheckTimer);
    clearTimeout(view.initialCodexRepaintTimer);
    clearTimeout(view.initialCodexRepaintWatchdogTimer);
    clearTimeout(view.claudeStatusRowRefreshTimer);
    clearTimeout(view.historyModelRefreshTimer);
    clearTimeout(view.promptSubmissionReflowGuardTimer);
    clearTimeout(view.promptDraftSyncTimer);
    clearTimeout(view.promptDraftSyncDebounceTimer);
    view.disposeMobileTextareaStabilizer?.();
    clearTimeout(view.pendingAgentPasteTimer);
    clearTimeout(view.inactiveOutputDrainTimer);
    clearTimeout(view.claudeWebglColdPrimeTimer);
    this.cancelTallGeometrySettle(view);
    this.cancelTerminalViewportRestore(view);
    if (view.settleFrame) cancelAnimationFrame(view.settleFrame);
    if (view.viewportRepairFrame) cancelAnimationFrame(view.viewportRepairFrame);
    if (view.v2ViewportSyncFrame) cancelAnimationFrame(view.v2ViewportSyncFrame);
    if (view.v2FitFrame) cancelAnimationFrame(view.v2FitFrame);
    if (view.v2InitialFitFrame) cancelAnimationFrame(view.v2InitialFitFrame);
    if (view.activationRepairFrame) cancelAnimationFrame(view.activationRepairFrame);
    if (view.codexFocusRefreshFrame) cancelAnimationFrame(view.codexFocusRefreshFrame);
    clearTimeout(view.layoutFitRetryTimer);
    if (view.layoutObserver) view.layoutObserver.disconnect();
    if (view.scrollObserver) view.scrollObserver.disconnect();
    if (view.visibilityObserver) view.visibilityObserver.disconnect();
    if (view.ws) view.ws.close();
    view.terminalFindResultListener?.dispose();
    view.term.dispose();
    view.container.remove();
    this.views.delete(id);
  },


  async loadAgentSpecs() {
    try {
      const response = await fetch("/api/agents");
      if (response.ok) this.agentSpecs = await response.json();
    } catch { /* transient fetch failure at boot; AGENT_SPEC_DEFAULTS stays in effect */ }
  },


  agentSpec(kind) {
    return this.agentSpecs[kind || "none"] || null;
  },


  agentBehavior(kind) {
    return AGENT_CLIENT_BEHAVIORS[kind] || null;
  },


  agentLabel(kind, fallback = "agent") {
    return this.agentSpec(kind)?.label || fallback;
  },


  agentPermissions(kind, fallbackKind = "none") {
    return this.agentSpec(kind)?.permissions || this.agentSpec(fallbackKind)?.permissions
      || [{ value: "default", label: "Default" }];
  },


  maybeRequestNotificationPermission() {
    if (typeof Notification === "undefined" || Notification.permission !== "default") return;
    void Notification.requestPermission();
  },

  notifyAgentEvent(session, body) {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    // The one you are looking at needs no banner.
    if (document.hasFocus() && session.session_id === this.activeId) return;
    const title = this.titlePresentation(session).text || session.title || "terminal";
    try {
      const notification = new Notification(`${title} ${body}`, {
        tag: `termdeck-${session.session_id}`,
        body: `TermDeck${this.projectSlug ? ` · ${this.projectSlug}` : ""}`,
      });
      notification.onclick = () => {
        window.focus();
        this.activate(session.session_id);
        notification.close();
      };
    } catch { /* notification construction can throw in odd embedding contexts */ }
  },

  formatTokenCount(value) {
    if (!Number.isFinite(value) || value <= 0) return "";
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 10_000) return `${Math.round(value / 1000)}k`;
    if (value >= 1_000) return `${(value / 1000).toFixed(1)}k`;
    return String(value);
  },


  // The live context size (and window, where the CLI reports one) for the active session,
  // shown in the status bar. Refreshed on activation and whenever a turn finishes.
  async refreshSessionUsage(id = this.activeId) {
    const element = this.$("status-usage");
    if (!element) return;
    const session = this.session(id);
    if (!session?.agent_session_id || !this.agentSpec(session.agent_kind)?.is_agent) {
      element.classList.add("hidden");
      return;
    }
    element.classList.add("hidden");
    let usage = {};
    try {
      const response = await fetch(`/api/sessions/${id}/usage`);
      if (response.ok) usage = await response.json();
    } catch { /* transient; nothing to show */ }
    if (id !== this.activeId) return;
    const context = this.formatTokenCount(Number(usage.context_tokens));
    if (!context) { element.classList.add("hidden"); return; }
    const window_ = this.formatTokenCount(Number(usage.context_window));
    element.textContent = window_ ? `ctx ${context}/${window_}` : `ctx ${context}`;
    const output = this.formatTokenCount(Number(usage.output_tokens));
    const total = this.formatTokenCount(Number(usage.total_tokens));
    element.title = [`context ${context} tokens`, output && `last turn output ${output}`,
      total && `session total ${total}`].filter(Boolean).join(" · ");
    element.classList.remove("hidden");
  },


  async loadSettings() {
    try {
      const res = await fetch("/api/settings");
      const incoming = await res.json();
      const legacyTerminalIconsEnabled = incoming.show_terminal_icons === true;
      const storedTerminalIconAgents = incoming.terminal_icon_agents && typeof incoming.terminal_icon_agents === "object"
        ? incoming.terminal_icon_agents : {};
      incoming.terminal_icon_agents = Object.fromEntries(Object.keys(this.agentSpecs).map((kind) => [kind,
        Object.prototype.hasOwnProperty.call(storedTerminalIconAgents, kind)
          ? !!storedTerminalIconAgents[kind] : legacyTerminalIconsEnabled]));
      if (incoming.code_font_size == null) incoming.code_font_size = incoming.viewer_font_size || SETTINGS_DEFAULTS.code_font_size;
      if (incoming.side_split != null && incoming.side_split !== SETTINGS_DEFAULTS.side_split) {
        incoming.side_split_user_set = true;
      }
      if (incoming.sidebar_text_color == null) {
        const legacyColor = incoming.sidebar_status_color || incoming.wave_color;
        if (/^#[0-9a-f]{6}$/i.test(String(legacyColor || ""))) incoming.sidebar_text_color = legacyColor;
      }
      const legacyGlobTokens = String(incoming.search_glob || "").split(",").map((token) => token.trim()).filter(Boolean);
      const legacyIncludeGlob = legacyGlobTokens.filter((token) => !token.startsWith("!")).join(", ");
      const legacyExcludeGlob = legacyGlobTokens.filter((token) => token.startsWith("!")).join(", ");
      const migratedFileGlobSettings = incoming.tree_file_glob === SETTINGS_DEFAULTS.tree_file_glob &&
        incoming.search_file_glob === SETTINGS_DEFAULTS.search_file_glob && legacyIncludeGlob;
      const migratedExcludeGlob = incoming.excluded_file_glob === SETTINGS_DEFAULTS.excluded_file_glob &&
        incoming.search_glob !== SETTINGS_DEFAULTS.search_glob && legacyExcludeGlob;
      if (migratedFileGlobSettings) {
        incoming.tree_file_glob = legacyIncludeGlob;
        incoming.search_file_glob = legacyIncludeGlob;
      }
      if (migratedExcludeGlob) incoming.excluded_file_glob = legacyExcludeGlob;
      const migratedVirtualWebgl = incoming.virtual_tall_webgl === true && incoming.tall_webgl == null;
      if (migratedVirtualWebgl) incoming.tall_webgl = true;
      delete incoming.virtual_tall_webgl;
      delete incoming.claude_raw_replay_experimental;
      delete incoming.claude_full_raw_replay_experimental;
      // The panel used to float over the workspace, and its stored width was a floating-overlay
      // width with a 2x-sidebar minimum. It is now the sidebar's own width, so that value is
      // discarded and re-derived from the sidebar; the server drops the keys on its next write.
      delete incoming.files_pinned;
      delete incoming.files_width;
      delete incoming.files_panel_width_initialized;
      this.settings = { ...SETTINGS_DEFAULTS, ...incoming };
      this.initializeBrowserRendererSettings();
      this.persistedSettings = this.copySettings(this.settings);
      this.lastFilesSidePanelTab = FILES_SIDE_PANEL_TABS.includes(this.settings.files_side_panel_last_tab)
        ? this.settings.files_side_panel_last_tab : "project";
      if (!this.settings.md_prompt_queues || typeof this.settings.md_prompt_queues !== "object") this.settings.md_prompt_queues = {};
      if (!this.settings.md_prompt_drafts || typeof this.settings.md_prompt_drafts !== "object") this.settings.md_prompt_drafts = {};
      if (!THEME_BY_ID[this.settings.theme]) this.settings.theme = SETTINGS_DEFAULTS.theme;
      this.settings.show_git_status = true;
      const excludedTokens = this.fileTypeFilterTokens();
      if (this.settings.hide_dot_folders !== false && !excludedTokens.includes("!.*")) excludedTokens.unshift("!.*");
      if (!excludedTokens.includes("!*.log")) excludedTokens.push("!*.log");
      const normalizedExcludedGlob = [...new Set(excludedTokens)].join(", ");
      const excludedGlobChanged = this.settings.excluded_file_glob !== normalizedExcludedGlob;
      this.settings.excluded_file_glob = normalizedExcludedGlob;
      this.settings.hide_dot_folders = excludedTokens.includes("!.*");
      this.syncLegacySearchGlob();
      if (migratedFileGlobSettings || migratedExcludeGlob || migratedVirtualWebgl || excludedGlobChanged) this.saveSettings();
    } catch (err) {
      this.settings = { ...SETTINGS_DEFAULTS };
      this.initializeBrowserRendererSettings();
      this.persistedSettings = this.copySettings(this.settings);
    }
    if (!/^#[0-9a-f]{6}$/i.test(String(this.settings.sidebar_text_color || ""))) {
      this.settings.sidebar_text_color = SETTINGS_DEFAULTS.sidebar_text_color;
    }
    this.settings.show_terminal_age = true;
    if (!THEME_BY_ID[this.settings.theme]) this.settings.theme = SETTINGS_DEFAULTS.theme;
    if (this.normalizeNotebookNotes()) this.saveSettings();
    // V2 is now the only desktop terminal scroll controller. Remove the old
    // browser-only opt-in so a previous preference cannot revive V1.
    localStorage.removeItem("termdeck.terminal_scroll_v2");
    const states = this.settings.project_state || {};
    if (!Object.keys(states).length && (this.settings.active_session_id || (this.settings.open_files || []).length)) {
      states.__all__ = { active_session_id: this.settings.active_session_id, open_files: this.settings.open_files };
      this.settings.project_state = states;
    }
    this.unreadSessions = this.unreadSessionIdsForCurrentWorktreeView();
    this.applySettings();
  },


  restoreOpenFiles() {
    const states = this.settings.project_state || {};
    const lists = Object.values(states).map((state) => state.open_files || []);
    const scopedSavedFiles = this.projectSlug ? this.getProjectState().open_files || [] : [];
    const scopedSavedKeys = new Set(scopedSavedFiles.map((file) => `${file.root}|${file.path}`));
    const files = lists.flat().filter((file) => file && file.root && file.path &&
      (!this.projectSlug || this.owningProjectKey(file.root) === this.projectStateKey())).slice(-OPEN_FILES_MAX_ENTRIES);
    let recoveredMisownedFile = false;
    for (const f of files) {
      const key = `${f.root}|${f.path}`;
      this.openFiles.set(key,
        { root: f.root, path: f.path, name: f.path.split("/").pop(), model: null, fullPath: null, truncated: false,
          mtime: Number(f.mtime) || 0, git_status: String(f.git_status || "") });
      if (this.projectSlug && !scopedSavedKeys.has(key)) recoveredMisownedFile = true;
    }
    if (recoveredMisownedFile) this.persistOpenFiles();
    void this.refreshOpenFileGitStatuses();
  },


  closeOpenFileEntry(key, entry, recordRecent = true) {
    clearTimeout(entry.autosaveTimer);
    entry.autosaveTimer = 0;
    if (entry.model) {
      if (this.lspClient?.model === entry.model) this.lspClient.deactivate();
      entry.model.dispose();
      entry.model = null;
    }
    if (recordRecent) {
      const recent = Array.isArray(this.settings.recent_closed_files) ? this.settings.recent_closed_files : [];
      this.settings.recent_closed_files = [{ root: entry.root, path: entry.path },
        ...recent.filter((item) => item.root !== entry.root || item.path !== entry.path)].slice(0, 30);
    }
    this.openFiles.delete(key);
    this.sidebarSelectedFileKeys.delete(key);
    if (this.sidebarFileSelectionAnchorKey === key) this.sidebarFileSelectionAnchorKey = null;
    if (this.secondaryFileKey === key) this.secondaryFileKey = null;
  },


  enforceOpenFilesLimit() {
    let changed = false;
    for (const [key, entry] of this.openFiles) {
      if (this.openFiles.size <= OPEN_FILES_MAX_ENTRIES) break;
      if (key === this.activeFileKey || key === this.fileHistoryTabKey || entry.dirty || entry.savePromise) continue;
      this.closeOpenFileEntry(key, entry, false);
      changed = true;
    }
    return changed;
  },


  owningProjectKey(root) {
    const normalized = String(root || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const worktree = this.worktrees.find((candidate) => String(candidate.path || "").replace(/\\/g, "/").replace(/\/+$/, "") === normalized);
    if (worktree) return worktree.id === "root" ? worktree.project : `${worktree.project}::worktree:${worktree.id}`;
    return this.projectForCwd(root)?.name || "__all__";
  },


  themeDefinition() {
    return THEME_BY_ID[this.settings.theme] || THEME_BY_ID.dark;
  },


  themeLabel() {
    return this.themeDefinition().label;
  },


  isLight() {
    return this.themeDefinition().kind === "light";
  },


  monacoThemeName() {
    return "termdeck-theme";
  },


  termTheme() {
    return this.themeDefinition().terminal;
  },


  applyThemeVariables() {
    const theme = this.themeDefinition();
    for (const [name, value] of Object.entries(theme.css)) document.documentElement.style.setProperty(name, value);
    document.documentElement.dataset.theme = theme.id;
    document.body.classList.toggle("theme-light", theme.kind === "light");
    document.body.classList.toggle("theme-dark", theme.kind !== "light");
  },


  defineMonacoTheme(theme = this.themeDefinition()) {
    monaco.editor.defineTheme(this.monacoThemeName(), {
      base: theme.monacoBase, inherit: true, rules: [], colors: theme.monacoColors,
    });
    if (this.editor) monaco.editor.setTheme(this.monacoThemeName());
  },
});
