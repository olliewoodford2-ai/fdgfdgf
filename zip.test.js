// Run: node --test test/
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createZip, sanitizeZipPath } = require("../zip.js");

test("sanitizeZipPath blocks traversal and normalises slashes", () => {
  assert.strictEqual(sanitizeZipPath("/../a\\b/./c.js"), "a/b/c.js");
});

test("ZIP is readable by an independent reader (python zipfile)", (t) => {
  const py = spawnSync("python3", ["--version"]);
  if (py.status !== 0) return t.skip("python3 not available");

  const files = {
    "src/App.jsx": "export default function App() {\n\n  return <div>zażółć gęślą jaźń</div>;\n}\n",
    "src/api/base44Client.js": "// nested dir\n",
    "package.json": '{"name":"x"}',
    "empty.txt": "",
    "docs/zażółć.md": "unicode file name",
    "../evil.txt": "must land at evil.txt"
  };
  const zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "b44-")), "out.zip");
  fs.writeFileSync(zipPath, createZip(files));

  const script = `
import zipfile, json, sys
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None, "CRC mismatch"
print(json.dumps({n: z.read(n).decode("utf-8") for n in z.namelist()}))
`;
  const run = spawnSync("python3", ["-c", script, zipPath], { encoding: "utf8" });
  assert.strictEqual(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.strictEqual(out["src/App.jsx"], files["src/App.jsx"]);
  assert.strictEqual(out["docs/zażółć.md"], "unicode file name");
  assert.strictEqual(out["evil.txt"], "must land at evil.txt");
  assert.strictEqual(out["empty.txt"], "");
  assert.strictEqual(Object.keys(out).length, 6);
});
