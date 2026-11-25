import { View, div, svg } from "gpui-kit";
import { Popover, h_flex, v_flex } from "gpui-base";
import { appHome, home, layout, panes, run, spaces, terminals, theme } from "herdr";

const TARGETS = [
  {
    id: "herdr",
    label: "Customize Herdr",
    tabName: "Customize Herdr",
    spaceName: "Herdr",
    hint: "herdr-app",
    folder: () => appHome(),
  },
  {
    id: "omp",
    label: "Customize OMP",
    tabName: "Customize OMP",
    spaceName: "OMP",
    hint: "~/.omp",
    folder: () => `${home().replace(/[\\/]+$/, "")}/.omp`,
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

const isNarrow = () => (findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function normPath(p) {
  return String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function findExistingSession(target) {
  const targetDir = normPath(target.folder());
  const allPanes = panes();
  const termByAddr = new Map(terminals().map((t) => [t.address, t]));

  for (const space of spaces()) {
    if (space.machine) continue;
    for (const tab of space.tabs) {
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
        const inTargetDir = normPath(pane.cwd) === targetDir;
        if ((tab.named && tab.name === target.tabName) || (inTargetDir && isOmp)) {
          return { space, tab, pane };
        }
      }
    }
  }
  return null;
}

function openOrFocusOmp(target) {
  const existing = findExistingSession(target);
  if (existing) {
    if (existing.tab.settled) run("tab.unsettle", { id: existing.tab.id });
    run("space.select", { id: existing.space.id });
    run("tab.select", { id: existing.tab.id });
    run("pane.focus", { pane: existing.pane.pane });
    return;
  }

  const allSpaces = spaces();
  const active = allSpaces.find((s) => s.active);
  const localSpace = active && !active.machine ? active : allSpaces.find((s) => !s.machine);
  const folder = target.folder();

  if (localSpace) {
    run("tab.new", {
      name: target.tabName,
      space: localSpace.id,
      folder,
      argv: ["omp"],
    });
  } else {
    run("space.new", {
      name: target.spaceName,
      tab: target.tabName,
      folder,
      argv: ["omp"],
      machine: "",
    });
  }
}

export default class HerdrOmp extends View {
  init() {
    this.open = false;
  }

  render() {
    const t = theme();
    const collapsed = isNarrow();
    const sessions = TARGETS.map((target) => ({
      target,
      existing: findExistingSession(target),
    }));
    const anyActive = sessions.some((s) => s.existing?.pane.focused);
    const anyRunning = sessions.some((s) => Boolean(s.existing));

    const dot = () => div().size(6).rounded_full().bg(t.accent);

    const trigger = h_flex()
      .id("herdr-omp-btn")
      .h(28)
      .px(8)
      .gap(9)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .text_color(anyActive || this.open ? t.foreground : t.muted)
      .when(anyActive || this.open, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .when(collapsed, (el) =>
        el.relative().w(32).px(0).justify_center().tooltip("Customize (Herdr / OMP)")
      )
      .child(svg("mods/herdr-omp/icon.svg").size(14).text_color(anyRunning ? t.accent : t.muted))
      .when(!collapsed, (el) =>
        el
          .child(div().flex_1().truncate().child("Customize"))
          .when(anyRunning, (row) => row.child(dot()))
      )
      .when(collapsed && anyRunning, (el) => el.child(dot().absolute().top(5).right(6)));

    const menu = v_flex()
      .min_w(196)
      .p(4)
      .gap(2)
      .rounded(8)
      .bg(t.popover)
      .border(1)
      .border_color(t.border)
      .text_size(13)
      .children(
        sessions.map(({ target, existing }) => {
          const active = Boolean(existing?.pane.focused);
          const running = Boolean(existing);
          return h_flex()
            .id(`herdr-omp-item-${target.id}`)
            .h(30)
            .px(8)
            .gap(8)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .text_color(active ? t.foreground : t.muted)
            .when(active, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => {
              this.open = false;
              cx.notify();
              openOrFocusOmp(target);
            })
            .child(svg("mods/herdr-omp/icon.svg").size(13).text_color(running ? t.accent : t.muted))
            .child(div().flex_1().truncate().child(target.label))
            .child(div().text_size(11).text_color(t.dim).child(target.hint))
            .when(running, (row) => row.child(dot()));
        })
      );

    return v_flex()
      .size_full()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .px(8)
      .py(6)
      .text_size(13)
      .when(collapsed, (el) => el.px(0).items_center())
      .child(
        Popover.new("herdr-omp-popover")
          .anchor("bottom_left")
          .open(this.open)
          .on_open_change((open, cx) => {
            this.open = open;
            cx.notify();
          })
          .trigger(trigger)
          .content(menu)
      );
  }
}
