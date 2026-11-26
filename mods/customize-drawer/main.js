import { View, div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { appHome, hc, home, layout, run, setShared, shared, terminals, theme } from "herdr";

const TARGETS = [
  {
    id: "herdr",
    label: "Herdr",
    folder: () => appHome(),
    icon: () => image("frame/welcome/herdr.png").size(14).rounded(3),
  },
  {
    id: "omp",
    label: "OMP",
    folder: () => `${home().replace(/[\\/]+$/, "")}/.omp`,
    icon: (t, active) => svg("icons/omp.svg").size(13).text_color(active ? t.foreground : t.muted),
  },
];

const spawning = new Set();

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

function findCustomizeTerminal(target) {
  return (
    terminals().find(
      (t) =>
        t.state === "live" &&
        !String(t.address ?? "").includes("/") &&
        t.labels?.["customize.target"] === target.id
    ) ?? null
  );
}

function mountDrawerTerminal(target, folder, addr) {
  setShared("customize.drawer", { target: target.id, folder, terminal: addr });
  run("layout.set", { layout: cloneWithTerminal(layout(), addr) });
  run("layout.show", { id: "customize-drawer" });
  run("pane.focus", { terminal: addr });
}

function switchDrawerTarget(target, cx) {
  const folder = target.folder();
  const existing = findCustomizeTerminal(target);
  if (existing?.address) {
    mountDrawerTerminal(target, folder, existing.address);
    return;
  }

  if (spawning.has(target.id)) {
    run("layout.show", { id: "customize-drawer" });
    return;
  }

  spawning.add(target.id);
  setShared("customize.drawer", { target: target.id, folder, terminal: "" });
  run("layout.show", { id: "customize-drawer" });

  cx.spawn(async (cx) => {
    try {
      const res = await hc([
        "run",
        "--bg",
        "--keep",
        "--no-parent",
        "--json",
        "--cwd",
        folder,
        "--label",
        `customize.target=${target.id}`,
        "--",
        "omp",
      ]);
      let addr = null;
      if (res.code === 0) {
        try {
          addr = JSON.parse(res.stdout)?.address ?? null;
        } catch {}
      }
      if (!addr) {
        for (let i = 0; i < 30; i++) {
          await cx.sleep(100);
          const found = findCustomizeTerminal(target);
          if (found?.address) {
            addr = found.address;
            break;
          }
        }
      }
      if (addr) {
        mountDrawerTerminal(target, folder, addr);
        cx.notify();
      }
    } finally {
      spawning.delete(target.id);
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
