// Status/title/processing changes arrive through /ws/status. This slower
// fallback only reconciles session-list metadata such as created/closed tabs.
// In-app dialogs (dialogs.js) stand in for window.confirm / alert / prompt: the native ones block the
// event loop, cannot be styled or positioned, and can be permanently suppressed by the browser's
// "prevent this page from creating more dialogs" checkbox. confirm/prompt must be awaited; alert may be
// dropped where the caller does not depend on dismissal.
const uiConfirm = (...args) => window.TermdeckDialogs.confirm(...args);
const uiAlert = (...args) => window.TermdeckDialogs.alert(...args);
const uiPrompt = (...args) => window.TermdeckDialogs.prompt(...args);
const SESSION_LIST_REFRESH_MS = 30000;
const TITLE_STATUS_RE = /^[\u2800-\u28ff○-◗⏳⚡✳](\s+)/;
// Same status glyphs as TITLE_STATUS_RE, plus the leading ellipsis codex shows while working. Used only
// when GENERATING a new fork's name, never for display: a fork is seeded from the parent's live title,
// so one surviving glyph per generation compounds into names like "✳ ✳ ◐ ✳ ✳ name fork 1 1 1". Display
// keeps using TITLE_STATUS_RE so a rendered name still matches the title the session is stored under.
const TITLE_STATUS_PREFIX_RE = /^(?:[⠀-⣿○-◗⏳⚡✳]|\.\.\.|…)\s*/;
const RECONNECT_MS = 1500;
// A restarted server answers the moment its port opens, and a page reloaded into that instant can come
// back without its terminals. Let the new instance settle before reloading onto it.
const TERMINAL_ATTACH_ACTIVITY_SUPPRESSION_MS = 1800;
// How far from the top the view must travel before the "More history in Markdown" button hides again.
// Well clear of one row: the button is re-evaluated on every write, and a row-sized nudge from the
// parked-reader anchor must never be able to toggle it.
const TERMINAL_HISTORY_MORE_HIDE_PX = 140;
// Screens of scrollback a terminal must hold before it offers the Markdown transcript. A fresh session
// has none of this; a session worth reading elsewhere has plenty.
const TERMINAL_HISTORY_MORE_MIN_PAGES = 5;
// How far back "recently used" reaches for the sidebar's active-terminals filter, when the user has not
// chosen otherwise. A day covers "what I was working on", including yesterday evening.
const RECENT_TERMINAL_HOURS_DEFAULT = 24;
const RECENT_TERMINAL_HOUR_CHOICES = [2, 6, 12, 24, 48, 168];
// Long enough not to fire on an ordinary click, short enough to feel deliberate rather than stuck.
const RECENT_TERMINAL_LONG_PRESS_MS = 450;
const INACTIVE_TERMINAL_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
const INACTIVE_TERMINAL_OUTPUT_BATCH_BYTES = 256 * 1024;
const DEFAULT_COMMAND = "codex";
const DEFAULT_CWD = "~";
const SETTINGS_DEFAULTS = { sidebar_width: 250, files_panel_width: 0, sidebar_font_size: 18, project_font_size: 18, terminal_font_size: 18,
  ui_font_size: 11, system_font_size: 13, code_font_size: 12, diff_font_size: 13, tree_font_size: 12, bottom_font_size: 14, files_tab_font_size: 11, active_session_id: "", open_files: [], project_state: {}, theme: "dark",
  ignored_dirs: [], hide_excluded: true, hide_dot_folders: true, file_tree_sort: "name", side_split: 0.55, side_full: false, side_split_user_set: false, show_stats: true,
  show_mtime: true, show_git_status: true, word_wrap: false, search_glob: "!*.json, !*.csv, !*.log", tree_file_glob: "", search_file_glob: "", excluded_file_glob: "!.*, !*.json, !*.csv, !*.log", keybindings: {},
  last_command: "codex", last_model: "codex", last_permissions: { codex: "default", claude: "default", agy: "default", none: "default" },
  recent_terminal_hours: 24,
  show_terminal_icons: false, terminal_icon_agents: {}, terminal_icon_size: 14, history_mode: false, transcript_first_surface: "terminal", tall_webgl: true, inline_size_controls: false, notebook_open: false, notebook_left: -1, notebook_text: "", prompt_history: {}, md_prompt_queues: {}, selection_copy_history: [],
  notebook_notes: [], notebook_active_note_id: "", notebook_notes_initialized: false, md_prompt_drafts: {},
  show_terminal_age: true, sidebar_text_color: "#d5dbe5", vscode_keybindings: {},
  notify_attention: true, notify_agent_idle: true,
  search_scope: "project", recent_closed_files: [], worktree_ui_state: {}, selected_worktrees: {}, worktree_roots: {},
  files_side_panel_last_tab: "project", file_search_history: [],
  file_tab_max_visible: 20, file_tab_order: "opened", lsp_enabled: true, lsp_command_overrides: {},
  lan_access_enabled: false };
// Per-agent knobs that only exist client-side (scroll/repaint quirks and the like). Everything
// data-shaped about an agent (labels, permissions, markers, capability flags) comes from
// /api/agents — one AgentCli class per agent on the server. See docs/agent-cli-api.md.
const AGENT_CLIENT_BEHAVIORS = {
  codex: {
    skipAttachScreenRepaint: true,      // repaint after attach double-paints codex's own redraw
    deferReflowAfterPrompt: true,       // hold reflow while codex redraws around a submitted prompt
    viewportAnchor: true,               // marker-anchored scroll hold across "Ran N" command folds
    focusTailRefresh: true,             // repaint the tail after focus; codex skips it while unfocused
    tailRepair: true,                   // detect+repair a mis-rendered tail after collapse writes
    repaintRestoreScroll: true,         // restore scroll target itself after a full repaint
    commandCollapse: true,              // watch for command-fold byte sequences and re-anchor
    blankRepaintDespiteScrollback: true, // codex can present a blank screen even with scrollback
    commandTranscriptShortcut: true,    // ctrl+t opens codex's own transcript overlay
  },
  claude: {
    attentionScreenDetection: true,     // scan the visible screen for permission-prompt markers
    statusRowRefresh: true,             // periodic bottom status-row repaint while following
  },
};
// Fallback snapshot of /api/agents, used only when the boot-time fetch fails (transient hiccup on a
// page that otherwise loaded): without it every capability check degrades to "shell terminal" for the
// whole browser session. The server response is authoritative and replaces this wholesale.
// Icon SVGs mirror AgentCli.icon_svg on the server so sidebar icons survive that fallback too.
const FALLBACK_ICON_SVGS = {
  claude: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.25c.42 0 .76.34.76.76v4.08l3.53-2.04a.76.76 0 1 1 .76 1.31L9.52 7.4l3.53 2.04a.76.76 0 1 1-.76 1.31L8.76 8.72v4.08a.76.76 0 0 1-1.52 0V8.72l-3.53 2.04a.76.76 0 1 1-.76-1.31L6.48 7.4 2.95 5.36a.76.76 0 1 1 .76-1.31l3.53 2.04V2.01c0-.42.34-.76.76-.76Z"/></svg>',
  codex: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zM3.5988 18.304a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1412-1.6462zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5968 3.8558L13.1038 8.364 15.1192 7.2a.0757.075 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zm-12.6413 4.1347-2.0201-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805-4.783 2.7582a.7948.7948 0 0 0-.3927.6813zM9.4041 10.4976l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z"/></svg>',
  agy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 1.8 14.45 9.55 22.2 12l-7.75 2.45L12 22.2l-2.45-7.75L1.8 12l7.75-2.45L12 1.8Z"/><path fill="currentColor" d="m18.55 2.15.8 2.5 2.5.8-2.5.8-.8 2.5-.8-2.5-2.5-.8 2.5-.8.8-2.5Z" opacity=".7"/></svg>',
  aider: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8.8" cy="12" r="6.4" fill="currentColor"/><circle cx="15.2" cy="12" r="6.4" fill="currentColor" opacity=".45"/></svg>',
  opencode: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="19" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="6.5" y="8.5" width="5" height="7" fill="currentColor"/><path d="M14 15.5h3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};
const AGENT_SPEC_DEFAULTS = {
  none: { kind: "none", label: "Shell", is_agent: false, prompt_marker: "", icon_svg: "",
    permissions: [{ value: "default", label: "Shell permissions" }],
    supports_resume: false, supports_fork: false, accepts_session_ref: false,
    records_raw_replay: false, has_prompt_queue: false, transcript_commands: [] },
  claude: { kind: "claude", label: "Claude", is_agent: true, prompt_marker: "❯", icon_svg: FALLBACK_ICON_SVGS.claude,
    permissions: [{ value: "default", label: "Default (Claude config)" }, { value: "accept-edits", label: "Accept edits" },
      { value: "auto", label: "Auto" }, { value: "full-access", label: "Full access" }],
    supports_resume: true, supports_fork: true, accepts_session_ref: true,
    records_raw_replay: true, has_prompt_queue: false,
    transcript_commands: [{ command: "/compact", description: "Compact the conversation context" },
      { command: "/context", description: "Show current context usage" },
      { command: "/usage", description: "Show plan usage and session cost" }] },
  codex: { kind: "codex", label: "Codex", is_agent: true, prompt_marker: "›", icon_svg: FALLBACK_ICON_SVGS.codex,
    permissions: [{ value: "default", label: "Default (Codex config)" }, { value: "read-only", label: "Read only" },
      { value: "workspace-write", label: "Workspace write" }, { value: "full-access", label: "Full access" }],
    supports_resume: true, supports_fork: true, accepts_session_ref: true,
    records_raw_replay: true, has_prompt_queue: true,
    transcript_commands: [{ command: "/compact", description: "Compact the conversation context" },
      { command: "/status", description: "Show model, context, and usage status" },
      { command: "/ps", description: "Show background terminals and tasks" },
      { command: "/plan", description: "Switch to plan mode" },
      { command: "/fast", description: "Toggle fast mode" }] },
  agy: { kind: "agy", label: "AGY", is_agent: true, prompt_marker: "", icon_svg: FALLBACK_ICON_SVGS.agy,
    permissions: [{ value: "default", label: "Default" }, { value: "full-access", label: "Full access" }],
    supports_resume: true, supports_fork: false, accepts_session_ref: false,
    records_raw_replay: false, has_prompt_queue: false, transcript_commands: [] },
  aider: { kind: "aider", label: "Aider", is_agent: true, prompt_marker: "", icon_svg: FALLBACK_ICON_SVGS.aider,
    permissions: [{ value: "default", label: "Default (confirm actions)" }, { value: "auto", label: "Auto-approve (--yes-always)" }],
    supports_resume: true, supports_fork: false, accepts_session_ref: false, sessionless: true,
    records_raw_replay: false, has_prompt_queue: false, transcript_commands: [] },
  opencode: { kind: "opencode", label: "OpenCode", is_agent: true, prompt_marker: "┃", icon_svg: FALLBACK_ICON_SVGS.opencode,
    permissions: [{ value: "default", label: "Default" }],
    supports_resume: true, supports_fork: true, accepts_session_ref: true, fullscreen_tui: true,
    records_raw_replay: true, has_prompt_queue: false, transcript_commands: [] },
};
const SEARCH_DEBOUNCE_MS = 500;
const TERMINAL_SEARCH_DEBOUNCE_MS = 700;
const TERMINAL_FIND_HIGHLIGHT_LIMIT = 2000;
const TERMINAL_FIND_DECORATIONS = Object.freeze({
  matchBackground: "#665000", matchBorder: "#d8ae00", matchOverviewRuler: "#d8ae00",
  activeMatchBackground: "#b85c00", activeMatchBorder: "#ffd166", activeMatchColorOverviewRuler: "#ff9f1c",
});
// Find reveals its hit with term.select(), so what the user actually sees is the ordinary SELECTION
// color -- theme selectionBackground, #3b4252, a dark slate barely a shade off the terminal background
// (confirmed by reading the painted .xterm-selection divs: rgb(59,66,82)). The decoration palette above
// never reaches the screen at all here, because nothing calls the search addon's own find methods
// (measured: zero .xterm-decoration elements while a match was highlighted). Borrowing the active-match
// orange from that palette for the selection keeps one consistent find color, and it is applied as a
// THEME override rather than CSS so it survives refreshTerminalAppearance and works under the WebGL
// renderer too (CSS could only ever style the DOM renderer's selection layer).
const TERMINAL_FIND_SELECTION_BACKGROUND = TERMINAL_FIND_DECORATIONS.activeMatchBackground;
const TERMINAL_FIND_SELECTION_FOREGROUND = "#ffffff";
const MOBILE_TERMINAL_LONG_PRESS_MS = 450;
const MOBILE_TERMINAL_SELECTION_MOVE_TOLERANCE = 12;
const MOBILE_SIDEBAR_CONTEXT_LONG_PRESS_MS = 500;
const MOBILE_SIDEBAR_CONTEXT_MOVE_TOLERANCE = 12;
const MOBILE_TERMINAL_SELECTION_BACKGROUND = "#287fd1";
const MOBILE_TERMINAL_SELECTION_FOREGROUND = "#ffffff";
const MOBILE_SIDEBAR_PINNED_KEY = "termdeck.mobile_sidebar_pinned";
const BROWSER_TALL_WEBGL_KEY = "termdeck.browser_tall_webgl";
const TRANSCRIPT_DRAFT_LOCAL_PREFIX = "termdeck.transcript-draft.v1";
const MOBILE_CONNECTION_WARNING_DELAY_MS = 1200;
// Unfinished experiment: hold back writes to hidden terminals and catch them up on activation.
// No setting and no toggle — flip this constant to work on it. See drainTerminalWrites().
const DEFER_INACTIVE_TERMINAL_OUTPUT = false;
const MOBILE_DISPLAY_SCALE_KEY = "termdeck.mobile_display_scale";
const SERVER_LOCAL_SETTING_KEYS = new Set(["tall_webgl", "notebook_open"]);
const MOBILE_DISPLAY_SCALE_MIN = 0.8;
const MOBILE_DISPLAY_SCALE_MAX = 1.6;
const MOBILE_DISPLAY_SCALE_STEP = 0.1;
// Tall-terminal row budget. WebGL backs the terminal with one drawing buffer sized to the FULL terminal
// in DEVICE pixels, so the real ceiling is MAX_TEXTURE_SIZE / (cellHeight * devicePixelRatio). That dpr
// term is why a row count measured safe on one machine is wrong on another: a retina display needs twice
// the pixels for the same rows. Measured under headless SwiftShader (MAX_TEXTURE_SIZE 8192, 21px cell,
// dpr 1) the ceiling is 390 rows; a real GPU usually reports 16384, which lands at ~390 again at dpr 2
// and ~780 at dpr 1. Querying both at runtime is the only way to claim the tallest terminal the machine
// in front of us can actually back, instead of hardcoding a guess -- and it degrades to DOM by itself on
// a GPU too small to matter.
// 4000 rows, up from the original 1000: the DOM renderer has no texture limit, only content rows
// materialize as DOM nodes, and the attach replay is cheap since title churn stopped being replayed --
// so the extra height just moves the point where the scrollback bridge has to take over.
const TALL_ROWS_DOM = 4000;
// Renderer choice for the tall terminal, deliberately a code flag rather than a setting: DOM is good
// enough today and the settings surface is already crowded. WebGL is not a straight upgrade here -- it
// backs the terminal with one drawing buffer sized to the FULL terminal in device pixels, so
// MAX_TEXTURE_SIZE caps it near 390 rows on this hardware, against 1000 for DOM, which has no such
// limit. Flip to true to explore that trade again; tallRowPlan then sizes the terminal to whatever the
// GPU can actually back.
const TALL_ROWS_MIN_FOR_WEBGL = 120;
// Fraction of MAX_TEXTURE_SIZE the canvas may occupy. MAX_TEXTURE_SIZE is not the real ceiling: measured
// on a 16384 GPU, the renderer draws normally up to 11520 device pixels of canvas and paints NOTHING at
// 13920 -- no error, no fallback, just a black pane with a full buffer behind it. That is the "a new
// terminal shows nothing" report, and the old 0.85 put the canvas at 13926, landing exactly in the dead
// zone. Sized under the measured boundary rather than the advertised one, with room for other GPUs.
const TALL_WEBGL_TEXTURE_HEADROOM = 0.65;
// How close to the ceiling still counts as "at the bottom". Deliberately tiny: a row's worth of slack
// was enough to swallow a slow scroll whole -- nudging up a few pixels still measured as "at the bottom",
// so the settle handler turned following back on and pulled the view straight back down, and only a fast
// gesture (one that cleared the slack in a single step) could escape. Nothing needs the slack: every way
// of arriving at the bottom lands on the ceiling exactly, because the clamp puts it there.
const TALL_BOTTOM_TOLERANCE_PX = 2;
// How many frames a follow scroll keeps re-applying while the container clamps it short (see
// tallSetScrollTop): enough for the rows behind the growth to be laid out, few enough that a target
// that is genuinely unreachable stops asking.
const TALL_CLAMPED_SCROLL_RETRIES = 4;
// How far below the top edge the cursor's row is held when following is capped (see tallFollowTarget):
// enough rows for the composer's own top border to stay on screen above the cursor line.
const TALL_FOLLOW_CURSOR_TOP_MARGIN_ROWS = 3;
// How long after a fold glue before its one re-placement runs (see the glue's comment): long enough
// for a mid-redraw state to have resolved, short enough that a misfire's dip stays sub-second.
const TALL_GLUE_RECHECK_MS = 800;
// How long after the last scroll event a gesture is still considered in progress, and how long of a
// quiet period settles it. Both cover a scrollbar drag pausing mid-gesture without ending it.
const TALL_SCROLL_ACTIVE_MS = 250;
const TALL_SCROLL_SETTLE_MS = 150;
// How far the view may sit below the ceiling before a write treats it as "the user moved this", without
// waiting for the scroll event to say so. Several rows: the browser's own focus scroll-into-view nudges
// by a pixel or two, which must NOT count, while any real gesture clears this immediately.
const TALL_FOLLOW_BREAK_PX = 60;
// Overshoot small enough to simply leave alone. The scrollable area is a fixed 1000 rows while the
// content usually ends short of that, so a drag can reach a little past the last line -- on a full canvas
// that is the couple of blank rows below it. Correcting such a small overshoot is worse than allowing it:
// the correction is what the user sees as the view jumping back a line or two after the drag lands.
// Larger overshoots (a sparse terminal, where the empty area is enormous) are still pulled back.
const TALL_OVERSHOOT_DEADZONE_PX = 72;
// How long a smaller content height must persist before the scrollable box actually shrinks. A composer
// redrawing itself reports one row fewer for a frame at a time, and reacting to each dip makes the box
// oscillate; growth is always applied immediately, so nothing is ever unreachable while this waits.
const TALL_SHRINK_SETTLE_MS = 400;
const CODEX_COLLAPSE_SHRINK_SETTLE_MS = 1200;
const CODEX_COMMAND_COLLAPSE_BYTES = new TextEncoder().encode("ctrl + t to view transcript");
const CODEX_INITIAL_REPAINT_SETTLE_MS = 140;
const CODEX_INITIAL_REPAINT_MAX_MS = 700;
// How long to wait after attaching before deciding the terminal really has nothing to show. Long enough
// for a replay to arrive and paint, short enough that a genuinely blank pane is not left sitting there.
const TALL_BLANK_REPAINT_MS = 900;
// A freshly attached tab is not one paint but several: the saved recording replays, then the agent
// redraws its own screen over the tail of it (a lazily respawned codex reprints its whole conversation),
// and every frame in between is a position this view can be left at if the last one lands wrong -- the
// cursor walking high through a redraw reads as a fold, the resulting jump reads as "something moved
// this view", and the tab ends up parked mid-history with nothing left to drive it down. So a following
// view re-asserts its position for a bounded window after attaching, once the writes go quiet. Anything
// the user does with the scroll ends the window on the spot: this only ever corrects positions nobody
// asked for.
const TALL_ATTACH_SETTLE_WINDOW_MS = 8000;
const TALL_ATTACH_SETTLE_INTERVAL_MS = 400;
// How many consecutive "looks mid-redraw" frames may be skipped before the measurement is taken anyway.
const TALL_MAX_BLANK_SKIPS = 4;
const TALL_ROWS_MAX = 1000;
const CLAUDE_WEBGL_COLD_PRIME_MIN_MS = 900;
const CLAUDE_WEBGL_COLD_PRIME_IDLE_MS = 220;
const CLAUDE_WEBGL_COLD_PRIME_MAX_MS = 2400;
const CLAUDE_WEBGL_COLD_PRIME_RETRY_MS = 60;
const HISTORY_BACKGROUND_TARGET_TURNS = 320;
const HISTORY_BACKGROUND_PAGE_TURNS = 160;
const HISTORY_BACKGROUND_LOAD_DELAY_MS = 180;
const SEARCH_HISTORY_STORAGE_KEY = "termdeck.search_history";
const SEARCH_HISTORY_RECORD_DELAY_MS = 3000;
const PROMPT_DRAFT_SYNC_PASTE_DELAY_MS = 250;
const FILE_AUTOSAVE_DELAY_MS = 500;
const SESSION_GROUP_HOVER_DELAY_MS = 700;
const CLOSED_SESSIONS_INITIAL_DISPLAY = 50;
const CLOSED_SESSIONS_MAX_DISPLAY = 100;
const TERMINAL_AGE_REFRESH_MS = 30000;
// A snapshot is hard-wrapped at the width it was taken at, and cannot be rewrapped once written into the
// buffer. A container that has not been laid out yet fits to a handful of columns, and saving then
// poisons the record: the width is stored with it, so a later restore at that same bogus width passes the
// equality check and paints history as an unreadable narrow column beside a full-width screen.
const TERMINAL_AGE_DAY_MS = 24 * 60 * 60 * 1000;
const TERMINAL_AGE_WEEK_MS = 7 * TERMINAL_AGE_DAY_MS;
const TERMINAL_AGE_INTERMEDIATE_FADE = 0.48;
const TERMINAL_GROUP_AGE_BRIGHTNESS = [1, 0.9, 0.8];
const TERMINAL_TAIL_REPAIR_LINES = 16;
const TERMINAL_RENDER_CHECK_INTERVAL_MS = 3000;
const TERMINAL_RENDER_CONFIRM_DELAY_MS = 700;
const TERMINAL_RENDER_REPAIR_COOLDOWN_MS = 10000;
const TERMINAL_VIEWPORT_RESTORE_IDLE_MS = 260;
const TERMINAL_VIEWPORT_RESTORE_TIMEOUT_MS = 3000;
const TERMINAL_VIEWPORT_ANCHOR_ROWS = 12;
const TERMINAL_VIEWPORT_ANCHOR_MAX_CHARS = 180;
const TERMINAL_VIEWPORT_ANCHOR_MIN_CHARS = 24;
const OPEN_FILES_MAX_ENTRIES = 80;
const RECENTLY_OPENED_TERMINALS_MAX_ENTRIES = 80;
const TERMINAL_V2_FIT_RETRY_LIMIT = 32;
const TERMINAL_V2_FIT_RETRY_DELAY_MS = 140;
// Three checks, well spread out, not five packed inside the first 600ms: only a genuine geometry change
// sends a pty resize, so a tight burst cannot interrupt an agent CLI's multi-line composer redraw.
const TERMINAL_ACTIVE_SETTLE_DELAYS_MS = [150, 800, 2000];
const TERMINAL_DEBUG_SNAPSHOT_LIMIT = 50;
const HEADER_PICKER_RESULT_LIMIT = 50;
const SELECTION_SEARCH_MAX_CHARS = 1000;
const SELECTION_ACTION_DELAY_MS = 500;
const IMAGE_ATTACHMENT_MIME_RE = /^image\//i;
const IMAGE_ATTACHMENT_EXTENSION_RE = /\.(?:avif|bmp|gif|heic|jpeg|jpg|png|svg|tif|tiff|webp)$/i;
const MAX_FORK_COUNT = 25;
const CLAUDE_STATUS_ROW_REFRESH_INTERVAL_MS = 500;
const CODEX_PROMPT_REFLOW_GUARD_MS = 1800;
const AGENT_PASTE_RETRY_DELAY_MS = 250;
const AGENT_PASTE_TIMEOUT_MS = 45000;
const AGENT_PASTE_OUTPUT_QUIET_MS = 600;
const DEFAULT_AGENT_PASTE_DELAY_MS = 250;
const TERMINAL_ATTENTION_ANIMATION_MS = 2600;
const TERMINAL_ATTENTION_TEXT_MARKERS = ["esc to cancel", "tab to amend"];
const KEYBOARD_SHORTCUT_SECTIONS = ["Terminal", "Files", "General"];
// Files viewer, file search, and terminal search share one files-section panel and one shortcut.
// The panel needs more room than the terminal list, so an unresized sidebar grows by this ratio
// while it is open; the workspace shifts over by the same amount rather than being covered.
const FILES_PANEL_WIDTH_RATIO = 1.5;
const FILES_PANEL_MIN_WIDTH = 300;
const FILES_SIDE_PANEL_TABS = ["project", "search", "git"];
// Navigation states that name a file, and therefore belong on the /f/ route no matter which side panel
// is open. Everything else lets the panel pick the route (see navUrl).
const FILE_ROUTE_NAV_KINDS = ["file", "open-file", "file-history", "file-history-path", "path"];
const CLOSED_SIDE_VIEW = "closed";
const ALL_WORKTREES_ID = "all";
const FILES_SIDE_PANEL_LAST_TAB_KEY = "termdeck.files_panel_last_tab";
// Which open files get the rendered-document toggle beside the tab strip, and how long a change to the
// source waits before the reading view is rebuilt (a save arrives as a burst of model edits).
// Monaco draws its own scrollbars rather than using the page's, and its default is noticeably fatter than
// everything else here. Matched to the app's 12px track (see ::-webkit-scrollbar in style.css) so the
// editor does not stand out beside a terminal; --editor-scrollbar-inset tracks this.
// The gutter is sized by Monaco from the EDITOR's font, so shrinking the digits in CSS alone leaves the
// width it reserved behind. Three characters is the minimum, not the maximum -- a file past 999 lines
// still gets the column it needs -- and the decorations strip beside it only has to separate the two.
const EDITOR_LINE_NUMBER_MIN_CHARS = 3;
const EDITOR_LINE_DECORATIONS_WIDTH = 4;
const EDITOR_SCROLLBAR_SIZE = 12;
const EDITOR_SCROLLBAR_OPTIONS = Object.freeze({
  verticalScrollbarSize: EDITOR_SCROLLBAR_SIZE, horizontalScrollbarSize: EDITOR_SCROLLBAR_SIZE,
  verticalSliderSize: EDITOR_SCROLLBAR_SIZE, horizontalSliderSize: EDITOR_SCROLLBAR_SIZE, useShadows: false,
});
// Files the editor cannot show but the browser can: opened as a preview instead of being refused as
// binary. The server serves the bytes from an allowlist of its own (ProjectFileService.MEDIA_CONTENT_TYPES);
// this map only decides which element to render them in.
const MEDIA_FILE_KINDS = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".bmp": "image",
  ".ico": "image", ".avif": "image", ".svg": "image",
  ".mp4": "video", ".m4v": "video", ".webm": "video", ".mov": "video", ".ogv": "video",
  ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".flac": "audio", ".oga": "audio", ".ogg": "audio",
  ".pdf": "document",
};
const MARKDOWN_FILE_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd", ".mdx"];
const MARKDOWN_FILE_VIEW_RENDER_DEBOUNCE_MS = 150;
const CLIENT_PLATFORM = String(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || globalThis.navigator?.userAgent || "").toLowerCase();
const IS_MAC_KEYBOARD_PLATFORM = /mac|iphone|ipad|ipod/.test(CLIENT_PLATFORM);
const PRIMARY_MODIFIER_DISPLAY = IS_MAC_KEYBOARD_PLATFORM ? "⌘" : "Ctrl";
const DESKTOP_KEYBINDINGS = [
  { id: "new-terminal", label: "New terminal", def: "Meta+b", section: "Terminal" },
  { id: "new-project", label: "New project", def: "Alt+Shift+s", section: "General" },
  { id: "new-worktree", label: "New worktree", def: "Alt+Shift+w", section: "General" },
  { id: "close-item", label: "Close active terminal / file", def: "Meta+Shift+Backspace", section: "General" },
  { id: "fork-terminal", label: "Fork active terminal", def: "Meta+Shift+b", section: "Terminal" },
  { id: "restart-terminal", label: "Restart active terminal", def: "Meta+Alt+r", section: "Terminal" },
  { id: "restore-last-closed-terminal", label: "Restore last closed terminal", def: "Alt+Shift+t", section: "Terminal" },
  { id: "resync-terminal", label: "Resync active terminal content", def: "Alt+Shift+r", section: "Terminal" },
  { id: "rename-terminal", label: "Rename active terminal", def: "Alt+r", section: "Terminal" },
  { id: "copy-session-id", label: "Copy active session id", def: "Alt+i", section: "Terminal" },
  { id: "mark-terminal-unread", label: "Mark active terminal as unread", def: "Alt+u", section: "Terminal" },
  { id: "create-terminal-group-from-active", label: "Create group from active terminal", def: "Alt+Shift+g", section: "Terminal" },
  { id: "move-active-to-top", label: "Move active terminal / group to top", def: "Alt+t", section: "Terminal" },
  { id: "open-move-menu", label: "Open active terminal Move to menu", def: "Alt+m", section: "Terminal" },
  { id: "undo-terminal-edit", label: "Undo terminal composer edit", def: "Meta+z", section: "Terminal" },
  { id: "open-terminal-new-tab", label: "Open active terminal in a new browser tab", def: "Meta+Alt+o", section: "Terminal" },
  { id: "toggle-diagnostics-recording", label: "Record diagnostics for a bug report", def: "Ctrl+Alt+Shift+k", section: "Terminal" },
  { id: "save-file", label: "Save open file", def: "Meta+s", section: "Files" },
  { id: "toggle-markdown-view", label: "Markdown view for the open file", def: "Alt+Shift+m", section: "Files" },
  { id: "file-history-previous-change", label: "File history: previous change", def: "Alt+Shift+ArrowUp", section: "Files" },
  { id: "file-history-next-change", label: "File history: next change", def: "Alt+Shift+ArrowDown", section: "Files" },
  { id: "file-history-apply-change", label: "File history: apply change to current file", def: "Alt+Shift+ArrowRight", section: "Files" },
  { id: "prev-terminal", label: "Previous terminal", def: "Meta+Alt+ArrowUp", section: "Terminal" },
  { id: "next-terminal", label: "Next terminal", def: "Meta+Alt+ArrowDown", section: "Terminal" },
  { id: "cycle-side-panel", label: "Files / Search / Git (4th press closes)", def: "Meta+Shift+e", section: "Files" },
  { id: "open-files-panel", label: "Open files panel", def: "Meta+Shift+d", section: "Files" },
  { id: "open-file-search", label: "Open file-content search", def: "Meta+Shift+f", section: "Files" },
  { id: "open-git-panel", label: "Open Git panel", def: "Meta+Shift+g", section: "Files" },
  { id: "open-files-new-tab", label: "Open files in a new browser tab", def: "Meta+Alt+d", section: "Files" },
  { id: "open-search-new-tab", label: "Open file search in a new browser tab", def: "Meta+Alt+f", section: "Files" },
  { id: "open-terminal-search", label: "Search terminal names and output", def: "Meta+Shift+s", section: "Terminal" },
  { id: "view-terminals", label: "Terminals view", def: "Meta+Shift+t", section: "Terminal" },
  { id: "switch-project", label: "Switch project", def: "Alt+s", section: "General" },
  { id: "toggle-notebook", label: "Quick notebook", def: "Alt+n", section: "General" },
  { id: "selection-copy", label: "Copy selected terminal / transcript text", def: "Meta+c", section: "General" },
  { id: "selection-note-new", label: "Create note from selected text", def: "Meta+Alt+n", section: "General" },
  { id: "selection-note-append", label: "Append selected text to note", def: "Meta+Alt+Shift+n", section: "General" },
  { id: "selection-copy-history", label: "Open copied text history", def: "Meta+Shift+v", section: "General" },
  { id: "toggle-history", label: "Switch terminal / transcript", def: "Alt+g", section: "General" },
  { id: "scroll-bottom", label: "Scroll terminal / transcript to bottom", def: "Meta+Shift+ArrowDown", section: "General" },
  { id: "focus-prompt", label: "Focus active terminal / editor / transcript prompt", def: "Alt+f", section: "General" },
  { id: "select-active-input", label: "Select active terminal / editor / prompt text", def: "Alt+a", section: "General" },
  { id: "select-terminal-all", label: "Select all terminal text", def: "Meta+Shift+a", section: "Terminal" },
  { id: "recent-terminals", label: "Recently opened terminals", def: "Meta+e", section: "Terminal" },
  { id: "quick-open", label: "Quick Open", def: "Alt+p", section: "Files" },
  { id: "toggle-problems", label: "Problems panel", def: "Alt+Shift+p", section: "Files" },
  { id: "conversation-outline", label: "Outline", def: "Alt+o", section: "General" },
];
const FILE_HISTORY_SHORTCUT_ACTIONS = new Set([
  "file-history-previous-change", "file-history-next-change", "file-history-apply-change",
]);
const VSCODE_KEYBINDINGS = [
  { id: "new-terminal", label: "New terminal", def: "Ctrl+Alt+b", section: "Terminal" },
  { id: "close-item", label: "Close active terminal", def: "Ctrl+Alt+Backspace", section: "Terminal" },
  { id: "fork-terminal", label: "Fork active terminal", def: "Ctrl+Alt+Shift+b", section: "Terminal" },
  { id: "restart-terminal", label: "Restart active terminal", def: "Ctrl+Alt+Shift+r", section: "Terminal" },
  { id: "restore-last-closed-terminal", label: "Restore last closed terminal", def: "Ctrl+Alt+Shift+t", section: "Terminal" },
  { id: "resync-terminal", label: "Resync active terminal content", def: "Ctrl+Alt+r", section: "Terminal" },
  { id: "prev-terminal", label: "Previous terminal", def: "Ctrl+Alt+ArrowUp", section: "Terminal" },
  { id: "next-terminal", label: "Next terminal", def: "Ctrl+Alt+ArrowDown", section: "Terminal" },
  { id: "open-terminal-new-tab", label: "Open active terminal in a new browser tab", def: "Ctrl+Alt+o", section: "Terminal" },
  { id: "toggle-diagnostics-recording", label: "Record diagnostics for a bug report", def: "Ctrl+Alt+Shift+k", section: "Terminal" },
  { id: "toggle-notebook", label: "Quick notebook", def: "Ctrl+Alt+n", section: "General" },
  { id: "open-files-new-tab", label: "Open files in a new browser tab", def: "Ctrl+Alt+d", section: "Files" },
  { id: "open-search-new-tab", label: "Open file search in a new browser tab", def: "Ctrl+Alt+f", section: "Files" },
  { id: "toggle-history", label: "Switch terminal / transcript", def: "Ctrl+Alt+m", section: "General" },
  { id: "select-terminal-all", label: "Select all terminal text", def: "Ctrl+Alt+Shift+a", section: "Terminal" },
  { id: "vscode-refresh", label: "Refresh TermDeck", def: "Ctrl+r", section: "General" },
  { id: "vscode-reload", label: "Reload TermDeck webview", def: "Ctrl+Shift+r", section: "General" },
];
const REFERENCE_KEYS = [
  { keys: `${PRIMARY_MODIFIER_DISPLAY}[ / ${PRIMARY_MODIFIER_DISPLAY}]`, label: "Browser back / forward (last-clicked navigation)", section: "General" },
  { keys: IS_MAC_KEYBOARD_PLATFORM ? "⌃⇧F" : "Ctrl+Shift+F", label: "Focus file-content search", section: "Files" },
  { keys: IS_MAC_KEYBOARD_PLATFORM ? "⌃⇧Space" : "Ctrl+Shift+Space", label: "Open file browser/search", section: "Files" },
  { keys: IS_MAC_KEYBOARD_PLATFORM ? "⌃R / ⌃M / ⌘⌫" : "Ctrl+R / Ctrl+M / Ctrl+Backspace", label: "Rename / move / delete selected tree file", section: "Files" },
];
const VSCODE_REFERENCE_KEYS = [
  { keys: IS_MAC_KEYBOARD_PLATFORM ? "⌘⇧P" : "Ctrl+Shift+P", label: "Open VS Code Command Palette", section: "General" },
  { keys: IS_MAC_KEYBOARD_PLATFORM ? "⌘⇧E" : "Ctrl+Shift+E", label: "Open VS Code Explorer", section: "Files" },
  { keys: IS_MAC_KEYBOARD_PLATFORM ? "⌘W" : "Ctrl+W", label: "Close editor tab", section: "General" },
];
function parseModeFlag(raw) {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 1;
  const value = String(raw || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return false;
}
const ALWAYS_EXCLUDED = TermDeckFileBrowser.alwaysExcluded;
const STATS_POLL_MS = 5000;
const STAT_HISTORY_MAX = 48;
const FONT_MIN = 8, FONT_MAX = 32;
const INLINE_SIZE_SETTING_DEFINITIONS = [
  { key: "sidebar_font_size", label: "Terminal list" }, { key: "project_font_size", label: "Project title" },
  { key: "terminal_icon_size", label: "Terminal icons" }, { key: "terminal_font_size", label: "Terminal" },
  { key: "ui_font_size", label: "Status line" }, { key: "system_font_size", label: "Menus / lists" }, { key: "code_font_size", label: "Code" },
  { key: "files_tab_font_size", label: "File tabs" },
  { key: "bottom_font_size", label: "UI icons / spacing" }, { key: "diff_font_size", label: "Diff" },
  { key: "tree_font_size", label: "Tree / search" },
];
const RECENT_FILES_MIN_REFRESH_MS = 5000;
const RECENT_FILES_EVENT_DEBOUNCE_MS = 2000;
const FILE_TREE_WS_ROUTE = "/ws/files";
const FILE_TREE_CHANGED = "file_tree_changed";
const QUERY_RESPONSE_RE = /^\x1b\[[?>]?[\d;]*[Rc]$/;
// The terminal's OWN replies -- focus in/out, device-attribute and cursor-position answers, mouse
// reports, DCS/OSC responses. Everything else on the input channel is a person: letters and Enter, but
// also the arrow keys used to navigate a prompt. Mirrors the server's _TERMINAL_REPLY_RE.
const TERMINAL_REPLY_RE = /\x1b\[[IO]|\x1b\[[0-9;]*n|\x1b\[[?>][0-9;]*c|\x1b\[[0-9;]*R|\x1b\[M[\s\S]{3}|\x1b\[<[0-9;]*[Mm]|\x1bP[\s\S]*?\x1b\\|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const PATH_LINK_RE = /(?:~\/|\.{1,2}\/|\/)?[\w@%+=.-]+(?:\/[\w@%+=.-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+){0,2}/g;
const KNOWN_EXTS = new Set(["py", "md", "json", "js", "ts", "tsx", "css", "html", "sh", "zsh", "txt", "yaml", "yml",
  "toml", "csv", "log", "plist", "sql", "xml", "ini", "cfg", "lock", "ipynb", "rs", "go", "c", "h", "cpp", "hpp", "java"]);
const MATERIAL_ICONS_BASE = "/static/vendor/material-icons/icons/";
// Folder rows use a plain grey outline rather than a Material folder variant: the tree already carries
// colour on the FILE icons, so a coloured folder on every row competed with them for attention. Local
// SVGs (static/icons) instead of the vendored set, because none of its 225 folder variants is neutral.
const TERMDECK_ICONS_BASE = "/static/icons/";
const FOLDER_ICON_CLOSED = `${TERMDECK_ICONS_BASE}folder.svg`;
const FOLDER_ICON_OPEN = `${TERMDECK_ICONS_BASE}folder-open.svg`;
const MATERIAL_ICONS_MAP_URL = "/static/vendor/material-icons/dist/material-icons.json";
const HAS_VSCODE_WEBVIEW_API = typeof acquireVsCodeApi === "function";
const IS_VSCODE_EMBEDDED = window.parent !== window;
const HOST_HINT = String(location.host || "").toLowerCase();
const PATH_HINT = String(location.pathname || "").toLowerCase();
const LOCATION_HINT = String(location.href || "").toLowerCase();
const LOCATION_PARAMS = new URLSearchParams(location.search);
const WORKSPACE_ROOT_QUERY = LOCATION_PARAMS.get("workspace_root") || "";
const IS_PROJECT_NAVIGATION_PATH = /^\/[pfg]\/[^/]+\/[^/]+\/.+/.test(location.pathname);
if (location.hash && !IS_PROJECT_NAVIGATION_PATH) {
  const hash = location.hash.replace(/^#/, "");
  for (const [key, value] of new URLSearchParams(hash)) {
    LOCATION_PARAMS.set(key, value);
  }
}
const VS_CODE_PARAM = String(LOCATION_PARAMS.get("vscode") || "").toLowerCase();
const NATIVE_VSCODE_PARAM = String(LOCATION_PARAMS.get("native_terminal") || "").toLowerCase();
const VSCODE_EDITOR_PARAM = String(LOCATION_PARAMS.get("termdeck_editor") || "").toLowerCase();
const VSCODE_EDITOR_MODE = ["1", "true", "yes", "on"].includes(VSCODE_EDITOR_PARAM);
const REFERRER_HINT = String(document.referrer || "").toLowerCase();
const REFERRER_IS_VSCODE = /vscode-(webview|resource)|vscode-(?:assets|file)/.test(REFERRER_HINT) ||
  REFERRER_HINT.includes("vscode-webview://") || REFERRER_HINT.includes("vscode-resource:");
const URL_HINTS_VSCODE = LOCATION_HINT.includes("vscode-webview") ||
  LOCATION_HINT.includes("vscode-resource") || HOST_HINT.includes("vscode-webview") || PATH_HINT.includes("vscode-webview");
const VS_CODE_MODE = HAS_VSCODE_WEBVIEW_API || IS_VSCODE_EMBEDDED || URL_HINTS_VSCODE || (VS_CODE_PARAM &&
  ["1", "true", "yes", "on"].includes(VS_CODE_PARAM)) ||
  (NATIVE_VSCODE_PARAM && ["1", "true", "yes", "on"].includes(NATIVE_VSCODE_PARAM)) ||
  REFERRER_IS_VSCODE;
const NATIVE_VSCODE_MODE = VS_CODE_MODE &&
  (NATIVE_VSCODE_PARAM ? ["1", "true", "yes", "on"].includes(NATIVE_VSCODE_PARAM) : true);
const makeTerminalTheme = (background, foreground, cursor, selectionBackground, ansi) => {
  const [black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen,
    brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = ansi;
  return { background, foreground, cursor, selectionBackground,
    selectionInactiveBackground: selectionBackground,
    selectionForeground: foreground, black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite };
};
const rgbaThemeColor = (color, alpha) => {
  const match = String(color || "").match(/^#([0-9a-f]{6})$/i);
  if (!match) return color;
  const value = Number.parseInt(match[1], 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
};
const monacoThemeColor = (color) => {
  const value = String(color || "").trim();
  const hex = value.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (hex) return `#${hex[1]}${hex[2] || "ff"}`;
  const rgba = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (!rgba) return "#00000000";
  const alpha = Math.round((rgba[4] == null ? 1 : Number(rgba[4])) * 255).toString(16).padStart(2, "0");
  return `#${[rgba[1], rgba[2], rgba[3]].map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}${alpha}`;
};
// A softer version of a theme colour, for surfaces that should register without claiming attention.
const fadedThemeColor = (color, factor) => {
  const hex = monacoThemeColor(color);
  const alpha = Math.round(Number.parseInt(hex.slice(7, 9), 16) * factor);
  return `${hex.slice(0, 7)}${Math.max(0, Math.min(255, alpha)).toString(16).padStart(2, "0")}`;
};
const makeTheme = (id, label, kind, colors, ansi, monacoBase = kind === "light" ? "vs" : "vs-dark") => {
  const activeBackground = colors.activeBg || rgbaThemeColor(colors.accent, 0.14);
  const activeBorder = colors.activeBorder || rgbaThemeColor(colors.accent, 0.45);
  const lineHighlightBackground = fadedThemeColor(colors.activeBg || rgbaThemeColor(colors.accent, 0.14), 0.85);
  const treeSelectedBackground = colors.treeSelectedBg || rgbaThemeColor(colors.accent, 0.17);
  const treeSelectedBorder = colors.treeSelectedBorder || rgbaThemeColor(colors.accent, 0.48);
  const terminalBackground = colors.term || colors.bg;
  const terminalForeground = colors.terminalForeground || colors.text;
  return {
    id, label, kind, monacoBase,
    css: {
      "--bg": colors.bg, "--panel": colors.panel, "--panel2": colors.panel2, "--border": colors.border,
      "--text": colors.text, "--dim": colors.dim, "--accent": colors.accent, "--working-blue": colors.working || colors.accent,
      "--sidebar-text-color": colors.sidebar || colors.text, "--green": colors.green, "--red": colors.red,
      "--term-bg": colors.term || colors.bg, "--term-text": terminalForeground, "--term-blue": ansi[12],
      "--term-cyan": ansi[14], "--term-green": ansi[10], "--term-yellow": ansi[11], "--term-magenta": ansi[13],
      "--scroll-thumb": colors.scroll || colors.border,
      "--scroll-thumb-hover": colors.scrollHover || colors.accent, "--active-bg": activeBackground,
      "--active-border": activeBorder, "--active-text": colors.activeText || colors.text,
      "--line-highlight": lineHighlightBackground,
      "--tree-selected-bg": treeSelectedBackground, "--tree-selected-border": treeSelectedBorder,
    },
    terminal: makeTerminalTheme(terminalBackground, terminalForeground, colors.cursor || colors.accent,
      colors.selection || activeBorder, ansi),
    monacoColors: {
      "editor.background": monacoThemeColor(colors.monacoBg || terminalBackground), "editor.foreground": monacoThemeColor(colors.text),
      "editorGutter.background": monacoThemeColor(colors.monacoBg || terminalBackground), "editorLineNumber.foreground": monacoThemeColor(colors.dim),
      "editorLineNumber.activeForeground": monacoThemeColor(colors.accent), "editor.selectionBackground": monacoThemeColor(colors.selection || activeBorder),
      "editorCursor.foreground": monacoThemeColor(colors.cursor || colors.accent),
      // The line the cursor is on marks itself with a faint tint and no outline: at the full active
      // colour, with a border top and bottom, it read as a selection rather than as the caret's line.
      "editor.lineHighlightBackground": lineHighlightBackground, "editor.lineHighlightBorder": "#00000000",
      "editorIndentGuide.background1": monacoThemeColor(colors.border), "editorIndentGuide.activeBackground1": monacoThemeColor(activeBorder),
      // The same thumb the rest of the app uses, so the editor's scrollbar is not a different object
      // from the terminal's (see ::-webkit-scrollbar in style.css).
      "scrollbarSlider.background": monacoThemeColor(colors.scroll || colors.border),
      "scrollbarSlider.hoverBackground": monacoThemeColor(colors.scrollHover || colors.accent),
      "scrollbarSlider.activeBackground": monacoThemeColor(colors.scrollHover || colors.accent),
      "editorOverviewRuler.border": "#00000000",
    },
  };
};
const THEME_DEFINITIONS = [
  makeTheme("dark", "Nord dark", "dark",
    { bg: "#0b0e12", panel: "#12161c", panel2: "#1a2029", border: "#232a35", text: "#d5dbe5", terminalForeground: "#d8dee9", dim: "#7a8494", accent: "#5ccfe6", working: "#83e6ff", green: "#9fe8a2", red: "#f28779", term: "#0a0c10", monacoBg: "#101418", cursor: "#8fbcbb", selection: "#3b4252", scroll: "#2b3440", scrollHover: "#3d4856", activeBg: "rgba(92, 207, 230, 0.13)", activeBorder: "rgba(92, 207, 230, 0.4)", activeText: "#eaf6f9", treeSelectedBg: "rgba(4, 57, 94, 0.55)", treeSelectedBorder: "rgba(0, 122, 204, 0.45)" },
    ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"]),
  makeTheme("nord-vivid", "Nord dark vivid", "dark",
    { bg: "#0b0e12", panel: "#12161c", panel2: "#1a2029", border: "#2c3441", text: "#e2e8f0", terminalForeground: "#e5e9f0", dim: "#929fb3", accent: "#67e8f9", working: "#8befff", green: "#7ee787", red: "#ff6b81", term: "#0a0c10", monacoBg: "#101418", cursor: "#8befff", selection: "#3b4961", scroll: "#344052", scrollHover: "#4b5b72", activeBg: "rgba(103, 232, 249, 0.15)", activeBorder: "rgba(103, 232, 249, 0.48)", activeText: "#f3fbff", treeSelectedBg: "rgba(71, 148, 255, 0.22)", treeSelectedBorder: "rgba(103, 232, 249, 0.52)" },
    ["#3b4252", "#ff6b81", "#7ee787", "#f6c85f", "#82aaff", "#c792ea", "#67e8f9", "#e5e9f0", "#6272a4", "#ff8296", "#9bf6a5", "#ffe08a", "#9bbcff", "#d8a8ff", "#8befff", "#ffffff"]),
  makeTheme("light", "GitHub light", "light",
    { bg: "#f2f4f7", panel: "#ffffff", panel2: "#e9edf2", border: "#d4dbe3", text: "#24292f", terminalForeground: "#1f2328", dim: "#6b7580", accent: "#0969da", green: "#1a7f37", red: "#cf222e", term: "#ffffff", cursor: "#0969da", selection: "#b6d7fb", scroll: "#c7cfd8", scrollHover: "#aab2c0", activeBg: "rgba(9, 105, 218, 0.1)", activeBorder: "rgba(9, 105, 218, 0.35)", activeText: "#0a3069", treeSelectedBg: "rgba(9, 105, 218, 0.12)", treeSelectedBorder: "rgba(9, 105, 218, 0.3)" },
    ["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"]),
  makeTheme("mac-terminal", "macOS terminal", "dark",
    { bg: "#202124", panel: "#292a2d", panel2: "#343539", border: "#484a50", text: "#f1f3f4", dim: "#a9adb5", accent: "#7dd3fc", working: "#86efac", green: "#8bd49c", red: "#ff8a80", term: "#1e1f22", cursor: "#f1f3f4", selection: "#4b5563" },
    ["#303238", "#ff8a80", "#8bd49c", "#ffe082", "#82b1ff", "#cf93d9", "#80cbc4", "#f1f3f4", "#6b7078", "#ff5252", "#69f0ae", "#ffd740", "#448aff", "#e040fb", "#64ffda", "#ffffff"]),
  makeTheme("github-dark", "GitHub dark", "dark",
    { bg: "#0d1117", panel: "#161b22", panel2: "#21262d", border: "#30363d", text: "#c9d1d9", dim: "#8b949e", accent: "#58a6ff", working: "#79c0ff", green: "#7ee787", red: "#ff7b72", term: "#0d1117", cursor: "#58a6ff", selection: "#264f78" },
    ["#484f58", "#ff7b72", "#7ee787", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4", "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc"]),
  makeTheme("one-dark", "One Dark", "dark",
    { bg: "#1e2127", panel: "#282c34", panel2: "#313640", border: "#3e4451", text: "#abb2bf", dim: "#7f848e", accent: "#61afef", working: "#56b6c2", green: "#98c379", red: "#e06c75", term: "#1e2127", cursor: "#61afef", selection: "#3e4451" },
    ["#545862", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#7f848e", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"]),
  makeTheme("monokai", "Monokai", "dark",
    { bg: "#272822", panel: "#2d2e27", panel2: "#3e3d32", border: "#5a594f", text: "#f8f8f2", dim: "#a6a69c", accent: "#a6e22e", working: "#66d9ef", green: "#a6e22e", red: "#f92672", term: "#272822", cursor: "#f8f8f0", selection: "#49483e" },
    ["#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2", "#75715e", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5"]),
  makeTheme("dracula", "Dracula", "dark",
    { bg: "#282a36", panel: "#303241", panel2: "#3a3c4e", border: "#4b4d60", text: "#f8f8f2", dim: "#a7a9be", accent: "#bd93f9", working: "#8be9fd", green: "#50fa7b", red: "#ff5555", term: "#282a36", cursor: "#f8f8f2", selection: "#44475a" },
    ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#8be9fd", "#bd93f9", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#a4ffff", "#d6acff", "#a4ffff", "#ffffff"]),
  makeTheme("solarized-dark", "Solarized dark", "dark",
    { bg: "#002b36", panel: "#073642", panel2: "#0b4654", border: "#1b5965", text: "#839496", dim: "#657b83", accent: "#2aa198", working: "#268bd2", green: "#859900", red: "#dc322f", term: "#002b36", cursor: "#2aa198", selection: "#174b55" },
    ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#586e75", "#cb4b16", "#b4c342", "#c9a400", "#458bd2", "#d33682", "#2aa198", "#fdf6e3"]),
  makeTheme("solarized-light", "Solarized light", "light",
    { bg: "#fdf6e3", panel: "#eee8d5", panel2: "#e6dfcb", border: "#d8cfb9", text: "#586e75", dim: "#839496", accent: "#268bd2", green: "#859900", red: "#dc322f", term: "#fdf6e3", cursor: "#268bd2", selection: "#c9dff0" },
    ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#586e75", "#cb4b16", "#b4c342", "#c9a400", "#458bd2", "#d33682", "#2aa198", "#fdf6e3"]),
  makeTheme("gruvbox-dark", "Gruvbox dark", "dark",
    { bg: "#282828", panel: "#32302f", panel2: "#3c3836", border: "#504945", text: "#ebdbb2", dim: "#a89984", accent: "#83a598", working: "#8ec07c", green: "#b8bb26", red: "#fb4934", term: "#282828", cursor: "#ebdbb2", selection: "#504945" },
    ["#3c3836", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#7c6f64", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"]),
  makeTheme("gruvbox-light", "Gruvbox light", "light",
    { bg: "#fbf1c7", panel: "#f2e5bc", panel2: "#ebdbb2", border: "#d5c4a1", text: "#3c3836", dim: "#7c6f64", accent: "#076678", green: "#79740e", red: "#9d0006", term: "#fbf1c7", cursor: "#076678", selection: "#d5e5e8" },
    ["#3c3836", "#9d0006", "#79740e", "#b57614", "#076678", "#8f3f71", "#427b58", "#7c6f64", "#928374", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#ebdbb2"]),
  makeTheme("tokyo-night", "Tokyo Night", "dark",
    { bg: "#16161e", panel: "#1f2335", panel2: "#292e42", border: "#3b4261", text: "#c0caf5", dim: "#7982a9", accent: "#7aa2f7", working: "#7dcfff", green: "#9ece6a", red: "#f7768e", term: "#16161e", cursor: "#7aa2f7", selection: "#283457" },
    ["#15161e", "#f7768e", "#41a6b5", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#7982a9", "#414868", "#ff7a93", "#73daca", "#ff9e64", "#8db0ff", "#c7a0ff", "#a4daff", "#acb0d0"]),
  makeTheme("catppuccin-mocha", "Catppuccin mocha", "dark",
    { bg: "#11111b", panel: "#181825", panel2: "#313244", border: "#45475a", text: "#cdd6f4", dim: "#9399b2", accent: "#89b4fa", working: "#74c7ec", green: "#a6e3a1", red: "#f38ba8", term: "#11111b", cursor: "#f5e0e6", selection: "#45475a" },
    ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"]),
  makeTheme("catppuccin-latte", "Catppuccin latte", "light",
    { bg: "#eff1f5", panel: "#e6e9ef", panel2: "#dce0e8", border: "#bcc0cc", text: "#4c4f69", dim: "#7c7f93", accent: "#1e66f5", green: "#40a02b", red: "#d20f39", term: "#eff1f5", cursor: "#1e66f5", selection: "#cbd7f5" },
    ["#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#8839ef", "#179299", "#acb0be", "#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#8839ef", "#179299", "#bcc0cc"]),
  makeTheme("rose-pine", "Rosé Pine", "dark",
    { bg: "#191724", panel: "#1f1d2e", panel2: "#26233a", border: "#403d52", text: "#e0def4", dim: "#908caa", accent: "#c4a7e7", working: "#9ccfd8", green: "#9ccfd8", red: "#eb6f92", term: "#191724", cursor: "#c4a7e7", selection: "#403d52" },
    ["#26233a", "#eb6f92", "#9ccfd8", "#f6c177", "#31748f", "#c4a7e7", "#ebbcba", "#e0def4", "#6e6a86", "#eb6f92", "#9ccfd8", "#f6c177", "#31748f", "#c4a7e7", "#ebbcba", "#e0def4"]),
  makeTheme("ayu-dark", "Ayu dark", "dark",
    { bg: "#0b0e14", panel: "#11151c", panel2: "#1b212b", border: "#303846", text: "#bfbdb6", dim: "#7d8799", accent: "#e6b450", working: "#59c2ff", green: "#aad94c", red: "#f07178", term: "#0b0e14", cursor: "#e6b450", selection: "#273747" },
    ["#0b0e14", "#f07178", "#aad94c", "#e6b450", "#59c2ff", "#d2a6ff", "#95e6cb", "#bfbdb6", "#565b66", "#ff8f8f", "#c2d94c", "#ffb454", "#73d0ff", "#dfbfff", "#a8e6cf", "#f8f8f2"]),
  makeTheme("ayu-light", "Ayu light", "light",
    { bg: "#fafafa", panel: "#f3f4f5", panel2: "#e7e9eb", border: "#cfd3d8", text: "#5c6166", dim: "#8a9199", accent: "#399ee6", green: "#86b300", red: "#ed9366", term: "#fafafa", cursor: "#399ee6", selection: "#cfe8f8" },
    ["#5c6166", "#f07171", "#86b300", "#f2ae49", "#399ee6", "#a37acc", "#4cbf99", "#fafafa", "#8a9199", "#f07171", "#86b300", "#f2ae49", "#399ee6", "#a37acc", "#4cbf99", "#ffffff"]),
  makeTheme("high-contrast", "High contrast", "dark",
    { bg: "#000000", panel: "#080808", panel2: "#171717", border: "#777777", text: "#ffffff", dim: "#c7c7c7", accent: "#00ffff", working: "#ffff00", green: "#00ff66", red: "#ff5555", term: "#000000", cursor: "#ffffff", selection: "#444444" },
    ["#000000", "#ff5555", "#00ff66", "#ffff00", "#55aaff", "#ff55ff", "#00ffff", "#ffffff", "#777777", "#ff7777", "#55ff88", "#ffff77", "#77bbff", "#ff77ff", "#77ffff", "#ffffff"], "hc-black"),
];
const THEME_BY_ID = Object.fromEntries(THEME_DEFINITIONS.map((theme) => [theme.id, theme]));

class TermdeckApp {
  constructor() {
    this.vscodeMode = VS_CODE_MODE;
    this.nativeVscodeMode = NATIVE_VSCODE_MODE;
    this.vscodeEditorMode = VSCODE_EDITOR_MODE;
    this.vscodeWorkspaceRoot = WORKSPACE_ROOT_QUERY || "";
    this.vscodeProjectName = "";
    document.body.classList.toggle("vscode-mode", this.vscodeMode);
    document.body.classList.toggle("vscode-native-mode", this.nativeVscodeMode);
    document.body.classList.toggle("vscode-editor-mode", this.vscodeEditorMode);
    this.hostStatePatched = false;
    this.handleHostMessageBound = this.handleHostMessage.bind(this);
    this.sessions = [];
    this.closedSessions = [];
    this.agentSpecs = AGENT_SPEC_DEFAULTS;
    this.agentRunStartedAt = new Map();
    this.initialLoadComplete = false;
    this.initialPageContentReady = false;
    this.views = new Map();
    this.transcriptSessionStates = new Map();
    this.openFiles = new Map();
    this.markdownFileViews = new Set();
    this.markdownFileViewScroll = new Map();
    this.markdownFileViewListener = null;
    this.markdownFileViewModel = null;
    this.markdownFileViewRenderTimer = 0;
    this.lspClient = null;
    this.openFilesPersistPromise = Promise.resolve();
    this.sidebarSelectedFileKeys = new Set();
    this.sidebarFileSelectionAnchorKey = null;
    this.activeId = null;
    this.activeFileKey = null;
    this.fileHistoryOpen = false;
    this.fileHistoryTabKey = null;
    this.fileHistoryLoadedKey = null;
    this.fileHistorySidebarVisible = false;
    this.fileHistoryMode = "all";
    this.fileHistorySelections = [];
    this.fileHistoryVersions = [];
    this.fileHistoryItems = [];
    this.fileHistoryLoadGeneration = 0;
    this.fileHistoryComparisonTimer = 0;
    this.fileHistoryDiffEditor = null;
    this.fileHistoryCurrentEditor = null;
    this.fileHistoryTransientModels = new Set();
    this.fileHistoryActiveComparison = null;
    this.fileHistoryDiffBlocks = [];
    this.fileHistoryDiffBlockIndex = -1;
    this.fileHistoryDiffPending = false;
    this.historyOpen = false;
    this.historySlashMenuIndex = -1;
    this.historySlashMenuMatches = [];
    this.terminalLayoutTransitionGeneration = 0;
    this.terminalLayoutTransitioning = false;
    this.historyRefreshTimer = 0;
    this.historyLoadBusy = false;
    this.historyWs = null;
    this.historyWsReconnectTimer = 0;
    this.historyStreamSessionId = null;
    this.historyManualRefreshSessionId = "";
    this.historySnapshotBuffers = new Map();
    this.historyTurnsBySession = new Map();
    this.historyScrollBySession = new Map();
    this.historyLiveTurnsBySession = new Map();
    this.historyOlderTurnsBySession = new Map();
    this.historyBeforeBySession = new Map();
    this.historyHasMoreBySession = new Map();
    this.historyOlderLoadBusy = false;
    this.historyTopLoadObserver = null;
    this.historyBackgroundLoadTimer = 0;
    this.historyBackgroundLoadSessionId = "";
    this.historyFilteredLoadTimer = 0;
    this.historyStreamFresh = false;
    this.historyRevisions = new Map();
    this.historyPendingPrompts = new Map();
    this.historyPendingPromptSequence = 0;
    this.historyFingerprint = "";
    this.historyTurns = [];
    this.historyRenderedTurns = [];
    this.historyLoaded = false;
    this.historyEditsCollapsed = false;
    this.historyFilters = { hidePrompts: false, hideThinking: false, codeOnly: false, foldRepetitive: false };
    this.historyFilterProjectKey = "";
    this.headerPickerActiveIndices = { project: 0, worktree: 0 };
    this.closedExpanded = false;
    this.restoreLastClosedTerminalBusy = false;
    this.restoreLastClosedTerminalNeedsConfirmation = false;
    this.closedDisplayLimit = CLOSED_SESSIONS_INITIAL_DISPLAY;
    this.terminalSearchText = "";
    this.terminalSearchEditorOpen = false;
    this.terminalSearchFocusIndex = -1;
    this.sidebarAnimationVisibilityObserver = null;
    this.settings = { ...SETTINGS_DEFAULTS };
    this.persistedSettings = { ...SETTINGS_DEFAULTS };
    this.fontSampleSelectionIndex = 0;
    this.fontSampleReturnFocus = null;
    this.saveTimer = null;
    this.settingsSavePromise = Promise.resolve();
    this.projectStateSavePromise = Promise.resolve();
    this.treeRoot = null;
    this.treeDirs = new Map();
    this.treeReloadPromise = null;
    this.expandedDirs = new Set();
    this.treePollBusy = false;
    this.treeWs = null;
    this.treeWsRoot = "";
    this.treeWsReconnectTimer = 0;
    this.treeEventRefreshTimer = 0;
    this.treeChangedDirectories = new Set();
    this.treeChangedEntries = new Map();
    this.gitSideGeneration = 0;
    this.gitSideState = null;
    this.gitPanelView = "changes";
    this.gitSelectedPaths = new Set();
    this.gitSelectionRoot = "";
    this.gitSelectionExplicitlyCleared = false;
    this.gitSelectionAnchorPath = "";
    this.gitFocusedFile = null;
    this.gitReviewOpen = false;
    this.gitPendingReview = null;
    this.gitReviewDiffEditor = null;
    this.gitReviewTextEditor = null;
    this.gitReviewModels = [];
    this.gitReviewGeneration = 0;
    this.gitReviewDiffIndex = -1;
    this.gitReviewDiffPending = false;
    this.gitReviewSideBySide = true;
    this.gitConflictReview = null;
    this.gitConflictSource = "theirs";
    this.gitConflictResolutionInProgress = false;
    this.gitGraphGeneration = 0;
    this.gitExpandedCommitId = "";
    this.gitCommitDetails = new Map();
    this.gitCommitDetailGeneration = 0;
    this.gitHistoryLimit = 25;
    this.gitHistoryScopePaths = [];
    this.gitPendingHistoryScope = null;
    this.gitHistoryQuery = "";
    this.gitHistoryFilters = { author: "", since: "", until: "", revision: "", path: "" };
    this.gitHistoryFiltersOpen = false;
    this.gitHistorySearchTimer = 0;
    this.gitGraphPathsKey = "";
    this.gitGraphError = "";
    this.gitComparison = null;
    this.gitPullRequestRoot = "";
    this.gitPullRequestState = "open";
    this.gitPullRequests = [];
    this.gitPullRequestDetail = null;
    this.gitPullRequestLoading = false;
    this.gitPullRequestLoaded = false;
    this.gitPullRequestError = "";
    this.gitPullRequestGeneration = 0;
    this.gitStashesCollapsed = localStorage.getItem("termdeck.git_stashes_collapsed") === "1";
    this.recentFiles = [];
    this.recentFilesRoot = null;
    this.recentFilesFingerprint = "";
    this.recentFilesBusy = false;
    this.recentFilesFetchedAt = 0;
    this.recentFilesExpanded = false;
    this.recentFilesWs = null;
    this.recentFilesWsRoot = "";
    this.recentFilesWsReconnectTimer = 0;
    this.recentFilesEventRefreshTimer = 0;
    this.sideView = "terminals";
    this.filesSidePanelCycleView = null;
    this.filesSidePanelCycleTransition = false;
    this.fileTypeFilterMenuMode = "name";
    const savedFilesTab = localStorage.getItem(FILES_SIDE_PANEL_LAST_TAB_KEY);
    this.lastFilesSidePanelTab = FILES_SIDE_PANEL_TABS.includes(savedFilesTab) ? savedFilesTab : "project";
    this.searchWord = false;
    this.searchCase = false;
    this.searchRegex = false;
    this.nameSearchCase = false;
    this.searchGeneration = 0;
    this.searchHistory = [];
    this.searchHistorySelection = -1;
    this.pendingSearchHistoryState = null;
    this.searchHistoryRecordTimer = 0;
    this.searchSelection = { content: -1, name: -1 };
    this.contentSearchTree = null;
    this.nameSearchTree = null;
    this.treeSearchFilter = null;
    this.terminalSearchMatches = new Map();
    this.terminalSearchClosedMatches = new Map();
    this.terminalTitleSearchResults = [];
    this.historySearchResults = [];
    this.historySearchOperations = false;
    this.terminalSearchGroupSimilar = false;
    this.terminalSearchAbort = null;
    this.terminalSearchTimer = 0;
    this.terminalSearchGroupId = null;
    this.terminalSearchWorktreeId = null;
    this.terminalSearchHoverHideTimer = 0;
    this.pendingHistorySearchNavigation = null;
    this.historySearchNavigationBusy = false;
    this.terminalFindSessionId = "";
    this.terminalFindQuery = "";
    this.terminalFindFallbackMatches = [];
    this.terminalFindFallbackIndex = -1;
    this.nameSearchGeneration = 0;
    this.applyingHistory = false;
    this.lastNavJson = "";
    this.hideInactiveTerminals = false;
    this.sessionActivityAt = new Map();
    this.sessionTitleEls = new Map();
    this.sessionSpinnerEls = new Map();
    this.sessionActivityEls = new Map();
    // Activity detail arrives only over the status websocket; /api/sessions doesn't carry it,
    // so it must survive refresh() replacing the session objects (same reason processingStates
    // and sessionModelById are maps, not session fields).
    this.sessionActivityById = new Map();
    this.sessionStatusEls = new Map();
    this.sessionRowEls = new Map();
    this.terminalAgeRefreshTimer = 0;
    this.sessionListSignature = "";
    this.dragGroupTimer = 0;
    this.dragGroupTargetKey = null;
    this.dragGroupHoverKey = null;
    this.sidebarSelectedSessionIds = new Set();
    this.sidebarSelectionAnchorId = null;
    this.contextMenuTarget = null;
    this.modalGroupId = null;
    this.modalAfterSessionId = null;
    this.worktreeReviewSessionId = null;
    this.revealActiveSessionOnLoad = true;
    this.processingStates = new Map();
    this.processingSince = new Map();
    this.attentionSessions = new Set();
    this.attentionTimers = new Map();
    this.attentionServerStates = new Map();
    // A prompt can be accepted by the PTY before the agent reports
    // processing=true. Keep that hand-off visible in Markdown mode.
    this.historyPendingProcessing = new Map();
    this.processingTimer = 0;
    this.pageTitleFaviconState = "plain";
    this.pageFavicon = document.querySelector('link[rel~="icon"]');
    this.pageFaviconHref = this.pageFavicon?.getAttribute("href") || "/static/favicon.svg";
    this.pageFaviconType = this.pageFavicon?.getAttribute("type") || "image/svg+xml";
    this.viewedCompletedSessions = new Set();
    this.unreadSessions = new Set();
    this.statHistory = [];
    this.editor = null;
    this.secondaryEditor = null;
    this.secondaryDiffEditor = null;
    this.secondaryFileKey = null;
    this.fileInspectorMode = null;
    this.fileBlameGeneration = 0;
    this.fileBlameActiveKey = null;
    this.fileBlameRecordsByLine = new Map();
    this.fileBlameAuthorWidth = 0;
    this.fileBlameLineNumberWidth = 0;
    this.fileBlameDecorationIds = [];
    this.fileGitHunkGeneration = 0;
    this.fileGitHunkDecorationIds = [];
    this.fileGitHunksByLine = new Map();
    this.fileGitHunkRefreshTimer = 0;
    this.fileOutlineTimer = 0;
    this.problemsOpen = false;
    this.problemsRefreshTimer = 0;
    this.quickOpenResults = [];
    this.quickOpenSelection = 0;
    this.quickOpenMode = "all";
    this.quickOpenTimer = 0;
    this.quickOpenGeneration = 0;
    this.conversationOutlineOpen = false;
    this.conversationOutlineSessionId = null;
    this.conversationOutlineTurnsBySession = new Map();
    this.lastSearchFiles = [];
    this.notebookEditor = null;
    this.notebookEditorModels = new Map();
    this.notebookMounted = false;
    this.notebookCopiesOpen = false;
    this.notebookExpandedCopy = null;
    this.notebookSearchIndex = 0;
    this.notebookTitleTimer = 0;
    this.notebookResizePointerId = null;
    this.selectionActionState = null;
    this.selectionCopyHistoryIndex = 0;
    this.selectionActionUpdateFrame = 0;
    this.selectionActionUpdateTimer = 0;
    this.pendingNewAgentSelection = "";
    this.pendingNewAgentSelectionUseHistory = false;
    this.nativeSessionIds = new Set();
    this.sessionModelById = new Map();
    this.selectedTreeRow = null;
    this.iconMap = null;
    this.lastValidNavState = null;
    this.statusWs = null;
    this.statusWsReconnectTimer = 0;
    this.mobileConnectionWarningTimer = 0;
    this.serverInstanceId = "";
    this.remoteIdleTimeoutMs = 0;
    this.remoteIdleLastInteractionAt = 0;
    this.remoteIdleTimer = 0;
    this.remoteIdleTransitioning = false;
    this.remoteBrowserEmail = "";
    this.remoteIdleActivityHandler = () => this.recordRemoteBrowserActivity();
    this.remoteIdleVisibilityHandler = () => this.handleRemoteBrowserVisibilityChange();
    this.mobileOnlineHandler = () => {
      this.reconnectFocusedConnections();
    };
    this.mobileOfflineHandler = () => this.setMobileConnectionWarning(true, "offline");
    this.focusedConnectionRecoveryHandler = () => this.reconnectFocusedConnections();
    this.layoutFitSettleTimer = 0;
    this.mobileOrientationChangeTimer = 0;
    this.mobileViewportResizeHandler = this.syncMobileVisualViewport.bind(this);
    this.mobileOrientationChangeHandler = this.scheduleMobileOrientationChange.bind(this);
    this.mobileOrientationFinishHandler = this.finishMobileOrientationChange.bind(this);
    this.sidebarResizeInProgress = false;
    this.sidebarResizeFinalFitFrame = 0;
    this.activeEditorFocusTimer = 0;
    this.projects = [];
    this.worktrees = [];
    this.worktreeId = "root";
    this.interactionWorktreeId = "root";
    this.renderWorktreeId = null;
    const fileModeRoute = location.pathname.startsWith("/f/");
    const gitModeRoute = location.pathname.startsWith("/g/");
    const projectMatch = location.pathname.match(/^\/[pfg]\/([^/]+)(?:\/([^/]+))?(?:\/(.*))?$/);
    this.projectSlug = projectMatch ? decodeURIComponent(projectMatch[1])
      : this.vscodeEditorMode ? (LOCATION_PARAMS.get("project") || null) : null;
    this.requestedWorktreeUrlSegment = projectMatch?.[2] ? decodeURIComponent(projectMatch[2]) : "";
    this.requestedNavigationPath = projectMatch?.[3]
      ? projectMatch[3].split("/").map((segment) => decodeURIComponent(segment)).join("/") : "";
    const urlParams = new URLSearchParams(location.search);
    this.worktreeId = String(urlParams.get("wt") || "root").trim() || "root";
    const requestedFileView = gitModeRoute ? "git"
      : ["project", "search", "git"].includes(urlParams.get("view")) ? urlParams.get("view") : "project";
    if (urlParams.get("t")) this.initialNav = { kind: "term", id: urlParams.get("t") };
    // Not gated on the route any more: an open diff is ?git_path= on the files route (older addresses put
    // it on /g/, which still arrives here with the same parameters).
    else if (urlParams.get("git_path")) {
      this.initialNav = { kind: "git-diff", path: urlParams.get("git_path"), scope: urlParams.get("git_scope") || "working",
        revision: urlParams.get("git_revision") || "", previous_path: urlParams.get("git_previous_path") || "",
        base: urlParams.get("git_base") || "", target: urlParams.get("git_target") || "" };
    } else if (fileModeRoute && this.requestedNavigationPath && urlParams.has("history")) {
      this.initialNav = { kind: "file-history-path", selector: this.requestedNavigationPath,
        mode: ["all", "local", "git"].includes(urlParams.get("history")) ? urlParams.get("history") : "all",
        selection: (urlParams.get("history_selection") || "").split(",").filter(Boolean), view: requestedFileView };
    }
    else if (urlParams.get("f") && urlParams.has("history")) {
      this.initialNav = { kind: "file-history", key: urlParams.get("f"),
        mode: ["all", "local", "git"].includes(urlParams.get("history")) ? urlParams.get("history") : "all",
        selection: (urlParams.get("history_selection") || "").split(",").filter(Boolean), view: requestedFileView };
    } else if (urlParams.get("f")) {
      this.initialNav = {
        kind: "open-file",
        key: urlParams.get("f"),
        view: requestedFileView,
        return_to: String(urlParams.get("rt") || "").trim(),
      };
    } else if ((fileModeRoute || gitModeRoute) && this.requestedNavigationPath) {
      // A path segment on /g/ is a file, not part of the git route: TermDeck used to put an open file
      // there whenever the Git panel was up, and those addresses are in people's history and bookmarks.
      // They open the file with the Git panel selected, which is what they always meant.
      this.initialNav = { kind: "path", selector: this.requestedNavigationPath, view: requestedFileView };
    } else if (fileModeRoute || gitModeRoute || ["project", "search", "git"].includes(urlParams.get("view"))) {
      this.initialNav = { kind: "files", view: requestedFileView, q: urlParams.get("q") || "" };
    }
    else if (urlParams.get("q")) {
      this.initialNav = { kind: "search", q: urlParams.get("q"), glob: urlParams.get("glob") || "",
                          word: urlParams.get("w") === "1", case_sensitive: urlParams.get("c") === "1",
                          regex: urlParams.get("re") === "1" };
    } else this.initialNav = this.requestedNavigationPath ? { kind: "path", selector: this.requestedNavigationPath } : null;
    this.$ = (id) => document.getElementById(id);
    this.ensureDesktopTerminalsHeader();
    this.applyVscodeModeLayout();
  }

  touchMobileLayoutEnabled() {
    return window.matchMedia("(max-width: 900px), (hover: none) and (pointer: coarse)").matches;
  }

  browserBooleanSetting(storageKey, fallback) {
    const stored = localStorage.getItem(storageKey);
    return stored == null ? !!fallback : stored === "1";
  }

  setBrowserBooleanSetting(storageKey, enabled) {
    localStorage.setItem(storageKey, enabled ? "1" : "0");
  }

  initializeBrowserRendererSettings() {
    if (localStorage.getItem(BROWSER_TALL_WEBGL_KEY) == null) {
      this.setBrowserBooleanSetting(BROWSER_TALL_WEBGL_KEY, true);
    }
  }

  mobileDisplayScale() {
    const stored = Number(localStorage.getItem(MOBILE_DISPLAY_SCALE_KEY));
    if (!Number.isFinite(stored) || stored <= 0) return 1;
    return Math.max(MOBILE_DISPLAY_SCALE_MIN, Math.min(MOBILE_DISPLAY_SCALE_MAX, stored));
  }

  displayScale() {
    return this.touchMobileLayoutEnabled() ? this.mobileDisplayScale() : 1;
  }

  scaledSettingSize(key) {
    const configured = this.touchMobileLayoutEnabled() ? SETTINGS_DEFAULTS[key] : this.settings[key];
    const base = Number(configured) || SETTINGS_DEFAULTS[key];
    return Math.round(base * this.displayScale() * 100) / 100;
  }

  setMobileDisplayScale(scale) {
    const normalized = Math.max(MOBILE_DISPLAY_SCALE_MIN, Math.min(MOBILE_DISPLAY_SCALE_MAX,
      Math.round(Number(scale) / MOBILE_DISPLAY_SCALE_STEP) * MOBILE_DISPLAY_SCALE_STEP));
    localStorage.setItem(MOBILE_DISPLAY_SCALE_KEY, String(normalized));
    this.applySettings();
  }

  mobileSidebarPinned() {
    return localStorage.getItem(MOBILE_SIDEBAR_PINNED_KEY) === "1";
  }

  syncMobileSidebarControls() {
    const pinned = this.mobileSidebarPinned();
    document.body.classList.toggle("mobile-sidebar-pinned", pinned);
    const pin = this.$("mobile-sidebar-pin");
    if (!pin) return;
    pin.setAttribute("aria-pressed", String(pinned));
    pin.title = pinned ? "Unpin sidebar" : "Keep sidebar open after selection";
    pin.setAttribute("aria-label", pin.title);
    const icon = pin.querySelector(".codicon");
    icon?.classList.toggle("codicon-pin", !pinned);
    icon?.classList.toggle("codicon-pinned", pinned);
  }

  setMobileSidebarCollapsed(collapsed) {
    if (!this.touchMobileLayoutEnabled()) return;
    const next = !!collapsed && !this.mobileSidebarPinned();
    document.body.classList.toggle("mobile-sidebar-collapsed", next);
    if (!next) this.closeHistoryFilterMenu?.();
    document.body.scrollTo({ left: 0, behavior: "auto" });
    requestAnimationFrame(() => {
      this.syncMobileVisualViewport();
      this.scheduleTerminalLayoutFit();
    });
  }

  collapseMobileSidebarAfterSelection() {
    if (this.touchMobileLayoutEnabled() && !this.mobileSidebarPinned()) this.setMobileSidebarCollapsed(true);
  }

  initializeMobileSidebar() {
    if (!this.touchMobileLayoutEnabled()) return;
    document.body.classList.add("mobile-touch-layout");
    document.body.classList.toggle("mobile-sidebar-collapsed", !this.mobileSidebarPinned());
    this.syncMobileSidebarControls();
    this.$("mobile-sidebar-collapse").onclick = () => this.setMobileSidebarCollapsed(true);
    this.$("mobile-sidebar-toggle").onclick = () => this.setMobileSidebarCollapsed(false);
    this.$("mobile-display-smaller").onclick = () => this.setMobileDisplayScale(this.mobileDisplayScale() - MOBILE_DISPLAY_SCALE_STEP);
    this.$("mobile-display-larger").onclick = () => this.setMobileDisplayScale(this.mobileDisplayScale() + MOBILE_DISPLAY_SCALE_STEP);
    this.$("mobile-sidebar-pin").onclick = () => {
      const pinned = !this.mobileSidebarPinned();
      localStorage.setItem(MOBILE_SIDEBAR_PINNED_KEY, pinned ? "1" : "0");
      this.syncMobileSidebarControls();
      if (pinned) this.setMobileSidebarCollapsed(false);
    };
  }

  syncMobileVisualViewport() {
    const viewport = window.visualViewport;
    if (!this.touchMobileLayoutEnabled() || !viewport || !Number.isFinite(viewport.height) || viewport.height <= 0) {
      document.documentElement.style.removeProperty("--mobile-visual-height");
      return;
    }
    document.documentElement.style.setProperty("--mobile-visual-height", `${Math.round(viewport.height)}px`);
  }

  scheduleMobileOrientationChange() {
    clearTimeout(this.mobileOrientationChangeTimer);
    this.mobileOrientationChangeTimer = window.setTimeout(this.mobileOrientationFinishHandler, 250);
  }

  finishMobileOrientationChange() {
    this.mobileOrientationChangeTimer = 0;
    this.syncMobileVisualViewport();
    const scrollingElement = document.scrollingElement;
    if (scrollingElement) scrollingElement.scrollTop = 0;
    this.scheduleTerminalLayoutFit();
  }

  projectQuery() {
    if (!this.projectSlug) return "";
    const params = new URLSearchParams({ project: this.projectSlug });
    if (this.worktreeId !== ALL_WORKTREES_ID) params.set("worktree_id", this.worktreeId || "root");
    return `?${params}`;
  }

  worktreeForUrlSegment(segment) {
    const value = String(segment || "").trim();
    if (!value) return null;
    if (value === ALL_WORKTREES_ID) {
      return this.worktrees.filter((worktree) => worktree.available).length > 1
        ? { id: ALL_WORKTREES_ID, branch: ALL_WORKTREES_ID, name: ALL_WORKTREES_ID } : null;
    }
    const exactId = this.worktrees.find((worktree) => worktree.available && worktree.id === value);
    if (exactId) return exactId;
    const branchMatches = this.worktrees.filter((worktree) => worktree.available && String(worktree.branch || "") === value);
    if (branchMatches.length) return branchMatches.length === 1 ? branchMatches[0] : null;
    const nameMatches = this.worktrees.filter((worktree) => worktree.available && String(worktree.name || "") === value);
    return nameMatches.length === 1 ? nameMatches[0] : null;
  }

  worktreeUrlSegment(worktreeId = this.stateWorktreeId()) {
    if (worktreeId === ALL_WORKTREES_ID) return ALL_WORKTREES_ID;
    const worktree = this.worktrees.find((candidate) => candidate.id === (worktreeId || "root"));
    return String(worktree?.branch || worktree?.name || worktreeId || "root");
  }

  encodedProjectWorktreePath(project = this.projectSlug, worktreeId = this.stateWorktreeId()) {
    if (!project) return location.pathname;
    return `/p/${encodeURIComponent(project)}/${encodeURIComponent(this.worktreeUrlSegment(worktreeId))}`;
  }

  encodedFileModeWorktreePath(project = this.projectSlug, worktreeId = this.stateWorktreeId()) {
    if (!project) return location.pathname;
    return `/f/${encodeURIComponent(project)}/${encodeURIComponent(this.worktreeUrlSegment(worktreeId))}`;
  }

  encodedRelativeFilePath(path) {
    return String(path || "").split("/").filter(Boolean).map((segment) => encodeURIComponent(segment)).join("/");
  }

  normalizedFileSystemPath(path) {
    const normalized = String(path || "").replaceAll("\\", "/").replace(/\/{2,}/g, "/");
    return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
  }

  relativeNavigationPathForFileKey(key) {
    const separator = String(key || "").indexOf("|");
    if (separator <= 0) return "";
    const worktreeRoot = this.normalizedFileSystemPath(this.worktreeRoot());
    const fileRoot = this.normalizedFileSystemPath(String(key).slice(0, separator));
    const filePath = this.normalizedFileSystemPath(String(key).slice(separator + 1));
    const absoluteFilePath = filePath.startsWith("/") ? filePath : this.normalizedFileSystemPath(`${fileRoot}/${filePath}`);
    if (!worktreeRoot || absoluteFilePath === worktreeRoot || !absoluteFilePath.startsWith(`${worktreeRoot}/`)) return "";
    return this.encodedRelativeFilePath(absoluteFilePath.slice(worktreeRoot.length + 1));
  }

  applyVscodeModeLayout() {
    document.body.classList.toggle("vscode-mode", this.vscodeMode);
    document.body.classList.toggle("vscode-native-mode", this.nativeVscodeMode);
    document.body.classList.toggle("vscode-editor-mode", this.vscodeEditorMode);
    if (!this.vscodeMode) return;
    const forceHidden = ["active-toggle", "view-project", "view-search", "view-git", "files-section", "side-split",
      "project-worktree-header", "project-select", "project-select-label"];
    for (const id of forceHidden) {
      const el = this.$(id);
      if (el) {
        el.style.display = "none";
        el.classList.add("hidden");
      }
    }
    this.setSideView("terminals", false);
  }

  applyHostModeState({ vscode, nativeTerminal }) {
    const nextVscodeMode = parseModeFlag(vscode);
    const nextNativeMode = typeof nativeTerminal === "undefined" ? this.nativeVscodeMode : parseModeFlag(nativeTerminal);
    const shouldRefreshNative = !this.hostStatePatched && nextVscodeMode && nextNativeMode &&
      (this.vscodeMode !== nextVscodeMode || this.nativeVscodeMode !== nextNativeMode);
    this.vscodeMode = nextVscodeMode;
    this.nativeVscodeMode = nextNativeMode;
    this.hostStatePatched = true;
    this.applyVscodeModeLayout();
    if (shouldRefreshNative) void this.refresh();
  }

  applyVscodeContextState(payload) {
    const nextWorkspaceRoot = typeof payload.workspaceRoot === "string" ? payload.workspaceRoot
      : typeof payload.workspace_root === "string" ? payload.workspace_root : "";
    const nextProjectName = typeof payload.projectName === "string" ? payload.projectName
      : typeof payload.project_name === "string" ? payload.project_name : null;
    if (nextWorkspaceRoot) this.vscodeWorkspaceRoot = nextWorkspaceRoot;
    this.vscodeProjectName = nextProjectName === null ? this.vscodeProjectName : nextProjectName;
    if (!this.vscodeProjectName) this.vscodeProjectName = "";
  }

  projectFallbackFromWorkspaceRoot() {
    if (!this.vscodeMode || !this.vscodeWorkspaceRoot || !this.projects.length) return "";
    const fallback = this.projects.find((candidate) => {
      const root = String(candidate.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
      const source = this.vscodeWorkspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
      return root === source;
    });
    if (!fallback) return "";
    this.vscodeProjectName = fallback.name;
    return fallback.root;
  }

  applyVscodeDefaultProjectState() {
    if (!this.vscodeMode) {
      if (this.vscodeProjectName) {
        if (this.projectSlug !== this.vscodeProjectName) this.projectSlug = this.vscodeProjectName;
        this.updateHeaderPickerDisplay("project");
        return;
      }
      if (this.projectFallbackFromWorkspaceRoot()) {
        this.projectSlug = this.vscodeProjectName;
        return;
      }
      this.projectSlug = this.projectSlug || null;
      return;
    }
    if (!this.vscodeEditorMode) this.projectSlug = null;
    return;
  }

  resolveVscodeDefaultCwd() {
    const workspaceRoot = this.vscodeWorkspaceRoot || WORKSPACE_ROOT_QUERY;
    if (workspaceRoot) return workspaceRoot;
    if (this.vscodeMode) {
      const fallback = this.projectFallbackFromWorkspaceRoot();
      if (fallback) return fallback;
    }
    const activeSession = this.session(this.activeId);
    return activeSession?.cwd || this.projectRoot() || DEFAULT_CWD;
  }

  handleHostMessage(event) {
    if (!event?.data) return;
    if (event.data.type === "termdeck-action") {
      const action = String(event.data.action || "");
      const payload = event.data.payload || {};
      if (!action) return;
      if (action === "new-terminal" || action === "new-group" || action === "vscode-refresh" || action === "vscode-reload") {
        this.runAction(action);
        return;
      }
      if (action === "select-session") {
        const sessionId = String(payload.session_id || payload.sessionId || "");
        if (sessionId) {
          if (this.session(sessionId)) this.activate(sessionId, { reveal: false });
          else void this.refresh().then(() => {
            if (this.session(sessionId)) this.activate(sessionId, { reveal: false });
          });
        }
        return;
      }
      if (action === "toggle-history") {
        this.toggleHistory();
        return;
      }
      if (action === "set-history") {
        this.setHistoryMode(!!payload.enabled);
        return;
      }
      if (action === "refresh") {
        this.requestVscodeRefresh(!!payload.hard);
        return;
      }
      return;
    }
    if (event.data.type !== "termdeck-host-state") return;
    if (typeof event.data.vscode === "undefined") return;
    const previousProjectSlug = this.projectSlug;
    this.applyHostModeState({
      vscode: event.data.vscode,
      native_terminal: event.data.native_terminal,
    });
    this.applyVscodeContextState(event.data);
    this.applyVscodeDefaultProjectState();
    if (this.vscodeEditorMode && this.vscodeProjectName && this.projectSlug !== this.vscodeProjectName) {
      this.projectSlug = this.vscodeProjectName;
    }
    if (this.projectSlug && this.projectSlug !== previousProjectSlug) {
      void this.refresh();
    }
  }

  projectStateKeyFor(worktreeId) {
    const project = this.projectSlug || "__all__";
    return worktreeId && worktreeId !== "root" ? `${project}::worktree:${worktreeId}` : project;
  }

  stateWorktreeId() {
    if (this.renderWorktreeId) return this.renderWorktreeId;
    if (this.worktreeId === ALL_WORKTREES_ID) return this.interactionWorktreeId || "root";
    return this.worktreeId || "root";
  }

  projectStateKey() {
    return this.projectStateKeyFor(this.stateWorktreeId());
  }

  getProjectStateForWorktree(worktreeId) {
    const states = this.settings.project_state || {};
    const key = this.projectStateKeyFor(worktreeId || "root");
    const state = states[key] || {};
    return {
      active_session_id: "", open_files: [], open_files_collapsed: false, recent_files_collapsed: true,
      recent_file_exclude_glob: "!*.json, !*.log, !*.csv",
      recently_opened_terminal_ids: [], unread_sessions: [],
      terminal_groups: [], session_groups: {}, session_view_modes: {},
      notebook_notes: [], notebook_active_note_id: "", notebook_notes_initialized: false, notebook_text: "",
      selection_copy_history: [], selection_copy_history_initialized: false,
      ...state,
      recent_files_collapsed: state.recent_files_collapsed ?? true,
    };
  }

  getProjectState() {
    return this.getProjectStateForWorktree(this.stateWorktreeId());
  }

  worktreeSectionStorageKey(worktreeId, field) {
    return `termdeck.${this.projectSlug || "__all__"}.worktree.${worktreeId}.${field}`;
  }

  worktreeSectionCollapsed(worktreeId) {
    const saved = this.settings.worktree_ui_state?.[this.worktreeSectionStorageKey(worktreeId, "state")];
    if (saved && typeof saved.collapsed === "boolean") return saved.collapsed;
    try {
      return window.localStorage.getItem(this.worktreeSectionStorageKey(worktreeId, "collapsed")) === "1";
    } catch (error) {
      return false;
    }
  }

  setWorktreeSectionCollapsed(worktreeId, collapsed) {
    const key = this.worktreeSectionStorageKey(worktreeId, "state");
    const current = this.settings.worktree_ui_state?.[key] || {};
    this.settings.worktree_ui_state = { ...(this.settings.worktree_ui_state || {}),
      [key]: { ...current, collapsed: !!collapsed } };
    this.saveSettings();
    try {
      window.localStorage.setItem(this.worktreeSectionStorageKey(worktreeId, "collapsed"), collapsed ? "1" : "0");
    } catch (error) {
      return;
    }
  }

  worktreeClosedExpanded(worktreeId) {
    if (this.worktreeId !== ALL_WORKTREES_ID) return this.closedExpanded;
    const saved = this.settings.worktree_ui_state?.[this.worktreeSectionStorageKey(worktreeId, "state")];
    if (saved && typeof saved.closed_expanded === "boolean") return saved.closed_expanded;
    try {
      const stored = window.localStorage.getItem(this.worktreeSectionStorageKey(worktreeId, "closed-expanded"));
      return stored === null ? false : stored === "1";
    } catch (error) {
      return false;
    }
  }

  setWorktreeClosedExpanded(worktreeId, expanded) {
    if (this.worktreeId !== ALL_WORKTREES_ID) {
      this.closedExpanded = expanded;
    }
    const key = this.worktreeSectionStorageKey(worktreeId, "state");
    const current = this.settings.worktree_ui_state?.[key] || {};
    this.settings.worktree_ui_state = { ...(this.settings.worktree_ui_state || {}),
      [key]: { ...current, closed_expanded: !!expanded } };
    this.saveSettings();
    try {
      window.localStorage.setItem(this.worktreeSectionStorageKey(worktreeId, "closed-expanded"), expanded ? "1" : "0");
    } catch (error) {
      return;
    }
  }

  worktreeIdForSession(session) {
    return String(session?.worktree_id || "root").trim() || "root";
  }

  sessionsForWorktree(worktreeId, sessions = this.sessions) {
    return sessions.filter((session) => this.worktreeIdForSession(session) === worktreeId);
  }

  setInteractionWorktreeFromElement(element, fallbackSession = null) {
    if (this.worktreeId !== ALL_WORKTREES_ID) return;
    const worktreeId = String(element?.dataset?.worktreeId || this.worktreeIdForSession(fallbackSession)).trim();
    if (worktreeId && worktreeId !== ALL_WORKTREES_ID && this.interactionWorktreeId !== worktreeId) {
      this.interactionWorktreeId = worktreeId;
      this.updateRecentFilesWatch();
    }
  }

  availableWorktreeSections() {
    const sections = this.worktrees.filter((worktree) => worktree.available).map((worktree) => ({ ...worktree }));
    const knownIds = new Set(sections.map((worktree) => String(worktree.id)));
    const records = [...this.sessions, ...this.closedSessions];
    for (const record of records) {
      const id = this.worktreeIdForSession(record);
      if (knownIds.has(id)) continue;
      knownIds.add(id);
      sections.push({ id, name: id === "root" ? "Project root" : `Worktree ${id}`, branch: "", path: "", available: true });
    }
    if (!sections.length && this.projectSlug) {
      sections.push({ id: "root", name: this.projectSlug, branch: "", path: this.projectRoot() || "", available: true });
    }
    return sections;
  }

  unreadSessionIdsForCurrentWorktreeView() {
    if (this.worktreeId !== ALL_WORKTREES_ID) return new Set(this.getProjectState().unread_sessions || []);
    const project = this.projectSlug || "__all__";
    const prefix = `${project}::worktree:`;
    const ids = new Set();
    for (const [key, state] of Object.entries(this.settings.project_state || {})) {
      if (key !== project && !key.startsWith(prefix)) continue;
      for (const sessionId of state.unread_sessions || []) ids.add(sessionId);
    }
    return ids;
  }

  patchProjectState(patch) {
    const resourceFields = new Set(["terminal_groups", "session_groups", "terminal_layout", "session_order",
      "unread_sessions", "recently_opened_terminal_ids", "session_view_modes"]);
    const invalidFields = Object.keys(patch).filter((field) => resourceFields.has(field));
    if (invalidFields.length) throw new Error(`project resources require targeted APIs: ${invalidFields.join(", ")}`);
    const states = this.settings.project_state || {};
    const stateKey = this.projectStateKey();
    states[stateKey] = { ...this.getProjectState(), ...patch };
    this.settings.project_state = states;
    this.queueProjectStatePatch(stateKey, patch);
  }

  projectStateSearchParams(stateKey) {
    const params = new URLSearchParams();
    if (stateKey !== "__all__") {
      const [projectName, worktreeId] = stateKey.split("::worktree:");
      params.set("project", projectName);
      params.set("worktree_id", worktreeId || "root");
    }
    return params;
  }

  applyLocalProjectStatePatch(patch, stateKey = this.projectStateKey()) {
    const states = this.settings.project_state || {};
    const current = states[stateKey] || {};
    states[stateKey] = { ...current, ...patch };
    this.settings.project_state = states;
  }

  async refreshCurrentProjectState() {
    const stateKey = this.projectStateKey();
    // Captured before the first await, not after: this runs when the tab becomes visible, which is
    // exactly when a notification click hands the user back to the deck and they immediately act.
    // Anything they do from here on is newer than what the fetch returns, and applying the response
    // then reverted the selected terminal and the transcript/terminal mode under them
    // (reconcileActiveSessionViewMode forces the mode back to the fetched copy), which read as
    // clicks not registering.
    const revision = this.projectStateLocalRevision || 0;
    await this.projectStateSavePromise;
    const params = this.projectStateSearchParams(stateKey);
    let response;
    try {
      response = await fetch(`/api/terminal-layout?${params}`);
    } catch (error) {
      return;
    }
    if (!response.ok || stateKey !== this.projectStateKey()) return;
    const payload = await response.json();
    if ((this.projectStateLocalRevision || 0) !== revision) return;
    const nextState = {};
    for (const field of ["active_session_id", "open_files", "open_files_collapsed", "recent_files_collapsed",
      "recent_file_exclude_glob", "recently_opened_terminal_ids", "session_order", "pinned_sessions", "pinned_groups",
      "unread_sessions", "terminal_groups", "session_groups", "terminal_layout", "session_view_modes", "notebook_notes",
      "notebook_active_note_id", "notebook_notes_initialized", "notebook_text", "selection_copy_history",
      "selection_copy_history_initialized"]) {
      if (Object.prototype.hasOwnProperty.call(payload, field)) nextState[field] = payload[field];
    }
    const previous = this.settings.project_state?.[stateKey] || {};
    if (JSON.stringify(previous) === JSON.stringify(nextState)) {
      this.reconcileActiveSessionViewMode();
      return;
    }
    this.applyLocalProjectStatePatch(nextState, stateKey);
    this.unreadSessions = this.unreadSessionIdsForCurrentWorktreeView();
    this.renderList();
    this.reconcileActiveSessionViewMode();
  }

  queueProjectResourceRequest(stateKey, path, method, body = null) {
    // Every local change to project state goes through here, so this counter is how a refresh
    // in flight can tell that what it fetched is already out of date.
    this.projectStateLocalRevision = (this.projectStateLocalRevision || 0) + 1;
    const params = this.projectStateSearchParams(stateKey);
    const separator = path.includes("?") ? "&" : "?";
    const query = params.toString();
    const url = query ? `${path}${separator}${query}` : path;
    const payload = body === null ? "" : JSON.stringify(this.copySettings(body));
    this.projectStateSavePromise = this.projectStateSavePromise.catch((error) => {
      console.error("TermDeck project resource save failed", error);
    }).then(async () => {
      let response;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetch(url, { method, keepalive: payload.length < 60000,
            headers: payload ? { "Content-Type": "application/json" } : {}, body: payload || undefined });
          if (response.ok || response.status < 500) break;
        } catch (error) {
          if (attempt === 1) throw error;
        }
      }
      if (!response?.ok) throw new Error(`project resource save failed (${response?.status || "network"})`);
    }).catch((error) => {
      console.error("TermDeck project resource save failed", error);
      const status = this.$("stat-text");
      if (status) status.textContent = error.message;
      void this.refreshCurrentProjectState();
    });
  }

  queueProjectStatePatch(stateKey, patch) {
    for (const [field, value] of Object.entries(patch)) {
      this.queueProjectResourceRequest(stateKey, `/api/project-state/${encodeURIComponent(field)}`, "PUT", { value });
    }
  }

  queueTerminalGroupCreate(group, sessionIds = [], anchorToken = "", after = false, stateKey = this.projectStateKey()) {
    this.queueProjectResourceRequest(stateKey, "/api/terminal-groups", "POST", {
      group_id: group.id, name: group.name, collapsed: !!group.collapsed,
      session_ids: sessionIds, anchor_token: anchorToken, after,
    });
  }

  queueTerminalGroupUpdate(groupId, patch, stateKey = this.projectStateKey()) {
    this.queueProjectResourceRequest(stateKey, `/api/terminal-groups/${encodeURIComponent(groupId)}`, "PATCH", patch);
  }

  queueTerminalGroupDelete(groupId, stateKey = this.projectStateKey()) {
    this.queueProjectResourceRequest(stateKey, `/api/terminal-groups/${encodeURIComponent(groupId)}`, "DELETE");
  }

  queueTerminalGroupMerge(sourceGroupId, targetGroupId, stateKey = this.projectStateKey()) {
    this.queueProjectResourceRequest(stateKey, `/api/terminal-groups/${encodeURIComponent(sourceGroupId)}/merge`, "POST",
      { target_group_id: targetGroupId });
  }

  queueSessionGroupAssignments(assignments, targetSessionId = "", after = false, stateKey = this.projectStateKey()) {
    this.queueProjectResourceRequest(stateKey, "/api/session-group-assignments", "PUT",
      { assignments, target_session_id: targetSessionId || "", after });
  }

  queueTerminalLayoutMove(token, targetToken = "", after = false, toTop = false, stateKey = this.projectStateKey()) {
    this.queueProjectResourceRequest(stateKey, "/api/terminal-layout/move", "PATCH",
      { token, target_token: targetToken, after, to_top: toTop });
  }

  queueSessionOrderMove(sessionIds, targetSessionId = "", after = false, stateKey = this.projectStateKey()) {
    this.queueProjectResourceRequest(stateKey, "/api/session-order/move", "PATCH",
      { session_ids: sessionIds, target_session_id: targetSessionId, after });
  }

  persistUnreadSessionDelta(sessionIds, unread) {
    const idsByStateKey = new Map();
    const project = this.projectSlug || "__all__";
    const prefix = `${project}::worktree:`;
    for (const sessionId of [...new Set(sessionIds)].filter(Boolean)) {
      const session = this.session(sessionId);
      let stateKeys = session ? [this.projectStateKeyFor(this.worktreeIdForSession(session))] : [];
      if (!stateKeys.length) {
        stateKeys = Object.entries(this.settings.project_state || {})
          .filter(([key, state]) => (key === project || key.startsWith(prefix)) &&
            (state.unread_sessions || []).includes(sessionId))
          .map(([key]) => key);
      }
      if (!stateKeys.length) stateKeys = [this.projectStateKey()];
      for (const stateKey of stateKeys) {
        if (!idsByStateKey.has(stateKey)) idsByStateKey.set(stateKey, []);
        idsByStateKey.get(stateKey).push(sessionId);
      }
    }
    for (const [stateKey, ids] of idsByStateKey) {
      const current = this.settings.project_state?.[stateKey] || {};
      const unreadIds = new Set(current.unread_sessions || []);
      for (const sessionId of ids) {
        if (unread) unreadIds.add(sessionId);
        else unreadIds.delete(sessionId);
      }
      this.applyLocalProjectStatePatch({ unread_sessions: [...unreadIds] }, stateKey);
      this.queueProjectResourceRequest(stateKey, "/api/session-unread", "PUT", { session_ids: ids, unread });
    }
  }

  rememberRecentlyOpenedTerminal(sessionId) {
    if (!sessionId || !this.session(sessionId)) return;
    const current = this.getProjectState().recently_opened_terminal_ids || [];
    const next = [sessionId, ...current.filter((id) => id !== sessionId)].slice(0, RECENTLY_OPENED_TERMINALS_MAX_ENTRIES);
    if (next.length === current.length && next.every((id, index) => id === current[index])) return;
    this.applyLocalProjectStatePatch({ recently_opened_terminal_ids: next });
    this.queueProjectResourceRequest(this.projectStateKey(),
      `/api/recently-opened-terminals/${encodeURIComponent(sessionId)}`, "POST");
  }

  previouslyOpenedTerminalId(excludedSessionIds) {
    const excluded = excludedSessionIds instanceof Set ? excludedSessionIds : new Set(excludedSessionIds || []);
    for (const sessionId of this.getProjectState().recently_opened_terminal_ids || []) {
      if (!excluded.has(sessionId) && this.session(sessionId)) return sessionId;
    }
    return "";
  }

  sectionCollapsed(field) {
    return !!this.getProjectState()[field];
  }

  setSectionCollapsed(field, collapsed) {
    this.patchProjectState({ [field]: collapsed });
    try {
      window.localStorage.setItem(`termdeck.${this.projectStateKey()}.${field}`, collapsed ? "1" : "0");
    } catch (error) {
      // The server-backed project state is still updated.
    }
  }

  toggleSectionCollapsed(field) {
    const collapsed = !this.sectionCollapsed(field);
    this.setSectionCollapsed(field, collapsed);
    this.renderList();
    if (field !== "recent_files_collapsed") return;
    this.updateRecentFilesWatch();
    if (!collapsed) void this.refreshRecentFiles(true);
  }

  recentFilesVisibleRoot() {
    const activeRoot = this.session(this.activeId)?.cwd || this.worktreeRoot();
    const filesVisible = !this.$("files-section").classList.contains("hidden");
    return (filesVisible && this.treeRoot) || activeRoot || "";
  }

  updateRecentFilesWatch() {
    const root = this.recentFilesVisibleRoot();
    if (this.vscodeMode || document.hidden || this.sectionCollapsed("recent_files_collapsed") || !root) {
      this.disconnectRecentFilesWatch();
      return;
    }
    if (this.recentFilesWs && this.recentFilesWsRoot === root &&
        (this.recentFilesWs.readyState === WebSocket.CONNECTING || this.recentFilesWs.readyState === WebSocket.OPEN)) return;
    this.disconnectRecentFilesWatch();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}${FILE_TREE_WS_ROUTE}?root=${encodeURIComponent(root)}`);
    this.recentFilesWs = socket;
    this.recentFilesWsRoot = root;
    socket.onmessage = (event) => {
      if (this.recentFilesWs !== socket) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        if (error instanceof SyntaxError) return;
        throw error;
      }
      if (message.type === FILE_TREE_CHANGED) this.queueRecentFilesEventRefresh();
    };
    socket.onclose = () => {
      if (this.recentFilesWs !== socket) return;
      this.recentFilesWs = null;
      this.recentFilesWsRoot = "";
      if (document.hidden || this.sectionCollapsed("recent_files_collapsed")) return;
      clearTimeout(this.recentFilesWsReconnectTimer);
      this.recentFilesWsReconnectTimer = window.setTimeout(() => {
        this.recentFilesWsReconnectTimer = 0;
        this.updateRecentFilesWatch();
      }, 5000);
    };
  }

  disconnectRecentFilesWatch() {
    clearTimeout(this.recentFilesWsReconnectTimer);
    this.recentFilesWsReconnectTimer = 0;
    clearTimeout(this.recentFilesEventRefreshTimer);
    this.recentFilesEventRefreshTimer = 0;
    const socket = this.recentFilesWs;
    this.recentFilesWs = null;
    this.recentFilesWsRoot = "";
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  }

  queueRecentFilesEventRefresh() {
    if (this.sectionCollapsed("recent_files_collapsed") || document.hidden) return;
    clearTimeout(this.recentFilesEventRefreshTimer);
    this.recentFilesEventRefreshTimer = window.setTimeout(() => {
      this.recentFilesEventRefreshTimer = 0;
      void this.refreshRecentFiles();
    }, RECENT_FILES_EVENT_DEBOUNCE_MS);
  }

  terminalGroups() {
    return this.terminalGroupsForWorktree();
  }

  terminalGroupsForWorktree(worktreeId = this.stateWorktreeId()) {
    return (this.getProjectStateForWorktree(worktreeId).terminal_groups || [])
      .filter((group) => group && group.id && String(group.name || "").trim())
      .map((group) => ({ id: String(group.id), name: String(group.name).trim(), collapsed: !!group.collapsed }));
  }

  terminalGroupNameForSession(sessionId, worktreeId = this.stateWorktreeId()) {
    const groupId = this.getProjectStateForWorktree(worktreeId).session_groups?.[sessionId];
    return this.terminalGroupsForWorktree(worktreeId).find((group) => group.id === groupId)?.name || "";
  }

  async createTerminalGroup() {
    const name = await uiPrompt("Name for the terminal group", "New group");
    if (!name || !name.trim()) return;
    const groups = this.terminalGroups();
    const group = { id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: name.trim(), collapsed: false };
    this.applyLocalProjectStatePatch({ terminal_groups: [...groups, group] });
    this.queueTerminalGroupCreate(group);
    this.renderList();
  }

  async renameTerminalGroup(groupId) {
    const group = this.terminalGroups().find((candidate) => candidate.id === groupId);
    if (!group) return;
    const name = await uiPrompt("Rename terminal group", group.name);
    if (!name || !name.trim() || name.trim() === group.name) return;
    const groups = this.terminalGroups().map((candidate) => candidate.id === groupId
      ? { ...candidate, name: name.trim() } : candidate);
    this.applyLocalProjectStatePatch({ terminal_groups: groups });
    this.queueTerminalGroupUpdate(groupId, { name: name.trim() });
    this.renderList();
  }

  async deleteTerminalGroup(groupId) {
    const group = this.terminalGroups().find((candidate) => candidate.id === groupId);
    if (!group || !await uiConfirm(`Delete group "${group.name}"? Terminals will remain ungrouped.`)) return;
    this.applyLocalProjectStatePatch(this.terminalGroupDeletionPatch(groupId));
    this.queueTerminalGroupDelete(groupId);
    this.renderList();
  }

  terminalGroupDeletionPatch(groupId) {
    const state = this.getProjectState();
    const sessionGroups = { ...(state.session_groups || {}) };
    const availableIds = new Set(this.sessionsForWorktree(this.stateWorktreeId()).map((session) => session.session_id));
    const memberIds = (state.session_order || [])
      .filter((sessionId) => availableIds.has(sessionId) && sessionGroups[sessionId] === groupId);
    memberIds.push(...Object.entries(sessionGroups)
      .filter(([sessionId, assignedGroupId]) => assignedGroupId === groupId && availableIds.has(sessionId) &&
        !memberIds.includes(sessionId))
      .map(([sessionId]) => sessionId));
    for (const [sessionId, assignedGroupId] of Object.entries(sessionGroups)) {
      if (assignedGroupId === groupId) delete sessionGroups[sessionId];
    }
    const groupToken = `group:${groupId}`;
    const layout = this.terminalLayout();
    const groupIndex = layout.includes(groupToken) ? layout.indexOf(groupToken) : layout.length;
    const terminalLayout = layout.filter((entry) => entry !== groupToken);
    terminalLayout.splice(groupIndex, 0, ...memberIds.map((sessionId) => `session:${sessionId}`)
      .filter((entry) => !terminalLayout.includes(entry)));
    return {
      terminal_groups: this.terminalGroups().filter((candidate) => candidate.id !== groupId),
      session_groups: sessionGroups,
      terminal_layout: terminalLayout,
    };
  }

  toggleTerminalGroup(groupId) {
    const current = this.terminalGroups().find((group) => group.id === groupId);
    if (!current) return;
    const collapsed = !current.collapsed;
    const groups = this.terminalGroups().map((group) => group.id === groupId
      ? { ...group, collapsed } : group);
    this.applyLocalProjectStatePatch({ terminal_groups: groups });
    this.queueTerminalGroupUpdate(groupId, { collapsed });
    const groupBox = this.$("session-list").querySelector(`[data-group-id="${CSS.escape(groupId)}"]`);
    const members = groupBox?.querySelector(".terminal-group-members");
    if (!members) {
      this.renderList();
      return;
    }
    members.classList.toggle("collapsed", collapsed);
    const chevron = groupBox.querySelector(".terminal-group-label > .codicon");
    if (chevron) chevron.className = `codicon ${collapsed ? "codicon-chevron-right" : "codicon-chevron-down"}`;
  }

  groupSessionIds(groupId, sessionGroups = this.getProjectState().session_groups || {}) {
    const currentSessionIds = new Set(this.sessionsForWorktree(this.stateWorktreeId()).map((session) => session.session_id));
    return Object.entries(sessionGroups)
      .filter(([sessionId, assignedGroupId]) => assignedGroupId === groupId && currentSessionIds.has(sessionId))
      .map(([sessionId]) => sessionId);
  }

  assignSessionGroup(sessionId, groupId) {
    const state = this.getProjectState();
    const layout = this.terminalLayout();
    const sessionGroups = { ...(state.session_groups || {}) };
    const oldGroupId = sessionGroups[sessionId] || null;
    if (groupId) sessionGroups[sessionId] = groupId;
    else delete sessionGroups[sessionId];
    const patch = { session_groups: sessionGroups };
    if (groupId) {
      const token = `session:${sessionId}`;
      patch.terminal_layout = layout.filter((entry) => entry !== token);
    } else if (!layout.includes(`session:${sessionId}`)) {
      const groupIndex = oldGroupId ? layout.indexOf(`group:${oldGroupId}`) : -1;
      const insertAt = groupIndex < 0 ? layout.length : groupIndex + 1;
      layout.splice(insertAt, 0, `session:${sessionId}`);
      patch.terminal_layout = layout;
    }
    this.applyLocalProjectStatePatch(patch);
    this.queueSessionGroupAssignments({ [sessionId]: groupId || null });
    this.renderList();
  }

  sidebarSessionIdsInRenderOrder() {
    const rows = this.$("session-list")?.querySelectorAll(".session-item[data-session-id]") || [];
    const ids = [...rows].map((row) => row.dataset.sessionId).filter((id) => !!this.session(id));
    return ids.length ? ids : this.sessions.map((session) => session.session_id);
  }

  applySidebarSelectionStyles() {
    const rows = this.$("session-list")?.querySelectorAll(".session-item[data-session-id]") || [];
    for (const row of rows) row.classList.toggle("sidebar-selected", this.sidebarSelectedSessionIds.has(row.dataset.sessionId));
  }

  openFileKeysInRenderOrder() {
    const rows = this.$("session-list")?.querySelectorAll(".file-item[data-file-key]") || [];
    const keys = [...rows].map((row) => row.dataset.fileKey).filter((key) => this.openFiles.has(key));
    return keys.length ? keys : [...this.openFiles.keys()];
  }

  applySidebarFileSelectionStyles() {
    const rows = this.$("session-list")?.querySelectorAll(".file-item[data-file-key]") || [];
    for (const row of rows) row.classList.toggle("sidebar-selected", this.sidebarSelectedFileKeys.has(row.dataset.fileKey));
  }

  handleOpenFileRowSelection(event, key) {
    const orderedKeys = this.openFileKeysInRenderOrder();
    const multiSelect = event.metaKey || event.ctrlKey;
    if (event.shiftKey) {
      const anchorKey = this.sidebarFileSelectionAnchorKey && orderedKeys.includes(this.sidebarFileSelectionAnchorKey)
        ? this.sidebarFileSelectionAnchorKey : key;
      const anchorIndex = orderedKeys.indexOf(anchorKey);
      const targetIndex = orderedKeys.indexOf(key);
      const range = orderedKeys.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1);
      this.sidebarSelectedFileKeys = multiSelect
        ? new Set([...this.sidebarSelectedFileKeys, ...range]) : new Set(range);
      this.sidebarFileSelectionAnchorKey = anchorKey;
    } else if (multiSelect) {
      const next = new Set(this.sidebarSelectedFileKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      this.sidebarSelectedFileKeys = next;
      this.sidebarFileSelectionAnchorKey = key;
    } else {
      this.sidebarSelectedFileKeys = new Set([key]);
      this.sidebarFileSelectionAnchorKey = key;
    }
    this.sidebarSelectedSessionIds.clear();
    this.applySidebarSelectionStyles();
    this.applySidebarFileSelectionStyles();
    void this.activateFile(key, null, { fromOpenFiles: true }).then(() => {
      if (!event.shiftKey && !multiSelect && this.activeFileKey === key && this.openFiles.get(key)?.model) {
        this.collapseMobileSidebarAfterSelection();
      }
    });
  }

  selectContextMenuFileKeys(key) {
    if (!this.sidebarSelectedFileKeys.has(key)) {
      this.sidebarSelectedFileKeys = new Set([key]);
      this.sidebarFileSelectionAnchorKey = key;
      this.sidebarSelectedSessionIds.clear();
      this.applySidebarSelectionStyles();
      this.applySidebarFileSelectionStyles();
    }
    const selected = this.sidebarSelectedFileKeys.has(key) ? [...this.sidebarSelectedFileKeys] : [key];
    const order = new Map(this.openFileKeysInRenderOrder().map((fileKey, index) => [fileKey, index]));
    return [...new Set(selected)].filter((fileKey) => this.openFiles.has(fileKey))
      .sort((left, right) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER));
  }

  handleSessionRowSelection(event, sessionId) {
    this.setInteractionWorktreeFromElement(event.currentTarget, this.session(sessionId));
    const selectedWorktreeId = this.stateWorktreeId();
    const orderedIds = this.sidebarSessionIdsInRenderOrder()
      .filter((id) => this.worktreeIdForSession(this.session(id)) === selectedWorktreeId);
    const multiSelect = event.metaKey || event.ctrlKey;
    if (event.shiftKey) {
      const anchorId = this.sidebarSelectionAnchorId && orderedIds.includes(this.sidebarSelectionAnchorId)
        ? this.sidebarSelectionAnchorId : sessionId;
      const anchorIndex = orderedIds.indexOf(anchorId);
      const targetIndex = orderedIds.indexOf(sessionId);
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const range = orderedIds.slice(start, end + 1);
      this.sidebarSelectedSessionIds = multiSelect
        ? new Set([...this.sidebarSelectedSessionIds, ...range])
        : new Set(range);
      this.sidebarSelectionAnchorId = anchorId;
    } else if (multiSelect) {
      const next = new Set(this.sidebarSelectedSessionIds);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      this.sidebarSelectedSessionIds = next;
      this.sidebarSelectionAnchorId = sessionId;
    } else {
      this.sidebarSelectedSessionIds = new Set([sessionId]);
      this.sidebarSelectionAnchorId = sessionId;
    }
    this.sidebarSelectedFileKeys.clear();
    this.applySidebarSelectionStyles();
    this.applySidebarFileSelectionStyles();
    this.activate(sessionId);
    if (!event.shiftKey && !multiSelect) this.collapseMobileSidebarAfterSelection();
  }

  selectedSessionIdsForDrag(sessionId) {
    const selectedWorktreeId = this.stateWorktreeId();
    const selected = this.sidebarSelectedSessionIds.has(sessionId)
      ? [...this.sidebarSelectedSessionIds]
      : [sessionId];
    const order = new Map(this.sidebarSessionIdsInRenderOrder().map((id, index) => [id, index]));
    return [...new Set(selected)]
      .filter((id) => !!this.session(id) && this.worktreeIdForSession(this.session(id)) === selectedWorktreeId)
      .sort((left, right) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER));
  }

  selectContextMenuSessionIds(sessionId) {
    this.sidebarSelectedFileKeys.clear();
    this.applySidebarFileSelectionStyles();
    if (!this.sidebarSelectedSessionIds.has(sessionId)) {
      this.sidebarSelectedSessionIds = new Set([sessionId]);
      this.sidebarSelectionAnchorId = sessionId;
      this.applySidebarSelectionStyles();
    }
    return this.selectedSessionIdsForDrag(sessionId);
  }

  sessionIdsFromDragItem(dragItem) {
    if (dragItem?.kind !== "session") return [];
    const tokens = Array.isArray(dragItem.tokens) ? dragItem.tokens : [dragItem.token];
    return [...new Set(tokens
      .filter((token) => String(token).startsWith("session:"))
      .map((token) => String(token).slice("session:".length)))]
      .filter((id) => !!this.session(id));
  }

  sessionOrderWithSelectedIdsAroundTarget(selectedIds, targetId, after = false) {
    const selected = new Set(selectedIds);
    const order = this.sessionsForWorktree(this.stateWorktreeId()).map((session) => session.session_id)
      .filter((id) => !selected.has(id));
    const targetIndex = order.indexOf(targetId);
    if (targetIndex < 0) return order;
    order.splice(targetIndex + (after ? 1 : 0), 0, ...selectedIds);
    return order;
  }

  moveSelectedSessionsIntoGroup(sessionIds, groupId, targetId = null, after = false) {
    const selectedWorktreeId = this.stateWorktreeId();
    const ids = [...new Set(sessionIds)].filter((id) => !!this.session(id) &&
      this.worktreeIdForSession(this.session(id)) === selectedWorktreeId);
    if (!ids.length) return;
    const state = this.getProjectState();
    const sessionGroups = { ...(state.session_groups || {}) };
    const selectedTokens = new Set(ids.map((id) => `session:${id}`));
    const layout = this.terminalLayout().filter((entry) => !selectedTokens.has(entry));
    for (const id of ids) {
      if (groupId) sessionGroups[id] = groupId;
      else delete sessionGroups[id];
    }
    if (!groupId) layout.push(...ids.map((id) => `session:${id}`));
    const patch = { session_groups: sessionGroups, terminal_layout: layout };
    if (groupId && targetId) {
      patch.session_order = this.sessionOrderWithSelectedIdsAroundTarget(
        ids.filter((id) => id !== targetId), targetId, after);
    }
    this.applyLocalProjectStatePatch(patch);
    this.queueSessionGroupAssignments(Object.fromEntries(ids.map((id) => [id, groupId || null])), targetId || "", after);
    this.sessions = this.applySessionOrder(this.sessions);
    this.renderList();
  }

  async moveSelectedSessionsToProject(sessionIds, project) {
    const sessions = [...new Set(sessionIds)].map((id) => this.session(id))
      .filter((session) => !!session && session.project !== project);
    if (!project || !sessions.length) return;
    const responses = await Promise.all(sessions.map((session) => fetch(`/api/sessions/${session.session_id}/project`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project }),
    })));
    const failure = responses.find((response) => !response.ok);
    if (failure) {
      void uiAlert(`move ${sessions.length === 1 ? "terminal" : "terminals"} to project failed (${failure.status})`);
      await this.refresh();
      return;
    }
    if (this.projectSlug && this.projectSlug !== project) {
      location.href = `/p/${encodeURIComponent(project)}`;
      return;
    }
    await this.refresh();
  }

  repositionSelectedSessions(sessionIds, targetId, after = false) {
    const selectedWorktreeId = this.stateWorktreeId();
    const ids = [...new Set(sessionIds)].filter((id) => !!this.session(id) && id !== targetId &&
      this.worktreeIdForSession(this.session(id)) === selectedWorktreeId);
    const target = this.session(targetId);
    if (!ids.length || !target || this.worktreeIdForSession(target) !== selectedWorktreeId) return;
    const state = this.getProjectState();
    const targetGroupId = state.session_groups?.[targetId] || null;
    if (targetGroupId) {
      this.moveSelectedSessionsIntoGroup(ids, targetGroupId, targetId, after);
      return;
    }
    const selectedTokens = new Set(ids.map((id) => `session:${id}`));
    const sessionGroups = { ...(state.session_groups || {}) };
    for (const id of ids) delete sessionGroups[id];
    const layout = this.terminalLayout().filter((entry) => !selectedTokens.has(entry));
    const targetIndex = layout.indexOf(`session:${targetId}`);
    if (targetIndex < 0) return;
    layout.splice(targetIndex + (after ? 1 : 0), 0, ...ids.map((id) => `session:${id}`));
    this.applyLocalProjectStatePatch({
      session_groups: sessionGroups,
      terminal_layout: layout,
      session_order: this.sessionOrderWithSelectedIdsAroundTarget(ids, targetId, after),
    });
    this.queueSessionGroupAssignments(Object.fromEntries(ids.map((id) => [id, null])), targetId, after);
    this.sessions = this.applySessionOrder(this.sessions);
    this.renderList();
  }

  async groupSelectedSessionsFromDrop(sessionIds, targetId, after = false) {
    const selectedWorktreeId = this.stateWorktreeId();
    const ids = [...new Set(sessionIds)].filter((id) => !!this.session(id) && id !== targetId &&
      this.worktreeIdForSession(this.session(id)) === selectedWorktreeId);
    const target = this.session(targetId);
    if (!ids.length || !target || this.worktreeIdForSession(target) !== selectedWorktreeId) return;
    const state = this.getProjectState();
    const sessionGroups = state.session_groups || {};
    const targetGroupId = sessionGroups[targetId] || null;
    if (targetGroupId) {
      this.moveSelectedSessionsIntoGroup(ids, targetGroupId, targetId, after);
      return;
    }
    const sourceGroupIds = [...new Set(ids.map((id) => sessionGroups[id]).filter(Boolean))];
    if (sourceGroupIds.length === 1) {
      this.moveSelectedSessionsIntoGroup([...ids, targetId], sourceGroupIds[0], targetId, after);
      return;
    }
    const name = await uiPrompt("Name for the new terminal group", `${this.effectiveTitle(target)} group`);
    if (!name || !name.trim()) return;
    const group = { id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: name.trim(), collapsed: false };
    const allIds = [...ids, targetId];
    const allTokens = new Set(allIds.map((id) => `session:${id}`));
    const currentLayout = this.terminalLayout();
    const targetIndex = currentLayout.indexOf(`session:${targetId}`);
    const layout = currentLayout.filter((entry) => !allTokens.has(entry));
    layout.splice(targetIndex < 0 ? layout.length : Math.min(targetIndex, layout.length), 0, `group:${group.id}`);
    const nextSessionGroups = { ...sessionGroups };
    for (const id of allIds) nextSessionGroups[id] = group.id;
    this.applyLocalProjectStatePatch({
      terminal_groups: [...this.terminalGroups(), group],
      session_groups: nextSessionGroups,
      terminal_layout: layout,
      session_order: this.sessionOrderWithSelectedIdsAroundTarget(ids, targetId, after),
    });
    this.queueTerminalGroupCreate(group, allIds, `session:${targetId}`, after);
    this.sessions = this.applySessionOrder(this.sessions);
    this.renderList();
  }

  moveSessionToGroup(sessionId, groupId, targetId = null, after = false) {
    const state = this.getProjectState();
    const currentGroupId = state.session_groups?.[sessionId] || null;
    if (currentGroupId === groupId && targetId) {
      this.reorderGroupedSessions(sessionId, targetId, after);
      return;
    }
    const sessionGroups = { ...(state.session_groups || {}) };
    if (groupId) sessionGroups[sessionId] = groupId;
    else delete sessionGroups[sessionId];
    const patch = { session_groups: sessionGroups };
    const layout = this.terminalLayout().filter((entry) => entry !== `session:${sessionId}`);
    if (groupId) {
      patch.terminal_layout = layout;
    } else {
      const targetIndex = targetId ? layout.indexOf(`session:${targetId}`) : -1;
      if (targetIndex >= 0) layout.splice(targetIndex + (after ? 1 : 0), 0, `session:${sessionId}`);
      else {
        const oldGroupIndex = currentGroupId ? layout.indexOf(`group:${currentGroupId}`) : -1;
        layout.splice(oldGroupIndex >= 0 ? oldGroupIndex + 1 : layout.length, 0, `session:${sessionId}`);
      }
      patch.terminal_layout = layout;
    }
    if (groupId && targetId) {
      const order = this.sessions.map((session) => session.session_id).filter((id) => id !== sessionId);
      const targetIndex = order.indexOf(targetId);
      if (targetIndex >= 0) order.splice(targetIndex + (after ? 1 : 0), 0, sessionId);
      patch.session_order = order;
    }
    this.applyLocalProjectStatePatch(patch);
    this.queueSessionGroupAssignments({ [sessionId]: groupId || null }, targetId || "", after);
    this.sessions = this.applySessionOrder(this.sessions);
    this.renderList();
  }

  terminalLayout(sessions = this.sessions) {
    const state = this.getProjectState();
    const scopedSessions = this.worktreeId === ALL_WORKTREES_ID && !this.renderWorktreeId
      ? this.sessionsForWorktree(this.stateWorktreeId(), sessions) : sessions;
    const groups = this.terminalGroups();
    const groupIds = new Set(groups.map((group) => group.id));
    const sessionIds = new Set(scopedSessions.map((session) => session.session_id));
    const sessionGroups = state.session_groups || {};
    const layout = [];
    const seen = new Set();
    const add = (entry) => {
      if (seen.has(entry)) return;
      const [kind, id] = String(entry).split(":", 2);
      if (kind === "group" && !groupIds.has(id)) return;
      if (kind === "session" && (!sessionIds.has(id) || sessionGroups[id])) return;
      if (kind !== "group" && kind !== "session") return;
      seen.add(entry);
      layout.push(entry);
    };
    if (Array.isArray(state.terminal_layout)) {
      state.terminal_layout.forEach(add);
    } else {
      // Migrate older group state by placing each group beside its earliest
      // member instead of losing the relationship at the end of the list.
      const orderedIds = state.session_order?.length
        ? state.session_order
        : scopedSessions.map((session) => session.session_id);
      const groupsAt = new Map();
      for (const group of groups) {
        const memberIndex = orderedIds.findIndex((id) => sessionGroups[id] === group.id);
        if (memberIndex >= 0) {
          if (!groupsAt.has(memberIndex)) groupsAt.set(memberIndex, []);
          groupsAt.get(memberIndex).push(group);
        }
      }
      for (let index = 0; index <= orderedIds.length; index += 1) {
        for (const group of groupsAt.get(index) || []) add(`group:${group.id}`);
        if (index < orderedIds.length) add(`session:${orderedIds[index]}`);
      }
    }
    for (const session of scopedSessions) add(`session:${session.session_id}`);
    for (const group of groups) add(`group:${group.id}`);
    return layout;
  }

  migrateLegacyPinnedLayout() {
    const state = this.getProjectState();
    const pinnedSessions = new Set(state.pinned_sessions || []);
    const pinnedGroups = new Set(state.pinned_groups || []);
    if (!pinnedSessions.size && !pinnedGroups.size) return;
    const sessionGroups = state.session_groups || {};
    for (const [sessionId, groupId] of Object.entries(sessionGroups)) {
      if (pinnedSessions.has(sessionId)) pinnedGroups.add(groupId);
    }
    const legacyTokens = new Set([
      ...[...pinnedGroups].map((id) => `group:${id}`),
      ...[...pinnedSessions]
        .filter((id) => !sessionGroups[id])
        .map((id) => `session:${id}`),
    ]);
    const layout = this.terminalLayout();
    const top = layout.filter((entry) => legacyTokens.has(entry));
    const nextLayout = [...top, ...layout.filter((entry) => !legacyTokens.has(entry))];
    this.applyLocalProjectStatePatch({ terminal_layout: nextLayout, pinned_sessions: [], pinned_groups: [] });
    for (const token of [...top].reverse()) this.queueTerminalLayoutMove(token, "", false, true);
    this.patchProjectState({ pinned_sessions: [], pinned_groups: [] });
  }

  moveTerminalLayoutToTop(token) {
    const current = this.terminalLayout();
    if (!current.includes(token)) return;
    const layout = current.filter((entry) => entry !== token);
    layout.unshift(token);
    this.applyLocalProjectStatePatch({ terminal_layout: layout });
    this.queueTerminalLayoutMove(token, "", false, true);
    this.renderList();
  }

  reorderTerminalLayout(draggedToken, targetToken, after = false) {
    const state = this.getProjectState();
    const layout = this.terminalLayout().filter((entry) => entry !== draggedToken);
    const targetIndex = layout.indexOf(targetToken);
    if (targetIndex < 0) return;
    layout.splice(targetIndex + (after ? 1 : 0), 0, draggedToken);
    const patch = { terminal_layout: layout };
    const [kind, id] = draggedToken.split(":", 2);
    if (kind === "session" && state.session_groups?.[id]) {
      const oldGroupId = state.session_groups[id];
      const sessionGroups = { ...(state.session_groups || {}) };
      delete sessionGroups[id];
      patch.session_groups = sessionGroups;
    }
    this.applyLocalProjectStatePatch(patch);
    if (kind === "session" && state.session_groups?.[id]) this.queueSessionGroupAssignments({ [id]: null });
    this.queueTerminalLayoutMove(draggedToken, targetToken, after);
    this.renderList();
  }

  reorderGroupedSessions(draggedId, targetId, after = false) {
    const ids = this.sessions.map((session) => session.session_id).filter((id) => id !== draggedId);
    const targetIndex = ids.indexOf(targetId);
    if (targetIndex < 0) return;
    ids.splice(targetIndex + (after ? 1 : 0), 0, draggedId);
    this.applyLocalProjectStatePatch({ session_order: ids });
    this.queueSessionOrderMove([draggedId], targetId, after);
    this.sessions = this.applySessionOrder(this.sessions);
    this.renderList();
  }

  mergeTerminalGroups(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const groups = this.terminalGroups();
    if (!groups.some((group) => group.id === sourceId) || !groups.some((group) => group.id === targetId)) return;
    const state = this.getProjectState();
    const sessionGroups = { ...(state.session_groups || {}) };
    for (const [sessionId, groupId] of Object.entries(sessionGroups)) {
      if (groupId === sourceId) sessionGroups[sessionId] = targetId;
    }
    this.applyLocalProjectStatePatch({
      terminal_groups: groups.filter((group) => group.id !== sourceId),
      session_groups: sessionGroups,
      terminal_layout: this.terminalLayout().filter((entry) => entry !== `group:${sourceId}`),
    });
    this.queueTerminalGroupMerge(sourceId, targetId);
    this.renderList();
  }

  async groupSessionsFromDrop(draggedId, targetId, after = false) {
    const state = this.getProjectState();
    const sessionGroups = { ...(state.session_groups || {}) };
    const draggedGroupId = sessionGroups[draggedId] || null;
    const targetGroupId = sessionGroups[targetId] || null;
    if (draggedGroupId && draggedGroupId === targetGroupId) {
      this.reorderGroupedSessions(draggedId, targetId, after);
      return;
    }
    if (targetGroupId) {
      this.assignSessionGroup(draggedId, targetGroupId);
      this.reorderGroupedSessions(draggedId, targetId, after);
      return;
    }
    if (draggedGroupId) {
      this.assignSessionGroup(targetId, draggedGroupId);
      // The dragged member remains the anchor: dropping after the target
      // means the target belongs immediately before the dragged member.
      this.reorderGroupedSessions(targetId, draggedId, !after);
      return;
    }
    const dragged = this.session(draggedId), target = this.session(targetId);
    if (!dragged || !target) return;
    const suggestion = `${this.effectiveTitle(target)} group`;
    const name = await uiPrompt("Name for the new terminal group", suggestion);
    if (!name || !name.trim()) return;
    const group = { id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: name.trim(), collapsed: false };
    const layout = this.terminalLayout().filter((entry) => entry !== `session:${draggedId}` && entry !== `session:${targetId}`);
    const targetIndex = this.terminalLayout().indexOf(`session:${targetId}`);
    layout.splice(targetIndex < 0 ? layout.length : Math.min(targetIndex, layout.length), 0, `group:${group.id}`);
    sessionGroups[draggedId] = group.id;
    sessionGroups[targetId] = group.id;
    this.applyLocalProjectStatePatch({ terminal_groups: [...this.terminalGroups(), group], session_groups: sessionGroups,
      terminal_layout: layout });
    this.queueTerminalGroupCreate(group, [draggedId, targetId], `session:${targetId}`, after);
    this.reorderGroupedSessions(draggedId, targetId, after);
  }

  createTerminalGroupFromSession(sessionId) {
    this.createTerminalGroupFromSessions([sessionId]);
  }

  async createTerminalGroupFromSessions(sessionIds) {
    const ids = [...new Set(sessionIds)].filter((id) => !!this.session(id));
    if (!ids.length) return;
    const firstSession = this.session(ids[0]);
    const suggestion = ids.length === 1 ? `${this.effectiveTitle(firstSession)} group`
      : `${this.effectiveTitle(firstSession)} + ${ids.length - 1} group`;
    const name = await uiPrompt("Name for the new terminal group", suggestion);
    if (!name || !name.trim()) return;
    const state = this.getProjectState();
    const sessionGroups = { ...(state.session_groups || {}) };
    const group = { id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: name.trim(), collapsed: false };
    const layout = this.terminalLayout();
    const selectedTokens = new Set(ids.map((id) => `session:${id}`));
    const indexes = ids.map((id) => {
      const tokenIndex = layout.indexOf(`session:${id}`);
      if (tokenIndex >= 0) return tokenIndex;
      return sessionGroups[id] ? layout.indexOf(`group:${sessionGroups[id]}`) : -1;
    }).filter((index) => index >= 0);
    const index = indexes.length ? Math.min(...indexes) : -1;
    const nextLayout = layout.filter((entry) => !selectedTokens.has(entry));
    nextLayout.splice(index < 0 ? nextLayout.length : Math.min(index, nextLayout.length), 0, `group:${group.id}`);
    for (const id of ids) sessionGroups[id] = group.id;
    const anchorToken = index < 0 ? "" : layout[index];
    this.applyLocalProjectStatePatch({
      terminal_groups: [...this.terminalGroups(), group],
      session_groups: sessionGroups,
      terminal_layout: nextLayout,
    });
    this.queueTerminalGroupCreate(group, ids, anchorToken);
    this.renderList();
  }

  removeTerminalGroup(groupId) {
    const group = this.terminalGroups().find((candidate) => candidate.id === groupId);
    if (!group) return;
    this.applyLocalProjectStatePatch(this.terminalGroupDeletionPatch(groupId));
    this.queueTerminalGroupDelete(groupId);
    this.renderList();
  }

  async closeAllInTerminalGroup(groupId) {
    const sessionGroups = this.getProjectState().session_groups || {};
    const sessions = this.sessions.filter((session) => sessionGroups[session.session_id] === groupId);
    if (!sessions.length) return;
    const group = this.terminalGroups().find((candidate) => candidate.id === groupId);
    const label = group?.name || "this group";
    if (!await uiConfirm(`Close all ${sessions.length} terminals in "${label}"?`)) return;
    if (!await uiConfirm(`Confirm closing all terminals in "${label}". Running agents will be stopped.`)) return;
    const responses = await Promise.all(sessions.map((session) => fetch(`/api/sessions/${session.session_id}`, { method: "DELETE" })));
    if (responses.some((response) => response.ok)) this.restoreLastClosedTerminalNeedsConfirmation = false;
    this.refresh();
  }

  openTerminalGroupContextMenu(event, group) {
    event.preventDefault();
    event.stopPropagation();
    group = this.terminalGroups().find((candidate) => candidate.id === group.id) || group;
    const menu = this.$("context-menu");
    menu.textContent = "";
    this.contextMenuTarget = { type: "group", id: group.id };
    this.addContextItem(menu, this.shortcutLabel("Move group to top", "move-active-to-top"),
      () => this.moveTerminalLayoutToTop(`group:${group.id}`), "arrow-up");
    this.addContextItem(menu, group.collapsed ? "Expand group" : "Collapse group",
      () => this.toggleTerminalGroup(group.id), group.collapsed ? "chevron-down" : "chevron-up");
    this.addContextItem(menu, this.shortcutLabel("Rename group", "rename-terminal"),
      () => this.renameTerminalGroup(group.id), "edit");
    this.addContextItem(menu, this.shortcutLabel("Mark group as unread", "mark-terminal-unread"),
      () => this.markTerminalGroupUnread(group.id), "eye-closed");
    this.addContextItem(menu, this.shortcutLabel("Remove grouping", "create-terminal-group-from-active"),
      () => this.removeTerminalGroup(group.id), "ungroup-by-ref-type");
    this.addContextItem(menu, this.shortcutLabel("Close all", "close-item"),
      () => this.closeAllInTerminalGroup(group.id), "close-all");
    this.positionContextMenu(menu, event.clientX, event.clientY);
  }

  attachGroupDropTarget(element, groupId) {
    element.ondragover = (event) => {
      if (this.dragItem?.type !== "layout" || this.dragItem.kind !== "session") return;
      event.preventDefault();
      this.clearDragLandingIndicator();
      element.classList.add("drop-group");
    };
    element.ondragleave = () => {
      element.classList.remove("drop-group");
      this.clearDragGroupingTimer();
    };
    element.ondrop = (event) => {
      if (this.dragItem?.type !== "layout" || this.dragItem.kind !== "session") return;
      event.preventDefault();
      const sessionIds = this.sessionIdsFromDragItem(this.dragItem);
      this.clearDragLandingIndicator();
      this.moveSelectedSessionsIntoGroup(sessionIds, groupId);
      this.dragItem = null;
    };
  }

  async loadProjects() {
    if (this.vscodeMode) {
      this.projects = [];
      const button = this.$("project-select");
      button.disabled = true;
      button.style.display = "none";
      button.classList.add("hidden");
      if (!this.vscodeEditorMode) this.projectSlug = null;
      return;
    }
    try {
      const res = await fetch("/api/projects");
      this.projects = await res.json();
    } catch (err) {
      this.projects = [];
    }
    const button = this.$("project-select");
    button.disabled = false;
    button.style.display = "";
    button.classList.remove("hidden");
    this.applyVscodeDefaultProjectState();
    if (this.vscodeMode) {
      button.disabled = true;
      button.style.display = "none";
      button.classList.add("hidden");
      return;
    }
    this.updateHeaderPickerDisplay("project");
    await this.loadWorktrees();
  }

  async loadWorktrees() {
    const row = this.$("worktree-header-row");
    const button = this.$("worktree-select");
    if (!row || !button || !this.projectSlug || this.vscodeMode) {
      this.worktrees = [];
      row?.classList.add("hidden");
      this.updateHeaderAddMenu();
      return;
    }
    try {
      const response = await fetch(`/api/worktrees?project=${encodeURIComponent(this.projectSlug)}`);
      if (!response.ok) throw new Error("worktree list failed");
      this.worktrees = await response.json();
    } catch (error) {
      this.worktrees = [];
    }
    const availableWorktrees = this.worktrees.filter((worktree) => worktree.available);
    const requestedWorktreeUrlSegment = this.requestedWorktreeUrlSegment;
    const requestedWorktree = this.worktreeForUrlSegment(requestedWorktreeUrlSegment);
    if (requestedWorktreeUrlSegment && !requestedWorktree) {
      throw new Error(`unknown or ambiguous worktree URL segment: ${requestedWorktreeUrlSegment}`);
    }
    if (requestedWorktree) this.worktreeId = requestedWorktree.id;
    this.requestedWorktreeUrlSegment = "";
    if (!this.worktrees.length) {
      row.classList.add("hidden");
      this.updateHeaderAddMenu();
      return;
    }
    const saved = this.settings.selected_worktrees?.[this.projectSlug] ||
      localStorage.getItem(`termdeck.${this.projectSlug}.worktree_id`) || "";
    const availableIds = new Set(availableWorktrees.map((worktree) => worktree.id));
    if (availableWorktrees.length > 1) availableIds.add(ALL_WORKTREES_ID);
    if (!availableIds.has(this.worktreeId)) this.worktreeId = availableIds.has(saved) ? saved : "root";
    if (!availableIds.has(this.worktreeId)) this.worktreeId = "root";
    this.updateHeaderPickerDisplay("worktree");
    row.classList.remove("hidden");
    this.updateHeaderAddMenu();
  }

  async switchWorktree(worktreeId) {
    if (worktreeId === ALL_WORKTREES_ID && this.worktrees.filter((worktree) => worktree.available).length > 1) {
      this.worktreeId = ALL_WORKTREES_ID;
    } else {
      const selected = this.worktrees.find((worktree) => worktree.id === worktreeId);
      if (!selected || !selected.available) return;
      this.worktreeId = selected.id;
    }
    this.interactionWorktreeId = this.worktreeId === ALL_WORKTREES_ID ? this.interactionWorktreeId : this.worktreeId;
    this.updateHeaderPickerDisplay("worktree");
    this.disconnectRecentFilesWatch();
    this.unreadSessions = this.unreadSessionIdsForCurrentWorktreeView();
    this.settings.selected_worktrees = { ...(this.settings.selected_worktrees || {}), [this.projectSlug]: this.worktreeId };
    this.saveSettings();
    localStorage.setItem(`termdeck.${this.projectSlug}.worktree_id`, this.worktreeId);
    history.pushState({ kind: "init" }, "", this.navUrl({ kind: "init" }));
    if (this.fileHistoryTabKey !== null) this.closeFileHistory(false);
    this.activeId = null;
    this.activeFileKey = null;
    this.openFiles.clear();
    this.treeRoot = null;
    await this.refresh();
    this.setSideView("terminals", false);
  }

  async addProjectFromHeader() {
    await this.chooseProjectFolder();
  }

  headerPickerElements(kind) {
    return {
      button: this.$(`${kind}-select`), input: this.$(`${kind}-select-input`), label: this.$(`${kind}-select-label`),
      list: this.$(`${kind}-select-list`), menu: this.$(`${kind}-select-menu`), summary: this.$(`${kind}-select-summary`),
    };
  }

  headerPickerOptions(kind) {
    if (kind === "project") {
      return [{ value: "", label: "All projects", detail: "", disabled: false }, ...this.projects.map((project) => ({
        value: project.name, label: project.name, detail: this.compactProjectPath(project.root), disabled: false,
      }))];
    }
    const available = this.worktrees.filter((worktree) => worktree.available);
    const options = available.length > 1
      ? [{ value: ALL_WORKTREES_ID, label: "All worktrees", detail: "Every worktree", disabled: false }]
      : [];
    return [...options, ...this.worktrees.map((worktree) => ({
      value: worktree.id, label: `${worktree.branch || worktree.name || worktree.path}${worktree.available ? "" : " (missing)"}`,
      detail: this.compactProjectPath(worktree.path), disabled: !worktree.available,
    }))];
  }

  currentHeaderPickerValue(kind) {
    return kind === "project" ? this.projectSlug || "" : this.worktreeId;
  }

  matchingHeaderPickerOptions(kind) {
    const input = this.headerPickerElements(kind).input;
    const query = String(input?.value || "").trim().toLowerCase();
    const options = this.headerPickerOptions(kind);
    if (!query) return options;
    const prefix = options.filter((option) => option.label.toLowerCase().startsWith(query));
    const rest = options.filter((option) => !option.label.toLowerCase().startsWith(query) &&
      `${option.label} ${option.detail}`.toLowerCase().includes(query));
    return [...prefix, ...rest];
  }

  updateHeaderPickerDisplay(kind) {
    const elements = this.headerPickerElements(kind);
    if (!elements.label || !elements.button) return;
    const current = this.headerPickerOptions(kind).find((option) => option.value === this.currentHeaderPickerValue(kind));
    elements.label.textContent = current?.label || (kind === "project" ? "All projects" : "Worktree");
    elements.button.title = current?.detail || (kind === "project" ? "Switch project" : "Switch worktree");
  }

  renderHeaderPicker(kind) {
    const elements = this.headerPickerElements(kind);
    const matches = this.matchingHeaderPickerOptions(kind);
    const shown = matches.slice(0, HEADER_PICKER_RESULT_LIMIT);
    const activeIndex = Math.max(0, Math.min(this.headerPickerActiveIndices[kind], shown.length - 1));
    this.headerPickerActiveIndices[kind] = shown.length ? activeIndex : -1;
    elements.list.textContent = "";
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "header-picker-empty";
      empty.textContent = `No matching ${kind === "project" ? "project" : "worktree"}`;
      elements.list.appendChild(empty);
    }
    for (const [index, option] of shown.entries()) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `header-picker-option${index === activeIndex ? " active" : ""}${option.value === this.currentHeaderPickerValue(kind) ? " selected" : ""}${option.disabled ? " disabled" : ""}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(option.value === this.currentHeaderPickerValue(kind)));
      row.disabled = option.disabled;
      const check = document.createElement("span");
      check.className = `header-picker-option-check codicon ${option.value === this.currentHeaderPickerValue(kind) ? "codicon-check" : ""}`;
      const copy = document.createElement("span");
      copy.className = "header-picker-option-copy";
      const label = document.createElement("span");
      label.className = "header-picker-option-label";
      label.textContent = option.label;
      copy.appendChild(label);
      if (option.detail) {
        const detail = document.createElement("span");
        detail.className = "header-picker-option-detail";
        detail.textContent = option.detail;
        copy.appendChild(detail);
      }
      row.append(check, copy);
      row.onmouseenter = () => {
        this.headerPickerActiveIndices[kind] = index;
        elements.list.querySelectorAll(".header-picker-option.active").forEach((item) => item.classList.remove("active"));
        row.classList.add("active");
      };
      row.onmousedown = (event) => {
        event.preventDefault();
        if (!option.disabled) this.selectHeaderPickerOption(kind, option.value);
      };
      elements.list.appendChild(row);
    }
    elements.summary.classList.toggle("hidden", matches.length <= HEADER_PICKER_RESULT_LIMIT);
    elements.summary.textContent = matches.length > HEADER_PICKER_RESULT_LIMIT
      ? `Showing 50 of ${matches.length}; type to narrow` : "";
    elements.list.querySelector(".header-picker-option.active")?.scrollIntoView({ block: "nearest" });
  }

  openHeaderPicker(kind) {
    this.closeHeaderPickers();
    this.closeHeaderAddMenu();
    const elements = this.headerPickerElements(kind);
    if (!elements.button || elements.button.disabled) return;
    elements.input.value = "";
    const currentIndex = this.headerPickerOptions(kind).findIndex((option) => option.value === this.currentHeaderPickerValue(kind));
    this.headerPickerActiveIndices[kind] = currentIndex >= 0 && currentIndex < HEADER_PICKER_RESULT_LIMIT ? currentIndex : 0;
    this.renderHeaderPicker(kind);
    elements.menu.classList.remove("hidden");
    elements.button.setAttribute("aria-expanded", "true");
    elements.input.focus();
  }

  closeHeaderPickers() {
    for (const kind of ["project", "worktree"]) {
      const elements = this.headerPickerElements(kind);
      elements.menu?.classList.add("hidden");
      elements.button?.setAttribute("aria-expanded", "false");
    }
  }

  toggleHeaderPicker(kind) {
    const elements = this.headerPickerElements(kind);
    if (elements.menu.classList.contains("hidden")) this.openHeaderPicker(kind);
    else this.closeHeaderPickers();
  }

  selectHeaderPickerOption(kind, value) {
    const option = this.headerPickerOptions(kind).find((candidate) => candidate.value === value);
    if (!option || option.disabled) return;
    this.closeHeaderPickers();
    if (kind === "project") location.href = value ? `/p/${encodeURIComponent(value)}` : "/";
    else void this.switchWorktree(value);
  }

  handleHeaderPickerKeydown(kind, event) {
    const elements = this.headerPickerElements(kind);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeHeaderPickers();
      elements.button.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    const shown = this.matchingHeaderPickerOptions(kind).slice(0, HEADER_PICKER_RESULT_LIMIT);
    if (!shown.length) return;
    if (event.key === "Enter") {
      const option = shown[this.headerPickerActiveIndices[kind]];
      if (option && !option.disabled) this.selectHeaderPickerOption(kind, option.value);
      return;
    }
    const step = event.key === "ArrowDown" ? 1 : -1;
    let next = this.headerPickerActiveIndices[kind];
    for (let attempts = 0; attempts < shown.length; attempts += 1) {
      next = (next + step + shown.length) % shown.length;
      if (!shown[next].disabled) break;
    }
    this.headerPickerActiveIndices[kind] = next;
    this.renderHeaderPicker(kind);
  }

  initHeaderPickers() {
    for (const kind of ["project", "worktree"]) {
      const elements = this.headerPickerElements(kind);
      elements.button.onclick = (event) => {
        event.stopPropagation();
        this.toggleHeaderPicker(kind);
      };
      elements.input.oninput = () => {
        this.headerPickerActiveIndices[kind] = 0;
        this.renderHeaderPicker(kind);
      };
      elements.input.onkeydown = (event) => this.handleHeaderPickerKeydown(kind, event);
    }
  }

  updateHeaderAddMenu() {
    const button = this.$("header-add-worktree");
    if (!button) return;
    const rootWorktree = this.worktrees.find((worktree) => worktree.is_root);
    const gitAvailable = !!this.projectSlug && !this.vscodeMode && !!rootWorktree && rootWorktree.git_repository !== false;
    button.disabled = !gitAvailable;
    button.title = gitAvailable ? "Create a worktree" : "Select a Git project to create a worktree";
    this.updateHeaderAddShortcutLabels();
  }

  updateHeaderAddShortcutLabels() {
    const actions = [["header-add-project", "new-project"], ["header-add-worktree", "new-worktree"],
      ["header-add-terminal", "new-terminal"]];
    for (const [id, actionId] of actions) {
      const shortcut = this.$(id)?.querySelector(".header-add-shortcut");
      if (shortcut) shortcut.textContent = this.touchMobileLayoutEnabled() ? "" : this.bindingToDisplay(this.bindingFor(actionId));
    }
  }

  closeHeaderAddMenu() {
    this.$("header-add-menu")?.classList.add("hidden");
  }

  positionHeaderAddMenu() {
    const menu = this.$("header-add-menu");
    const button = this.$("project-add-btn");
    const header = this.$("sidebar-header");
    if (!menu || !button || !header) return;
    const buttonBounds = button.getBoundingClientRect();
    const headerBounds = header.getBoundingClientRect();
    menu.style.left = `${buttonBounds.left - headerBounds.left}px`;
    menu.style.top = `${buttonBounds.bottom - headerBounds.top + 4}px`;
  }

  toggleHeaderAddMenu() {
    const menu = this.$("header-add-menu");
    if (!menu) return;
    menu.classList.toggle("hidden");
    if (!menu.classList.contains("hidden")) {
      this.updateHeaderAddMenu();
      this.positionHeaderAddMenu();
    }
  }

  runHeaderAddAction(action) {
    this.closeHeaderAddMenu();
    if (action === "project") void this.addProjectFromHeader();
    else if (action === "worktree") this.openWorktreeModal();
    else if (action === "terminal") this.openModal();
  }

  openWorktreeModal() {
    this.closeHeaderAddMenu();
    if (!this.projectSlug || this.vscodeMode) return;
    const project = this.projects.find((candidate) => candidate.name === this.projectSlug);
    if (!project) return;
    const rootWorktree = this.worktrees.find((worktree) => worktree.is_root);
    if (rootWorktree && rootWorktree.git_repository === false) {
      void uiAlert(`Project "${project.name}" is not a Git repository. Select the repository folder containing .git first.`);
      return;
    }
    this.$("worktree-modal-project").textContent = `${project.name} · ${this.compactProjectPath(project.root)}`;
    this.$("worktree-name").value = "";
    this.$("worktree-branch").value = "";
    this.$("worktree-location").value = "";
    this.worktreeBranches = [];
    this.worktreeCurrentBranch = "";
    this.worktreeLocationParent = "";
    this.worktreeLocationEdited = false;
    this.closeWorktreeBranchList();
    this.clearWorktreeModalError();
    this.hideWorktreeProgress();
    this.updateWorktreeCreateState();
    this.$("worktree-modal-backdrop").classList.remove("hidden");
    void this.loadWorktreeDialogOptions(rootWorktree?.branch || "");
    requestAnimationFrame(() => this.$("worktree-name").focus());
  }

  // Fills the dialog from the repository itself: every local branch to base the worktree on, and
  // the folder TermDeck would use, shown so it can be edited rather than left implicit.
  async loadWorktreeDialogOptions(preferredBranch = "") {
    if (!this.projectSlug) return;
    try {
      const response = await fetch(`/api/worktrees/branches?project=${encodeURIComponent(this.projectSlug)}`);
      if (!response.ok) return;
      const payload = await response.json();
      this.worktreeBranches = Array.isArray(payload.branches) ? payload.branches : [];
      this.worktreeCurrentBranch = payload.current || "";
      const selected = [preferredBranch, payload.current].find((branch) => this.worktreeBranches.includes(branch));
      if (selected) this.$("worktree-base-ref").value = selected;
      this.worktreeLocationParent = this.settings.worktree_roots?.[this.projectSlug] || payload.default_location || "";
      this.syncWorktreeLocation();
      this.updateWorktreeCreateState();
    } catch (error) {
      return;
    }
  }

  // Mirrors the server's folder rule so the field shows the path that will actually be created.
  worktreeFolderSlug(value) {
    return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "").slice(0, 48);
  }

  // The folder field is the exact checkout path, so it tracks the name until the person edits it.
  syncWorktreeLocation() {
    if (this.worktreeLocationEdited || !this.worktreeLocationParent) return;
    const title = this.$("worktree-name").value.trim() || this.$("worktree-branch").value.trim() ||
      this.$("worktree-base-ref").value.trim();
    this.$("worktree-location").value = `${this.worktreeLocationParent}/${this.worktreeFolderSlug(title) || "worktree"}`;
    this.updateWorktreeCreateState();
  }

  // Only what has been typed narrows the list. Opening it filters by nothing, or the branch already
  // in the field would hide every other branch exactly when someone wants to browse them.
  matchingWorktreeBranches() {
    const typed = this.worktreeBranchFilterActive ? this.$("worktree-base-ref").value.trim().toLowerCase() : "";
    if (!typed) return this.worktreeBranches;
    const prefix = this.worktreeBranches.filter((branch) => branch.toLowerCase().startsWith(typed));
    const rest = this.worktreeBranches.filter((branch) => !branch.toLowerCase().startsWith(typed) &&
      branch.toLowerCase().includes(typed));
    return [...prefix, ...rest];
  }

  renderWorktreeBranchList() {
    const list = this.$("worktree-base-ref-list");
    const matches = this.matchingWorktreeBranches();
    list.textContent = "";
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "worktree-branch-empty";
      empty.textContent = "no matching branch";
      list.appendChild(empty);
      this.worktreeBranchActiveIndex = -1;
      return;
    }
    if (this.worktreeBranchActiveIndex >= matches.length) this.worktreeBranchActiveIndex = matches.length - 1;
    for (const [index, branch] of matches.entries()) {
      const option = document.createElement("div");
      option.className = `worktree-branch-option${index === this.worktreeBranchActiveIndex ? " active" : ""}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === this.worktreeBranchActiveIndex));
      option.textContent = branch;
      if (branch === this.worktreeCurrentBranch) {
        const marker = document.createElement("span");
        marker.className = "worktree-branch-current";
        marker.textContent = "current";
        option.appendChild(marker);
      }
      // mousedown, not click: the input's blur would close the list before a click landed.
      option.onmousedown = (event) => {
        event.preventDefault();
        this.selectWorktreeBranch(branch);
      };
      list.appendChild(option);
    }
    const active = list.querySelector(".worktree-branch-option.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  openWorktreeBranchList({ filtered = false } = {}) {
    this.worktreeBranchFilterActive = filtered;
    this.renderWorktreeBranchList();
    this.$("worktree-base-ref-list").classList.remove("hidden");
    this.$("worktree-base-ref").setAttribute("aria-expanded", "true");
  }

  closeWorktreeBranchList() {
    this.worktreeBranchActiveIndex = -1;
    this.$("worktree-base-ref-list").classList.add("hidden");
    this.$("worktree-base-ref").setAttribute("aria-expanded", "false");
  }

  worktreeBranchListOpen() {
    return !this.$("worktree-base-ref-list").classList.contains("hidden");
  }

  selectWorktreeBranch(branch) {
    this.$("worktree-base-ref").value = branch;
    this.closeWorktreeBranchList();
    this.syncWorktreeLocation();
    this.updateWorktreeCreateState();
  }

  // Runs before the dialog-wide Escape/Enter handler on document, so a key the list uses never
  // reaches it: Escape would close the whole dialog and Enter would submit it.
  handleWorktreeBranchKeydown(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!this.worktreeBranchListOpen()) {
        this.worktreeBranchActiveIndex = 0;
        this.openWorktreeBranchList();
        return;
      }
      const total = this.matchingWorktreeBranches().length;
      if (!total) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      this.worktreeBranchActiveIndex = (this.worktreeBranchActiveIndex + step + total) % total;
      this.renderWorktreeBranchList();
      return;
    }
    if (!this.worktreeBranchListOpen()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeWorktreeBranchList();
      return;
    }
    if (event.key === "Enter" && this.worktreeBranchActiveIndex >= 0) {
      const branch = this.matchingWorktreeBranches()[this.worktreeBranchActiveIndex];
      if (!branch) return;
      event.preventDefault();
      event.stopPropagation();
      this.selectWorktreeBranch(branch);
      return;
    }
    if (event.key === "Tab") this.closeWorktreeBranchList();
  }

  async browseWorktreeLocation() {
    const button = this.$("worktree-location-browse");
    button.disabled = true;
    try {
      const response = await fetch("/api/worktrees/pick-folder", { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 501) {
        // Only macOS has a native chooser; elsewhere the path field is the whole interface.
        button.classList.add("hidden");
        return;
      }
      if (!response.ok) {
        void uiAlert(payload.detail || "failed to choose a folder");
        return;
      }
      if (!payload.cancelled && payload.location) {
        this.worktreeLocationParent = payload.location;
        this.worktreeLocationEdited = false;
        this.syncWorktreeLocation();
      }
    } finally {
      button.disabled = false;
    }
  }

  closeWorktreeModal() {
    this.$("worktree-modal-backdrop").classList.add("hidden");
  }

  // Blue once the dialog has what it needs: a branch to start from and somewhere to put the worktree.
  // The button stays clickable either way, so a bad value still reports itself in the dialog.
  updateWorktreeCreateState() {
    const ready = !!this.$("worktree-base-ref").value.trim() && !!this.$("worktree-location").value.trim();
    this.$("worktree-modal-create").classList.toggle("modal-primary", ready);
  }

  clearWorktreeModalError() {
    this.hideWorktreeProgress();
    this.$("worktree-modal-error").classList.add("hidden");
    this.$("worktree-modal-open-existing").classList.add("hidden");
    this.worktreeConflictSegment = "";
  }

  // Failures stay inside the dialog so the fields keep their values and can be corrected. A folder
  // that is already a worktree of this repository is offered directly rather than just reported.
  showWorktreeModalError(detail) {
    const structured = detail && typeof detail === "object" ? detail : null;
    const message = structured ? structured.message : detail;
    if (structured?.commands?.length) this.showWorktreeProgress(structured.commands, "failed");
    else this.hideWorktreeProgress();
    this.$("worktree-modal-error-text").textContent = message || "worktree creation failed";
    this.$("worktree-modal-error").classList.remove("hidden");
    // The URL takes the same segment the create flow uses, not the internal id.
    this.worktreeConflictSegment = structured?.worktree_id
      ? structured.worktree_name || structured.worktree_branch || structured.worktree_id : "";
    const open = this.$("worktree-modal-open-existing");
    open.classList.toggle("hidden", !this.worktreeConflictSegment);
    if (this.worktreeConflictSegment) {
      this.$("worktree-modal-error-text").textContent = `${message} — already a worktree on ${this.worktreeConflictSegment}.`;
    }
  }

  openConflictingWorktree() {
    if (!this.worktreeConflictSegment) return;
    const target = `/p/${encodeURIComponent(this.projectSlug)}/${encodeURIComponent(this.worktreeConflictSegment)}`;
    this.closeWorktreeModal();
    location.href = target;
  }

  async createProjectWorktree() {
    const name = this.$("worktree-name").value.trim();
    const baseRef = this.$("worktree-base-ref").value.trim();
    const branch = this.$("worktree-branch").value.trim();
    // Not named `location`: this function reads location.href below, and a local would shadow it.
    const folder = this.$("worktree-location").value.trim();
    if (this.worktreeCreateInFlight) return;
    this.worktreeCreateInFlight = true;
    this.clearWorktreeModalError();
    // `git worktree add` copies a whole checkout, which is slow enough to look frozen. The commands
    // shown while it runs are the ones the request will run; the reply replaces them with what ran.
    this.showWorktreeProgress([this.plannedWorktreeCommand(baseRef, branch, folder)]);
    try {
      const response = await fetch("/api/worktrees", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: this.projectSlug, name, branch, base_ref: baseRef, location: folder }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.showWorktreeModalError(payload.detail);
        return;
      }
      this.rememberWorktreeRoot(payload.path || folder);
      this.closeWorktreeModal();
      await this.loadWorktrees();
      const worktreeSegment = payload.name || payload.branch || payload.id;
      const url = new URL(`/p/${encodeURIComponent(this.projectSlug)}/${encodeURIComponent(worktreeSegment)}`, location.href);
      this.showWorktreeResult("Worktree created", `${payload.name || payload.branch} · ${payload.branch || "new branch"}`,
        url, payload.path || "");
    } catch (error) {
      this.showWorktreeModalError(error.message || "worktree creation failed");
    } finally {
      this.worktreeCreateInFlight = false;
      this.$("worktree-modal-create").disabled = false;
    }
  }

  // What the server is about to run, so the panel says something specific from the first frame.
  plannedWorktreeCommand(baseRef, branch, folder) {
    const quote = (value) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`);
    const parts = ["git", "worktree", "add"];
    if (branch) parts.push("-b", quote(branch));
    parts.push(quote(folder), quote(baseRef));
    return parts.join(" ");
  }

  showWorktreeProgress(commands, state = "running") {
    const panel = this.$("worktree-modal-progress");
    const list = this.$("worktree-modal-progress-commands");
    this.$("worktree-modal-progress-label").textContent =
      state === "failed" ? "Could not create the worktree" : "Creating worktree…";
    panel.classList.toggle("failed", state === "failed");
    list.textContent = "";
    for (const command of commands) {
      const row = document.createElement("div");
      row.className = `worktree-command${state === "running" ? "" : ` ${state}`}`;
      row.textContent = command;
      list.appendChild(row);
    }
    panel.classList.remove("hidden");
    this.$("worktree-modal-create").disabled = state === "running";
  }

  hideWorktreeProgress() {
    this.$("worktree-modal-progress").classList.add("hidden");
    this.$("worktree-modal-progress-commands").textContent = "";
  }

  // The folder a project's worktrees live in is remembered, so renaming the root once is enough.
  rememberWorktreeRoot(createdPath) {
    const parent = String(createdPath || "").replace(/\/+$/, "").split("/").slice(0, -1).join("/");
    if (!parent || !this.projectSlug) return;
    const roots = { ...(this.settings.worktree_roots || {}) };
    if (roots[this.projectSlug] === parent) return;
    roots[this.projectSlug] = parent;
    this.settings.worktree_roots = roots;
    this.saveSettings();
  }

  // Shared by "Worktree created" and "Project added": both offer the same address, so both need the
  // in-page link and the new-tab link pointed at it. Setting one and not the other left the button
  // aimed wherever the dialog last was.
  showWorktreeResult(title, name, url, path) {
    this.$("worktree-result-title").textContent = title;
    this.$("worktree-result-name").textContent = name;
    const link = this.$("worktree-result-link");
    link.href = url.href;
    link.textContent = url.href;
    link.title = url.href;
    const openTab = this.$("worktree-result-open-tab");
    openTab.href = url.href;
    openTab.title = `Open ${url.href} in a new tab`;
    this.$("worktree-result-hint").textContent = "Click the address to open it here, or use the button below for a new tab.";
    this.$("worktree-result-path").textContent = path;
    this.$("worktree-result-backdrop").classList.remove("hidden");
    requestAnimationFrame(() => link.focus());
  }

  closeWorktreeResult() {
    this.$("worktree-result-backdrop").classList.add("hidden");
  }

  async deleteSelectedWorktree() {
    const selected = this.worktrees.find((worktree) => worktree.id === this.worktreeId);
    if (!selected || selected.is_root) return;
    if (!await uiConfirm(`Remove worktree "${selected.name}"? Terminals in it must be closed first.`)) return;
    const moveToTrash = await uiConfirm("Move the worktree folder to the macOS Trash? Cancel keeps the files but detaches the worktree.");
    const response = await fetch(`/api/worktrees/${encodeURIComponent(selected.id)}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: this.projectSlug, move_to_trash: moveToTrash }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      void uiAlert(payload.detail || "worktree deletion failed");
      return;
    }
    this.worktreeId = "root";
    localStorage.setItem(`termdeck.${this.projectSlug}.worktree_id`, "root");
    await this.loadWorktrees();
    await this.switchWorktree("root");
  }

  projectRoot() {
    const p = this.projects.find((x) => x.name === this.projectSlug);
    return p ? p.root : null;
  }

  worktreeRoot() {
    const selectedId = this.worktreeId === ALL_WORKTREES_ID ? this.interactionWorktreeId : (this.worktreeId || "root");
    const selected = this.worktrees.find((worktree) => worktree.id === selectedId && worktree.available);
    return selected?.path || this.projectRoot();
  }

  fileDeckProjectForRoot(root) {
    const normalized = String(root || "").replace(/\\/g, "/").replace(/\/+$/, "");
    return this.projects
      .filter((project) => {
        const projectRoot = String(project.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
        return normalized === projectRoot || normalized.startsWith(projectRoot + "/");
      })
      .sort((left, right) => String(right.root || "").length - String(left.root || "").length)[0] || null;
  }

  openFileDeckInNewTab(root, relativePath = "") {
    this.openFileDeckViewInNewTab(root, "tree", relativePath);
  }

  async openFileExternally(root, path) {
    const response = await fetch("/api/files/open-external", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, path }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      this.$("status-name").textContent = payload.detail || "unable to open file externally";
      return false;
    }
    this.$("status-name").textContent = `opened ${path.split("/").pop() || path} externally`;
    return true;
  }

  containingDirectoryPath(path) {
    const normalized = String(path || "").replace(/\\/g, "/");
    const separator = normalized.lastIndexOf("/");
    return separator < 0 ? "" : normalized.slice(0, separator);
  }

  async openFolderExternally(root, path, label = "folder") {
    const response = await fetch("/api/files/open-external", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, path }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      this.$("status-name").textContent = payload.detail || `unable to open ${label} externally`;
      return false;
    }
    this.$("status-name").textContent = `opened ${label} externally`;
    return true;
  }

  addOpenFileExternallyContextItem(menu, root, path) {
    this.addContextItem(menu, "Open externally", () => { void this.openFileExternally(root, path); }, "link-external");
    this.addContextItem(menu, "Open containing folder externally",
      () => { void this.openFolderExternally(root, this.containingDirectoryPath(path), "containing folder"); }, "folder-opened");
  }

  addOpenFolderExternallyContextItem(menu, root, path) {
    this.addContextItem(menu, "Open folder externally", () => { void this.openFolderExternally(root, path); }, "folder-opened");
  }

  projectRelativeFilePath(project, root, relativePath) {
    const projectRoot = String(project.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const currentRoot = String(root || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const nestedRoot = currentRoot === projectRoot ? "" :
      currentRoot.startsWith(`${projectRoot}/`) ? currentRoot.slice(projectRoot.length + 1) : "";
    return [nestedRoot, String(relativePath || "").replace(/^\/+/, "")].filter(Boolean).join("/");
  }

  openFileDeckViewInNewTab(root, view, relativePath = "", searchQuery = "") {
    const project = this.fileDeckProjectForRoot(root) || this.projects.find((candidate) => candidate.name === this.projectSlug);
    if (!project) return;
    const params = new URLSearchParams();
    params.set("view", view === "tree" ? "project" : view);
    const selectedWorktreeId = this.worktreeId && this.worktreeId !== ALL_WORKTREES_ID && root === this.worktreeRoot()
      ? this.worktreeId : "root";
    // Git included: it is the same files route with ?view=git, which params already carries.
    const basePath = project.name === this.projectSlug
      ? this.encodedFileModeWorktreePath(project.name, selectedWorktreeId)
      : `/f/${encodeURIComponent(project.name)}/${encodeURIComponent(selectedWorktreeId)}`;
    let navigationPath = "";
    if (relativePath) {
      const fileRoot = this.worktreeId && this.worktreeId !== "root" && this.worktreeId !== ALL_WORKTREES_ID && root === this.worktreeRoot() ? root : project.root;
      const filePath = fileRoot === root ? relativePath : this.projectRelativeFilePath(project, root, relativePath);
      if (fileRoot === root) navigationPath = this.encodedRelativeFilePath(filePath);
      else params.set("f", `${fileRoot}|${filePath}`);
    }
    if (searchQuery) params.set("q", searchQuery);
    const query = params.toString() ? `?${params}` : "";
    window.open(`${basePath}${navigationPath ? `/${navigationPath}` : ""}${query}`, "_blank", "noopener,noreferrer");
  }

  openFileDeckView(view) {
    const project = this.fileDeckProjectForRoot(this.worktreeRoot() || this.sessions.find((session) => session.session_id === this.activeId)?.cwd) ||
      this.projects.find((candidate) => candidate.name === this.projectSlug);
    if (!project) return;
    this.setSideView(view === "tree" ? "project" : view, false);
  }

  openTerminalInNewTab(session) {
    const project = this.projects.find((candidate) => candidate.name === session.project) ||
      this.fileDeckProjectForRoot(session.cwd);
    if (!project) return;
    const worktreeSegment = project.name === this.projectSlug
      ? this.worktreeUrlSegment(session.worktree_id || "root")
      : String(session.worktree_branch || session.worktree_id || "root");
    const sessionName = this.titlePresentation(session).text.trim();
    const fragment = sessionName ? `#${encodeURIComponent(sessionName)}` : "";
    window.open(`/p/${encodeURIComponent(project.name)}/${encodeURIComponent(worktreeSegment)}/${encodeURIComponent(session.session_id)}${fragment}`,
      "_blank", "noopener,noreferrer");
  }

  handleFileDeckAuxClick(event, root, relativePath = "") {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    this.openFileDeckInNewTab(root, relativePath);
  }

  handleNavigationAuxClick(event, view) {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    this.openNavigationViewInNewTab(view);
  }

  handleNavigationContextMenu(event, view) {
    event.preventDefault();
    event.stopPropagation();
    this.openNavigationViewInNewTab(view);
  }

  openNavigationViewInNewTab(view) {
    if (view === "terminals") {
      const session = this.session(this.activeId);
      if (session) this.openTerminalInNewTab(session);
      return;
    }
    const entry = this.activeFileKey !== null ? this.openFiles.get(this.activeFileKey) : null;
    const root = entry?.root || this.treeRoot || this.projectRoot();
    if (!root) return;
    if (view === "project" && entry) this.openFileDeckViewInNewTab(root, "tree", entry.path);
    else this.openFileDeckViewInNewTab(root, view === "project" ? "tree" : view,
      "", view === "search" ? this.$("search-query").value.trim() : "");
  }

  compactProjectPath(root) {
    return String(root || "").replace(/^\/Users\/[^/]+/, "~");
  }

  projectForCwd(cwd) {
    const normalized = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
    return this.projects
      .filter((project) => {
        const root = String(project.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
        return normalized === root || normalized.startsWith(root + "/");
      })
      .sort((a, b) => String(b.root || "").length - String(a.root || "").length)[0] || null;
  }

  async chooseProjectFolder() {
    if (this.vscodeMode) return;
    const button = this.$("project-add-btn");
    if (button?.disabled) return;
    if (button) button.disabled = true;
    try {
      const res = await fetch("/api/projects/pick-folder", { method: "POST" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        void uiAlert(payload.detail || "failed to choose project folder");
        return;
      }
      if (payload.cancelled) return;
      const project = payload.project;
      if (!project?.name) {
        void uiAlert("native folder selection returned no project");
        return;
      }
      await this.loadProjects();
      const url = new URL(`/p/${encodeURIComponent(project.name)}`, location.href);
      this.showWorktreeResult("Project added", project.name, url, project.root || "");
    } catch (error) {
      void uiAlert(error.message || "failed to choose project folder");
    } finally {
      if (button) button.disabled = false;
    }
  }

  async init() {
    this.initInlineSizeControls();
    this.initFontSampleEditor();
    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const fontSampleEditorOpen = !this.$("font-samples-backdrop").classList.contains("hidden");
      if (!this.settings.inline_size_controls && !fontSampleEditorOpen) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (fontSampleEditorOpen) this.closeFontSampleEditor();
      else this.exitInlineSizeControls();
    }, true);
    window.addEventListener("message", this.handleHostMessageBound, false);
    window.addEventListener("pagehide", () => {
      this.disconnectRecentFilesWatch();
      this.flushPendingSettingsSave();
      this.flushPendingFileSavesOnPageExit();
      this.flushPendingSearchHistoryRecord();
    });
    window.addEventListener("beforeunload", () => {
      this.flushPendingSettingsSave();
      this.flushPendingFileSavesOnPageExit();
      this.flushPendingSearchHistoryRecord();
    });
    document.body.classList.toggle("termdeck-page-hidden", document.hidden);
    // Sibling tabs read this stamp to learn which session is being watched here, so they do not
    // post a banner for the one session already in front of the user.
    this.markWatchedSession();
    window.addEventListener("focus", () => {
      this.markWatchedSession();
      this.markActiveSessionRead();
    });
    document.addEventListener("visibilitychange", () => {
      document.body.classList.toggle("termdeck-page-hidden", document.hidden);
      this.markWatchedSession();
      this.markActiveSessionRead();
      if (document.visibilityState === "hidden") {
        this.disconnectRecentFilesWatch();
        this.flushPendingSettingsSave();
        this.flushPendingFileSavesOnPageExit();
        this.flushPendingSearchHistoryRecord();
        } else {
        this.updateRecentFilesWatch();
        void this.refreshCurrentProjectState();
        if (!this.sectionCollapsed("recent_files_collapsed")) void this.refreshRecentFiles(true);
      }
    });
    await Promise.all([this.loadAgentSpecs(), this.loadSettings()]);
    if (this.settings.notify_attention !== false || this.settings.notify_agent_idle !== false) {
      // Chrome ignores a permission request that arrives without a user gesture, so a
      // page-load request leaves the permission stuck at "default" forever. Ask again on
      // the first real gesture, where the prompt is actually allowed to appear.
      const requestOnFirstGesture = () => {
        this.maybeRequestNotificationPermission();
        window.removeEventListener("pointerdown", requestOnFirstGesture, true);
        window.removeEventListener("keydown", requestOnFirstGesture, true);
      };
      window.addEventListener("pointerdown", requestOnFirstGesture, true);
      window.addEventListener("keydown", requestOnFirstGesture, true);
    }
    this.initializeMobileSidebar();
    this.loadSearchHistory();
    await this.loadProjects();
    this.initializeEventlyDemoPresentation();
    this.applyVscodeModeLayout();
    if (!this.vscodeMode) {
      this.restoreOpenFiles();
      this.initMonaco();
      this.loadIconMap();
    }
    this.$("settings-gear").onclick = (e) => this.openSettingsPopover(e.currentTarget);
    // Null-safe: #file-view-close is not in index.html yet. This runs during setup, so the throw
    // aborted the rest of this initialisation rather than just failing one button.
    const fileViewClose = this.$("file-view-close");
    if (fileViewClose) fileViewClose.onclick = () => this.navigateBackFromActiveFile();
    this.$("file-history-toggle").onclick = () => this.toggleFileHistory();
    this.$("file-history-toggle").oncontextmenu = (event) => this.openActiveFileHistoryMenu(event);
    this.$("git-review-close").onclick = () => this.closeGitReview();
    this.$("git-review-open-file").onclick = () => this.openFocusedGitWorkingFile();
    this.$("git-review-previous").onclick = () => this.navigateGitReviewDiff(-1);
    this.$("git-review-next").onclick = () => this.navigateGitReviewDiff(1);
    this.$("git-review-layout").onclick = () => this.toggleGitReviewLayout();
    for (const button of this.$("git-review-conflict-sources").querySelectorAll("button[data-source]")) {
      button.onclick = () => this.selectGitConflictSource(button.dataset.source);
    }
    this.$("git-review-conflict-stage").onclick = () => this.stageGitConflictResultAndOpenNext();
    this.$("file-history-close").onclick = () => this.hideFileHistorySidebar();
    for (const button of this.$("file-history-filters").querySelectorAll("button[data-mode]")) {
      button.onclick = () => this.setFileHistoryMode(button.dataset.mode);
    }
    this.$("file-history-diff-previous").onclick = () => this.navigateFileHistoryDiff(-1);
    this.$("file-history-diff-next").onclick = () => this.navigateFileHistoryDiff(1);
    this.initNotebook();
    this.initHistoryFilters();
    this.initSelectionActions();
    this.initIdeFeatures();
    this.initHeaderPickers();
    for (const view of ["terminals", "project", "search", "git"]) {
      this.$("view-" + view).onclick = () => this.handleFileModeNavigationClick(view);
      this.$("view-" + view).onauxclick = (event) => this.handleNavigationAuxClick(event, view);
      if (view !== "terminals") {
        this.$("view-" + view).oncontextmenu = (event) => this.handleNavigationContextMenu(event, view);
      }
    }
    const replaceToggle = this.$("replace-toggle");
    replaceToggle.onclick = () => {
      const bar = this.$("replace-bar");
      bar.classList.toggle("hidden");
      replaceToggle.classList.toggle("on", !bar.classList.contains("hidden"));
    };
    this.$("view-terminals").classList.add("on");
    this.$("vscode-refresh-btn").onclick = () => this.requestVscodeRefresh(false);
    this.$("project-add-btn").onclick = (event) => {
      event.stopPropagation();
      this.toggleHeaderAddMenu();
    };
    this.$("header-add-project").onclick = () => this.runHeaderAddAction("project");
    this.$("header-add-worktree").onclick = () => this.runHeaderAddAction("worktree");
    this.$("header-add-terminal").onclick = () => this.runHeaderAddAction("terminal");
    this.updateHeaderAddMenu();
    const queryInput = this.$("search-query");
    queryInput.autocomplete = "off";
    queryInput.autocapitalize = "off";
    queryInput.autocorrect = "off";
    queryInput.addEventListener("keydown", (e) => {
      if (this.handleFileSearchNavigation(e, "content")) return;
      if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(this.searchDebounce);
        if (!this.activateFileSearchSelection("content")) this.runSearch();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        queryInput.value = "";
        this.setExplorerMode("tree");
      }
    });
    queryInput.addEventListener("input", () => this.debouncedSearch());
    this.syncFileGlobInputs();
    const searchFileGlobInput = this.$("search-file-glob");
    searchFileGlobInput.oninput = this.handleSearchFileGlobInput.bind(this);
    searchFileGlobInput.onkeydown = this.handleSearchFileGlobKeydown.bind(this);
    this.$("file-type-filter-button").onclick = (event) => this.toggleFileTypeFilterMenu(event.currentTarget);
    this.$("search-file-type-filter-button").onclick = (event) => this.toggleFileTypeFilterMenu(event.currentTarget);
    const wordBtn = this.$("search-word-toggle"), caseBtn = this.$("search-case-toggle"), regexBtn = this.$("search-regex-toggle");
    wordBtn.onclick = () => { this.searchWord = !this.searchWord; wordBtn.classList.toggle("on", this.searchWord); };
    caseBtn.onclick = () => { this.searchCase = !this.searchCase; caseBtn.classList.toggle("on", this.searchCase); };
    regexBtn.onclick = () => { this.searchRegex = !this.searchRegex; regexBtn.classList.toggle("on", this.searchRegex); };
    const nameInput = this.$("search-name");
    nameInput.autocomplete = "off";
    nameInput.autocapitalize = "off";
    nameInput.autocorrect = "off";
    const nameCaseBtn = this.$("name-case-toggle");
    nameCaseBtn.onclick = () => {
      this.nameSearchCase = !this.nameSearchCase;
      nameCaseBtn.classList.toggle("on", this.nameSearchCase);
      if (nameInput.value.trim()) void this.runNameSearch();
    };
    nameInput.addEventListener("keydown", (e) => {
      if (this.handleFileSearchNavigation(e, "name")) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (!this.activateFileSearchSelection("name")) this.runNameSearch();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        nameInput.value = "";
        this.setExplorerMode("tree");
      }
    });
    nameInput.addEventListener("input", () => this.debouncedNameSearch());
    this.$("search-history-btn").onclick = (event) => this.toggleSearchHistory(event.currentTarget);
    this.$("name-search-history-btn").onclick = (event) => this.toggleSearchHistory(event.currentTarget);
    this.$("replace-all-btn").onclick = () => this.replaceAll();
    const mtimeBtn = this.$("mtime-toggle");
    mtimeBtn.classList.toggle("on", !this.settings.show_mtime);
    mtimeBtn.title = this.settings.show_mtime ? "Hide last-modified times" : "Show last-modified times";
    mtimeBtn.setAttribute("aria-label", mtimeBtn.title);
    mtimeBtn.onclick = () => {
      this.settings.show_mtime = !this.settings.show_mtime;
      mtimeBtn.classList.toggle("on", !this.settings.show_mtime);
      mtimeBtn.title = this.settings.show_mtime ? "Hide last-modified times" : "Show last-modified times";
      mtimeBtn.setAttribute("aria-label", mtimeBtn.title);
      this.saveSettings();
      this.rerenderTree();
    };
    const treeSortBtn = this.$("tree-sort-toggle");
    treeSortBtn.onclick = () => {
      this.settings.file_tree_sort = this.settings.file_tree_sort === "mtime" ? "name" : "mtime";
      this.updateTreeSortButton();
      this.saveSettings();
      if (this.sideView === "project" && this.$("search-name").value.trim()) void this.runNameSearch();
      else if (this.sideView === "search" && this.$("search-query").value.trim()) void this.runSearch(null, true);
      else this.rerenderTree();
    };
    this.updateTreeSortButton();
    const hideBtn = this.$("hide-excluded-toggle");
    hideBtn.classList.toggle("on", !this.settings.hide_excluded);
    hideBtn.title = this.settings.hide_excluded ? "Show excluded folders" : "Hide excluded folders";
    hideBtn.setAttribute("aria-label", hideBtn.title);
    hideBtn.onclick = () => {
      this.settings.hide_excluded = !this.settings.hide_excluded;
      hideBtn.classList.toggle("on", !this.settings.hide_excluded);
      hideBtn.title = this.settings.hide_excluded ? "Show excluded folders" : "Hide excluded folders";
      hideBtn.setAttribute("aria-label", hideBtn.title);
      this.saveSettings();
      this.rerenderTree();
    };
    this.updateHideDotButton();
    this.$("git-refresh").onclick = () => void this.loadGitSidePanel();
    this.$("files-tree").addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".tree-row");
      if (row && row.dataset.rel) this.openTreeContextMenu(e, row);
    });
    this.initResizer("sidebar-resizer", "sidebar_width", false, 236, 520);
    this.initSideSplit();
    if (!this.vscodeMode) {
      this.updateRecentFilesWatch();
      this.terminalAgeRefreshTimer = window.setInterval(() => {
        this.updateSessionAgeStyles();
        this.updateActiveTerminalAge();
      }, TERMINAL_AGE_REFRESH_MS);
    }
    this.$("session-list").addEventListener("scroll", () => this.hideTerminalSearchHoverPopup(), { passive: true });
    setInterval(() => this.pollStats(), STATS_POLL_MS);
    this.pollStats();
    document.addEventListener("mousedown", (e) => {
      // A dialog belongs to whatever opened it, so answering one is not a click outside that thing:
      // confirming "Move note to Trash" used to close Quick Notes along with the note's tab.
      if (e.target.closest?.(".inline-size-controls, #inline-size-done, #font-samples-backdrop, .td-modal-backdrop")) return;
      for (const id of ["settings-popover", "context-menu"]) {
        const pop = this.$(id);
        if (pop.classList.contains("hidden") || pop.contains(e.target)) continue;
        // The stats readout toggles its own menu on click. Auto-hiding here would let the click
        // that follows reopen it, so a second click could never close it.
        if (id === "context-menu" && this.statsMaintenanceMenuOpen() && e.target.closest?.("#bottombar-stats")) continue;
        pop.classList.add("hidden");
        if (id === "context-menu") this.contextMenuTarget = null;
      }
      const headerAddMenu = this.$("header-add-menu");
      if (headerAddMenu && !headerAddMenu.classList.contains("hidden") && !headerAddMenu.contains(e.target) &&
          !this.$("project-add-btn")?.contains(e.target)) this.closeHeaderAddMenu();
      if (!e.target.closest?.(".header-picker-field")) this.closeHeaderPickers();
      const promptHistory = this.$("history-prompt-history");
      const promptHistoryButton = this.$("history-prompt-history-btn");
      if (promptHistory && !promptHistory.classList.contains("hidden") &&
          !promptHistory.contains(e.target) && !promptHistoryButton?.contains(e.target)) this.closePromptHistory();
      const sendMenu = this.$("history-send-menu");
      if (sendMenu && !sendMenu.classList.contains("hidden") && !e.target.closest?.("#history-send-split")) {
        this.closeHistorySendMenu();
      }
      const slashMenu = this.$("history-slash-menu");
      if (slashMenu && !slashMenu.classList.contains("hidden") && !e.target.closest?.("#history-prompt-wrap")) {
        this.closeHistorySlashMenu();
      }
      const selectionActions = this.$("selection-actions");
      if (selectionActions && !selectionActions.classList.contains("hidden") && !selectionActions.contains(e.target)) {
        this.hideSelectionActions();
      }
      const searchHistoryMenu = this.$("search-history-menu");
      if (searchHistoryMenu && !searchHistoryMenu.classList.contains("hidden") &&
          !searchHistoryMenu.contains(e.target) && !e.target.closest("#search-history-btn, #name-search-history-btn")) {
        this.closeSearchHistory();
      }
      const fileTypeMenu = this.$("file-type-filter-menu");
      if (fileTypeMenu && !fileTypeMenu.classList.contains("hidden") && !fileTypeMenu.contains(e.target) &&
          !e.target.closest("#file-type-filter-button, #search-file-type-filter-button, #recent-file-type-filter-button")) {
        this.closeFileTypeFilterMenu();
      }
      const notebookPanel = this.$("notebook-panel");
      const notebookToggle = this.$("notebook-toggle");
      const fileTabsNotebook = this.$("file-tabs-notebook");
      if (this.settings.notebook_open && notebookPanel && !notebookPanel.contains(e.target) &&
          !notebookToggle?.contains(e.target) && !fileTabsNotebook?.contains(e.target)) {
        this.setNotebookOpen(false, { focus: false });
      }
    });
    this.$("history-search-close").onclick = () => this.closeHistorySearchContext();
    this.$("history-search-open").onclick = () => this.openHistorySearchSession();
    this.$("history-search-backdrop").onclick = (event) => {
      if (event.target === this.$("history-search-backdrop")) this.closeHistorySearchContext();
    };
    this.$("modal-cancel").onclick = () => this.closeModal();
    this.$("modal").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.createSession();
    });
    this.$("modal-model").onchange = () => { this.clearModalError(); this.updateModalPermissions(); };
    this.$("worktree-modal-cancel").onclick = () => this.closeWorktreeModal();
    this.$("worktree-modal-create").onclick = () => void this.createProjectWorktree();
    this.$("worktree-location-browse").onclick = () => void this.browseWorktreeLocation();
    this.$("worktree-modal-open-existing").onclick = () => this.openConflictingWorktree();
    this.$("worktree-name").oninput = () => this.syncWorktreeLocation();
    this.$("worktree-branch").oninput = () => this.syncWorktreeLocation();
    // Once the path is hand-edited it stops following the name; nothing should overwrite a typed path.
    this.$("worktree-location").oninput = () => {
      this.worktreeLocationEdited = true;
      this.updateWorktreeCreateState();
    };
    const baseRef = this.$("worktree-base-ref");
    baseRef.oninput = () => {
      this.worktreeBranchActiveIndex = 0;
      this.openWorktreeBranchList({ filtered: true });
      this.syncWorktreeLocation();
      this.updateWorktreeCreateState();
    };
    baseRef.onkeydown = (event) => this.handleWorktreeBranchKeydown(event);
    baseRef.onfocus = () => this.openWorktreeBranchList();
    baseRef.onblur = () => this.closeWorktreeBranchList();
    this.$("worktree-base-ref-toggle").onclick = () => {
      if (this.worktreeBranchListOpen()) return this.closeWorktreeBranchList();
      baseRef.focus();
      baseRef.select();
    };
    this.$("worktree-modal-backdrop").addEventListener("mousedown", (event) => {
      if (event.target === this.$("worktree-modal-backdrop")) this.closeWorktreeModal();
    });
    this.$("worktree-result-close").onclick = () => this.closeWorktreeResult();
    this.$("worktree-result-backdrop").addEventListener("mousedown", (event) => {
      if (event.target === this.$("worktree-result-backdrop")) this.closeWorktreeResult();
    });
    for (const id of ["history-btn", "vscode-history-btn"]) {
      const button = this.$(id);
      if (button) {
        button.onmousedown = (event) => event.preventDefault();
        button.onclick = () => {
          void this.toggleHistory().finally(() => this.refocusActiveInputAfterToolbarAction());
        };
      }
    }
    this.$("terminal-history-more").onclick = () => {
      this.setHistoryMode(true);
      this.refocusActiveInputAfterToolbarAction();
    };
    this.updateShortcutTitles();
    this.$("history-edits-toggle").onclick = () => this.toggleHistoryEdits();
    this.$("history-scroll-bottom").onmousedown = (event) => event.preventDefault();
    this.$("history-scroll-bottom").onclick = () => {
      this.scrollHistoryToBottom();
      this.refocusActiveInputAfterToolbarAction();
    };
    this.$("history-body").addEventListener("scroll", () => this.loadOlderHistoryWhenNearTop(), { passive: true });
    this.$("history-body").addEventListener("touchend", () => this.loadOlderHistoryWhenNearTop(), { passive: true });
    this.$("history-body").addEventListener("click", (event) => this.handleHistoryFileLink(event));
    for (const id of ["terminal-resync-btn", "vscode-terminal-resync-btn"]) {
      const button = this.$(id);
      if (button) {
        button.onmousedown = (event) => event.preventDefault();
        button.onclick = () => {
          if (this.historyOpen) this.refreshActiveTranscript();
          else this.resyncActiveTerminal();
          this.refocusActiveInputAfterToolbarAction();
        };
      }
    }
    this.$("editor-wrap-toggle").onclick = () => {
      this.settings.editor_no_wrap = !this.settings.editor_no_wrap;
      this.applySettings({ fitTerminals: false });
      this.saveSettings();
    };
    this.$("terminal-find-input").addEventListener("input", () => this.updateTerminalFindMatches());
    this.$("terminal-find-input").addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeTerminalFind();
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.moveTerminalFindMatch(event.shiftKey ? -1 : 1);
      }
    });
    this.$("terminal-find-previous").onclick = () => this.moveTerminalFindMatch(-1);
    this.$("terminal-find-next").onclick = () => this.moveTerminalFindMatch(1);
    this.$("terminal-find-close").onclick = () => this.closeTerminalFind();
    const stats = this.$("bottombar-stats");
    stats.onclick = (event) => this.toggleStatsMaintenanceMenu(event.currentTarget);
    stats.onkeydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.toggleStatsMaintenanceMenu(event.currentTarget);
    };
    this.$("history-send").onclick = () => {
      this.closeHistorySendMenu();
      this.handleHistorySendButton();
    };
    this.$("history-send-menu-toggle").onclick = (event) => {
      event.stopPropagation();
      this.toggleHistorySendMenu();
    };
    this.$("history-queue").onclick = () => {
      this.closeHistorySendMenu();
      this.sendHistoryPrompt({ queue: true });
    };
    this.$("history-stop").onclick = () => {
      this.closeHistorySendMenu();
      this.interruptHistoryPrompt();
    };
    this.$("history-queued-toggle").onclick = () => this.toggleHistoryQueueCollapsed();
    this.$("history-prompt-history-btn").onclick = () => this.togglePromptHistory();
    this.$("history-prompt-help-text").textContent = this.touchMobileLayoutEnabled() ? "" :
      `Shift+Enter submit · ${PRIMARY_MODIFIER_DISPLAY}+Enter queue · Enter newline · ↑↓ edit queued`;
    this.$("history-prompt").addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (this.historySlashMenuOpen()) {
          this.closeHistorySlashMenu();
          return;
        }
        if (!this.$("history-send-menu").classList.contains("hidden")) {
          this.closeHistorySendMenu();
          return;
        }
        if (this.touchMobileLayoutEnabled()) return;
        this.interruptHistoryPrompt();
        return;
      }
      if (this.historySlashMenuOpen() && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        e.stopPropagation();
        this.moveHistorySlashMenuSelection(e.key === "ArrowUp" ? -1 : 1);
        return;
      }
      if (this.historySlashMenuOpen() && (e.key === "Enter" || e.key === "Tab")) {
        e.preventDefault();
        e.stopPropagation();
        this.selectHistorySlashCommand(this.historySlashMenuIndex);
        return;
      }
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.metaKey && !e.ctrlKey && !e.altKey &&
          !this.$("history-prompt").value && this.sessionInteractionState(this.activeId, false)?.promptQueue?.length) {
        e.preventDefault();
        e.stopPropagation();
        const view = this.sessionInteractionState(this.activeId, false);
        const queueLength = view.promptQueue.length;
        view.promptQueueCollapsed = false;
        const current = Number.isInteger(view.promptQueueEditIndex) ? view.promptQueueEditIndex :
          (e.key === "ArrowUp" ? queueLength - 1 : 0);
        view.promptQueueEditIndex = Math.max(0, Math.min(queueLength - 1,
          Number.isInteger(view.promptQueueEditIndex) ? current + (e.key === "ArrowUp" ? -1 : 1) : current));
        this.renderHistoryQueue(view);
        requestAnimationFrame(() => {
          const editor = this.$("history-queued-items")?.querySelector(
            `[data-queue-index="${view.promptQueueEditIndex}"] .history-queued-editor`);
          if (editor) {
            editor.focus();
            editor.select();
          }
        });
        return;
      }
      if (e.key !== "Enter" || e.isComposing) return;
      const submitPrompt = e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
      const queuePrompt = !e.shiftKey && !e.altKey && (e.metaKey || e.ctrlKey);
      if (!submitPrompt && !queuePrompt) return;
      e.preventDefault();
      e.stopPropagation();
      this.sendHistoryPrompt({ queue: queuePrompt });
    }, true);
    const historyPrompt = this.$("history-prompt");
    historyPrompt.addEventListener("paste", (event) => {
      const files = this.historyImageFilesFromDataTransfer(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      void this.insertHistoryAttachmentFiles(this.sessionInteractionState(this.activeId), files);
    });
    historyPrompt.addEventListener("dragover", (event) => {
      const files = this.historyImageFilesFromDataTransfer(event.dataTransfer);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      historyPrompt.classList.add("image-drop-target");
    });
    historyPrompt.addEventListener("dragleave", () => historyPrompt.classList.remove("image-drop-target"));
    historyPrompt.addEventListener("drop", (event) => {
      const files = this.historyImageFilesFromDataTransfer(event.dataTransfer);
      historyPrompt.classList.remove("image-drop-target");
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      void this.insertHistoryAttachmentFiles(this.sessionInteractionState(this.activeId), files);
    });
    historyPrompt.addEventListener("input", () => {
      const view = this.sessionInteractionState(this.activeId, false);
      if (!view) return;
      this.persistMarkdownPromptDraft(view, this.$("history-prompt").value);
      this.resizeHistoryPrompt();
      this.updateHistorySendMenu();
      this.updateHistorySlashMenu();
    });
    this.$("attach-btn").onclick = () => this.historyOpen ? this.attachToHistory() : this.attachToActive();
    this.$("reveal-session-btn").onclick = () => {
      if (this.activeFileKey !== null) void this.revealActiveFile();
      else this.revealAndFocusActiveTerminalInSidebar();
    };
    for (const id of ["scroll-bottom-btn", "vscode-scroll-bottom-btn"]) {
      const button = this.$(id);
      if (button) {
        button.onmousedown = (event) => event.preventDefault();
        button.onclick = () => {
          this.scrollActiveToBottom();
          this.refocusActiveInputAfterToolbarAction();
        };
      }
    }
    this.$("keys-btn").onclick = () => this.openKeybindings();
    this.$("keys-done").onclick = () => this.$("keys-backdrop").classList.add("hidden");
    this.$("keys-reset").onclick = () => this.resetKeybindings();
    this.$("keys-search").addEventListener("input", () => this.renderKeybindingsList());
    this.$("keys-backdrop").addEventListener("mousedown", (e) => { if (e.target.id === "keys-backdrop") this.$("keys-backdrop").classList.add("hidden"); });
    this.$("terminal-process-report-close").onclick = () => this.closeTerminalProcessReport();
    this.$("terminal-process-report-backdrop").addEventListener("mousedown", (e) => {
      if (e.target.id === "terminal-process-report-backdrop") this.closeTerminalProcessReport();
    });
    this.$("modal-backdrop").addEventListener("mousedown", (e) => {
      if (e.target.id === "modal-backdrop") this.closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (this.isDesktopTerminalSelectInputEvent(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.selectActiveTerminalInputText();
        return;
      }
      if (!this.isDesktopTerminalSelectAllEvent(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.selectActiveTerminalText();
    }, true);
    document.addEventListener("keydown", (e) => this.handleCodexCommandTranscriptShortcut(e), true);
    // Every per-element dragleave/drop/dragend only runs when the drag ends on that same element, so a
    // drag released anywhere else — empty sidebar, outside the window, Escape — strands its indicator.
    // Bubble phase, never capture: the drop handlers read .drop-after off the target to decide placement,
    // so this has to run after them.
    for (const endEvent of ["dragend", "drop"]) {
      document.addEventListener(endEvent, () => this.clearDragLandingIndicator(true));
    }
    // Cmd+B is a browser bookmark/sidebar shortcut on macOS. Capture the
    // configured TermDeck bindings before the browser gets a chance to act.
    window.addEventListener("keydown", (e) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== "b") return;
      if (!this.$("keys-backdrop").classList.contains("hidden") ||
          !this.$("modal-backdrop").classList.contains("hidden")) return;
      const actionId = this.bindingMap()[this.eventToBinding(e)];
      if (actionId !== "new-terminal" && actionId !== "fork-terminal") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.runAction(actionId);
    }, true);
    window.addEventListener("keydown", (e) => {
      if (!this.isRecentTerminalsShortcut(e) || !this.$("keys-backdrop").classList.contains("hidden") ||
          !this.$("modal-backdrop").classList.contains("hidden")) return;
      const actionId = this.bindingMap()[this.eventToBinding(e)];
      if (actionId !== "recent-terminals") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.runAction(actionId);
    }, true);
    window.addEventListener("keydown", (e) => {
      if (this.vscodeMode || !this.$("keys-backdrop").classList.contains("hidden") ||
          !this.$("modal-backdrop").classList.contains("hidden")) return;
      const actionId = this.bindingMap()[this.eventToBinding(e)];
      if (actionId !== "open-file-search") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.runAction(actionId);
    }, true);
    window.addEventListener("keydown", (e) => {
      if (!this.$("keys-backdrop").classList.contains("hidden") ||
          !this.$("modal-backdrop").classList.contains("hidden") || !this.fileHistoryActiveComparison?.isDiff) return;
      const actionId = this.bindingMap()[this.eventToBinding(e)];
      if (!FILE_HISTORY_SHORTCUT_ACTIONS.has(actionId)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.runAction(actionId);
    }, true);
    document.addEventListener("keydown", (e) => {
      if (!this.$("keys-backdrop").classList.contains("hidden")) {
        if (e.key === "Escape") this.$("keys-backdrop").classList.add("hidden");
        return;
      }
      // Null-safe because #worktree-review-backdrop is not in index.html yet: without this the throw
      // lands on EVERY keydown and kills every global shortcut below. Compared against false rather than
      // negated -- `!undefined` would be true and swallow all keys when the element is absent.
      if (this.$("worktree-review-backdrop")?.classList.contains("hidden") === false) {
        if (e.key === "Escape") {
          e.preventDefault();
          this.closeWorktreeReview();
        }
        return;
      }
      if (e.key === "Escape" && !this.$("header-add-menu").classList.contains("hidden")) {
        e.preventDefault();
        this.closeHeaderAddMenu();
        return;
      }
      if (e.key === "Escape" && ["project", "worktree"].some((kind) =>
        !this.headerPickerElements(kind).menu.classList.contains("hidden"))) {
        e.preventDefault();
        this.closeHeaderPickers();
        return;
      }
      const worktreeResultOpen = !this.$("worktree-result-backdrop").classList.contains("hidden");
      if (worktreeResultOpen) {
        if (e.key === "Escape") this.closeWorktreeResult();
        return;
      }
      const worktreeModalOpen = !this.$("worktree-modal-backdrop").classList.contains("hidden");
      if (worktreeModalOpen) {
        if (e.key === "Escape") this.closeWorktreeModal();
        if (e.key === "Enter") void this.createProjectWorktree();
        return;
      }
      const modalOpen = !this.$("modal-backdrop").classList.contains("hidden");
      if (modalOpen) {
        if (e.key === "Escape") this.closeModal();
        return;
      }
      if (e.key === "Escape" && !this.$("context-menu").classList.contains("hidden")) {
        e.preventDefault();
        e.stopPropagation();
        this.closeContextMenu();
        return;
      }
      if (e.key === "Escape" && this.exitInlineSizeControls()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (!this.vscodeMode && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f" &&
          this.activeFileKey === null && !this.historyOpen && e.target.closest?.(".xterm")) {
        e.preventDefault();
        e.stopPropagation();
        this.openTerminalFind();
        return;
      }
      if (this.tryAppShortcut(e)) return;
      if (e.key === "Escape" && this.activeFileKey !== null && !e.target.closest?.("#notebook-panel")) {
        e.preventDefault();
        e.stopPropagation();
        this.navigateBackFromActiveFile();
        return;
      }
      if (this.isTypingTarget(e)) return;
      const treeVisible = !this.$("files-section").classList.contains("hidden") &&
        !this.$("files-tree").classList.contains("hidden");
      const selectedRel = this.selectedTreeRow?.dataset?.rel;
      if (treeVisible && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter"].includes(e.key) &&
          !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        this.treeKeyNav(e.key);
        return;
      }
      if (treeVisible && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const nameInput = this.$("search-name");
        nameInput.value += e.key;
        nameInput.focus();
        return;
      }
      if (!selectedRel) return;
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === "Backspace") {
        e.preventDefault();
        this.deleteTreePath(selectedRel);
        return;
      }
      if (!e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "r") { e.preventDefault(); this.renameTreePath(selectedRel); }
      else if (key === "m") { e.preventDefault(); this.moveTreePath(selectedRel); }
    });
    window.addEventListener("popstate", (e) => this.applyBrowserNavigationState(e.state));
    const startupNav = this.initialNav && this.initialNav.kind !== "file" ? this.initialNav : { kind: "init" };
    this.lastValidNavState = startupNav;
    this.lastNavJson = JSON.stringify(startupNav);
    history.replaceState(startupNav, "", this.navUrl(startupNav));
    const scheduleLayoutFit = () => {
      this.scheduleTerminalLayoutFit();
    };
    new ResizeObserver(scheduleLayoutFit).observe(this.$("terminal-area"));
    new ResizeObserver(scheduleLayoutFit).observe(this.$("main"));
    window.addEventListener("resize", scheduleLayoutFit);
    this.syncMobileVisualViewport();
    window.visualViewport?.addEventListener("resize", this.mobileViewportResizeHandler);
    window.addEventListener("orientationchange", this.mobileOrientationChangeHandler);
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) scheduleLayoutFit();
    });
    this.installTerminalSizeDebugOverlay();
    this.initializeMobileConnectionWarning();
    void this.initializeRemoteIdleMode();
    this.refresh().finally(() => this.connectStatusStream());
    setInterval(() => this.refresh(), SESSION_LIST_REFRESH_MS);
  }

  navUrl(state) {
    const params = new URLSearchParams();
    if (this.projectSlug === "evently-demo" && new URLSearchParams(location.search).get("demo") === "evently") {
      params.set("demo", "evently");
    }
    // One route for every files surface. Git is a side panel and a diff is something shown in the same
    // tabbed workspace, so both ride in the query (?view=git, git_path=...) rather than owning a route of
    // their own. /g/ read its path segment as part of the Git route, which meant an open file addressed
    // there lost its path on reload and came back on whatever the panel had selected; and once the URL
    // was on /g/, every later switch to files or search inherited it. Addresses of that shape still load
    // -- the server keeps the routes and the boot parser reads them as ?view=git.
    const panelView = state.kind === "git-diff" ? "git"
      : FILES_SIDE_PANEL_TABS.includes(state.view) ? state.view : "";
    const fileModeNavigation = state.kind !== "term" &&
      (FILE_ROUTE_NAV_KINDS.includes(state.kind) || state.kind === "files" || state.kind === "git-diff" ||
       !!panelView || location.pathname.startsWith("/f/") || location.pathname.startsWith("/g/"));
    const basePath = fileModeNavigation ? this.encodedFileModeWorktreePath() : this.encodedProjectWorktreePath();
    let navigationPath = "";
    let fragment = "";
    if (state.kind === "term") {
      navigationPath = encodeURIComponent(state.id);
      const session = this.session(state.id);
      // The stable name, not the presented one. A working agent animates a spinner glyph into its title,
      // and titlePresentation only strips one leading glyph while codex writes two ("⠇ ⠙ name"), so the
      // fragment changed on every spinner frame. That defeats the identical-state guard in pushNav and
      // turns navigation into a history write several times a second. Chrome absorbs it; WebKit enforces
      // a limit of 100 history writes per 10 seconds and THROWS, which aborts whatever called it --
      // measured in Safari as the terminal not scrolling at all.
      const sessionName = session
        ? this.stripTitleStatusPrefixes(this.titlePresentation(session).text).trim() : "";
      if (sessionName) fragment = `#${encodeURIComponent(sessionName)}`;
    } else if (state.kind === "file" || state.kind === "open-file") {
      navigationPath = this.relativeNavigationPathForFileKey(state.key);
      if (!navigationPath && state.key) params.set("f", state.key);
    } else if (state.kind === "file-history") {
      navigationPath = this.relativeNavigationPathForFileKey(state.key);
      if (!navigationPath && state.key) params.set("f", state.key);
      params.set("history", state.mode || "all");
      if (state.selection?.length) params.set("history_selection", state.selection.join(","));
    } else if (state.kind === "file-history-path") {
      navigationPath = this.encodedRelativeFilePath(state.selector);
      params.set("history", state.mode || "all");
      if (state.selection?.length) params.set("history_selection", state.selection.join(","));
    } else if (state.kind === "git-diff") {
      params.set("git_path", state.path);
      params.set("git_scope", state.scope || "working");
      if (state.revision) params.set("git_revision", state.revision);
      if (state.previous_path) params.set("git_previous_path", state.previous_path);
      if (state.base) params.set("git_base", state.base);
      if (state.target) params.set("git_target", state.target);
    } else if (state.kind === "path") {
      navigationPath = this.encodedRelativeFilePath(state.selector);
    } else if (state.kind === "files") {
      if (state.q) params.set("q", state.q);
    } else if (state.kind === "search") {
      params.set("q", state.q);
      if (state.glob) params.set("glob", state.glob);
      if (state.word) params.set("w", "1");
      if (state.case_sensitive) params.set("c", "1");
      if (state.regex) params.set("re", "1");
    }
    // The all-projects root has no project route to extend: "/" + "/<segment>" forms a
    // protocol-relative URL whose HOST is the segment, and pushState throws on it -- aborting
    // boot when the startup state restores a terminal, and aborting activate() at the root
    // view. A bare "/<segment>" is not a served route either, so the root keeps its path:
    // files fall back to the ?f= param and a terminal keeps its name in the fragment.
    if (basePath === "/" && navigationPath) {
      if (state.key) params.set("f", state.key);
      navigationPath = "";
    }
    // /f/ means the project panel unless the query says otherwise, so only the other two need saying.
    if (panelView && panelView !== "project") params.set("view", panelView);
    const qs = params.toString();
    return `${basePath}${navigationPath ? `/${navigationPath}` : ""}${qs ? `?${qs}` : ""}${fragment}`;
  }

  pushNav(state) {
    if (this.applyingHistory) return;
    const json = JSON.stringify(state);
    if (json === this.lastNavJson) return;
    this.lastNavJson = json;
    this.lastNavUrl = this.navUrl(state);
    this.lastValidNavState = state;
    history.pushState(state, "", this.lastNavUrl);
  }

  replaceNav(state) {
    const json = JSON.stringify(state);
    // Skip a write that changes nothing, the way pushNav already does. This computed the same key but
    // never consulted it, so sitting still on one terminal rewrote the identical URL about once a second
    // -- measured at 15 writes in 15s. Harmless in isolation, but history writes are a rate-limited
    // resource in WebKit, and spending them on no-ops is what leaves no headroom for real navigation.
    const url = this.navUrl(state);
    if (json === this.lastNavJson && url === this.lastNavUrl) return;
    this.lastNavJson = json;
    this.lastNavUrl = url;
    this.lastValidNavState = state;
    history.replaceState(state, "", url);
  }

  parseNavState(rawState) {
    if (!rawState) return null;
    if (typeof rawState === "object" && !Array.isArray(rawState)) return rawState;
    if (typeof rawState !== "string") return null;
    try {
      const parsed = JSON.parse(rawState);
      return typeof parsed === "object" && parsed && !Array.isArray(parsed) ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  applyBrowserNavigationState(state) {
    const projectMatch = location.pathname.match(/^\/[pfg]\/[^/]+\/([^/]+)/);
    const targetWorktreeUrlSegment = projectMatch?.[1] ? decodeURIComponent(projectMatch[1]) : "";
    const targetWorktree = this.worktreeForUrlSegment(targetWorktreeUrlSegment);
    if (targetWorktreeUrlSegment && !targetWorktree) throw new Error(`unknown or ambiguous worktree URL segment: ${targetWorktreeUrlSegment}`);
    if (targetWorktree && targetWorktree.id !== this.stateWorktreeId()) {
      location.reload();
      return;
    }
    const navigationState = this.parseNavState(state);
    if (!navigationState) return;
    this.lastNavJson = JSON.stringify(navigationState);
    this.lastNavUrl = `${location.pathname}${location.search}${location.hash}`;
    this.applyNavState(navigationState);
  }

  applyNavState(state) {
    if (!state || state.kind === "init") return;
    if (this.fileHistoryOpen && !["file-history", "file-history-path"].includes(state.kind)) {
      this.deactivateFileHistoryTab();
    }
    if (state.kind === "path") {
      const selector = String(state.selector || "");
      if (!selector) return;
      if (this.session(selector)) {
        this.setSideView("terminals", false);
        this.replaceNav({ kind: "term", id: selector });
        this.activate(selector, { history: false, reveal: true });
      } else {
        const root = this.worktreeRoot();
        if (root) {
          const view = FILES_SIDE_PANEL_TABS.includes(state.view) ? state.view : this.lastFilesSidePanelTab;
          this.setSideView(FILES_SIDE_PANEL_TABS.includes(view) ? view : "project", false);
          this.replaceNav({ kind: "file", key: `${root}|${selector}`, view });
          void this.openFile(root, selector, null, null, { pinned: true, history: false, view });
        }
      }
      return;
    }
    if (state.kind === "file-history-path") {
      const root = this.worktreeRoot();
      if (root && state.selector) {
        const view = FILES_SIDE_PANEL_TABS.includes(state.view) ? state.view : this.lastFilesSidePanelTab;
        this.setSideView(FILES_SIDE_PANEL_TABS.includes(view) ? view : "project", false);
        void this.openFileHistoryForPath(root, state.selector, state.mode || "all",
          { history: false, selection: state.selection || [], view });
      }
      return;
    }
    if (state.kind === "file-history") {
      const separator = String(state.key || "").indexOf("|");
      if (separator <= 0) return;
      const root = state.key.slice(0, separator);
      const path = state.key.slice(separator + 1);
      const view = FILES_SIDE_PANEL_TABS.includes(state.view) ? state.view : this.lastFilesSidePanelTab;
      this.setSideView(FILES_SIDE_PANEL_TABS.includes(view) ? view : "project", false);
      void this.openFileHistoryForPath(root, path, state.mode || "all", { history: false, selection: state.selection || [], view });
      return;
    }
    if (state.kind === "git-diff") {
      const root = this.worktreeRoot();
      if (!root || !state.path) return;
      this.setSideView("git", false);
      this.gitExpandedCommitId = state.revision ? state.revision.slice(0, 7) : "";
      void this.openGitReviewDiff(root, state.path, state.scope || "working", false,
        { revision: state.revision || "", previousPath: state.previous_path || "", base: state.base || "",
          target: state.target || "", history: false });
      return;
    }
    if (state.kind === "open-file") {
      const separator = String(state.key || "").indexOf("|");
      if (separator <= 0) return;
      const root = String(state.key).slice(0, separator);
      const path = String(state.key).slice(separator + 1);
      this.setSideView(["project", "search", "git"].includes(state.view) ? state.view : "project", false);
      void this.openFile(root, path, null, null, { pinned: true, history: false });
      return;
    }
    if (state.kind === "files") {
      const view = ["project", "search", "git"].includes(state.view) ? state.view : "project";
      if (view === "git" && this.gitReviewOpen) this.closeGitReview(false);
      this.setSideView(view, false);
      if (view === "search" && state.q) {
        this.$("search-query").value = state.q;
        void this.runSearch(state.q, true);
      }
      if (view === "git" && this.activeFileKey === null && this.openFiles.size) {
        const key = [...this.openFiles.keys()].at(-1);
        void this.activateFile(key, null, { history: false });
      } else if (location.pathname.startsWith("/f/") && this.openFiles.size) {
        const key = [...this.openFiles.keys()].at(-1);
        this.replaceNav({ kind: "file", key, view });
        void this.activateFile(key, null, { history: false, view });
      }
      return;
    }
    if (state.kind === "file" && !this.openFiles.has(state.key)) {
      const returnId = String(state.return_to || "");
      const fallback = returnId && this.session(returnId)
        ? { kind: "term", id: returnId }
        : (this.lastValidNavState && this.lastValidNavState.kind !== "init"
          ? this.lastValidNavState
          : (this.activeId ? { kind: "term", id: this.activeId } : { kind: "init" }));
      this.replaceNav(fallback);
      return;
    }
    this.applyingHistory = true;
    this.lastNavJson = JSON.stringify(state);
    this.lastValidNavState = state;
    try {
      if (state.kind === "term" && this.session(state.id)) {
        if (state.history_scroll && typeof state.history_scroll === "object") {
          this.historyScrollBySession.set(state.id, state.history_scroll);
        }
        this.setSideView("terminals", false);
        this.activate(state.id, { history: false, reveal: true });
      } else if (state.kind === "file" && this.openFiles.has(state.key)) {
        const view = FILES_SIDE_PANEL_TABS.includes(state.view) ? state.view : this.lastFilesSidePanelTab;
        this.setSideView(FILES_SIDE_PANEL_TABS.includes(view) ? view : "project", false);
        this.activateFile(state.key, null, { history: false, view });
      } else if (state.kind === "search") {
        this.searchWord = !!state.word;
        this.searchCase = !!state.case_sensitive;
        this.searchRegex = !!state.regex;
        this.$("search-word-toggle").classList.toggle("on", this.searchWord);
        this.$("search-case-toggle").classList.toggle("on", this.searchCase);
        this.$("search-regex-toggle").classList.toggle("on", this.searchRegex);
        this.setFileGlobForMode("search", state.glob || "");
        if (this.sideView !== "search") {
          this.sideView = "terminals";
          this.setSideView("search");
        }
        this.runSearch(state.q, true);
      }
    } finally {
      this.applyingHistory = false;
    }
  }

  isTypingTarget(e) {
    const target = e.target;
    return target.tagName === "INPUT" || target.tagName === "TEXTAREA" ||
      (target.closest && (target.closest(".xterm") || target.closest("#monaco-host") || target.closest("#notebook-editor-host")));
  }

  async loadIconMap() {
    try {
      const res = await fetch(MATERIAL_ICONS_MAP_URL);
      this.iconMap = await res.json();
    } catch (err) {
      this.iconMap = null;
    }
  }

  fileIconUrl(fileName) {
    let icon = "file";
    if (this.iconMap) {
      const lower = fileName.toLowerCase();
      icon = this.iconMap.fileNames[lower] || null;
      if (!icon) {
        const parts = lower.split(".");
        for (let i = 1; i < parts.length && !icon; i++) icon = this.iconMap.fileExtensions[parts.slice(i).join(".")] || null;
      }
      icon = icon || this.iconMap.file || "file";
    }
    return `${MATERIAL_ICONS_BASE}${icon}.svg`;
  }

  fileTypeIconEl(fileName, cssClass) {
    const img = document.createElement("img");
    img.className = cssClass;
    img.src = this.fileIconUrl(fileName);
    img.onerror = () => { img.src = MATERIAL_ICONS_BASE + "file.svg"; img.onerror = null; };
    return img;
  }

  async refresh() {
    if (!this.initialLoadComplete) this.showInitialLoadingState();
    let sessions, closed;
    try {
      const [sessionsRes, closedRes] = await Promise.all(
        [fetch("/api/sessions" + this.projectQuery()), fetch("/api/closed" + this.projectQuery())]);
      sessions = await sessionsRes.json();
      closed = await closedRes.json();
    } catch (err) {
      if (!this.initialLoadComplete) this.showInitialLoadFailure();
      return;
    }
    const previousSessionListSignature = this.sessionListSignature;
    this.sessions = this.worktreeId === ALL_WORKTREES_ID ? sessions : this.applySessionOrder(sessions);
    this.closedSessions = closed;
    const currentSessionIds = new Set(this.sessions.map((session) => session.session_id));
    const staleUnreadSessionIds = [...this.unreadSessions].filter((sessionId) => !currentSessionIds.has(sessionId));
    if (staleUnreadSessionIds.length) {
      for (const sessionId of staleUnreadSessionIds) this.unreadSessions.delete(sessionId);
      this.persistUnreadSessionDelta(staleUnreadSessionIds, false);
    }
    for (const s of this.sessions) {
      this.cacheSessionModel(s);
      const view = this.sessionInteractionState(s.session_id, false);
      if (view && !view.promptEditing && !view.promptSubmitting && !view.promptDraftSyncPending &&
          view.pendingDraftSync === null && view.pendingTerminalDraft === null && view.promptDraft !== (s.draft || "")) {
        view.promptDraft = s.draft || "";
        if (s.session_id === this.activeId && this.historyOpen) this.showPromptDraft(view);
      }
      // The session list already carries the server's authoritative working
      // state. Do not infer it from the CLI title marker: that marker can be
      // restored only after a terminal websocket is opened, which made a
      // browser refresh appear idle until the user clicked that tab.
      const spinning = !s.dormant && s.processing === true;
      const serverNeedsAttention = s.needs_attention === true;
      const previousServerNeedsAttention = this.attentionServerStates.get(s.session_id);
      this.attentionServerStates.set(s.session_id, serverNeedsAttention);
      if (serverNeedsAttention && previousServerNeedsAttention !== true) this.triggerSessionAttention(s.session_id);
      const processingSince = Number(s.processing_since);
      if (processingSince > 0 && !this.processingStates.get(s.session_id) &&
          !this.historyPendingProcessing.has(s.session_id)) {
        this.processingSince.set(s.session_id, processingSince * 1000);
      }
      if (!this.processingStates.has(s.session_id)) {
        this.processingStates.set(s.session_id, spinning);
        if (spinning && !this.processingSince.has(s.session_id)) this.processingSince.set(s.session_id, Date.now());
      }
      else this.updateProcessingState(s.session_id, spinning);
    }
    for (const s of this.closedSessions) this.cacheSessionModel(s);
    const ids = new Set(sessions.map((s) => s.session_id));
    if (this.nativeVscodeMode) {
      for (const existingId of this.nativeSessionIds) {
        if (!ids.has(existingId)) this.postVscodeNativeClose(existingId);
      }
    }
    for (const [id, view] of [...this.views]) {
      if (!ids.has(id)) {
        this.postVscodeNativeClose(id);
        this.destroyView(id, view);
      }
    }
    for (const id of [...this.transcriptSessionStates.keys()]) {
      if (!ids.has(id)) this.transcriptSessionStates.delete(id);
    }
    if (this.activeId && !ids.has(this.activeId)) this.activeId = null;
    if (this.initialNav) {
      const nav = this.initialNav;
      this.initialNav = null;
      this.applyNavState(nav);
    }
    if (!this.activeId && sessions.length && this.activeFileKey === null) {
      const remembered = this.getProjectState().active_session_id;
      const selectedSessionId = ids.has(remembered) ? remembered : sessions[0].session_id;
      if (location.pathname.startsWith("/f/") || location.pathname.startsWith("/g/")) this.activeId = selectedSessionId;
      else this.activate(selectedSessionId);
    }
    if (previousSessionListSignature !== this.sessionListSignatureFor(this.sessions) || !this.sessionTitleEls.size) {
      this.renderList();
    } else {
      this.updateSessionRows();
    }
    // Recently modified files are a standalone-only sidebar section.
    if (!this.vscodeMode) this.updateRecentFilesWatch();
    if (this.revealActiveSessionOnLoad) {
      this.revealActiveSessionOnLoad = false;
      this.keepActiveSessionVisible();
    }
    this.renderTopbar();
    if (this.nativeVscodeMode) {
      for (const session of this.sessions) {
        const isActive = this.activeId === session.session_id;
        const visible = this.activeId ? (isActive && !this.historyOpen) : undefined;
        this.postVscodeNativeSession(session, visible);
      }
      this.nativeSessionIds = new Set(this.sessions.map((s) => s.session_id));
    }
    this.scheduleTerminalLayoutFit();
    this.finishInitialLoadingState();
  }

  connectStatusStream() {
    if (this.statusWs && (this.statusWs.readyState === WebSocket.OPEN || this.statusWs.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/status`);
    this.statusWs = ws;
    ws.onopen = () => {
      clearTimeout(this.mobileConnectionWarningTimer);
      this.mobileConnectionWarningTimer = 0;
      this.setMobileConnectionWarning(false);
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === "server_instance") {
          const instanceId = String(message.instance_id || "");
          if (!instanceId) return;
          const serverRestarted = !!this.serverInstanceId && this.serverInstanceId !== instanceId;
          this.serverInstanceId = instanceId;
          if (serverRestarted) {
            this.setMobileConnectionWarning(true, "reconnecting");
            // Every terminal's buffer was built from the old server's recording; rebuild rather
            // than let the new one repaint into it. See connect().
            for (const view of this.views.values()) view.replayFromScratchOnNextConnect = true;
            void this.refresh();
            this.reconnectFocusedConnections();
          }
          return;
        }
        if (message.type === "session_status") this.applySessionStatus(message);
      } catch (error) {
        console.warn("invalid session status event", error);
      }
    };
    ws.onclose = () => {
      if (this.statusWs !== ws) return;
      this.statusWs = null;
      this.scheduleMobileConnectionWarning();
      clearTimeout(this.statusWsReconnectTimer);
      this.statusWsReconnectTimer = setTimeout(() => this.connectStatusStream(), RECONNECT_MS);
    };
  }

  initializeMobileConnectionWarning() {
    window.addEventListener("online", this.mobileOnlineHandler);
    window.addEventListener("offline", this.mobileOfflineHandler);
    window.addEventListener("focus", this.focusedConnectionRecoveryHandler);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.reconnectFocusedConnections();
    });
    if (!navigator.onLine) this.setMobileConnectionWarning(true, "offline");
  }

  reconnectFocusedConnections() {
    if (document.hidden || !navigator.onLine) {
      if (!navigator.onLine) this.setMobileConnectionWarning(true, "offline");
      return;
    }
    let reconnecting = false;
    if (!this.statusWs || ![WebSocket.OPEN, WebSocket.CONNECTING].includes(this.statusWs.readyState)) {
      clearTimeout(this.statusWsReconnectTimer);
      this.statusWsReconnectTimer = 0;
      this.connectStatusStream();
      reconnecting = true;
    } else if (this.statusWs.readyState === WebSocket.CONNECTING) reconnecting = true;
    if (this.historyOpen && this.activeId && this.activeFileKey === null) {
      const historyConnected = this.historyStreamSessionId === this.activeId && this.historyWs &&
        [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.historyWs.readyState);
      if (!historyConnected) {
        clearTimeout(this.historyWsReconnectTimer);
        this.historyWsReconnectTimer = 0;
        this.connectHistoryStream(this.activeId);
        reconnecting = true;
      } else if (this.historyWs.readyState === WebSocket.CONNECTING) reconnecting = true;
    } else if (this.activeId && this.activeFileKey === null) {
      const view = this.views.get(this.activeId);
      if (view && !view.closed && !this.session(this.activeId)?.dormant) {
        if (!view.ws || view.ws.readyState === WebSocket.CLOSED) {
          clearTimeout(view.reconnectTimer);
          view.reconnectTimer = 0;
          view.ws = null;
          view.suppressReconnect = false;
          this.connect(this.activeId, view);
          reconnecting = true;
        } else if (view.ws.readyState === WebSocket.CLOSING) {
          view.suppressReconnect = false;
          view.reconnectAfterClose = true;
          reconnecting = true;
        } else if (view.ws.readyState === WebSocket.CONNECTING) reconnecting = true;
      }
    }
    if (reconnecting) this.setMobileConnectionWarning(true, "reconnecting");
    else this.setMobileConnectionWarning(!this.mobileConnectionAvailable(), "reconnecting");
    this.scheduleMobileConnectionWarning();
  }

  scheduleMobileConnectionWarning() {
    clearTimeout(this.mobileConnectionWarningTimer);
    if (!this.touchMobileLayoutEnabled()) return;
    this.mobileConnectionWarningTimer = window.setTimeout(() => {
      this.mobileConnectionWarningTimer = 0;
      this.setMobileConnectionWarning(!this.mobileConnectionAvailable(), navigator.onLine ? "reconnecting" : "offline");
    }, MOBILE_CONNECTION_WARNING_DELAY_MS);
  }

  mobileConnectionAvailable() {
    if (!navigator.onLine) return false;
    if (this.statusWs?.readyState === WebSocket.OPEN) return true;
    return !!this.historyOpen && this.historyWs?.readyState === WebSocket.OPEN;
  }

  setMobileConnectionWarning(disconnected, state = "reconnecting") {
    const warning = this.$("mobile-connection-warning");
    if (!warning) return;
    const message = this.$("mobile-connection-message");
    if (message && disconnected) {
      message.textContent = state === "offline"
        ? "Connection lost. Reconnecting when this device is online; your Transcript draft is saved."
        : "Reconnecting… Your Transcript draft is saved on this device.";
    }
    warning.classList.toggle("hidden", !disconnected || !this.touchMobileLayoutEnabled());
  }

  async initializeRemoteIdleMode() {
    if (this.vscodeMode || location.pathname.startsWith("/_remote/")) return;
    let payload;
    try {
      const response = await fetch("/_remote/status", { headers: { Accept: "application/json" } });
      if (!response.ok || !String(response.headers.get("content-type") || "").includes("application/json")) return;
      payload = await response.json();
    } catch (error) {
      return;
    }
    if (typeof payload?.email !== "string" || !payload.email) return;
    this.remoteBrowserEmail = payload.email;
    const remoteAccessRow = document.querySelector(".remote-access-settings-row");
    if (remoteAccessRow) void this.refreshRemoteAccessRow(remoteAccessRow);
    const idleSeconds = Number(payload?.idle_seconds || 0);
    if (!Number.isFinite(idleSeconds) || idleSeconds <= 0) return;
    this.remoteIdleTimeoutMs = Math.max(60000, idleSeconds * 1000);
    this.remoteIdleLastInteractionAt = Date.now();
    window.addEventListener("keydown", this.remoteIdleActivityHandler, { capture: true });
    window.addEventListener("pointerdown", this.remoteIdleActivityHandler, { capture: true });
    window.addEventListener("touchstart", this.remoteIdleActivityHandler, { capture: true, passive: true });
    window.addEventListener("wheel", this.remoteIdleActivityHandler, { capture: true, passive: true });
    document.addEventListener("visibilitychange", this.remoteIdleVisibilityHandler);
    this.scheduleRemoteBrowserIdleTransition();
  }

  async logoutRemoteBrowser(button) {
    button.disabled = true;
    try {
      const response = await fetch("/_remote/logout", { method: "POST" });
      if (!response.ok) throw new Error(`remote logout failed (${response.status})`);
      this.remoteIdleTransitioning = true;
      clearTimeout(this.remoteIdleTimer);
      const loginUrl = new URL("/_remote/login", location.origin);
      loginUrl.searchParams.set("return_to", `${location.pathname}${location.search}${location.hash}`);
      location.replace(loginUrl.href);
    } catch (error) {
      button.disabled = false;
      void uiAlert(error instanceof Error ? error.message : String(error));
    }
  }

  recordRemoteBrowserActivity() {
    if (!this.remoteIdleTimeoutMs || this.remoteIdleTransitioning) return;
    this.remoteIdleLastInteractionAt = Date.now();
    this.scheduleRemoteBrowserIdleTransition();
  }

  handleRemoteBrowserVisibilityChange() {
    if (!this.remoteIdleTimeoutMs || this.remoteIdleTransitioning) return;
    if (document.hidden) {
      this.scheduleRemoteBrowserIdleTransition();
      return;
    }
    if (Date.now() - this.remoteIdleLastInteractionAt >= this.remoteIdleTimeoutMs) {
      this.transitionRemoteBrowserToIdle();
      return;
    }
    this.recordRemoteBrowserActivity();
  }

  scheduleRemoteBrowserIdleTransition() {
    clearTimeout(this.remoteIdleTimer);
    if (!this.remoteIdleTimeoutMs || this.remoteIdleTransitioning) return;
    const elapsed = Date.now() - this.remoteIdleLastInteractionAt;
    this.remoteIdleTimer = window.setTimeout(() => this.transitionRemoteBrowserToIdle(),
      Math.max(0, this.remoteIdleTimeoutMs - elapsed));
  }

  transitionRemoteBrowserToIdle() {
    if (!this.remoteIdleTimeoutMs || this.remoteIdleTransitioning) return;
    this.remoteIdleTransitioning = true;
    clearTimeout(this.remoteIdleTimer);
    this.remoteIdleTimer = 0;
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    const idleUrl = new URL("/_remote/idle", location.origin);
    idleUrl.searchParams.set("return_to", returnTo);
    location.replace(idleUrl.href);
  }

  showInitialLoadingState() {
    const loadingState = this.$("initial-loading-state");
    loadingState.classList.add("loading");
    loadingState.classList.remove("hidden");
    this.$("initial-loading-message").textContent = "loading TermDeck…";
    window.TermdeckLoadingRecovery?.schedule();
  }

  showInitialLoadFailure() {
    const loadingState = this.$("initial-loading-state");
    loadingState.classList.remove("loading", "hidden");
    this.$("initial-loading-message").textContent = "unable to load TermDeck — retrying…";
    this.$("initial-loading-recovery").classList.remove("hidden");
  }

  finishInitialLoadingState() {
    this.initialLoadComplete = true;
    const emptyState = this.$("empty-state");
    emptyState.textContent = "no terminals — press + to open one";
    const session = this.session(this.activeId);
    const view = this.views.get(this.activeId);
    const terminalContentPending = !this.vscodeMode && this.activeFileKey === null && !this.historyOpen &&
      !!session && !!view && (view.awaitingSnapshot || view.replaying || !view.everConnected);
    if (terminalContentPending) {
      const loadingState = this.$("initial-loading-state");
      loadingState.classList.add("loading");
      loadingState.classList.remove("hidden");
      this.$("initial-loading-message").textContent = "loading terminal session…";
      window.TermdeckLoadingRecovery?.schedule();
      return;
    }
    this.finishInitialPageContentLoading();
  }

  initializeEventlyDemoPresentation() {
    const params = new URLSearchParams(location.search);
    if (!(this.projectSlug === "evently-demo" || this.projectSlug === "evently-python-demo") || params.get("demo") !== "evently") return;
    document.body.classList.add("evently-demo-presentation");
    if (this.$("evently-demo-feature-banner")) return;
    const banner = document.createElement("div");
    banner.id = "evently-demo-feature-banner";
    banner.innerHTML = '<span id="evently-demo-caption"></span>';
    document.body.append(banner);
    this.updateEventlyDemoFeatureBanner();
  }

  updateEventlyDemoFeatureBanner() {
    if (!document.body.classList.contains("evently-demo-presentation")) return;
    const caption = this.$("evently-demo-caption");
    if (!caption) return;
    const session = this.session(this.activeId);
    const groupName = this.terminalGroupNameForSession(this.activeId) || "Evently workspace";
    const settingsOpen = !this.$("settings-popover")?.classList.contains("hidden");
    const themeListOpen = settingsOpen && !!this.$("settings-popover")?.querySelector(".settings-theme-row.expanded");
    const activityEntries = this.activityDotEntries(this.sessionActivityById.get(this.activeId));
    let feature = "Persistent terminal workspace";
    if (settingsOpen) feature = themeListOpen ? `Theme gallery: ${this.themeLabel()}` : "Remote access: Google relay or local Wi-Fi";
    else if (this.settings.notebook_open) feature = "Notes: save context for follow-up work";
    else if (this.sideView === "git") feature = "Git history, blame, and changed-file review";
    else if (this.sideView === "search") feature = "Search across files and agents";
    else if (this.activeFileKey !== null) feature = "File editing, history, and usages";
    else if (this.historyOpen) feature = "Transcript and cross-agent review";
    else if (activityEntries.length) feature = `Background activity: ${activityEntries.map((entry) => entry.label).join(" · ")}`;
    caption.textContent = `Caption: ${feature} · ${groupName} · ${session?.title || "Select a feature terminal"}`;
  }

  finishInitialPageContentLoading(sessionId = this.activeId) {
    if (sessionId !== this.activeId) return;
    this.initialPageContentReady = true;
    const loadingState = this.$("initial-loading-state");
    loadingState.classList.remove("loading");
    loadingState.classList.add("hidden");
  }

  applySessionStatus(message) {
    const session = this.session(message.session_id);
    if (!session) return;
    // Keeps the "watched here" stamp fresh (throttled) so a sibling tab knows the session the user
    // is sitting on, however long they sit there.
    this.markWatchedSession();
    const previousPresentation = this.titlePresentation(session);
    const previousAgentSessionId = session.agent_session_id;
    const previousAgentKind = session.agent_kind;
    const previousExitCode = session.exit_code;
    const previousRunning = !!session.running;
    const previousDormant = !!session.dormant;
    const previousModel = this.sessionModelById.get(session.session_id) || "";
    const previousNeedsAttention = this.attentionServerStates.has(session.session_id)
      ? this.attentionServerStates.get(session.session_id) === true : session.needs_attention === true;
    if (Object.prototype.hasOwnProperty.call(message, "title") && message.title) session.title = message.title;
    if (Object.prototype.hasOwnProperty.call(message, "title_user_set")) session.title_user_set = !!message.title_user_set;
    if (Object.prototype.hasOwnProperty.call(message, "cli_title") && message.cli_title) session.cli_title = message.cli_title;
    if (Object.prototype.hasOwnProperty.call(message, "agent_session_id")) session.agent_session_id = message.agent_session_id;
    if (Object.prototype.hasOwnProperty.call(message, "agent_kind")) session.agent_kind = message.agent_kind;
    let activityDetailChanged = false;
    if (Object.prototype.hasOwnProperty.call(message, "activity")) {
      const previousActivity = this.sessionActivityById.get(session.session_id) || null;
      activityDetailChanged = JSON.stringify(previousActivity) !== JSON.stringify(message.activity || null);
      this.sessionActivityById.set(session.session_id, message.activity || null);
    }
    if (Object.prototype.hasOwnProperty.call(message, "last_activity_at")) {
      session.last_activity_at = message.last_activity_at;
      const activity = Number(message.last_activity_at || 0);
      if (activity > 0) this.touchSessionActivity(session.session_id, activity > 1e12 ? activity : activity * 1000);
    }
    if (Object.prototype.hasOwnProperty.call(message, "processing")) session.processing = !!message.processing;
    if (Object.prototype.hasOwnProperty.call(message, "processing_since")) {
      session.processing_since = message.processing_since;
      const processingSince = Number(message.processing_since);
      if (processingSince > 0 && !this.processingStates.get(session.session_id) &&
          !this.historyPendingProcessing.has(session.session_id)) {
        this.processingSince.set(session.session_id, processingSince * 1000);
      }
      else if (!message.processing) this.processingSince.delete(session.session_id);
    }
    if (Object.prototype.hasOwnProperty.call(message, "running")) session.running = !!message.running;
    if (Object.prototype.hasOwnProperty.call(message, "exit_code")) session.exit_code = message.exit_code;
    if (Object.prototype.hasOwnProperty.call(message, "dormant")) session.dormant = !!message.dormant;
    if (Object.prototype.hasOwnProperty.call(message, "needs_attention")) {
      session.needs_attention = !!message.needs_attention;
      this.attentionServerStates.set(session.session_id, session.needs_attention);
      if (!session.needs_attention) {
        this.clearSessionAttention(session.session_id);
        if (previousNeedsAttention) {
          const view = this.views.get(session.session_id);
          if (view) view.attentionScreenDetectionSuppressed = true;
        }
      }
    }
    this.cacheSessionModel(session);
    const spinning = !session.dormant && session.processing === true;
    const presentation = this.titlePresentation(session);
    const processingChanged = this.processingStates.get(session.session_id) !== spinning;
    const displayedTitleChanged = previousPresentation.text !== presentation.text;
    const modelChanged = previousModel !== (this.sessionModelById.get(session.session_id) || "");
    const rowStateChanged = displayedTitleChanged || processingChanged || previousAgentKind !== session.agent_kind ||
      previousExitCode !== session.exit_code || previousRunning !== !!session.running || previousDormant !== !!session.dormant ||
      previousNeedsAttention !== !!session.needs_attention;
    if (displayedTitleChanged) {
      this.postVscodeNativeSession(session, session.session_id === this.activeId ? !this.historyOpen : undefined);
    }
    if (processingChanged || (spinning && this.historyPendingProcessing.has(session.session_id))) {
      this.updateProcessingState(session.session_id, spinning);
    }
    if (activityDetailChanged) {
      this.updateSessionActivityDots(session.session_id);
      this.updateEventlyDemoFeatureBanner();
    }
    // A finished turn is when the transcript's newest usage report changes.
    if (processingChanged && !spinning && session.session_id === this.activeId) {
      void this.refreshSessionUsage(session.session_id);
    }
    // Desktop notifications live HERE, in the page, because macOS refuses osascript
    // notifications from the launchd-run server outright ("not allowed for this application");
    // the browser has a real permission prompt and follows the user to every machine.
    if (spinning && !this.agentRunStartedAt.has(session.session_id)) {
      this.agentRunStartedAt.set(session.session_id, Date.now());
    } else if (!spinning && this.agentRunStartedAt.has(session.session_id)) {
      const ranForMs = Date.now() - this.agentRunStartedAt.get(session.session_id);
      this.agentRunStartedAt.delete(session.session_id);
      if (processingChanged && ranForMs >= 5000 && this.settings.notify_agent_idle !== false) {
        this.notifyAgentEvent(session, "finished");
      }
    }
    if (session.needs_attention && !previousNeedsAttention) {
      this.triggerSessionAttention(session.session_id);
      if (this.settings.notify_attention !== false) this.notifyAgentEvent(session, "needs your attention");
    } else if (previousExitCode == null && session.exit_code != null && !session.dormant && session.exit_code !== 0) {
      this.triggerSessionAttention(session.session_id);
    }
    if (rowStateChanged) this.updateSessionRows(session.session_id);
    if (session.session_id === this.activeId) {
      if (this.historyOpen && previousAgentSessionId !== session.agent_session_id) {
        this.connectHistoryStream(session.session_id, { fresh: true });
      }
      if (rowStateChanged || modelChanged) this.renderTopbar();
    }
  }

  titlePresentation(s) {
    const title = this.effectiveTitle(s);
    const status = title.match(TITLE_STATUS_RE);
    const processing = s && this.processingStates.has(s.session_id)
      ? this.processingStates.get(s.session_id) === true
      : s?.processing === true;
    return { text: status ? title.slice(status[0].length) : title, spinning: processing };
  }

  updateSessionSpinner(id, spinning) {
    const spinner = this.sessionSpinnerEls.get(id);
    if (spinner) spinner.classList.toggle("on", spinning);
    this.updateSessionTextStatus(id, spinning);
  }

  // One entry per background-activity kind reported by AgentCli.activity_detail — "main"
  // is the spinner's job and stays out. Keys are generic on purpose: a future
  // {"background_jobs": 2} needs no client change to get its own dot.
  activityDotEntries(activity) {
    if (!activity) return [];
    const entries = [];
    for (const [key, value] of Object.entries(activity)) {
      if (key === "main") continue;
      const count = Number(value);
      if (!(count > 0)) continue;
      const noun = key.replace(/_/g, " ");
      entries.push({ key, count, label: `${count} ${count === 1 ? noun.replace(/s$/, "") : noun} running` });
    }
    return entries;
  }

  updateSessionActivityDots(id) {
    const host = this.sessionActivityEls.get(id);
    if (!host) return;
    const entries = this.activityDotEntries(this.sessionActivityById.get(id));
    const signature = JSON.stringify(entries);
    if (host.dataset.signature === signature) return;
    host.dataset.signature = signature;
    host.replaceChildren(...entries.map((entry) => {
      const chip = document.createElement("span");
      chip.className = `session-activity-chip activity-${entry.key}`;
      chip.title = entry.label;
      const count = document.createElement("span");
      count.className = "session-activity-count";
      count.textContent = String(entry.count);
      const dot = document.createElement("span");
      dot.className = "session-activity-dot";
      chip.append(count, dot);
      return chip;
    }));
    host.closest(".session-item")?.classList.toggle("has-activity", entries.length > 0);
  }

  updateSessionTextStatus(id, spinning = !!this.processingStates.get(id)) {
    const title = this.sessionTitleEls.get(id);
    if (!title) return;
    // The wave is the TEXT-mode stand-in for the spinning icon, and stays that way: running both at once
    // was tried and the sweep collided with the tab text rather than reading as one signal.
    const textOnly = this.usesTextTerminalStatus(this.session(id)?.agent_kind);
    const working = textOnly && !!spinning;
    title.classList.toggle("session-title-working", working);
    // Attention runs the title wave whatever the icon setting says. Working state and icon mode are
    // alternatives -- the spinning icon stands in for the wave -- but a question is worth both: the
    // icon's ring catches the eye, the wave over the name says which session wants you.
    title.classList.toggle("session-title-attention", this.attentionSessions.has(id));
    title.classList.toggle("session-title-unread", !this.vscodeMode && !working && this.unreadSessions.has(id));
    const session = this.session(id);
    if (!this.vscodeMode && session && !working) title.style.color = this.terminalAgeColor(session);
    else title.style.removeProperty("color");
  }

  setSessionTitleText(title, text) {
    const value = String(text || "");
    const row = title.closest(".session-item");
    const base = document.createElement("span");
    base.className = "session-title-base";
    if (row?.classList.contains("terminal-search-match") && this.terminalSearchText.trim()) {
      this.appendTerminalSearchHighlightedText(base, value, this.terminalSearchText);
    } else {
      base.textContent = value;
    }
    const waveWindow = document.createElement("span");
    waveWindow.className = "session-title-wave-window";
    waveWindow.setAttribute("aria-hidden", "true");
    const waveText = document.createElement("span");
    waveText.className = "session-title-wave-text";
    waveText.dataset.waveText = value;
    waveWindow.appendChild(waveText);
    title.replaceChildren(base, waveWindow);
  }

  terminalIconAgentKind(agentKind) {
    const kind = String(agentKind || "none").toLowerCase();
    return this.agentSpecs[kind] ? kind : "none";
  }

  terminalIconEnabledForAgent(agentKind) {
    const kind = this.terminalIconAgentKind(agentKind);
    const states = this.settings.terminal_icon_agents;
    if (states && typeof states === "object" && Object.prototype.hasOwnProperty.call(states, kind)) return !!states[kind];
    return !!this.settings.show_terminal_icons;
  }

  setTerminalIconEnabledForAgent(agentKind, enabled) {
    const kind = this.terminalIconAgentKind(agentKind);
    this.settings.terminal_icon_agents = { ...(this.settings.terminal_icon_agents || {}), [kind]: !!enabled };
  }

  usesTextTerminalStatus(agentKind) {
    return !this.vscodeMode && !this.terminalIconEnabledForAgent(agentKind);
  }

  updateUnreadIndicator(id) {
    const dot = this.sessionStatusEls.get(id);
    if (dot) {
      dot.classList.toggle("processing", !!this.processingStates.get(id));
      dot.classList.toggle("unread", this.unreadSessions.has(id) && !this.processingStates.get(id));
      dot.classList.toggle("attention", this.attentionSessions.has(id));
    }
    this.updateSessionTextStatus(id);
    this.updateTerminalGroupStatus(id);
    this.updateTerminalIconState(id);
  }

  updateTerminalGroupStatus(sessionId) {
    const groupId = this.getProjectState().session_groups?.[sessionId];
    if (!groupId) return;
    const label = this.$("session-list")?.querySelector(
      `[data-group-id="${CSS.escape(groupId)}"] > .terminal-group-label`);
    if (!label) return;
    const memberIds = this.groupSessionIds(groupId);
    const working = memberIds.some((id) => this.processingStates.get(id));
    const attentionCount = memberIds.filter((id) => this.processingStates.get(id) || this.unreadSessions.has(id)).length;
    label.classList.remove("group-working", "group-unread");
    const unreadDot = label.querySelector(".group-unread-dot");
    if (unreadDot) {
      const groupNeedsAttention = memberIds.some((id) => this.attentionSessions.has(id));
      unreadDot.classList.toggle("on", attentionCount > 0 || groupNeedsAttention);
      unreadDot.classList.remove("attention");
      unreadDot.title = attentionCount ? `${attentionCount} active or unread terminal${attentionCount === 1 ? "" : "s"}` : "";
    }
    const attentionNumber = label.querySelector(".group-unread-count");
    if (attentionNumber) attentionNumber.textContent = attentionCount ? String(attentionCount) : "";
    const name = label.querySelector(".terminal-group-name");
    if (name && !this.vscodeMode) {
      const members = memberIds.map((id) => this.session(id)).filter(Boolean);
      name.style.color = this.terminalGroupAgeColor(members);
    }
    const suffix = [working ? "working" : "", attentionCount ? `${attentionCount} active or unread` : ""]
      .filter(Boolean).join(" · ");
    label.title = `Click to collapse/expand · right-click for group actions · drop terminals here${suffix ? ` · ${suffix}` : ""}`;
  }

  setSessionUnread(id, unread) {
    this.setSessionsUnread([id], unread);
  }

  // Coming back to the page is reading the terminal that is already on screen. Unread was cleared only
  // when the selection MOVED, so a session that finished a turn while its own tab sat in the background
  // kept the badge for good: returning to that tab selects nothing new, and neither does leaving it.
  markActiveSessionRead() {
    const id = this.activeId;
    if (document.hidden || !id || !this.session(id)) return;
    if (!this.processingStates.get(id)) this.viewedCompletedSessions.add(id);
    if (!this.unreadSessions.delete(id)) return;
    this.updateUnreadIndicator(id);
    this.persistUnreadSessionDelta([id], false);
  }

  setSessionsUnread(sessionIds, unread) {
    const ids = [...new Set(sessionIds)].filter((id) => !!this.session(id));
    if (!ids.length) return;
    for (const id of ids) {
      if (unread) {
        this.unreadSessions.add(id);
        this.viewedCompletedSessions.delete(id);
      } else {
        this.unreadSessions.delete(id);
        if (!this.processingStates.get(id)) this.viewedCompletedSessions.add(id);
      }
      this.updateUnreadIndicator(id);
    }
    this.persistUnreadSessionDelta(ids, unread);
  }

  markTerminalGroupUnread(groupId) {
    const sessionGroups = this.getProjectState().session_groups || {};
    const ids = this.sessions
      .filter((session) => sessionGroups[session.session_id] === groupId)
      .map((session) => session.session_id);
    this.setSessionsUnread(ids, true);
  }

  updateTerminalIconState(id) {
    if (this.vscodeMode) return;
    const title = this.sessionTitleEls.get(id);
    const icon = title?.closest(".session-item")?.querySelector(".terminal-type-icon");
    const session = this.session(id);
    if (!icon || !session) return;
    const enabled = this.terminalIconEnabledForAgent(session.agent_kind);
    const visible = enabled;
    icon.classList.toggle("on", visible);
    icon.closest(".session-item")?.classList.toggle("terminal-icons-hidden", !visible);
    const active = visible && (!!this.processingStates.get(id) || this.unreadSessions.has(id));
    icon.classList.toggle("terminal-status-active", active);
    icon.classList.remove("terminal-status-exited");
  }

  triggerSessionAttention(id) {
    const session = this.session(id);
    if (!session) return;
    this.attentionSessions.add(id);
    clearTimeout(this.attentionTimers.get(id));
    this.attentionTimers.delete(id);
    if (!session.needs_attention) {
      this.attentionTimers.set(id, setTimeout(() => this.clearSessionAttention(id), TERMINAL_ATTENTION_ANIMATION_MS));
    }
    this.updateUnreadIndicator(id);
  }

  clearSessionAttention(id) {
    clearTimeout(this.attentionTimers.get(id));
    this.attentionTimers.delete(id);
    if (!this.attentionSessions.delete(id)) return;
    this.updateUnreadIndicator(id);
  }

  sessionNeedsAttention(id) {
    if (this.attentionServerStates.has(id)) return this.attentionServerStates.get(id) === true;
    return this.session(id)?.needs_attention === true || this.attentionSessions.has(id);
  }

  // Drop the badge without answering the prompt: the terminal still wants a human eventually, so it
  // stays unread rather than going quiet entirely.
  async ignoreSessionsAttention(sessionIds) {
    const ids = [...new Set(sessionIds)].filter((id) => this.sessionNeedsAttention(id));
    if (!ids.length) return;
    for (const id of ids) {
      this.clearSessionAttention(id);
      this.attentionServerStates.set(id, false);
      const session = this.session(id);
      if (session) session.needs_attention = false;
    }
    this.setSessionsUnread(ids, true);
    for (const id of ids) this.updateSessionRows(id);
    await Promise.all(ids.map((id) =>
      fetch(`/api/sessions/${encodeURIComponent(id)}/attention`, { method: "POST" }).catch(() => null)));
  }

  updateProcessingState(id, spinning) {
    const session = this.session(id);
    const dormant = !!session?.dormant;
    spinning = spinning && !dormant;
    const previous = this.processingStates.get(id);
    const pendingSince = this.historyPendingProcessing.get(id);
    if (spinning && previous !== true) {
      this.processingSince.set(id, pendingSince || this.processingSince.get(id) || Date.now());
    }
    if (spinning) this.historyPendingProcessing.delete(id);
    if (spinning) this.viewedCompletedSessions.delete(id);
    if (spinning && previous !== true && !this.processingSince.has(id)) this.processingSince.set(id, Date.now());
    if (!spinning) this.processingSince.delete(id);
    this.processingStates.set(id, spinning);
    this.updateSessionSpinner(id, spinning);
    this.updateUnreadIndicator(id);
    this.updateHistoryThinkingIndicator();
    this.renderHistoryMeta();
    const queuedPromptDispatched = !spinning && this.dispatchNextMarkdownPrompt(this.sessionInteractionState(id, false));
    const completed = !dormant && previous === true && !spinning && !queuedPromptDispatched;
    const userIsViewingSession = id === this.activeId && !document.hidden && document.hasFocus();
    if (completed && !userIsViewingSession && !this.viewedCompletedSessions.has(id) && !this.unreadSessions.has(id)) {
      this.unreadSessions.add(id);
      // After the set, not before: the indicator was refreshed further up, while the session was still
      // marked read, so the badge waited for whatever redrew the list next.
      this.updateUnreadIndicator(id);
      this.persistUnreadSessionDelta([id], true);
    }
  }

  markdownPromptQueueForSession(sessionId) {
    const queues = this.settings.md_prompt_queues && typeof this.settings.md_prompt_queues === "object"
      ? this.settings.md_prompt_queues : {};
    const saved = Array.isArray(queues[sessionId]) ? queues[sessionId] : [];
    return saved.map((text) => ({ text: String(text || "") })).filter((item) => item.text.trim());
  }

  ensureTranscriptSessionState(sessionId) {
    const terminalView = this.views.get(sessionId);
    if (terminalView) return terminalView;
    const existing = this.transcriptSessionStates.get(sessionId);
    if (existing) return existing;
    const state = {
      sessionId, closed: false, markdownPromptDraft: this.markdownPromptDraftForSession(sessionId),
      promptQueue: this.markdownPromptQueueForSession(sessionId), promptQueueEditIndex: null,
      promptQueueDispatching: false, promptQueueHold: false, promptQueueCollapsed: false,
      promptApiSubmitting: false, promptApiInterrupting: false, promptSubmitting: false, promptSubmitEntered: false,
      promptSubmitTimer: 0, promptEditing: false, promptEditVersion: 0, promptSubmitVersion: -1,
      promptDraft: this.session(sessionId)?.draft || "",
    };
    this.transcriptSessionStates.set(sessionId, state);
    return state;
  }

  sessionInteractionState(sessionId, create = true) {
    return this.views.get(sessionId) || this.transcriptSessionStates.get(sessionId) ||
      (create ? this.ensureTranscriptSessionState(sessionId) : null);
  }

  adoptTranscriptSessionState(view) {
    const state = this.transcriptSessionStates.get(view.sessionId);
    if (!state) return view;
    for (const key of ["markdownPromptDraft", "promptQueue", "promptQueueEditIndex", "promptQueueDispatching",
      "promptQueueHold", "promptQueueCollapsed", "promptApiSubmitting", "promptSubmitting",
      "promptApiInterrupting", "promptSubmitEntered", "promptSubmitTimer", "promptEditing", "promptEditVersion", "promptSubmitVersion",
      "promptDraft"]) {
      if (Object.hasOwn(state, key)) view[key] = state[key];
    }
    this.transcriptSessionStates.delete(view.sessionId);
    return view;
  }

  markdownPromptDraftForSession(sessionId) {
    const localDraft = this.localTranscriptDraft(sessionId);
    if (localDraft !== null) return localDraft;
    const drafts = this.settings.md_prompt_drafts && typeof this.settings.md_prompt_drafts === "object"
      ? this.settings.md_prompt_drafts : {};
    return String(drafts[sessionId] || "");
  }

  transcriptDraftLocalStorageKey(sessionId) {
    return `${TRANSCRIPT_DRAFT_LOCAL_PREFIX}.${encodeURIComponent(this.projectStateKey())}.${encodeURIComponent(sessionId)}`;
  }

  localTranscriptDraft(sessionId) {
    try {
      const value = localStorage.getItem(this.transcriptDraftLocalStorageKey(sessionId));
      return value === null ? null : String(value).slice(0, 20000);
    } catch (_error) {
      return null;
    }
  }

  persistLocalTranscriptDraft(sessionId, text) {
    try {
      const key = this.transcriptDraftLocalStorageKey(sessionId);
      if (text) localStorage.setItem(key, text);
      else localStorage.removeItem(key);
    } catch (_error) {
    }
  }

  persistMarkdownPromptDraft(view, text = view?.markdownPromptDraft || "", options = {}) {
    if (!view) return;
    const drafts = this.settings.md_prompt_drafts && typeof this.settings.md_prompt_drafts === "object"
      ? this.settings.md_prompt_drafts : {};
    const nextDrafts = { ...drafts };
    const normalized = String(text || "").slice(0, 20000);
    this.persistLocalTranscriptDraft(view.sessionId, normalized);
    if (normalized) nextDrafts[view.sessionId] = normalized;
    else delete nextDrafts[view.sessionId];
    this.settings.md_prompt_drafts = nextDrafts;
    view.markdownPromptDraft = normalized;
    if (options.immediate) this.saveSettingsImmediately();
    else this.saveSettings();
  }

  persistMarkdownPromptQueue(view) {
    if (!view) return;
    const queues = this.settings.md_prompt_queues && typeof this.settings.md_prompt_queues === "object"
      ? this.settings.md_prompt_queues : {};
    const nextQueues = { ...queues };
    const texts = (view.promptQueue || []).map((item) => String(item.draftText ?? item.text ?? "")).filter((text) => text.trim());
    if (texts.length) nextQueues[view.sessionId] = texts;
    else delete nextQueues[view.sessionId];
    this.settings.md_prompt_queues = nextQueues;
    this.saveSettingsImmediately();
  }

  dispatchNextMarkdownPrompt(view) {
    if (!view || view.closed || view.promptQueueHold || view.promptQueueDispatching || !view.promptQueue.length ||
        this.processingStates.get(view.sessionId) || this.historyPendingProcessing.has(view.sessionId)) return false;
    const item = view.promptQueue[0];
    const text = String(item?.draftText ?? item?.text ?? "");
    if (!text.trim()) {
      view.promptQueue.shift();
      this.persistMarkdownPromptQueue(view);
      this.renderHistoryQueue(view);
      return this.dispatchNextMarkdownPrompt(view);
    }
    view.promptQueueDispatching = true;
    this.renderHistoryQueue(view);
    void this.submitHistoryPromptViaApi(view, text, { fromQueue: true }).then((sent) => {
      if (sent) this.acknowledgeSubmittedMarkdownQueueItem(view, item, text);
    }).finally(() => {
      view.promptQueueDispatching = false;
      this.persistMarkdownPromptQueue(view);
      this.renderHistoryQueue(view);
    });
    return true;
  }

  acknowledgeSubmittedMarkdownQueueItem(view, item, text) {
    if (!view) return;
    const comparisonText = this.historyPromptComparisonText(text);
    let itemIndex = view.promptQueue.indexOf(item);
    if (itemIndex < 0) itemIndex = view.promptQueue.findIndex((candidate) =>
      this.historyPromptComparisonText(candidate?.draftText ?? candidate?.text ?? "") === comparisonText);
    if (itemIndex >= 0) view.promptQueue.splice(itemIndex, 1);
    const prompt = this.historyOpen && this.activeId === view.sessionId ? this.$("history-prompt") : null;
    const savedDraftMatches = this.historyPromptComparisonText(view.markdownPromptDraft) === comparisonText;
    const visibleDraftMatches = prompt && this.historyPromptComparisonText(prompt.value) === comparisonText;
    if (comparisonText && (savedDraftMatches || visibleDraftMatches)) {
      this.persistMarkdownPromptDraft(view, "", { immediate: true });
      if (prompt) this.showPromptDraft(view);
    }
    view.promptQueueEditIndex = null;
    view.promptQueueHold = false;
    this.persistMarkdownPromptQueue(view);
    this.renderHistoryQueue(view);
  }

  session(id) {
    return this.sessions.find((s) => s.session_id === id) || null;
  }

  sessionOrClosed(id) {
    return this.session(id) || this.closedSessions.find((s) => s.session_id === id) || null;
  }

  sessionListSignatureFor(sessions = this.sessions) {
    return sessions.map((s) => s.session_id).join("|");
  }

  // onlySessionId scopes the DOM writes below to a single row. A status-websocket message already knows
  // exactly which session changed (applySessionStatus targets that row directly for title/processing);
  // calling this unscoped on every message meant one processing session's spinner-frame update rewrote
  // all N rows' className/text/icon state on every frame, and that ran per status message -- with several
  // sessions processing simultaneously this measured as the dominant, sustained cost of the whole page,
  // independent of how many terminal views were open. The unscoped 30s full-refresh caller is unaffected.
  updateSessionRows(onlySessionId = null) {
    const targets = onlySessionId ? this.sessions.filter((s) => s.session_id === onlySessionId) : this.sessions;
    for (const s of targets) {
      const presentation = this.titlePresentation(s);
      const title = this.sessionTitleEls.get(s.session_id);
      if (title) this.setSessionTitleText(title, presentation.text,
        this.usesTextTerminalStatus(s.agent_kind) && presentation.spinning);
      const dot = this.sessionStatusEls.get(s.session_id);
      if (dot) {
        dot.className = "status-dot" +
          (presentation.spinning ? " processing" : this.unreadSessions.has(s.session_id) ? " unread" : "") +
          (this.attentionSessions.has(s.session_id) ? " attention" : "");
      }
      const spinner = this.sessionSpinnerEls.get(s.session_id);
      if (spinner) spinner.classList.toggle("on", presentation.spinning);
      this.updateSessionTextStatus(s.session_id, presentation.spinning);
      this.updateSessionActivityDots(s.session_id);
      if (title) {
        const item = title.closest(".session-item");
        if (item) {
          item.classList.toggle("active", s.session_id === this.activeId && this.activeFileKey === null);
          this.updateTerminalIconState(s.session_id);
        }
      }
    }
    this.updateWorktreeSectionSummaries();
  }

  updateWorktreeSectionSummaries() {
    if (this.worktreeId !== ALL_WORKTREES_ID) return;
    for (const worktree of this.availableWorktreeSections()) {
      const sessions = this.sessionsForWorktree(String(worktree.id));
      const closed = this.closedSessions.filter((session) => this.worktreeIdForSession(session) === String(worktree.id));
      const activeCount = sessions.filter((session) => this.processingStates.get(session.session_id) ||
        this.unreadSessions.has(session.session_id)).length;
      const count = this.$("session-list")?.querySelector(`[data-worktree-id="${CSS.escape(String(worktree.id))}"] .worktree-section-count`);
      if (!count) continue;
      count.textContent = `${sessions.length} terminal${sessions.length === 1 ? "" : "s"}${closed.length ? ` · ${closed.length} closed` : ""}`;
      if (activeCount) count.textContent += ` · ${activeCount} active/unread`;
    }
  }

  effectiveTitle(s) {
    if (!s.title_user_set) return s.cli_title || s.title;
    const spinner = s.cli_title && /^([⠀-⣿○-◗⠁-⣿⏳⚡✳]+\s*)/.exec(s.cli_title);
    return spinner ? spinner[1] + s.title : s.title;
  }

  applySessionOrder(sessions) {
    const state = this.getProjectState();
    const order = state.session_order || [];
    const rank = new Map(order.map((id, i) => [id, i]));
    return [...sessions].sort((a, b) =>
      (rank.has(a.session_id) ? rank.get(a.session_id) : 1e9) - (rank.has(b.session_id) ? rank.get(b.session_id) : 1e9));
  }

  makeDraggable(item, type, key, onReorder) {
    item.draggable = true;
    item.ondragstart = (e) => {
      this.dragItem = { type, key };
      this.clearDragGroupingTimer();
      item.classList.add("dragging-tab");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", key);
    };
    item.ondragover = (e) => {
      if (this.dragItem && this.dragItem.type === type && this.dragItem.key !== key) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const isSessionDrop = type === "session";
        if (isSessionDrop && this.dragGroupTargetKey === key) {
          item.classList.remove("drop-before", "drop-after");
          item.classList.add("group-drop-target");
          return;
        }
        const rect = item.getBoundingClientRect();
        if (!isSessionDrop) {
          this.clearDragLandingIndicator();
          item.classList.add(e.clientY >= rect.top + rect.height / 2 ? "drop-after" : "drop-before");
          return;
        }
        if (this.dragGroupHoverKey !== key) {
          this.clearDragLandingIndicator();
          item.classList.add(e.clientY >= rect.top + rect.height / 2 ? "drop-after" : "drop-before");
          this.dragGroupHoverKey = key;
          const draggedId = this.dragItem.key;
          this.dragGroupTimer = window.setTimeout(() => {
            if (this.dragItem?.type !== "session" || this.dragItem.key !== draggedId) return;
            this.dragGroupTargetKey = key;
            item.classList.remove("drop-before", "drop-after");
            const targetGroup = this.getProjectState().session_groups?.[key];
            const draggedGroup = this.getProjectState().session_groups?.[draggedId];
            const label = item.querySelector(".group-drop-indicator span:last-child");
            if (label) label.textContent = targetGroup || draggedGroup ? "group" : "new group";
            item.classList.add("group-drop-target");
          }, SESSION_GROUP_HOVER_DELAY_MS);
        } else {
          item.classList.remove("group-drop-target");
          item.classList.add(e.clientY >= rect.top + rect.height / 2 ? "drop-after" : "drop-before");
        }
      }
    };
    item.ondragleave = (e) => {
      if (!e.relatedTarget || !item.contains(e.relatedTarget)) this.clearDragLandingIndicator();
    };
    item.ondrop = (e) => {
      e.preventDefault();
      if (this.dragItem && this.dragItem.type === type && this.dragItem.key !== key) {
        const draggedId = this.dragItem.key;
        if (type === "session" && this.dragGroupTargetKey === key) this.groupSessionsFromDrop(draggedId, key);
        else onReorder(draggedId, key, item.classList.contains("drop-after"));
      }
      this.clearDragLandingIndicator();
      this.dragItem = null;
    };
    item.ondragend = () => {
      this.clearDragLandingIndicator(true);
      this.dragItem = null;
    };
  }

  setDragLandingMode(item, mode, label) {
    item.classList.remove("drop-before", "drop-after", "drop-group", "group-drop-pending", "group-drop-target");
    if (mode) item.classList.add(mode);
    const hint = item.querySelector(".group-drop-indicator span:last-child");
    if (hint && label) hint.textContent = label;
  }

  makeLayoutDraggable(item, token, kind) {
    item.draggable = true;
    item.ondragstart = (event) => {
      this.setInteractionWorktreeFromElement(item);
      const sessionId = kind === "session" ? token.slice("session:".length) : null;
      const sessionIds = sessionId ? this.selectedSessionIdsForDrag(sessionId) : [];
      const tokens = kind === "session" ? sessionIds.map((id) => `session:${id}`) : [token];
      if (sessionId) {
        this.sidebarSelectedSessionIds = new Set(sessionIds);
        this.sidebarSelectionAnchorId = sessionId;
        this.applySidebarSelectionStyles();
        for (const row of this.$("session-list").querySelectorAll(".session-item[data-session-id]")) {
          row.classList.toggle("dragging-tab", this.sidebarSelectedSessionIds.has(row.dataset.sessionId));
        }
      } else {
        item.classList.add("dragging-tab");
      }
      this.dragItem = { type: "layout", token, kind, tokens, worktreeId: this.stateWorktreeId() };
      this.clearDragGroupingTimer();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", tokens.join("\n"));
    };
    item.ondragover = (event) => {
      this.setInteractionWorktreeFromElement(item);
      const source = this.dragItem;
      if (!source || source.type !== "layout" || source.token === token) return;
      if (source.worktreeId && source.worktreeId !== this.stateWorktreeId()) return;
      const sourceSessionIds = this.sessionIdsFromDragItem(source);
      const targetId = kind === "session" ? token.slice("session:".length) : null;
      if (targetId && sourceSessionIds.includes(targetId)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (source.kind === "session" && kind === "group") {
        this.clearDragLandingIndicator();
        this.setDragLandingMode(item, "drop-group", "add to group");
        return;
      }
      const sessionGroups = this.getProjectState().session_groups || {};
      const sourceGroupIds = [...new Set(sourceSessionIds.map((id) => sessionGroups[id]).filter(Boolean))];
      const targetGroup = targetId ? sessionGroups[targetId] : null;
      const rect = item.getBoundingClientRect();
      const holdToCreate = source.kind === "session" && kind === "session" &&
        !sourceGroupIds.length && !targetGroup;
      const centerDrop = holdToCreate && event.clientY >= rect.top + rect.height * 0.25 &&
        event.clientY <= rect.top + rect.height * 0.75;
      if (holdToCreate && !centerDrop) {
        this.clearDragLandingIndicator();
        const after = event.clientY >= rect.top + rect.height / 2;
        const moveLabel = source.kind === "group" ? "move group" : "move";
        this.setDragLandingMode(item, after ? "drop-after" : "drop-before", `${moveLabel} ${after ? "after" : "before"}`);
        return;
      }
      if (holdToCreate) {
        if (this.dragGroupTargetKey === token) {
          this.setDragLandingMode(item, "group-drop-target", "create group");
          return;
        }
        if (this.dragGroupHoverKey !== token) {
          this.clearDragLandingIndicator();
          this.setDragLandingMode(item, "group-drop-pending", "hold to create group");
          this.dragGroupHoverKey = token;
          const sourceToken = source.token;
          this.dragGroupTimer = window.setTimeout(() => {
            if (this.dragItem?.type !== "layout" || this.dragItem.token !== sourceToken) return;
            this.dragGroupTargetKey = token;
            this.setDragLandingMode(item, "group-drop-target", "create group");
          }, SESSION_GROUP_HOVER_DELAY_MS);
        }
        return;
      }
      this.clearDragLandingIndicator();
      const after = event.clientY >= rect.top + rect.height / 2;
      const moveLabel = source.kind === "group" ? "move group" : "move";
      this.setDragLandingMode(item, after ? "drop-after" : "drop-before", `${moveLabel} ${after ? "after" : "before"}`);
    };
    item.ondragleave = (event) => {
      if (!event.relatedTarget || !item.contains(event.relatedTarget)) this.clearDragLandingIndicator();
    };
    item.ondrop = (event) => {
      this.setInteractionWorktreeFromElement(item);
      event.preventDefault();
      const source = this.dragItem;
      if (source?.type === "layout" && source.token !== token &&
          (!source.worktreeId || source.worktreeId === this.stateWorktreeId())) {
        const sourceSessionIds = this.sessionIdsFromDragItem(source);
        const targetId = token.slice(token.indexOf(":") + 1);
        if (kind === "session" && sourceSessionIds.includes(targetId)) {
          this.clearDragLandingIndicator();
          this.dragItem = null;
          return;
        }
        const sessionGroups = this.getProjectState().session_groups || {};
        const targetGroup = kind === "session" ? sessionGroups[targetId] : null;
        const targetRect = kind === "session" ? item.getBoundingClientRect() : null;
        if (source.kind === "session" && kind === "group") this.moveSelectedSessionsIntoGroup(sourceSessionIds, targetId);
        else if (source.kind === "session" && kind === "session" && this.dragGroupTargetKey === token) {
          const rect = item.getBoundingClientRect();
          this.groupSelectedSessionsFromDrop(sourceSessionIds, targetId, event.clientY >= rect.top + rect.height / 2);
        } else {
          const after = item.classList.contains("drop-after") ||
            (targetRect && event.clientY >= targetRect.top + targetRect.height / 2);
          if (source.kind === "session" && kind === "session" && targetGroup) {
            this.moveSelectedSessionsIntoGroup(sourceSessionIds, targetGroup, targetId, after);
          } else if (source.kind === "session" && kind === "session") {
            this.repositionSelectedSessions(sourceSessionIds, targetId, after);
          } else {
            this.reorderTerminalLayout(source.token, token, after);
          }
        }
      }
      this.clearDragLandingIndicator();
      this.dragItem = null;
    };
    item.ondragend = () => {
      this.clearDragLandingIndicator(true);
      this.dragItem = null;
    };
  }

  clearDragLandingIndicator(clearSource = false) {
    this.clearDragGroupingTimer();
    // Scoped to the document, not the session list: group labels, the file tree and the terminal's
    // drop-to-attach overlay all raise indicators that outlive a drag ending outside their own element.
    const landingClasses = ["drop-before", "drop-after", "drop-group", "group-drop-pending", "group-drop-target", "drag-over"];
    document.querySelectorAll(landingClasses.map((name) => `.${name}`).join(", "))
      .forEach((row) => row.classList.remove(...landingClasses));
    if (clearSource) document.querySelectorAll(".dragging-tab")
      .forEach((row) => row.classList.remove("dragging-tab"));
  }

  clearDragGroupingTimer() {
    if (this.dragGroupTimer) window.clearTimeout(this.dragGroupTimer);
    this.dragGroupTimer = 0;
    this.dragGroupTargetKey = null;
    this.dragGroupHoverKey = null;
  }

  reorderSessions(draggedId, targetId, after = false) {
    const ids = this.sessionsForWorktree(this.stateWorktreeId()).map((s) => s.session_id).filter((id) => id !== draggedId);
    const targetIndex = ids.indexOf(targetId);
    if (targetIndex < 0) return;
    ids.splice(targetIndex + (after ? 1 : 0), 0, draggedId);
    this.applyLocalProjectStatePatch({ session_order: ids });
    this.queueSessionOrderMove([draggedId], targetId, after);
    this.sessions = this.applySessionOrder(this.sessions);
    this.renderList();
  }

  reorderFiles(draggedKey, targetKey, after = false) {
    const keys = [...this.openFiles.keys()].filter((k) => k !== draggedKey);
    const targetIndex = keys.indexOf(targetKey);
    if (targetIndex < 0) return;
    keys.splice(targetIndex + (after ? 1 : 0), 0, draggedKey);
    const reordered = new Map(keys.map((k) => [k, this.openFiles.get(k)]));
    this.openFiles = reordered;
    this.persistOpenFiles();
    this.renderList();
  }

  sectionLabel(text) {
    const label = document.createElement("div");
    label.className = "side-section-label";
    if (text !== "terminals") {
      label.textContent = text;
      return label;
    }
    label.classList.add("side-section-header");
    const name = document.createElement("span");
    name.textContent = text;
    label.append(name);
    if (!this.vscodeMode) {
      const controls = document.createElement("span");
      controls.className = "section-header-controls";
      const sort = document.createElement("button");
      sort.id = "active-toggle";
      sort.className = "section-toggle terminals-sort-toggle";
      sort.classList.toggle("on", this.hideInactiveTerminals);
      sort.innerHTML = `<span class="codicon ${this.hideInactiveTerminals ? "codicon-eye-closed" : "codicon-eye"}"></span>`;
      sort.setAttribute("aria-pressed", String(this.hideInactiveTerminals));
      const window_ = this.recentHoursLabel(this.terminalRecentHours());
      sort.title = (this.hideInactiveTerminals ? "Show all terminals" : "Show active terminals only") +
        `\nLong press to set the active window (${window_})`;
      sort.setAttribute("aria-label", sort.title.replace("\n", " · "));
      // Click toggles; press and hold opens the window menu. The menu is a refinement you reach for
      // occasionally, so it stays out of the path of the thing you do constantly.
      sort.onpointerdown = (event) => {
        if (event.button !== 0) return;
        this.recentHoursLongPressFired = false;
        clearTimeout(this.recentHoursLongPressTimer);
        this.recentHoursLongPressTimer = window.setTimeout(() => {
          this.recentHoursLongPressFired = true;
          this.openRecentTerminalHoursMenu(this.$("active-toggle"));
        }, RECENT_TERMINAL_LONG_PRESS_MS);
      };
      const cancelLongPress = () => clearTimeout(this.recentHoursLongPressTimer);
      sort.onpointerup = cancelLongPress;
      sort.onpointerleave = cancelLongPress;
      sort.onpointercancel = cancelLongPress;
      sort.onclick = (event) => {
        event.stopPropagation();
        // A long press still delivers a click on release; that one must not also flip the filter.
        if (this.recentHoursLongPressFired) {
          this.recentHoursLongPressFired = false;
          return;
        }
        this.toggleHideInactiveTerminals();
      };
      const group = document.createElement("button");
      group.id = "new-group-btn";
      group.className = "section-toggle";
      group.innerHTML = '<span class="codicon codicon-folder-library"></span>';
      group.title = "New terminal group";
      group.setAttribute("aria-label", group.title);
      group.onclick = (event) => {
        event.stopPropagation();
        this.createTerminalGroup();
      };
      const search = document.createElement("button");
      search.id = "terminal-search-inline-toggle";
      search.className = "section-toggle";
      search.innerHTML = '<span class="codicon codicon-search"></span>';
      search.title = this.shortcutTitle("Search terminal names and output", "open-terminal-search");
      search.setAttribute("aria-label", search.title);
      const globalTerminalSearchOpen = this.terminalSearchEditorOpen && !this.terminalSearchGroupId;
      search.setAttribute("aria-pressed", String(globalTerminalSearchOpen));
      search.classList.toggle("on", globalTerminalSearchOpen);
      search.onclick = (event) => {
        event.stopPropagation();
        this.toggleTerminalSearchEditor();
      };
      const add = document.createElement("button");
      add.id = "new-session-btn";
      add.className = "section-toggle terminal-new-toggle";
      add.textContent = "+";
      add.title = this.shortcutTitle("New terminal", "new-terminal");
      add.setAttribute("aria-label", add.title);
      add.onclick = (event) => {
        event.stopPropagation();
        this.openModal();
      };
      controls.append(sort, group, search, add);
      label.appendChild(controls);
    }
    return label;
  }

  ensureDesktopTerminalsHeader(list = this.$("session-list"), terminalSearchEditor = null) {
    if (this.vscodeMode || !list || list.querySelector("#new-session-btn")) return;
    const header = this.sectionLabel("terminals");
    this.attachGroupDropTarget(header, null);
    list.prepend(header);
    if (this.terminalSearchEditorOpen && !this.terminalSearchGroupId) {
      header.after(terminalSearchEditor || this.createTerminalSearchEditor());
    }
  }

  terminalSearchGroupName() {
    if (!this.terminalSearchGroupId) return "";
    const worktreeId = this.terminalSearchWorktreeId || this.stateWorktreeId();
    return this.terminalGroupsForWorktree(worktreeId)
      .find((group) => group.id === this.terminalSearchGroupId)?.name || "";
  }

  terminalSearchPlaceholder() {
    const groupName = this.terminalSearchGroupName();
    return groupName ? `search ${groupName}` : "search terminal names and conversations";
  }

  updateTerminalSearchEditorScope() {
    const input = this.$("terminal-search-input");
    if (input) input.placeholder = this.terminalSearchPlaceholder();
    const summary = this.$("terminal-search-summary");
    if (summary && !this.terminalSearchText.trim()) summary.textContent = this.terminalSearchGroupName();
  }

  createTerminalSearchEditor() {
    const bar = document.createElement("div");
    bar.id = "terminal-search-inline";
    const icon = document.createElement("span");
    icon.className = "codicon codicon-search terminal-search-inline-icon";
    const input = document.createElement("input");
    input.id = "terminal-search-input";
    input.type = "text";
    input.placeholder = this.terminalSearchPlaceholder();
    input.value = this.terminalSearchText;
    input.autocomplete = "off";
    input.autocapitalize = "off";
    input.autocorrect = "off";
    input.spellcheck = false;
    const summary = document.createElement("span");
    summary.id = "terminal-search-summary";
    summary.setAttribute("aria-live", "polite");
    const close = document.createElement("button");
    close.id = "terminal-search-inline-close";
    close.className = "section-toggle";
    close.innerHTML = '<span class="codicon codicon-close"></span>';
    close.title = "Close terminal search";
    close.setAttribute("aria-label", close.title);
    input.oninput = () => {
      this.terminalSearchText = input.value;
      this.terminalSearchFocusIndex = -1;
      clearTimeout(this.terminalSearchTimer);
      this.terminalSearchTimer = window.setTimeout(() => this.runTerminalSearch(), TERMINAL_SEARCH_DEBOUNCE_MS);
    };
    input.onkeydown = (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        this.moveTerminalSearchRow(event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        clearTimeout(this.terminalSearchTimer);
        this.runTerminalSearch();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.closeTerminalSearchEditor();
      }
    };
    input.onclick = (event) => event.stopPropagation();
    close.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.closeTerminalSearchEditor();
    };
    bar.append(icon, input, close, summary);
    return bar;
  }

  openTerminalSearchEditor(groupId = null) {
    const nextGroupId = groupId && this.terminalGroups().some((group) => group.id === groupId) ? groupId : null;
    const scopeChanged = nextGroupId !== this.terminalSearchGroupId;
    this.terminalSearchGroupId = nextGroupId;
    this.terminalSearchWorktreeId = nextGroupId ? this.stateWorktreeId() : null;
    if (nextGroupId) {
      const groups = this.terminalGroups();
      if (groups.some((group) => group.id === nextGroupId && group.collapsed)) {
        this.applyLocalProjectStatePatch({ terminal_groups: groups.map((group) => group.id === nextGroupId
          ? { ...group, collapsed: false } : group) });
        this.queueTerminalGroupUpdate(nextGroupId, { collapsed: false });
      }
    }
    this.terminalSearchEditorOpen = true;
    this.renderList();
    requestAnimationFrame(() => {
      const input = this.$("terminal-search-input");
      if (!input) return;
      input.focus();
      input.select();
      if (scopeChanged && this.terminalSearchText.trim()) void this.runTerminalSearch();
    });
  }

  toggleTerminalSearchEditor(groupId = null) {
    const nextGroupId = groupId && this.terminalGroups().some((group) => group.id === groupId) ? groupId : null;
    if (this.terminalSearchEditorOpen && this.terminalSearchGroupId === nextGroupId) this.closeTerminalSearchEditor();
    else this.openTerminalSearchEditor(nextGroupId);
  }

  closeTerminalSearchEditor() {
    clearTimeout(this.terminalSearchTimer);
    this.hideTerminalSearchHoverPopup();
    if (this.terminalSearchAbort) this.terminalSearchAbort.abort();
    this.terminalSearchAbort = null;
    this.terminalSearchText = "";
    this.terminalSearchEditorOpen = false;
    this.terminalSearchGroupId = null;
    this.terminalSearchWorktreeId = null;
    this.terminalSearchFocusIndex = -1;
    this.terminalSearchMatches.clear();
    this.terminalSearchClosedMatches.clear();
    this.terminalTitleSearchResults = [];
    this.historySearchResults = [];
    this.renderList();
    requestAnimationFrame(() => this.focusActiveEditor());
  }

  collapsibleSectionLabel(text, field, extra = null) {
    const collapsed = this.sectionCollapsed(field);
    const label = document.createElement("div");
    label.className = "side-section-label side-section-header collapsible-section-header";
    const name = document.createElement("span");
    name.textContent = text;
    const controls = document.createElement("span");
    controls.className = "section-header-controls";
    const toggle = document.createElement("button");
    toggle.className = "section-toggle section-collapse-toggle";
    toggle.innerHTML = `<span class="codicon codicon-chevron-${collapsed ? "right" : "down"}"></span>`;
    toggle.title = collapsed ? `Expand ${text}` : `Collapse ${text}`;
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    label.title = toggle.title;
    label.onclick = () => this.toggleSectionCollapsed(field);
    toggle.onclick = (event) => {
      event.stopPropagation();
      this.toggleSectionCollapsed(field);
    };
    label.append(toggle, name);
    if (extra) {
      controls.appendChild(extra);
      label.appendChild(controls);
    }
    return label;
  }

  sessionActivityTime(session) {
    if (!session) return 0;
    const known = Number(this.sessionActivityAt.get(session.session_id) || 0);
    const serverActivity = Number(session.last_activity_at || 0);
    const serverActivityMs = serverActivity > 1e12 ? serverActivity : serverActivity * 1000;
    const processingSince = Number(session.processing_since || 0) * 1000;
    const created = Date.parse(String(session.created_at_est || "").replace(" ", "T")) || 0;
    return Math.max(known, serverActivityMs, processingSince, created);
  }

  formatTerminalAge(elapsedMs) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 60000) return "just now";
    const minutes = Math.floor(elapsedMs / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const remainingMinutes = minutes % 60;
    if (days) return `${days}d${hours ? ` ${hours}h` : ""}`;
    if (hours) return `${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ""}`;
    return `${minutes}m`;
  }

  terminalAgeText(session) {
    const timestamp = this.sessionActivityTime(session);
    if (!timestamp) return "unknown";
    return this.formatTerminalAge(Math.max(0, Date.now() - timestamp));
  }

  terminalAgeAgoLabel(session) {
    const label = this.terminalAgeText(session);
    return label === "unknown" || label === "just now" ? label : `${label} ago`;
  }

  terminalAgeBucketForActivityTime(timestamp) {
    if (!this.settings.show_terminal_age) return 0;
    const latest = this.latestTerminalActivityTime();
    if (!timestamp || !latest) return 0;
    const elapsed = Math.max(0, latest - timestamp);
    if (elapsed >= TERMINAL_AGE_WEEK_MS) return 2;
    return elapsed >= TERMINAL_AGE_DAY_MS ? 1 : 0;
  }

  terminalAgeColorForActivityTime(timestamp) {
    const baseMatch = String(this.settings.sidebar_text_color || "").match(/^#([0-9a-f]{6})$/i);
    const dimValue = getComputedStyle(document.body).getPropertyValue("--dim").trim();
    const dimMatch = dimValue.match(/^#([0-9a-f]{6})$/i);
    if (!baseMatch || !dimMatch) return this.settings.sidebar_text_color;
    const bucket = this.terminalAgeBucketForActivityTime(timestamp);
    const fade = bucket === 1 ? TERMINAL_AGE_INTERMEDIATE_FADE : bucket === 2 ? 1 : 0;
    const base = [0, 1, 2].map((index) => parseInt(baseMatch[1].slice(index * 2, index * 2 + 2), 16));
    const dim = [0, 1, 2].map((index) => parseInt(dimMatch[1].slice(index * 2, index * 2 + 2), 16));
    const color = base.map((value, index) => Math.round(value + (dim[index] - value) * fade));
    return `rgb(${color.join(", ")})`;
  }

  terminalAgeColor(session) {
    return this.terminalAgeColorForActivityTime(this.sessionActivityTime(session));
  }

  terminalAgeExactTimestamp(session) {
    const timestamp = this.sessionActivityTime(session);
    return timestamp ? new Date(timestamp).toLocaleString() : "activity time unavailable";
  }

  latestTerminalActivityTime() {
    return this.sessions.reduce((latest, session) => Math.max(latest, this.sessionActivityTime(session)), 0);
  }

  terminalAgeBucket(session) {
    return this.terminalAgeBucketForActivityTime(this.sessionActivityTime(session));
  }

  terminalGroupActivityTime(members) {
    return members.reduce((latest, session) => Math.max(latest, this.sessionActivityTime(session)), 0);
  }

  terminalGroupAgeColor(members) {
    const accentValue = getComputedStyle(document.body).getPropertyValue("--accent").trim();
    const accentMatch = accentValue.match(/^#([0-9a-f]{6})$/i);
    if (!accentMatch) return "var(--accent)";
    const bucket = this.terminalAgeBucketForActivityTime(this.terminalGroupActivityTime(members));
    const brightness = TERMINAL_GROUP_AGE_BRIGHTNESS[bucket];
    const channels = [0, 1, 2].map((index) => Math.round(
      parseInt(accentMatch[1].slice(index * 2, index * 2 + 2), 16) * brightness));
    return `rgb(${channels.join(", ")})`;
  }

  updateTerminalGroupAgeStyles() {
    if (this.vscodeMode) return;
    for (const group of this.terminalGroups()) {
      const label = this.$("session-list")?.querySelector(`[data-group-id="${CSS.escape(group.id)}"] > .terminal-group-label`);
      const name = label?.querySelector(".terminal-group-name");
      if (!name) continue;
      const members = this.groupSessionIds(group.id).map((id) => this.session(id)).filter(Boolean);
      name.style.color = this.terminalGroupAgeColor(members);
    }
  }

  updateSessionAgeStyles() {
    if (this.vscodeMode) return;
    for (const session of this.sessions) {
      const row = this.sessionRowEls.get(session.session_id);
      if (!row) continue;
      row.style.setProperty("--session-age-color", this.terminalAgeColor(session));
      const title = this.sessionTitleEls.get(session.session_id);
      if (title) {
        if (title.classList.contains("session-title-working")) title.style.removeProperty("color");
        else title.style.color = this.terminalAgeColor(session);
      }
      const baseTitle = row.dataset.baseTitle || row.title;
      row.title = `${baseTitle}\nlast activity ${this.terminalAgeAgoLabel(session)}\n${this.terminalAgeExactTimestamp(session)}`;
    }
    this.updateTerminalGroupAgeStyles();
  }

  updateActiveTerminalAge() {
    const age = this.$("terminal-age");
    if (!age) return;
    const session = this.session(this.activeId);
    if (this.vscodeMode || this.activeFileKey !== null || !session) {
      age.classList.add("hidden");
      age.textContent = "";
      age.title = "";
      return;
    }
    age.classList.remove("hidden");
    age.textContent = `last activity ${this.terminalAgeAgoLabel(session)}`;
    age.title = `Last terminal activity: ${this.terminalAgeExactTimestamp(session)}`;
  }

  touchSessionActivity(sessionId, timestamp = Date.now()) {
    if (!sessionId) return;
    const previous = Number(this.sessionActivityAt.get(sessionId) || 0);
    if (timestamp <= previous) return;
    this.sessionActivityAt.set(sessionId, timestamp);
  }

  updateHideInactiveTerminalsButton() {
    const button = this.$("active-toggle");
    if (!button) return;
    button.classList.toggle("on", this.hideInactiveTerminals);
    button.innerHTML = `<span class="codicon ${this.hideInactiveTerminals ? "codicon-eye-closed" : "codicon-eye"}"></span>`;
    button.setAttribute("aria-pressed", String(this.hideInactiveTerminals));
    button.title = this.hideInactiveTerminals ? "Show all terminals" : "Show active and unread terminals";
    button.setAttribute("aria-label", button.title);
  }

  toggleHideInactiveTerminals() {
    this.hideInactiveTerminals = !this.hideInactiveTerminals;
    this.updateHideInactiveTerminalsButton();
    this.renderList();
  }

  // The filter keeps anything working, anything waiting on you, anything unread -- and anything you
  // have touched recently. Without that last clause the list collapsed to whatever happened to be busy
  // at that instant, which hides the session you were reading a minute ago the moment it finishes.
  isActiveTerminal(session) {
    if (!session) return false;
    if (this.processingStates.get(session.session_id) === true || session.processing === true ||
        session.needs_attention === true || this.unreadSessions.has(session.session_id)) return true;
    return this.terminalUsedWithinWindow(session);
  }

  // A small menu under the filter button offering the window. Deliberately transient: it is a refinement
  // of a filter you just switched on, not a setting you go looking for, so any click elsewhere, Escape,
  // or a scroll dismisses it and the default stands if you ignore it.
  openRecentTerminalHoursMenu(anchor) {
    this.closeRecentTerminalHoursMenu();
    if (!anchor) return;
    const menu = document.createElement("div");
    menu.id = "recent-hours-menu";
    menu.setAttribute("role", "menu");
    const heading = document.createElement("div");
    heading.className = "recent-hours-heading";
    heading.textContent = "recently used within";
    menu.appendChild(heading);
    for (const hours of RECENT_TERMINAL_HOUR_CHOICES) {
      const option = document.createElement("button");
      option.className = "recent-hours-option";
      option.type = "button";
      option.setAttribute("role", "menuitemradio");
      const selected = hours === this.terminalRecentHours();
      option.classList.toggle("on", selected);
      option.setAttribute("aria-checked", String(selected));
      option.textContent = this.recentHoursLabel(hours);
      option.onclick = (event) => {
        event.stopPropagation();
        this.settings.recent_terminal_hours = hours;
        this.saveSettings();
        this.closeRecentTerminalHoursMenu();
        this.renderList();
      };
      menu.appendChild(option);
    }
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.top = `${Math.round(rect.bottom + 4)}px`;
    // Right-aligned to the button, then pulled back inside the viewport if that would overflow.
    const left = Math.min(Math.max(6, rect.right - menu.offsetWidth), window.innerWidth - menu.offsetWidth - 6);
    menu.style.left = `${Math.round(left)}px`;
    this.recentHoursMenu = menu;
    this.recentHoursDismiss = (event) => {
      if (event.type === "keydown" && event.key !== "Escape") return;
      if (event.type === "pointerdown" && (menu.contains(event.target) || anchor.contains(event.target))) return;
      this.closeRecentTerminalHoursMenu();
    };
    // Listeners are added on the next frame: the click that opened this menu is still propagating, and
    // catching it would close the menu in the same gesture that asked for it.
    requestAnimationFrame(() => {
      if (!this.recentHoursMenu) return;
      window.addEventListener("pointerdown", this.recentHoursDismiss, true);
      window.addEventListener("keydown", this.recentHoursDismiss, true);
      window.addEventListener("resize", this.recentHoursDismiss, true);
      this.$("session-list")?.addEventListener("scroll", this.recentHoursDismiss, true);
    });
  }

  closeRecentTerminalHoursMenu() {
    if (this.recentHoursDismiss) {
      window.removeEventListener("pointerdown", this.recentHoursDismiss, true);
      window.removeEventListener("keydown", this.recentHoursDismiss, true);
      window.removeEventListener("resize", this.recentHoursDismiss, true);
      this.$("session-list")?.removeEventListener("scroll", this.recentHoursDismiss, true);
      this.recentHoursDismiss = null;
    }
    this.recentHoursMenu?.remove();
    this.recentHoursMenu = null;
  }

  recentHoursLabel(hours) {
    if (hours % 168 === 0) return `${hours / 168}w`;
    if (hours % 24 === 0) return `${hours / 24}d`;
    return `${hours}h`;
  }

  terminalRecentHours() {
    const hours = Number(this.settings.recent_terminal_hours);
    return Number.isFinite(hours) && hours > 0 ? hours : RECENT_TERMINAL_HOURS_DEFAULT;
  }

  terminalUsedWithinWindow(session) {
    // last_activity_at is epoch seconds and covers input as well as output, so "used" means the session
    // did something or had something done to it -- which is what someone scanning the list is after.
    const last = Number(session.last_activity_at);
    if (!Number.isFinite(last) || last <= 0) return false;
    return (Date.now() / 1000 - last) <= this.terminalRecentHours() * 3600;
  }

  updateTerminalSearchGroupButton() {
    const button = this.$("terminal-search-group-toggle");
    if (!button) return;
    button.classList.toggle("on", this.terminalSearchGroupSimilar);
    button.setAttribute("aria-pressed", String(this.terminalSearchGroupSimilar));
    button.title = this.terminalSearchGroupSimilar
      ? "Show search results by terminal"
      : "Group similar matched text";
  }

  appendTerminalSearchHighlightedText(element, text, query) {
    const value = String(text || "");
    const terms = [...new Set(String(query || "").split(/\s+/).filter(Boolean))];
    const ranges = terms.flatMap((term) => this.searchHighlightRanges(value, term, { caseSensitive: false }))
      .sort((left, right) => left[0] - right[0] || right[1] - left[1]);
    const merged = [];
    for (const [start, end] of ranges) {
      const previous = merged[merged.length - 1];
      if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
      else merged.push([start, end]);
    }
    element.textContent = "";
    let cursor = 0;
    for (const [start, end] of merged) {
      if (start > cursor) element.appendChild(document.createTextNode(value.slice(cursor, start)));
      const mark = document.createElement("mark");
      mark.className = "terminal-search-highlight";
      mark.textContent = value.slice(start, end);
      element.appendChild(mark);
      cursor = end;
    }
    if (cursor < value.length) element.appendChild(document.createTextNode(value.slice(cursor)));
  }

  terminalSearchSnippetMatchesQuery(snippet) {
    const text = this.searchMatchText(snippet?.text).toLocaleLowerCase();
    const terms = String(this.terminalSearchText || "").toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return terms.length > 0 && terms.some((term) => text.includes(term));
  }

  terminalSearchTimestampMillis(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      if (value > 1e16) return value / 1e6;
      if (value > 1e12) return value;
      return value * 1000;
    }
    if (!value) return 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && String(value).trim() !== "") return this.terminalSearchTimestampMillis(numeric);
    return Date.parse(String(value)) || 0;
  }

  terminalSearchTimestampLabel(value) {
    const timestamp = this.terminalSearchTimestampMillis(value);
    if (!timestamp) return { relative: "", exact: "" };
    const age = this.formatTerminalAge(Math.max(0, Date.now() - timestamp));
    return { relative: age === "just now" ? age : `${age} ago`, exact: new Date(timestamp).toLocaleString() };
  }

  renderTerminalSearchSnippets(match) {
    const snippets = document.createElement("div");
    snippets.className = "terminal-search-snippets";
    const matchingSnippets = (match?.snippets || []).filter((snippet) => this.terminalSearchSnippetMatchesQuery(snippet));
    for (const snippet of matchingSnippets.slice(0, 8)) {
      const row = document.createElement("div");
      row.className = "terminal-search-snippet";
      const heading = document.createElement("div");
      heading.className = "terminal-search-snippet-heading";
      const kind = document.createElement("span");
      kind.className = "terminal-search-snippet-kind";
      kind.textContent = snippet.kind === "name" ? "terminal name" : "conversation";
      heading.appendChild(kind);
      const timestamp = this.terminalSearchTimestampLabel(snippet.timestamp);
      if (timestamp.relative) {
        const age = document.createElement("span");
        age.className = "terminal-search-snippet-age";
        age.textContent = timestamp.relative;
        age.title = timestamp.exact;
        heading.appendChild(age);
      }
      if (snippet.result && snippet.source_path) {
        const expand = document.createElement("button");
        expand.type = "button";
        expand.className = "terminal-search-snippet-expand";
        expand.innerHTML = '<span class="codicon codicon-chevron-down"></span>';
        expand.title = "Show surrounding context";
        expand.setAttribute("aria-label", expand.title);
        expand.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          void this.toggleTerminalSearchSnippetContext(row, snippet, expand);
        };
        heading.appendChild(expand);
      }
      const text = document.createElement(snippet.result ? "button" : "div");
      if (snippet.result) text.type = "button";
      text.className = "terminal-search-snippet-text";
      this.appendTerminalSearchHighlightedText(text, this.searchMatchText(snippet.text), this.terminalSearchText);
      if (snippet.result) {
        text.title = "Open this turn in the transcript";
        text.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          void this.openTerminalSearchTranscriptMatch(snippet);
        };
      }
      const context = document.createElement("div");
      context.className = "terminal-search-snippet-context hidden";
      row.append(heading, text, context);
      snippets.appendChild(row);
    }
    return snippets;
  }

  async toggleTerminalSearchSnippetContext(row, snippet, button) {
    const context = row.querySelector(".terminal-search-snippet-context");
    const expanded = button.getAttribute("aria-expanded") === "true";
    if (expanded) {
      context.classList.add("hidden");
      button.setAttribute("aria-expanded", "false");
      button.querySelector(".codicon").className = "codicon codicon-chevron-down";
      return;
    }
    context.classList.remove("hidden");
    button.setAttribute("aria-expanded", "true");
    button.querySelector(".codicon").className = "codicon codicon-chevron-up";
    if (context.dataset.loaded === "true") return;
    context.textContent = "loading context…";
    try {
      const params = new URLSearchParams({ source: snippet.source_path, line: String(snippet.line || 1), radius: "6",
        q: this.terminalSearchText, include_operations: String(this.historySearchOperations) });
      const response = await fetch(`/api/history-context?${params}`);
      if (!response.ok) throw new Error("history context unavailable");
      const payload = await response.json();
      context.textContent = "";
      context.dataset.loaded = "true";
      for (const line of payload.lines || []) {
        const contextLine = document.createElement("button");
        contextLine.type = "button";
        contextLine.className = "terminal-search-context-line" +
          (Number(line.line_no) === Number(payload.line_no) ? " target" : "");
        const contextTimestamp = this.terminalSearchTimestampLabel(line.timestamp);
        if (contextTimestamp.relative) {
          const age = document.createElement("span");
          age.className = "terminal-search-context-age";
          age.textContent = contextTimestamp.relative;
          age.title = contextTimestamp.exact;
          contextLine.appendChild(age);
        }
        const content = document.createElement("span");
        content.className = "terminal-search-context-text";
        this.appendTerminalSearchHighlightedText(content, this.searchMatchText(line.text), this.terminalSearchText);
        contextLine.appendChild(content);
        contextLine.title = "Open this turn in the transcript";
        contextLine.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          void this.openTerminalSearchTranscriptMatch({ ...snippet, line: line.line_no, text: line.text,
            timestamp: line.timestamp });
        };
        context.appendChild(contextLine);
      }
      if (!context.childElementCount) context.textContent = "no surrounding conversation available";
    } catch (error) {
      context.textContent = error.message || "history context unavailable";
    }
  }

  terminalSearchHoverPopup() {
    let popup = document.getElementById("terminal-search-hover-popup");
    if (popup) return popup;
    popup = document.createElement("div");
    popup.id = "terminal-search-hover-popup";
    popup.className = "hidden";
    popup.addEventListener("mouseenter", () => this.cancelTerminalSearchHoverHide());
    popup.addEventListener("mouseleave", () => this.scheduleTerminalSearchHoverHide());
    document.body.appendChild(popup);
    return popup;
  }

  showTerminalSearchHoverPopup(item, match) {
    if (!item?.isConnected || !match || !this.terminalSearchText.trim()) return;
    this.cancelTerminalSearchHoverHide();
    const snippets = this.renderTerminalSearchSnippets(match);
    if (!snippets.childElementCount) {
      this.hideTerminalSearchHoverPopup();
      return;
    }
    const popup = this.terminalSearchHoverPopup();
    popup.replaceChildren(snippets);
    popup.classList.remove("hidden");
    const bounds = item.getBoundingClientRect();
    const availableWidth = Math.max(320, window.innerWidth - bounds.right - 18);
    popup.style.width = `${Math.min(660, availableWidth)}px`;
    popup.style.left = `${Math.max(8, Math.min(window.innerWidth - popup.offsetWidth - 8, bounds.right + 7))}px`;
    popup.style.top = `${Math.max(8, Math.min(bounds.top, window.innerHeight - popup.offsetHeight - 8))}px`;
  }

  hideTerminalSearchHoverPopup() {
    this.cancelTerminalSearchHoverHide();
    document.getElementById("terminal-search-hover-popup")?.classList.add("hidden");
  }

  cancelTerminalSearchHoverHide() {
    clearTimeout(this.terminalSearchHoverHideTimer);
    this.terminalSearchHoverHideTimer = 0;
  }

  scheduleTerminalSearchHoverHide() {
    this.cancelTerminalSearchHoverHide();
    this.terminalSearchHoverHideTimer = window.setTimeout(() => this.hideTerminalSearchHoverPopup(), 320);
  }

  bindTerminalSearchHoverPopup(item, match) {
    if (!match) return;
    item.addEventListener("mouseenter", () => this.showTerminalSearchHoverPopup(item, match));
    item.addEventListener("mouseleave", () => this.scheduleTerminalSearchHoverHide());
    item.addEventListener("focus", () => this.showTerminalSearchHoverPopup(item, match));
    item.addEventListener("blur", () => this.scheduleTerminalSearchHoverHide());
  }

  terminalSearchRows() {
    return [...this.$("session-list").querySelectorAll(".session-item.terminal-search-match, .closed-item.terminal-search-match")];
  }

  moveTerminalSearchRow(direction) {
    const rows = this.terminalSearchRows();
    if (!rows.length) return;
    const current = rows.indexOf(document.activeElement);
    const start = current >= 0 ? current : this.terminalSearchFocusIndex;
    this.terminalSearchFocusIndex = (start + direction + rows.length) % rows.length;
    const row = rows[this.terminalSearchFocusIndex];
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
  }
}
