import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { h, nextTick, ref } from "vue";
import { createGitViewer } from "../src/composables/useGitViewer.js";
import {
  createGitDiffs,
  AUTO_DIFF_LINES,
  AUTO_DIFF_BYTES,
} from "../src/composables/useGitDiffs.js";
import {
  compileComponent,
  FakeElement,
  installDomGlobals,
  testRenderer,
} from "./support/vueTestRenderer.js";

const file = (path, additions = 1, scope = "commit") => ({
  path,
  scope,
  additions,
  deletions: 0,
  status: "added",
});
const waitFor = async (predicate) => {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Accordion timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const patch = (text) => ({
  ok: true,
  patch: text,
  binary: false,
  oversized: false,
});

test("small visible diffs load without clicks; large, binary, oversized and offscreen files remain deferred", async () => {
  const calls = [],
    collection = createGitDiffs({
      load: async (file, context) => {
        calls.push([file.path, context]);
        return patch(file.path);
      },
    });
  const files = [
    file("small.js"),
    file("large.rs", AUTO_DIFF_LINES),
    { ...file("binary.bin"), binary: true },
    { ...file("huge.txt"), oversized: true },
    file("offscreen.js"),
  ];
  collection.sync(files, "first");
  assert.equal(calls.length, 0);
  for (const item of files.slice(0, 4))
    collection.setNear(collection.fileKey(item), true);
  await waitFor(() => collection.records.get("commit\0small.js").result);
  assert.deepEqual(calls, [["small.js", "first"]]);
  collection.load("commit\0large.rs");
  await waitFor(() => collection.records.get("commit\0large.rs").result);
  assert.equal(calls[1][0], "large.rs");
  collection.toggle("commit\0small.js");
  collection.sync(files, "first", { refresh: true });
  await waitFor(() => !collection.records.get("commit\0large.rs").loading);
  assert.equal(collection.records.get("commit\0small.js").expanded, false);
  collection.dispose();
});

test("actual oversized text requires Load diff before rendering even when line stats were small", async () => {
  let calls = 0;
  const collection = createGitDiffs({
    load: async () => {
      calls++;
      return patch("x".repeat(AUTO_DIFF_BYTES + 1));
    },
  });
  collection.sync([file("long-line.txt")], "first");
  collection.setNear("commit\0long-line.txt", true);
  const record = collection.records.get("commit\0long-line.txt");
  await waitFor(() => record.deferred && !record.loading);
  assert.equal(record.result, null);
  assert.equal(calls, 1);
  collection.load(record.key);
  await waitFor(() => record.result);
  assert.equal(calls, 2);
  collection.dispose();
});

test("diff queue limits concurrency, rejects obsolete commit/worktree results and retains separate staging sections", async () => {
  const pending = [],
    calls = [];
  const collection = createGitDiffs({
    load: (file, context) =>
      new Promise((resolve) => {
        pending.push(resolve);
        calls.push([file.path, context]);
      }),
  });
  collection.sync([file("a"), file("b"), file("c")], "old");
  for (const item of collection.records.values())
    collection.setNear(item.key, true);
  await waitFor(() => calls.length === 2);
  assert.equal(pending.length, 2);
  collection.sync(
    [file("a", 1, "staged"), file("a", 1, "unstaged")],
    "working",
  );
  for (const item of collection.records.values())
    collection.setNear(item.key, true);
  pending.shift()(patch("obsolete"));
  pending.shift()(patch("obsolete"));
  await waitFor(() => calls.length === 4);
  assert.equal(collection.records.size, 2);
  const staged = collection.records.get("staged\0a"),
    unstaged = collection.records.get("unstaged\0a");
  assert.equal(staged.result, null);
  collection.sync(
    [file("a", 1, "staged"), file("a", 1, "unstaged")],
    "working",
    { refresh: true },
  );
  pending.shift()(patch("stale staged"));
  pending.shift()(patch("stale worktree"));
  await waitFor(() => calls.length === 6);
  assert.equal(staged.result, null);
  assert.equal(unstaged.result, null);
  pending.shift()(patch("latest staged"));
  pending.shift()(patch("latest worktree"));
  await waitFor(() => staged.result && unstaged.result);
  assert.equal(staged.result.patch, "latest staged");
  assert.equal(unstaged.result.patch, "latest worktree");
  collection.dispose();
});

test("offscreen patch cache is bounded and reloads automatically on returning to a file", async () => {
  let calls = 0;
  const collection = createGitDiffs({
    load: async (file) => {
      calls++;
      return patch(file.path);
    },
  });
  collection.sync(
    Array.from({ length: 40 }, (_, i) => file("file-" + i)),
    "first",
  );
  for (const record of collection.records.values()) {
    collection.setNear(record.key, true);
    await waitFor(() => record.result);
    collection.setNear(record.key, false);
  }
  assert.equal(
    [...collection.records.values()].filter((record) => record.result).length,
    32,
  );
  const first = collection.records.get("commit\0file-0");
  assert.equal(first.result, null);
  collection.setNear(first.key, true);
  await waitFor(() => first.result);
  assert.equal(calls, 41);
  collection.dispose();
});

test("a filesystem refresh rejects in-flight patches before its status query finishes", async () => {
  const pending = [];
  const collection = createGitDiffs({
    load: () => new Promise((resolve) => pending.push(resolve)),
  });
  collection.sync([file("a")], "working");
  collection.setNear("commit\0a", true);
  await waitFor(() => pending.length === 1);
  collection.invalidate();
  pending.shift()(patch("obsolete"));
  await waitFor(() => !collection.records.get("commit\0a").loading);
  assert.equal(collection.records.get("commit\0a").result, null);
  assert.equal(pending.length, 0);
  collection.sync([file("a")], "working", { refresh: true });
  await waitFor(() => pending.length === 1);
  pending.shift()(patch("latest"));
  await waitFor(() => collection.records.get("commit\0a").result);
  assert.equal(collection.records.get("commit\0a").result.patch, "latest");
  collection.dispose();
});

test("explicit large patches also obey the offscreen byte budget", async () => {
  const collection = createGitDiffs({
    load: async () => patch("x".repeat(512 * 1024)),
  });
  collection.sync(
    Array.from({ length: 20 }, (_, i) => file("large-" + i, AUTO_DIFF_LINES)),
    "first",
  );
  for (const record of collection.records.values()) {
    collection.load(record.key);
    collection.setNear(record.key, true);
    await waitFor(() => record.result);
    collection.setNear(record.key, false);
  }
  assert.ok(
    [...collection.records.values()].reduce(
      (bytes, record) => bytes + record.bytes,
      0,
    ) <=
      8 * 1024 * 1024,
  );
  collection.dispose();
});

test("actual accordion component renders multiple files, Load diff, collapse, viewport release and theme/mode changes", async () => {
  installDomGlobals();
  const observers = new Map();
  globalThis.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe(element) {
      observers.set(element.dataset.gitAnchor, this);
    }
    disconnect() {}
  };
  const component = await compileComponent("src/components/GitFileDiff.vue", {
    "@git-diff-view/vue": new URL(
      "./support/gitDiffViewStub.js",
      import.meta.url,
    ).href,
  });
  // Keep the real SFC template and replace only the third-party renderer/CSS
  // in Node, where CSS modules are not supported by the test loader.
  const code = (await fs.readFile(new URL(component), "utf8"))
    .replace(
      "from '@git-diff-view/vue'",
      "from '" +
        new URL("./support/gitDiffViewStub.js", import.meta.url).href +
        "'",
    )
    .replace("import '@git-diff-view/vue/styles/diff-view-pure.css'", "");
  await fs.writeFile(new URL(component), code);
  const { default: GitFileDiff } = await import(component);
  const calls = [],
    collection = createGitDiffs({
      load: async (file) => {
        calls.push(file.path);
        return patch(
          "--- /dev/null\n+++ b/" + file.path + "\n@@ -0,0 +1 @@\n+example\n",
        );
      },
    });
  collection.sync(
    [file("one.js"), file("two.js"), file("large.rs", AUTO_DIFF_LINES)],
    "first",
  );
  const host = new FakeElement("div"),
    theme = ref("dark"),
    mode = ref("split");
  const app = testRenderer.createApp({
    render: () =>
      h(
        "div",
        [...collection.records.values()].map((record) =>
          h(GitFileDiff, {
            key: record.key,
            record,
            collection,
            theme: theme.value,
            mode: mode.value,
          }),
        ),
      ),
  });
  app.mount(host);
  await nextTick();
  assert.equal(host.querySelectorAll(".git-file-diff").length, 3);
  assert.equal(host.querySelectorAll("[data-diff-render]").length, 0);
  for (const observer of observers.values())
    observer.callback([{ isIntersecting: true }]);
  await waitFor(() => host.querySelectorAll("[data-diff-render]").length === 2);
  assert.deepEqual(calls, ["one.js", "two.js"]);
  const loadButton = host
    .querySelectorAll("button")
    .find(
      (button) =>
        button.getAttribute("aria-label") === "Load diff for large.rs",
    );
  assert.ok(loadButton);
  loadButton.dispatchEvent({ type: "click" });
  await waitFor(() => host.querySelectorAll("[data-diff-render]").length === 3);
  theme.value = "light";
  mode.value = "unified";
  await nextTick();
  for (const diff of host.querySelectorAll("[data-diff-render]")) {
    assert.equal(diff.dataset.diffTheme, "light");
    assert.equal(diff.dataset.diffMode, "2");
  }
  collection.toggle("commit\0one.js");
  await nextTick();
  assert.equal(host.querySelectorAll("[data-diff-render]").length, 2);
  observers.get("commit\0two.js").callback([{ isIntersecting: false }]);
  await nextTick();
  assert.equal(host.querySelectorAll("[data-diff-render]").length, 1);
  app.unmount();
  collection.dispose();
  delete globalThis.IntersectionObserver;
});

test("selecting a commit mounts its entire accordion beside history and keeps working changes full width", async () => {
  installDomGlobals();
  Object.defineProperty(FakeElement.prototype, "options", {
    configurable: true,
    get() {
      return this.children.filter((child) => child.tagName === "OPTION");
    },
  });
  const fileComponent = await compileComponent(
    "src/components/GitFileDiff.vue",
  );
  const code = (await fs.readFile(new URL(fileComponent), "utf8"))
    .replace(
      "from '@git-diff-view/vue'",
      "from '" +
        new URL("./support/gitDiffViewStub.js", import.meta.url).href +
        "'",
    )
    .replace("import '@git-diff-view/vue/styles/diff-view-pure.css'", "");
  await fs.writeFile(new URL(fileComponent), code);
  const component = await compileComponent("src/components/GitViewer.vue", {
    "./GitFileDiff.vue": fileComponent,
  });
  const { default: GitViewer } = await import(component);
  const commits = ["first", "second"].map((sha) => ({
    sha,
    subject: sha,
    author: "Author",
    timestamp: 1,
    parents: [],
  }));
  const api = {
    status: async () => ({
      ok: true,
      branch: "main",
      head: "second",
      files: [file("working.js", 1, "unstaged")],
    }),
    log: async () => ({ ok: true, commits, hasMore: false }),
    commit: async (_path, sha) => ({
      ok: true,
      commit: commits.find((commit) => commit.sha === sha),
      files:
        sha === "first"
          ? [file("one.js"), file("two.js"), file("large.rs", AUTO_DIFF_LINES)]
          : [file("second.js")],
    }),
    diff: async (_path, selection) => patch(selection.file),
  };
  const viewer = createGitViewer(
    { id: "/repo", path: "/repo", name: "repo" },
    { api, registry: { subscribe: () => () => {} } },
  );
  const host = new FakeElement("div"),
    app = testRenderer.createApp({ render: () => h(GitViewer, { viewer }) });
  app.mount(host);
  await waitFor(() => !viewer.state.loading);
  await nextTick();
  assert.equal(host.querySelectorAll(".git-file-diff").length, 1);
  assert.equal(host.querySelectorAll(".git-sidebar").length, 0);
  await viewer.selectCommit("first");
  await nextTick();
  assert.equal(host.querySelectorAll(".git-file-diff").length, 3);
  assert.equal(host.querySelectorAll(".git-commit").length, 2);
  assert.equal(host.querySelectorAll(".git-sidebar").length, 1);
  assert.equal(host.querySelectorAll(".git-file-list").length, 0);
  const record = viewer.diffs.records.get("commit\0one.js");
  viewer.diffs.toggle(record.key);
  await viewer.selectCommit("first");
  assert.equal(record.expanded, false);
  await viewer.selectCommit("second");
  await nextTick();
  assert.equal(host.querySelectorAll(".git-file-diff").length, 1);
  assert.equal(viewer.diffs.records.has("commit\0second.js"), true);
  app.unmount();
  viewer.dispose();
  delete FakeElement.prototype.options;
});
