import { View, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, home, layout, run, theme } from "herdr";

const TARGETS = [
  {
    id: "herdr",
    name: "Herdr",
    tooltip: "Split down: new terminal in Herdr (~/.config/herdr-app)",
    folder: () => appHome(),
    icon: () => image("frame/welcome/herdr.png").size(16).rounded(3),
  },
  {
    id: "omp",
    name: "OMP",
    tooltip: "Split down: new terminal in OMP (~/.omp)",
    folder: () => `${home().replace(/[\\/]+$/, "")}/.omp`,
    icon: (t) => svg("icons/omp.svg").size(15).text_color(t.muted),
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

export default class HerdrOmp extends View {
  render() {
    const t = theme();
    const collapsed = isNarrow();
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
          TARGETS.map((target) =>
            h_flex()
              .id(`herdr-omp-${target.id}`)
              .when(!collapsed, (el) => el.flex_1().min_w(0))
              .when(collapsed, (el) => el.w(32))
              .h(30)
              .items_center()
              .justify_center()
              .rounded(8)
              .cursor_pointer()
              .tooltip(target.tooltip)
              .border(1)
              .border_color(t.chrome)
              .bg(t.raised)
              .hover((s) => s.bg(t.hover))
              .on_click(() =>
                run("terminal.open", {
                  place: "down",
                  folder: target.folder(),
                  argv: ["agy", "--dangerously-skip-permissions", "-c"],
                  name: target.name,
                })
              )
              .child(target.icon(t))
          )
        )
      );
  }
}
