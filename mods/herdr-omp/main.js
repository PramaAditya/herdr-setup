import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, home, layout, openOverlay, panes, run, setShared, shared, spaces, terminals, theme } from "herdr";

const CUSTOMIZE_SPACE = "__customize__";
const TARGETS = [
  {
    id: "herdr",
    tabName: "Customize Herdr",
    tooltip: "Customize Herdr",
    folder: () => appHome(),
    icon: () => image("frame/welcome/herdr.png").size(16).rounded(3),
  },
  {
    id: "omp",
    tabName: "Customize OMP",
    tooltip: "Customize OMP (~/.omp)",
    folder: () => `${home().replace(/[\\/]+$/, "")}/.omp`,
    icon: (t, active) => svg("icons/omp.svg").size(15).text_color(active ? t.foreground : t.muted),
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

const isNarrow = () => (findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

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
        const pane = allPanes.find((p) => p.tab === tab.id && p.terminal) ?? allPanes.find((p) => p.tab === tab.id);
        return { space, tab, pane };
      }
      const tabPanes = allPanes.filter((p) => p.tab === tab.id && p.terminal);
      for (const pane of tabPanes) {
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

function openOrToggleCustomize(target, cx) {
  const root = layout();
  const drawer = findNode(root, "customize-drawer");
  const drawerState = shared("customize.drawer") ?? {};
  const isDrawerOpen = Boolean(drawer && !drawer.hidden);

  if (isDrawerOpen && drawerState.target === target.id) {
    run("layout.hide", { id: "customize-drawer" });
    return;
  }

  const folder = target.folder();
  const existing = findCustomizeSession(target);
  if (existing?.pane?.terminal) {
    const addr = existing.pane.terminal;
    setShared("customize.drawer", { target: target.id, folder, terminal: addr });
    run("layout.set", { layout: cloneWithTerminal(root, addr) });
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
        run("layout.set", { layout: cloneWithTerminal(layout(), addr) });
        run("layout.show", { id: "customize-drawer" });
        run("pane.focus", { terminal: addr });
        cx.notify();
        return;
      }
    }
  });
}
export default class HerdrOmp extends View {
  render(cx) {
    const t = theme();
    const collapsed = isNarrow();
    const root = layout();
    const drawer = findNode(root, "customize-drawer");
    const drawerOpen = Boolean(drawer && !drawer.hidden);
    const drawerTarget = shared("customize.drawer")?.target ?? null;
    const row = collapsed ? v_flex().gap(4).items_center() : h_flex().gap(6).items_center();

    return v_flex()
      .size_full()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .px(collapsed ? 4 : 8)
      .py(6)
      .justify_center()
      .child(
        row.w_full().children(
          TARGETS.map((target) => {
            const existing = findCustomizeSession(target);
            const isActive = drawerOpen && drawerTarget === target.id;
            const status = existing?.tab.status;
            return h_flex()
              .id(`herdr-omp-${target.id}`)
              .relative()
              .when(!collapsed, (el) => el.flex_1().min_w(0))
              .when(collapsed, (el) => el.w(32))
              .h(30)
              .items_center()
              .justify_center()
              .rounded(8)
              .cursor_pointer()
              .tooltip(target.tooltip)
              .border(1)
              .border_color(isActive ? t.border : t.chrome)
              .bg(isActive ? t.selected : t.raised)
              .hover((s) => s.bg(t.hover))
              .on_click(() => openOrToggleCustomize(target, cx))
              .when(Boolean(existing), (el) =>
                el.on_mouse_down("right", (_e, cx) => {
                  cx.stop_propagation();
                  openOverlay({
                    mod: "menu",
                    kind: "popup",
                    width: 200,
                    props: { tab: "tab", target: { id: existing.tab.id, space: existing.space.id } },
                  });
                })
              )
              .child(target.icon(t, isActive))
              .when(status === "working", (el) =>
                el.child(div().size(5).rounded_full().bg(t.working).absolute().top(5).right(6))
              )
              .when(status === "blocked" || status === "done", (el) =>
                el.child(div().size(5).rounded_full().bg(t[status]).absolute().top(5).right(6))
              );
          })
        )
      );
  }
}
