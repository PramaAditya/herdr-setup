import { View, div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { appHome, home, layout, panes, run, setShared, shared, spaces, terminals, theme } from "herdr";

const CUSTOMIZE_SPACE = "__customize__";
const TARGETS = [
  {
    id: "herdr",
    label: "Herdr",
    tabName: "Customize Herdr",
    folder: () => appHome(),
    icon: () => image("frame/welcome/herdr.png").size(14).rounded(3),
  },
  {
    id: "omp",
    label: "OMP",
    tabName: "Customize OMP",
    folder: () => `${home().replace(/[\\/]+$/, "")}/.omp`,
    icon: (t, active) => svg("icons/omp.svg").size(13).text_color(active ? t.foreground : t.muted),
  },
];

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function cloneWithTerminal(node, termAddr) {
  if (!node || typeof node !== "object") return node;
  if (node.id === "customize-drawer-body") {
    const others = (node.children ?? []).filter((c) => c?.id !== "customize-drawer-term");
    const termBlock = {
      id: "customize-drawer-term",
      type: "block",
      content: { terminal: termAddr },
      size: { weight: 1 },
    };
    return { ...node, children: [termBlock, ...others] };
  }
  if (Array.isArray(node.children)) {
    return { ...node, children: node.children.map((c) => cloneWithTerminal(c, termAddr)) };
  }
  return node;
}

function normPath(p) {
  return String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function findCustomizeSession(target) {
  const targetDir = normPath(target.folder());
  const allPanes = panes();
  const termByAddr = new Map(terminals().map((t) => [t.address, t]));

  for (const space of spaces()) {
    if (space.machine) continue;
    for (const tab of space.tabs) {
      if (tab.named && tab.name === target.tabName) {
        const pane = allPanes.find((p) => p.tab === tab.id && p.terminal);
        if (pane?.terminal) return { space, tab, pane };
      }
      for (const pane of allPanes.filter((p) => p.tab === tab.id && p.terminal)) {
        const term = termByAddr.get(pane.terminal);
        const argv0 = String(term?.argv?.[0] ?? "").toLowerCase();
        const isOmp =
          argv0 === "omp" ||
          argv0.endsWith("/omp") ||
          argv0.endsWith("\\omp") ||
          argv0.endsWith("omp.exe") ||
          String(pane.program?.key ?? "").toLowerCase() === "omp" ||
          String(pane.title ?? "").toLowerCase().includes("omp");
        if (normPath(pane.cwd) === targetDir && isOmp) {
          return { space, tab, pane };
        }
      }
    }
  }
  return null;
}

function switchDrawerTarget(target, cx) {
  const folder = target.folder();
  const existing = findCustomizeSession(target);
  if (existing?.pane?.terminal) {
    const addr = existing.pane.terminal;
    setShared("customize.drawer", { target: target.id, folder, terminal: addr });
    const nextLayout = cloneWithTerminal(layout(), addr);
    run("layout.set", { layout: nextLayout });
    run("layout.show", { id: "customize-drawer" });
    run("pane.focus", { terminal: addr });
    return;
  }

  const customizeSpace = spaces().find((s) => !s.machine && s.name === CUSTOMIZE_SPACE);
  if (customizeSpace) {
    run("tab.new", { name: target.tabName, space: customizeSpace.id, folder, argv: ["omp"], focus: false });
  } else {
    run("space.new", { name: CUSTOMIZE_SPACE, tab: target.tabName, folder, argv: ["omp"], machine: "", focus: false });
  }
  setShared("customize.drawer", { target: target.id, folder, terminal: "" });
  run("layout.show", { id: "customize-drawer" });

  cx.spawn(async (cx) => {
    for (let i = 0; i < 30; i++) {
      await cx.sleep(100);
      const found = findCustomizeSession(target);
      if (found?.pane?.terminal) {
        const addr = found.pane.terminal;
        setShared("customize.drawer", { target: target.id, folder, terminal: addr });
        const nextLayout = cloneWithTerminal(layout(), addr);
        run("layout.set", { layout: nextLayout });
        run("layout.show", { id: "customize-drawer" });
        run("pane.focus", { terminal: addr });
        cx.notify();
        return;
      }
    }
  });
}

export default class CustomizeDrawer extends View {
  render(cx) {
    const t = theme();
    const state = shared("customize.drawer") ?? {};
    const activeId = state.target ?? "herdr";
    const root = layout();
    const filesNode = findNode(root, "customize-drawer-files");
    const filesOpen = Boolean(filesNode && !filesNode.hidden);

    return h_flex()
      .size_full()
      .px(10)
      .gap(6)
      .items_center()
      .bg(t.surface)
      .border_b(1)
      .border_color(t.border)
      .rounded_t(10)
      .text_size(12.5)
      .children(
        TARGETS.map((target) => {
          const active = target.id === activeId;
          return h_flex()
            .id(`drawer-tab-${target.id}`)
            .h(24)
            .px(8)
            .gap(6)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .bg(active ? t.selected : t.surface)
            .text_color(active ? t.foreground : t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => switchDrawerTarget(target, cx))
            .child(target.icon(t, active))
            .child(target.label);
        })
      )
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(state.folder ?? ""))
      .child(
        h_flex()
          .id("drawer-files-toggle")
          .h(24)
          .px(8)
          .gap(5)
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .text_size(12)
          .bg(filesOpen ? t.selected : t.surface)
          .text_color(filesOpen ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run(filesOpen ? "layout.hide" : "layout.show", { id: "customize-drawer-files" }))
          .child(svg("mods/files/file.svg").size(13))
          .child("Files")
      )
      .child(
        div()
          .id("drawer-close")
          .size(24)
          .flex()
          .items_center()
          .justify_center()
          .rounded(6)
          .cursor_pointer()
          .text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("layout.hide", { id: "customize-drawer" }))
          .child(svg("mods/pane/close.svg").size(12))
      );
  }
}
