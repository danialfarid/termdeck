window.TermDeckFileBrowser = (() => {
  const materialIconsBase = "/static/vendor/material-icons/icons/";
  const alwaysExcluded = [".git", "node_modules", "__pycache__", ".venv", ".idea", "_"];
  const fileIconNames = { py: "python", js: "javascript", ts: "typescript", json: "json", md: "markdown", css: "css", html: "html", yaml: "yaml", yml: "yaml", sh: "console", sql: "database", csv: "table", png: "image", jpg: "image", jpeg: "image", svg: "svg", rs: "rust", go: "go", java: "java", cpp: "cpp", c: "c", h: "h" };
  const gitStatusLabels = { "?": "untracked", M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "conflicted" };

  function fileIconElement(fileName, className = "tree-type-icon") {
    const extension = String(fileName || "").split(".").pop().toLowerCase();
    const image = document.createElement("img");
    image.className = className;
    image.src = `${materialIconsBase}${fileIconNames[extension] || "file"}.svg`;
    image.onerror = () => { image.src = `${materialIconsBase}file.svg`; image.onerror = null; };
    return image;
  }

  function formatMtime(epochSeconds) {
    const minutes = Math.max(0, Math.floor((Date.now() - Number(epochSeconds) * 1000) / 60000));
    const hours = Math.floor(minutes / 60), days = Math.floor(hours / 24), weeks = Math.floor(days / 7), months = Math.floor(weeks / 4);
    const values = months >= 12 ? [[Math.floor(months / 12), "y"], [months % 12, "m"]] : months ? [[months, "m"], [weeks % 4, "w"]] : weeks ? [[weeks, "w"], [days % 7, "d"]] : days ? [[days, "d"], [hours % 24, "h"]] : hours ? [[hours, "h"], [minutes % 60, "m"]] : [[minutes, "m"]];
    return `${values.filter(([value]) => value > 0).map(([value, suffix]) => `${value}${suffix}`).join(" ") || "0m"} ago`;
  }

  function appendEntryMetadata(row, entry, { showMtime = true, showGitStatus = true } = {}) {
    if (showMtime && entry.mtime) {
      const mtime = document.createElement("span");
      mtime.className = "tree-mtime";
      mtime.textContent = formatMtime(entry.mtime);
      mtime.title = `modified ${new Date(Number(entry.mtime) * 1000).toLocaleString()}`;
      row.appendChild(mtime);
    }
    if (!showGitStatus) return;
    const status = String(entry.git_status || "").trim().toUpperCase();
    if (!status) return;
    const statusClass = status === "?" ? "untracked" : status.toLowerCase();
    row.classList.add("git-row", `git-row-${statusClass}`);
    const badge = document.createElement("span");
    badge.className = "git-status";
    badge.textContent = status;
    row.appendChild(badge);
    row.title = `${row.title}\ngit: ${gitStatusLabels[status] || status}`;
  }

  function createTreeEntryRow({ root, relativePath, entry, excluded = false, showMtime = true, showGitStatus = true, fileIcon = fileIconElement, onDirectory, onFile, onDoubleClick, onAuxClick, onContextMenu }) {
    const childPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const row = document.createElement("div");
    row.className = `tree-row file-browser-tree-row ${entry.is_dir ? "dir" : "file"}${excluded ? " excluded" : ""}`;
    row.dataset.rel = childPath;
    row.dataset.path = childPath;
    row.dataset.kind = entry.is_dir ? "dir" : "file";
    row.tabIndex = 0;
    row.title = `${root}/${childPath}`;
    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = entry.name;
    if (entry.is_dir) {
      const chevron = document.createElement("span");
      chevron.className = "codicon codicon-chevron-right tree-chevron";
      const icon = document.createElement("img");
      icon.className = "tree-type-icon tree-folder-icon";
      icon.src = `${materialIconsBase}folder.svg`;
      icon.onerror = () => { icon.src = `${materialIconsBase}folder.svg`; };
      row.append(chevron, icon, name);
      row.onclick = () => onDirectory?.(row, childPath);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "tree-file-spacer";
      row.append(spacer, fileIcon(entry.name), name);
      row.onclick = (event) => onFile?.(event, row, childPath);
      row.ondblclick = () => onDoubleClick?.(row, childPath);
      row.onauxclick = (event) => onAuxClick?.(event, row, childPath);
    }
    appendEntryMetadata(row, entry, { showMtime, showGitStatus });
    row.oncontextmenu = (event) => onContextMenu?.(event, row, childPath);
    return row;
  }

  return { materialIconsBase, alwaysExcluded, fileIconElement, formatMtime, appendEntryMetadata, createTreeEntryRow };
})();
