"use strict";
// Editor loaders — CDN-loaded rich editors, each mounted on demand. Self
// contained (no app.js deps); every mount appends its editor into `host` and
// returns a getMarkdown() function. Exposes window.EditorLoaders.

(function () {
  function loadCss(href) {
    if ([...document.querySelectorAll("link[rel=stylesheet]")].some(l => l.href === href)) return;
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = href;
    document.head.appendChild(l);
  }

  let _crepeP, _toastP, _tiptapP, _easymdeP;

  function ensureCrepe() {
    if (!_crepeP) {
      loadCss("https://cdn.jsdelivr.net/npm/@milkdown/crepe@7.5.0/lib/theme/common/style.css");
      loadCss("https://cdn.jsdelivr.net/npm/@milkdown/crepe@7.5.0/lib/theme/frame-dark/style.css");
      _crepeP = import("https://esm.sh/@milkdown/crepe@7.5.0?bundle")
        .then(m => { if (!m.Crepe) throw new Error("no Crepe export"); return m.Crepe; });
    }
    return _crepeP;
  }
  function ensureToast() {
    if (!_toastP) {
      loadCss("https://cdn.jsdelivr.net/npm/@toast-ui/editor@3.2.2/dist/toastui-editor.min.css");
      loadCss("https://cdn.jsdelivr.net/npm/@toast-ui/editor@3.2.2/dist/theme/toastui-editor-dark.min.css");
      _toastP = import("https://esm.sh/@toast-ui/editor@3.2.2").then(m => m.default || m.Editor);
    }
    return _toastP;
  }
  function ensureTiptap() {
    if (!_tiptapP) {
      _tiptapP = Promise.all([
        import("https://esm.sh/@tiptap/core@2.11.5"),
        import("https://esm.sh/@tiptap/starter-kit@2.11.5"),
        import("https://esm.sh/tiptap-markdown@0.8.10"),
        import("https://esm.sh/@tiptap/extension-bubble-menu@2.11.5"),
        import("https://esm.sh/@tiptap/extension-image@2.11.5"),
        import("https://esm.sh/@tiptap/extension-link@2.11.5"),
      ]);
    }
    return _tiptapP;
  }
  function ensureEasyMDE() {
    if (!_easymdeP) {
      loadCss("https://cdn.jsdelivr.net/npm/easymde@2.18.0/dist/easymde.min.css");
      _easymdeP = import("https://esm.sh/easymde@2.18.0").then(m => m.default);
    }
    return _easymdeP;
  }

  // prompt for a URL and turn the current selection into a link (empty = unset)
  function setLink(chain) {
    const url = window.prompt("Link URL (leave empty to remove):", "https://");
    if (url === null) return chain;                       // cancelled → no-op
    if (url === "") return chain.extendMarkRange("link").unsetLink();
    return chain.extendMarkRange("link").setLink({ href: url });
  }
  // open a native file picker and insert the chosen image file(s) at the cursor
  function pickImage(editor) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      insertImageFiles(editor, imageFiles(input), null);
      input.remove();
    });
    input.click();
  }
  // collect image File objects from a drag/paste DataTransfer
  function imageFiles(dt) {
    const out = [];
    if (dt && dt.files) for (const f of dt.files) if (f.type.startsWith("image/")) out.push(f);
    return out;
  }
  // if `text` is a bare URL that points at (or can be rewritten to) an image,
  // return the direct image URL; otherwise null. Handles plain image links and
  // Giphy/Tenor share links. Generic pages (og:image) need a server resolver.
  function imageUrlFromText(text) {
    const s = (text || "").trim();
    if (!/^https?:\/\/\S+$/.test(s) || /\s/.test(s)) return null;   // must be a single bare URL
    if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?.*)?(#.*)?$/i.test(s)) return s;
    const giphy = s.match(/giphy\.com\/(?:gifs|clips)\/(?:.*-)?([a-zA-Z0-9]+)\/?$/);
    if (giphy) return `https://media.giphy.com/media/${giphy[1]}/giphy.gif`;
    return null;
  }

  // a single bare http(s) URL → the URL, else null
  function bareUrl(text) {
    const s = (text || "").trim();
    return (/^https?:\/\/\S+$/.test(s) && !/\s/.test(s)) ? s : null;
  }

  // Derive a human-friendly label from the URL ALONE (no network). Returns null
  // when the URL carries nothing better than its host (opaque id, shortener, …)
  // so the caller keeps the link literal. Real doc titles (private Drive etc.)
  // can't be had client-side — that needs a server unfurl / provider API.
  function linkTitle(url) {
    let u; try { u = new URL(url); } catch (e) { return null; }
    const host = u.hostname.replace(/^www\./, "");
    const segs = u.pathname.split("/").filter(Boolean)
      .map(s => { try { return decodeURIComponent(s); } catch (e) { return s; } });
    const last = segs[segs.length - 1] || "";
    const opaque = (s) => !s || /^\d+$/.test(s) || /^[0-9a-f]{16,}$/i.test(s)
      || (!/[-_ ]/.test(s) && /^[A-Za-z0-9]{16,}$/.test(s));   // long token, no separators

    // shorteners and id-in-query sites carry no title in the URL → stay literal
    const SHORTENERS = new Set(["bit.ly", "t.co", "goo.gl", "tinyurl.com", "ow.ly",
      "buff.ly", "is.gd", "cutt.ly", "rebrand.ly", "shorturl.at", "lnkd.in", "t.ly", "rb.gy"]);
    if (SHORTENERS.has(host)) return null;
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") return null;
    const ROUTE = new Set(["watch", "view", "edit", "index", "home", "new", "login",
      "signin", "dashboard", "share", "embed", "preview", "d", "file"]);

    if (host === "dropbox.com" || host === "dl.dropboxusercontent.com")
      return segs.find(s => /\.\w{2,5}$/.test(s)) || null;     // filename lives in the path
    if (host === "docs.google.com") {
      if (u.pathname.includes("/document/")) return "Google Doc";
      if (u.pathname.includes("/spreadsheets/")) return "Google Sheet";
      if (u.pathname.includes("/presentation/")) return "Google Slides";
      if (u.pathname.includes("/forms/")) return "Google Form";
      return "Google Docs";
    }
    if (host === "drive.google.com") return "Google Drive file";
    if (host === "github.com" && segs.length >= 2) {
      const t = segs[2], n = segs[3];
      if ((t === "pull" || t === "issues") && n) return `${segs[0]}/${segs[1]}#${n}`;
      return `${segs[0]}/${segs[1]}`;
    }
    if ((host.endsWith("notion.so") || host.endsWith("notion.site")) && last) {
      const t = last.replace(/-[0-9a-f]{32}$/i, "").replace(/-/g, " ").trim();
      if (t) return t;
    }
    if (host === "en.wikipedia.org" && segs[0] === "wiki" && segs[1])
      return segs[1].replace(/_/g, " ");
    if (last && !opaque(last) && !ROUTE.has(last.toLowerCase())) {   // generic readable slug
      const name = last.replace(/\.\w{2,5}$/, "").replace(/[-_]+/g, " ").trim();
      if (name && !opaque(name) && name.length > 1) return name;
    }
    return null;
  }

  // oEmbed providers expose a CORS-enabled JSON endpoint that returns the real
  // title for a public URL — the one reliable "fetch a title" path in-browser
  // (no scraping, no cookies). Cross-origin page scraping is blocked by CORS, so
  // private Drive/Dropbox titles can't be read this way; that needs OAuth + API.
  const OEMBED = [
    { re: /(^|\.)(youtube\.com|youtu\.be)$/, ep: (u) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u)}` },
    { re: /(^|\.)vimeo\.com$/,               ep: (u) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(u)}` },
    { re: /(^|\.)spotify\.com$/,             ep: (u) => `https://open.spotify.com/oembed?url=${encodeURIComponent(u)}` },
    { re: /(^|\.)soundcloud\.com$/,          ep: (u) => `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(u)}` },
  ];
  async function fetchOembedTitle(url) {
    let host; try { host = new URL(url).hostname; } catch (e) { return null; }
    const m = OEMBED.find(o => o.re.test(host));
    if (!m) return null;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(m.ep(url), { signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) return null;
      const j = await r.json();
      return (j && typeof j.title === "string" && j.title.trim()) ? j.title.trim() : null;
    } catch (e) { return null; }   // CORS / network / abort → silently keep the placeholder
  }

  // after a link is inserted, try to upgrade its text to the real oEmbed title.
  // Guards: a newer paste cancels this; if the user already edited the inserted
  // range we leave it alone.
  function enrichLinkTitle(editor, url, from, to, placeholder) {
    const gen = _enrichSeq;
    fetchOembedTitle(url).then((title) => {
      if (!title || gen !== _enrichSeq || title === placeholder) return;
      try {
        if (to > editor.state.doc.content.size) return;
        if (editor.state.doc.textBetween(from, to) !== placeholder) return;
        editor.chain().setTextSelection({ from, to })
          .insertContent({ type: "text", text: title, marks: [{ type: "link", attrs: { href: url } }] }).run();
      } catch (e) {}
    });
  }

  // remembers the last URL paste so a quick second paste (double ⌘/Ctrl-V) can
  // swap the smart insert (image / titled link) for the plain URL. _enrichSeq
  // invalidates a pending oEmbed upgrade as soon as another paste happens.
  let _lastPaste = null, _enrichSeq = 0;

  // read dropped/pasted image files as data URLs and insert them as image nodes
  function insertImageFiles(editor, files, pos) {
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const node = { type: "image", attrs: { src: reader.result, alt: file.name } };
        const c = editor.chain().focus();
        (pos == null ? c.insertContent(node) : c.insertContentAt(pos, node)).run();
      };
      reader.readAsDataURL(file);
    });
  }

  // Build the selection popup element + button wiring for TipTap. Returns
  // { el, wire(editor), refresh(editor) }; the BubbleMenu extension owns its
  // positioning/visibility, we just supply the DOM and the commands.
  function buildTiptapMenu() {
    const el = document.createElement("div");
    el.className = "tt-menu";
    el.addEventListener("mousedown", (e) => e.preventDefault()); // keep the editor selection

    const ITEMS = [
      { t: "B",   title: "Bold",          cls: "tt-b", cmd: (c) => c.toggleBold(),              on: (e) => e.isActive("bold") },
      { t: "I",   title: "Italic",        cls: "tt-i", cmd: (c) => c.toggleItalic(),            on: (e) => e.isActive("italic") },
      { t: "S",   title: "Strikethrough", cls: "tt-s", cmd: (c) => c.toggleStrike(),            on: (e) => e.isActive("strike") },
      { t: "</>", title: "Inline code",                cmd: (c) => c.toggleCode(),              on: (e) => e.isActive("code") },
      { t: "H1",  title: "Heading 1",                  cmd: (c) => c.toggleHeading({ level: 1 }), on: (e) => e.isActive("heading", { level: 1 }) },
      { t: "H2",  title: "Heading 2",                  cmd: (c) => c.toggleHeading({ level: 2 }), on: (e) => e.isActive("heading", { level: 2 }) },
      { t: "❝",   title: "Quote",                      cmd: (c) => c.toggleBlockquote(),        on: (e) => e.isActive("blockquote") },
      { t: "•",   title: "Bullet list",               cmd: (c) => c.toggleBulletList(),        on: (e) => e.isActive("bulletList") },
      { t: "🔗",  title: "Link",                       cmd: (c) => setLink(c),                  on: (e) => e.isActive("link") },
      { t: "🖼",  title: "Insert image (choose file)", act: (ed) => pickImage(ed) },
    ];

    const buttons = ITEMS.map((it) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tt-btn" + (it.cls ? " " + it.cls : "");
      b.textContent = it.t;
      b.title = it.title;
      el.appendChild(b);
      return { b, it };
    });

    function refresh(ed) {
      buttons.forEach(({ b, it }) => { if (it.on) b.classList.toggle("is-active", it.on(ed)); });
    }
    function wire(ed) {
      buttons.forEach(({ b, it }) => {
        b.addEventListener("click", () => {
          if (it.act) it.act(ed);                        // custom action (e.g. open the file picker)
          else it.cmd(ed.chain().focus()).run();         // chain command (formatting)
          refresh(ed);
        });
      });
    }
    return { el, wire, refresh };
  }

  const MOUNTS = {
    // Notion-style WYSIWYG; live input rules (`code`, ``` block, # heading); markdown storage.
    async milkdown(host, md) {
      const Crepe = await ensureCrepe();
      const div = document.createElement("div"); div.className = "tui-host";
      host.insertBefore(div, host.firstChild);
      const crepe = new Crepe({ root: div, defaultValue: md });
      await crepe.create();
      return () => crepe.getMarkdown();
    },
    // Toolbar + markdown⇄WYSIWYG; a code button but no live input rule.
    async toast(host, md) {
      const Editor = await ensureToast();
      const div = document.createElement("div"); div.className = "tui-host";
      host.insertBefore(div, host.firstChild);
      const ed = new Editor({
        el: div, height: "100%", initialEditType: "wysiwyg", previewStyle: "vertical",
        theme: "dark", usageStatistics: false, initialValue: md,
        toolbarItems: [["heading", "bold", "italic", "strike"], ["hr", "quote"],
          ["ul", "ol", "task"], ["table", "link", "image", "code", "codeblock"]],
      });
      return () => ed.getMarkdown();
    },
    // Headless ProseMirror WYSIWYG; live input rules; markdown via tiptap-markdown.
    // Adds a selection bubble-menu popup plus image/link nodes (both roundtrip
    // through markdown via tiptap-markdown).
    async tiptap(host, md) {
      const [core, sk, mk, bm, img, link] = await ensureTiptap();
      const div = document.createElement("div"); div.className = "tui-host tiptap-host";
      host.insertBefore(div, host.firstChild);
      const menu = buildTiptapMenu();
      div.appendChild(menu.el);
      const ed = new core.Editor({
        element: div,
        extensions: [
          sk.default,
          mk.Markdown,
          img.default.configure({ inline: false, allowBase64: true }),
          link.default.configure({ openOnClick: false, autolink: true }),
          bm.default.configure({ element: menu.el, tippyOptions: { duration: 100 } }),
        ],
        content: md,
        onSelectionUpdate: ({ editor }) => menu.refresh(editor),
        editorProps: {
          // drop image file(s) → insert at the drop point. Without this the
          // browser navigates to the file (opens it in a new tab).
          handleDrop(view, event, _slice, moved) {
            const files = moved ? [] : imageFiles(event.dataTransfer);
            if (!files.length) return false;            // not an image drop → default handling
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
            insertImageFiles(ed, files, at ? at.pos : null);
            return true;
          },
          // Smart paste. Image file → image. Bare URL → image/gif embed or a
          // titled link (label derived from the URL). A quick second paste of
          // the same URL (double ⌘/Ctrl-V) replaces that with the plain link.
          // Anything else falls through to default handling.
          handlePaste(view, event) {
            _enrichSeq++;                                   // cancel any pending oEmbed upgrade
            const files = imageFiles(event.clipboardData);
            if (files.length) {
              event.preventDefault();
              insertImageFiles(ed, files, null);
              _lastPaste = null;
              return true;
            }
            const url = bareUrl(event.clipboardData && event.clipboardData.getData("text/plain"));
            if (!url) { _lastPaste = null; return false; }   // not a bare URL → default paste
            event.preventDefault();

            // double-paste: undo the smart insert, drop in the plain URL instead
            const repeat = _lastPaste && _lastPaste.url === url
              && (performance.now() - _lastPaste.at) < 700;
            if (repeat) {
              const at = _lastPaste.from;
              try { ed.chain().focus().deleteRange({ from: at, to: _lastPaste.to }).run(); } catch (e) {}
              ed.chain().focus().insertContentAt(at,
                { type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] }).run();
              _lastPaste = null;                             // a third paste starts fresh
              return true;
            }

            const from = ed.state.selection.from;
            const img = imageUrlFromText(url);
            if (img) {
              ed.chain().focus().setImage({ src: img }).run();
            } else {
              const text = linkTitle(url) || url;            // null title → keep it literal
              ed.chain().focus().insertContent(
                { type: "text", text, marks: [{ type: "link", attrs: { href: url } }] }).run();
              enrichLinkTitle(ed, url, from, ed.state.selection.from, text); // async oEmbed upgrade
            }
            _lastPaste = { url, at: performance.now(), from, to: ed.state.selection.from };
            return true;
          },
        },
      });
      menu.wire(ed);
      return () => ed.storage.markdown.getMarkdown();
    },
    // Markdown source + toolbar + live preview.
    async easymde(host, md) {
      const EasyMDE = await ensureEasyMDE();
      const ta = document.createElement("textarea");
      host.insertBefore(ta, host.firstChild);
      const mde = new EasyMDE({ element: ta, initialValue: md, spellChecker: false, minHeight: "260px", status: false });
      return () => mde.value();
    },
  };

  window.EditorLoaders = { loadCss, MOUNTS };
})();
