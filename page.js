// Injected by popup.js into the Base44 tab (MAIN world).
// Exposes window.__b44dl.{fetchCode, listPaths, readFile}. Every method resolves to
// a plain JSON object and never throws, so the popup always gets a readable answer.
(() => {
  "use strict";

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const normPath = (value) => String(value).replace(/\\/g, "/").replace(/^\/+/, "").trim();

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  // ------------------------------------------------------------------ API mode

  function stripQuotes(value) {
    return String(value).replace(/^"+|"+$/g, "");
  }

  function findToken() {
    const stores = [];
    try { stores.push(localStorage); } catch {}
    try { stores.push(sessionStorage); } catch {}
    for (const store of stores) {
      for (const name of ["base44_access_token", "token", "access_token"]) {
        try {
          const value = store.getItem(name);
          if (value) return stripQuotes(value);
        } catch {}
      }
    }
    const jwt = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
    for (const store of stores) {
      try {
        for (let i = 0; i < store.length; i++) {
          const value = stripQuotes(store.getItem(store.key(i)) || "");
          if (jwt.test(value)) return value;
        }
      } catch {}
    }
    return "";
  }

  function normalizeFiles(payload) {
    const input = payload?.files ?? payload?.code ?? payload;
    const out = {};
    if (Array.isArray(input)) {
      for (const file of input) {
        const path = file?.path || file?.filePath || file?.file_path || file?.name;
        if (path) out[path] = String(file.content ?? file.code ?? "");
      }
      return out;
    }
    for (const [path, value] of Object.entries(input && typeof input === "object" ? input : {})) {
      if (typeof value === "string") out[path] = value;
      else if (value && typeof value === "object" && ("content" in value || "code" in value)) {
        out[path] = String(value.content ?? value.code ?? "");
      }
    }
    return out;
  }

  async function fetchCode(appId) {
    const token = findToken();
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`/api/apps/${encodeURIComponent(appId)}/code`, {
      headers,
      credentials: "include"
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed.detail || parsed.message || text;
      } catch {}
      if (typeof detail !== "string") detail = JSON.stringify(detail);
      return { ok: false, status: response.status, error: `Base44 API ${response.status}: ${detail}` };
    }
    const files = normalizeFiles(JSON.parse(text));
    if (!Object.keys(files).length) return { ok: false, error: "Base44 API answered but returned no files." };
    return { ok: true, files };
  }

  // ------------------------------------------------------------------ file tree

  const getNodeButton = (node) =>
    Array.from(node?.children || []).find((child) => child.tagName === "BUTTON") || null;

  // Folder buttons carry data-state (Radix) or aria-expanded; plain file buttons do not.
  function stateOf(button) {
    const state = button.getAttribute("data-state");
    if (state !== null) return state;
    if (button.hasAttribute("aria-expanded")) return button.getAttribute("aria-expanded") === "true" ? "open" : "closed";
    return null;
  }

  function getFolderContents(folderButton) {
    const children = Array.from(folderButton?.parentElement?.children || []);
    return children.filter((child) => child !== folderButton && child.tagName === "DIV").pop() || null;
  }

  function buttonLabels(button) {
    return [button.textContent, button.getAttribute("title"), button.getAttribute("aria-label")]
      .map(clean)
      .filter(Boolean);
  }

  function findNavigationRoot() {
    const heading = Array.from(document.querySelectorAll("body *")).find(
      (el) => el.children.length === 0 && /^(code )?files$/i.test(clean(el.textContent))
    );
    let ancestor = heading;
    for (let i = 0; i < 12 && ancestor; i++, ancestor = ancestor.parentElement) {
      const labels = Array.from(ancestor.querySelectorAll("button")).map((b) => clean(b.textContent).toLowerCase());
      if (labels.includes("src") || labels.includes("base44") || labels.includes("package.json")) return ancestor;
    }
    return document.querySelector('[role="navigation"]') || document.querySelector("nav") || document.body;
  }

  function findTreeContainer(navigation) {
    if (!navigation) return null;
    const candidates = [
      ...(navigation.matches?.("div") ? [navigation] : []),
      ...Array.from(navigation.querySelectorAll("div"))
    ];
    let best = null;
    let bestScore = 0;
    for (const container of candidates) {
      const nodes = Array.from(container.children);
      if (!nodes.length) continue;
      const buttons = nodes.map(getNodeButton).filter(Boolean);
      if (!buttons.length || buttons.length / nodes.length < 0.8) continue;
      const labels = buttons.map((b) => clean(b.textContent).toLowerCase());
      let score = buttons.length;
      if (labels.includes("src")) score += 100;
      if (labels.includes("base44")) score += 100;
      if (labels.includes("package.json")) score += 100;
      if (score > bestScore) {
        bestScore = score;
        best = container;
      }
    }
    return best;
  }

  function findTreeButton(container, name) {
    const wanted = clean(name);
    for (const node of Array.from(container.children)) {
      const button = getNodeButton(node);
      if (button && isVisible(button) && buttonLabels(button).includes(wanted)) return button;
    }
    return null;
  }

  async function waitForContents(folderButton, timeoutMs) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const contents = getFolderContents(folderButton);
      if (contents && contents.children.length) return contents;
      if (Date.now() > end) return null;
      await sleep(100);
    }
  }

  async function listPaths() {
    const root = findTreeContainer(findNavigationRoot());
    if (!root) {
      return { ok: false, paths: [], error: "Could not find the file tree. Open the project's Code view with the file tree visible." };
    }
    const paths = [];

    async function walk(container, parent, depth) {
      for (const node of Array.from(container.children)) {
        const button = getNodeButton(node);
        if (!button) continue;
        const name = clean(button.textContent);
        if (!name) continue;
        const here = [...parent, name].join("/");

        if (stateOf(button) === null) {
          paths.push(here);
          continue;
        }
        if (stateOf(button) !== "open") button.click();
        const contents = await waitForContents(button, 1500);
        // A "folder" that never shows children is really a file (e.g. wrapped in a tooltip).
        if (contents && depth < 15) await walk(contents, [...parent, name], depth + 1);
        else paths.push(here);
      }
    }

    await walk(root, [], 0);
    const unique = [...new Set(paths)];
    return unique.length
      ? { ok: true, paths: unique }
      : { ok: false, paths: [], error: "The file tree was found but no files were listed." };
  }

  async function openInTree(path) {
    const segments = path.split("/").filter(Boolean);
    if (!segments.length) throw new Error("Empty file path.");
    let container = findTreeContainer(findNavigationRoot());
    if (!container) throw new Error("File tree not found. Open the project's Code view first.");

    for (let i = 0; i < segments.length; i++) {
      const button = findTreeButton(container, segments[i]);
      if (!button) throw new Error(`"${segments[i]}" not found in the file tree.`);
      if (i === segments.length - 1) {
        button.click();
        return;
      }
      if (stateOf(button) !== "open") button.click();

      const next = segments[i + 1];
      const end = Date.now() + 3000;
      let found = null;
      while (!found && Date.now() < end) {
        const contents = getFolderContents(button);
        if (contents && findTreeButton(contents, next)) found = contents;
        else await sleep(100);
      }
      if (!found) throw new Error(`"${next}" did not appear inside "${segments[i]}".`);
      container = found;
    }
  }

  // --------------------------------------------------------------- editor access

  function getMonaco() {
    if (window.monaco?.editor) return window.monaco;
    try {
      const loaded = window.require?.("vs/editor/editor.main");
      if (loaded?.editor) return loaded;
    } catch {}
    return null;
  }

  function getMonacoEditor() {
    const monaco = getMonaco();
    const editors = (monaco?.editor?.getEditors?.() || []).filter(
      (editor) => editor.getModel?.() && isVisible(editor.getDomNode?.())
    );
    if (!editors.length) return null;
    const area = (editor) => {
      const rect = editor.getDomNode().getBoundingClientRect();
      return rect.width * rect.height;
    };
    return editors.find((e) => e.hasTextFocus?.()) || editors.sort((a, b) => area(b) - area(a))[0];
  }

  function findEditorRoot() {
    const roots = Array.from(document.querySelectorAll(".monaco-editor")).filter(isVisible);
    if (!roots.length) return null;
    return roots.find((r) => r.classList.contains("focused")) || roots[0];
  }

  function activeUri() {
    const editor = getMonacoEditor();
    if (editor) return editor.getModel().uri.toString();
    return findEditorRoot()?.dataset?.uri || "";
  }

  function stripScheme(uri) {
    let decoded = uri;
    try { decoded = decodeURIComponent(uri); } catch {}
    return ("/" + decoded.replace(/^[a-z][\w+.-]*:\/\//i, "")).replace(/\/+/g, "/");
  }

  const uriMatchesPath = (uri, path) => !!uri && stripScheme(uri).endsWith("/" + path);
  const uriLooksLikePath = (uri) => /\.[^/.]+$/.test(stripScheme(uri));

  // Fallback only: Monaco renders just the visible lines, so long files may be incomplete.
  function readDomText(root) {
    const lines = Array.from(root.querySelectorAll(".view-lines > .view-line"))
      .map((el) => ({ top: parseFloat(el.style.top) || 0, text: el.textContent.replace(/\u00a0/g, " ") }))
      .sort((a, b) => a.top - b.top);
    if (!lines.length) return { text: "", truncated: false };

    // Blank lines have no text, so rebuild them from the vertical gaps between lines.
    const gaps = lines.slice(1).map((l, i) => l.top - lines[i].top).filter((d) => d > 0);
    const lineHeight = gaps.length ? Math.min(...gaps) : 19;
    const out = [];
    let prevTop = null;
    for (const line of lines) {
      if (prevTop !== null) {
        for (let k = Math.round((line.top - prevTop) / lineHeight) - 1; k > 0; k--) out.push("");
      }
      out.push(line.text);
      prevTop = line.top;
    }

    const bar = root.querySelector(".scrollbar.vertical");
    const slider = bar?.querySelector(".slider");
    const truncated = !!(bar && slider && slider.offsetHeight > 0 && slider.offsetHeight < bar.offsetHeight - 2);
    return { text: out.join("\n"), truncated };
  }

  function readEditor() {
    const editor = getMonacoEditor();
    if (editor) return { via: "monaco", text: editor.getModel().getValue(), truncated: false };
    const root = findEditorRoot();
    if (!root) throw new Error("No code editor found on this page.");
    return { via: "dom", ...readDomText(root) };
  }

  async function readFile(rawPath) {
    const path = normPath(rawPath);
    const beforeUri = activeUri();
    const alreadyThere = uriMatchesPath(beforeUri, path);

    await openInTree(path);

    let confirmed = false;
    let lastUri = beforeUri;
    for (let i = 0; i < 80 && !confirmed; i++) {
      await sleep(100);
      lastUri = activeUri();
      if (!lastUri) continue;
      if (uriMatchesPath(lastUri, path)) {
        // If the previously open file also ends with this path (e.g. docs/README.md vs README.md)
        // give the click a moment to switch files before trusting it.
        if (alreadyThere && lastUri === beforeUri && i < 4) continue;
        confirmed = true;
      } else if (!uriLooksLikePath(lastUri) && lastUri !== beforeUri) {
        confirmed = true; // editor uses opaque URIs (inmemory://model/7): a change means the file switched
      }
    }

    let warning = "";
    if (!confirmed) {
      if (lastUri && !uriLooksLikePath(lastUri)) warning = "could not confirm the editor switched files";
      else throw new Error(`Editor did not switch to this file (active: ${lastUri || "none"}).`);
    }

    // The model can be filled asynchronously right after the switch: wait until it stops changing.
    let result = readEditor();
    for (let i = 0; i < 10; i++) {
      await sleep(result.via === "monaco" ? 120 : 250);
      const again = readEditor();
      if (again.text === result.text) break;
      result = again;
    }

    if (result.truncated) warning = (warning ? warning + "; " : "") + "only the visible part of the file could be read (Monaco API not exposed by the page)";
    return { ok: true, text: result.text, via: result.via, warning };
  }

  const safe = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  };

  window.__b44dl = {
    version: 3,
    fetchCode: safe(fetchCode),
    listPaths: safe(listPaths),
    readFile: safe(readFile)
  };
})();
