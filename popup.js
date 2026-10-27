const appIdInput = document.getElementById("appId");
const tabStatus = document.getElementById("tabStatus");
const logBox = document.getElementById("log");
const detectBtn = document.getElementById("detectBtn");
const downloadBtn = document.getElementById("downloadBtn");
const toggleAdvanced = document.getElementById("toggleAdvanced");
const advancedPanel = document.getElementById("advancedPanel");
const pathsInput = document.getElementById("paths");
const detectPathsBtn = document.getElementById("detectPathsBtn");
const downloadByPathsBtn = document.getElementById("downloadByPathsBtn");

const BUSY_BUTTONS = [detectBtn, downloadBtn, detectPathsBtn, downloadByPathsBtn];
let activeTab = null;

init();

async function init() {
  activeTab = await getActiveTab();
  const appId = extractAppId(activeTab?.url || "");
  tabStatus.textContent = appId ? "Base44" : "No Base44";
  if (appId) appIdInput.value = appId;
  log(appId ? "Project detected from the current tab." : "Open a Base44 editor tab, or paste a Project ID.");
}

detectBtn.addEventListener("click", async () => {
  activeTab = await getActiveTab();
  const appId = extractAppId(activeTab?.url || "");
  if (!appId) return log("No project ID found in the active tab. Open https://app.base44.com/apps/<id>/...");
  appIdInput.value = appId;
  tabStatus.textContent = "Base44";
  log(`Project ID: ${appId}`);
});

toggleAdvanced.addEventListener("click", () => {
  advancedPanel.hidden = !advancedPanel.hidden;
});

detectPathsBtn.addEventListener("click", () =>
  withBusy(async () => {
    log("Reading the file tree (folders will expand)...");
    const result = await callPage("listPaths");
    if (!result.ok) throw new Error(result.error);
    pathsInput.value = result.paths.join("\n");
    log(`Found ${result.paths.length} files. Edit the list if you like, then download.`);
  })
);

downloadBtn.addEventListener("click", () =>
  withBusy(async () => {
    const appId = requireAppId();

    log("Trying the Base44 code API...");
    const api = await callPage("fetchCode", appId);
    if (api.ok) {
      await saveZip(api.files, `base44-${appId}.zip`);
      log(`Done: ${Object.keys(api.files).length} files saved as ZIP.`);
      return;
    }

    log(`${api.error}\n\nFalling back to reading files through the editor...`);
    let paths = [];
    const listed = await callPage("listPaths");
    if (listed.ok) {
      paths = listed.paths;
      pathsInput.value = paths.join("\n");
    } else {
      paths = parsePaths(pathsInput.value);
      if (!paths.length) throw new Error(`${listed.error}\n\nOr paste file paths into Emergency mode and use "Download by paths".`);
    }
    await downloadViaEditor(appId, paths);
  })
);

downloadByPathsBtn.addEventListener("click", () =>
  withBusy(async () => {
    const appId = requireAppId();
    const paths = parsePaths(pathsInput.value);
    if (!paths.length) throw new Error("The path list is empty. Use \"Detect paths\" or paste paths, one per line.");
    await downloadViaEditor(appId, paths);
  })
);

async function downloadViaEditor(appId, paths) {
  const files = {};
  const failures = [];
  const warnings = [];

  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    log(`Reading ${i + 1}/${paths.length}: ${path}\n(keep this popup open)`);
    const result = await callPage("readFile", path);
    if (result.ok) {
      files[path] = result.text;
      if (result.warning) warnings.push({ path, warning: result.warning });
    } else {
      failures.push({ path, error: result.error || "Unknown error" });
    }
  }

  if (!Object.keys(files).length) {
    throw new Error(`Could not read any file through the editor.\n\n${formatFailures(failures)}`);
  }

  if (failures.length || warnings.length) {
    const report = [
      failures.length ? `FAILED (${failures.length}):\n${formatFailures(failures)}` : "",
      warnings.length ? `WARNINGS (${warnings.length}):\n${warnings.map((w) => `- ${w.path}: ${w.warning}`).join("\n")}` : ""
    ].filter(Boolean).join("\n\n");
    files["_DOWNLOAD_REPORT.txt"] = report + "\n";
  }

  await saveZip(files, `base44-${appId}-editor.zip`);
  const notes = [];
  if (failures.length) notes.push(`${failures.length} failed`);
  if (warnings.length) notes.push(`${warnings.length} with warnings`);
  log(`Done: ${paths.length - failures.length} files saved as ZIP${notes.length ? ` (${notes.join(", ")} - see _DOWNLOAD_REPORT.txt in the ZIP)` : ""}.`);
}

const formatFailures = (failures) => failures.map((f) => `- ${f.path}: ${f.error}`).join("\n");

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function extractAppId(url) {
  const match = String(url).match(/app\.base44\.com\/apps\/([^/?#]+)/);
  return match?.[1] || "";
}

function requireAppId() {
  const appId = appIdInput.value.trim();
  if (!/^[a-zA-Z0-9_-]{8,}$/.test(appId)) throw new Error("Enter a valid Project ID.");
  return appId;
}

function parsePaths(text) {
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

function log(message) {
  logBox.textContent = message;
}

async function withBusy(task) {
  try {
    BUSY_BUTTONS.forEach((btn) => (btn.disabled = true));
    await task();
  } catch (error) {
    log(error?.message || String(error));
  } finally {
    BUSY_BUTTONS.forEach((btn) => (btn.disabled = false));
  }
}

// Injects page.js into the Base44 tab, then calls one of its methods and returns the result.
async function callPage(method, ...args) {
  activeTab = await getActiveTab();
  if (!activeTab?.id) throw new Error("Cannot read the active tab.");
  if (!/^https:\/\/app\.base44\.com\//.test(activeTab.url || "")) {
    throw new Error("The active tab is not on app.base44.com. Switch to your Base44 editor tab and reopen this popup.");
  }
  const target = { tabId: activeTab.id };
  await chrome.scripting.executeScript({ target, world: "MAIN", files: ["page.js"] });
  const [injection] = await chrome.scripting.executeScript({
    target,
    world: "MAIN",
    func: (name, callArgs) => window.__b44dl[name](...callArgs),
    args: [method, args]
  });
  if (!injection || injection.result === undefined) {
    throw new Error("The page did not answer. Reload the Base44 tab and try again.");
  }
  return injection.result;
}

async function saveZip(files, filename) {
  const bytes = createZip(files);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  try {
    // saveAs must stay false: the Save-As dialog steals focus, which closes the popup
    // and destroys the blob URL before the download can read it.
    await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
