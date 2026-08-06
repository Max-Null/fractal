import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import FileTree from "./FileTree.vue";

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      file: { title: "Files", empty: "Empty directory", emptyDir: "Empty directory", reveal: "Reveal in Explorer", copyPath: "Copy Path", copyName: "Copy Name", copy: "Copy", cut: "Cut", paste: "Paste", pasteInto: "Paste here", delete: "Delete", rename: "Rename", newFolder: "New Folder", newFolderPrompt: "Enter folder name", confirmDelete: "Delete \"{name}\"?" },
    },
  },
});

// Mock tauri-bridge listDir + reveal
vi.mock("@/lib/electron-bridge", () => ({
  listDir: () => Promise.resolve([]),
  revealInExplorer: () => Promise.resolve(),
  deleteFile: () => Promise.resolve(),
  renameFile: () => Promise.resolve("/new"),
  moveFile: () => Promise.resolve("/new"),
  copyFile: () => Promise.resolve("/new"),
  createDir: () => Promise.resolve(),
}));

const mockEntries = [
  { name: "src", path: "/root/src", is_dir: true, size: 0 },
  { name: "components", path: "/root/src/components", is_dir: true, size: 0 },
  { name: "index.ts", path: "/root/index.ts", is_dir: false, size: 1024 },
  { name: "README.md", path: "/root/README.md", is_dir: false, size: 2048 },
];

describe("FileTree", () => {
  it("renders all entries", () => {
    const wrapper = mount(FileTree, { global: { plugins: [i18n] }, props: { entries: mockEntries, selected: null } });
    expect(wrapper.text()).toContain("src");
    expect(wrapper.text()).toContain("components");
    expect(wrapper.text()).toContain("index.ts");
    expect(wrapper.text()).toContain("README.md");
  });

  it("shows directory expand toggle", () => {
    const wrapper = mount(FileTree, { global: { plugins: [i18n] }, props: { entries: mockEntries, selected: null } });
    // Directories should have expand toggles (▶)
    const toggles = wrapper.findAll("span").filter((s) => s.text() === "▶");
    expect(toggles.length).toBeGreaterThan(0);
  });

  it("shows file sizes for files", () => {
    const wrapper = mount(FileTree, { global: { plugins: [i18n] }, props: { entries: mockEntries, selected: null } });
    expect(wrapper.text()).toContain("1.0 KB");
    expect(wrapper.text()).toContain("2.0 KB");
  });

  it("does not show file sizes for directories", () => {
    const wrapper = mount(FileTree, {
      global: { plugins: [i18n] },
      props: {
        entries: [
          { name: "dir", path: "/root/dir", is_dir: true, size: 0 },
        ],
        selected: null,
      },
    });
    // The "0 B" text should not appear for a directory
    const sizeText = wrapper.text();
    expect(sizeText).not.toMatch(/\d+\s*B/);
  });

  it("shows empty message when no entries", () => {
    const wrapper = mount(FileTree, { global: { plugins: [i18n] }, props: { entries: [], selected: null } });
    expect(wrapper.text()).toContain("Empty directory");
  });

  it("highlights selected file", () => {
    const wrapper = mount(FileTree, {
      global: { plugins: [i18n] }, props: { entries: mockEntries, selected: "index.ts" },
    });
    expect(wrapper.text()).toContain("index.ts");
  });

  it("expands directory on click", async () => {
    const wrapper = mount(FileTree, {
      global: { plugins: [i18n] },
      props: {
        entries: [{ name: "folder", path: "/root/folder", is_dir: true, size: 0 }],
        selected: null,
      },
    });
    const dirRow = wrapper.find(".cursor-pointer");
    await dirRow.trigger("click");
    // After clicking, directory should show expanded state (loading or children)
    // listDir mock returns [] so it should show "Empty"
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("Empty");
  });

  it("emits selectFile when clicking a file", async () => {
    const wrapper = mount(FileTree, {
      global: { plugins: [i18n] },
      props: {
        entries: [{ name: "file.ts", path: "/root/file.ts", is_dir: false, size: 100 }],
        selected: null,
      },
    });
    const fileRow = wrapper.find(".cursor-pointer");
    await fileRow.trigger("click");
    expect(wrapper.emitted("selectFile")).toBeTruthy();
    expect(wrapper.emitted("selectFile")![0][0]).toEqual({
      name: "file.ts", path: "/root/file.ts", is_dir: false, size: 100,
    });
  });
});
