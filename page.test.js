// Runs the real page.js against a tiny fake Base44-style file tree + fake Monaco.
// Run: node --test test/page.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

class El {
  constructor(tag, { text = "", attrs = {} } = {}) {
    this.tagName = tag.toUpperCase();
    this._text = text;
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.onclick = null;
  }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text; }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  hasAttribute(n) { return n in this.attrs; }
  matches(sel) { return sel.toUpperCase() === this.tagName; }
  click() { this.onclick && this.onclick(); }
  getBoundingClientRect() { return { width: 10, height: 10 }; }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelectorAll(sel) {
    const all = this.descendants();
    if (sel === "body *") return all;
    return all.filter((e) => e.tagName === sel.toUpperCase());
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function setup({ opaqueUris }) {
  const tree = {
    base44: { "config.jsonc": "{ }\n" },
    src: {
      components: { "Chat.jsx": "line1\n\nline3\n" },
      api: { "base44Client.js": "export const c = 1;\n" },
      "App.jsx": Array.from({ length: 500 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n",
    },
    docs: { "README.md": "nested readme\n" },
    "package.json": '{"name":"app"}\n',
    "README.md": "root readme\n",
  };

  const body = new El("body");
  const aside = body.append(new El("div"));
  aside.append(new El("h3", { text: "Code files" }));
  const root = aside.append(new El("div"));

  const current = { path: null, value: "", id: 0, uri: "" };
  let modelCounter = 0;
  const openFile = (p, content) => {
    // The editor switches asynchronously and fills the model a bit later, like the real app.
    setTimeout(() => {
      current.id = ++modelCounter;
      current.uri = opaqueUris ? `inmemory://model/${current.id}` : `file:///${p}`;
      current.value = "";
      setTimeout(() => { current.value = content; }, 60);
    }, 40);
  };

  function build(container, obj, prefix) {
    for (const [name, val] of Object.entries(obj)) {
      const node = container.append(new El("div"));
      const full = prefix ? `${prefix}/${name}` : name;
      if (typeof val === "string") {
        const b = node.append(new El("button", { text: name }));
        b.onclick = () => openFile(full, val);
      } else {
        const b = node.append(new El("button", { text: name, attrs: { "data-state": "closed" } }));
        let content = null;
        b.onclick = () => {
          if (b.attrs["data-state"] === "closed") {
            b.attrs["data-state"] = "open";
            content = node.append(new El("div"));
            build(content, val, full);
          } else {
            b.attrs["data-state"] = "closed";
            node.children = node.children.filter((c) => c !== content);
          }
        };
      }
    }
  }
  build(root, tree, "");

  const editorDom = new El("div");
  const monaco = {
    editor: {
      getEditors: () => [{
        getModel: () => current.uri ? { uri: { toString: () => current.uri }, getValue: () => current.value } : null,
        getDomNode: () => editorDom,
        hasTextFocus: () => true,
      }],
    },
  };

  globalThis.window = globalThis;
  globalThis.document = {
    querySelectorAll: (s) => body.querySelectorAll(s),
    querySelector: () => null,
    body,
  };
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  globalThis.monaco = monaco;
  delete globalThis.__b44dl;
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(__dirname, "..", "page.js"), "utf8"));
  return { api: globalThis.__b44dl, tree };
}

const flatten = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) => typeof v === "string" ? [[prefix + k, v]] : flatten(v, `${prefix}${k}/`));

for (const opaqueUris of [false, true]) {
  test(`listPaths finds every nested file, readFile returns exact full contents (opaque URIs: ${opaqueUris})`, async () => {
    const { api, tree } = setup({ opaqueUris });
    const listed = await api.listPaths();
    assert.ok(listed.ok, listed.error);

    const expected = flatten(tree).map(([p]) => p).sort();
    assert.deepStrictEqual([...listed.paths].sort(), expected);

    for (const [p, content] of flatten(tree)) {
      const r = await api.readFile(p);
      assert.ok(r.ok, `${p}: ${r.error}`);
      assert.strictEqual(r.text, content, `content mismatch for ${p}`);
      assert.strictEqual(r.warning, "", `${p}: unexpected warning ${r.warning}`);
    }
  });
}

test("a path that does not exist fails cleanly instead of throwing", async () => {
  const { api } = setup({ opaqueUris: false });
  const r = await api.readFile("src/nope.js");
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not found|did not appear/);
});
