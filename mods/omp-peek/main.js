import { readFile } from "fs/promises";
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, home, props, theme } from "herdr";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function stateFile(terminalId) {
  const safe = String(terminalId ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  return `${home().replace(/[\\/]+$/, "")}/.omp/run/herdr-subagents/${safe}.json`;
}

function formatAge(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default class OmpPeek extends View {
  init(_props, cx) {
    this.sub = null;
    this.alive = true;
    const poll = async () => {
      const { terminal, subagentId } = props() ?? {};
      if (!terminal || !subagentId) return;
      try {
        const raw = await readFile(stateFile(terminal), "utf8");
        const parsed = JSON.parse(raw);
        this.sub = parsed?.subagents?.[subagentId] ?? null;
      } catch {
        // file may not exist yet or was cleaned up
      }
      cx.notify();
    };
    cx.spawn(async () => {
      while (this.alive) {
        await poll();
        await new Promise((r) => setTimeout(r, 700));
      }
    });
  }

  close() {
    this.alive = false;
    closeOverlay(props()?.overlay);
  }

  render() {
    const t = theme();
    const { subagentId } = props() ?? {};
    const sub = this.sub;
    const status = sub?.status ?? "done";
    const working = status === "working";
    const elapsed = sub ? formatAge((sub.finishedAt ?? Date.now()) - sub.startedAt) : "";
    const events = [...(sub?.events ?? [])].reverse();

    return v_flex()
      .size_full()
      .bg(t.popover)
      .border(1)
      .border_color(t.border)
      .rounded(10)
      .overflow_hidden()
      .text_size(12.5)
      .child(
        h_flex()
          .h(38)
          .px(12)
          .gap(8)
          .flex_none()
          .items_center()
          .bg(t.surface)
          .border_b(1)
          .border_color(t.border)
          .child(svg("icons/omp.svg").size(14).flex_none().text_color(working ? t.working : t.muted))
          .child(div().font_semibold().truncate().text_color(t.foreground).child(sub?.name || subagentId || "Subagent"))
          .when(Boolean(sub?.agentType), (el) =>
            el.child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).child(sub.agentType))
          )
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .text_size(11.5)
              .text_color(working ? t.working : status === "error" ? t.blocked : t.done)
              .when(working, (el) => el.child(div().w(10).frames(SPIN, 90).child(SPIN[0])))
              .child(working ? "working" : status === "error" ? "error" : "done")
          )
          .when(Boolean(elapsed), (el) => el.child(div().text_size(11).text_color(t.dim).child(elapsed)))
          .child(div().flex_1())
          .child(
            div()
              .id("omp-peek-close")
              .px(7)
              .py(2)
              .rounded(5)
              .cursor_pointer()
              .text_color(t.muted)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.close())
              .child("✕")
          )
      )
      .when(Boolean(sub?.currentTool), (el) =>
        el.child(
          h_flex()
            .px(12)
            .py(7)
            .gap(8)
            .flex_none()
            .items_center()
            .bg(t.raised)
            .border_b(1)
            .border_color(t.border)
            .child(div().w(10).text_color(t.working).frames(SPIN, 90).child(SPIN[0]))
            .child(div().flex_1().truncate().text_color(t.foreground).child(sub.currentTool))
        )
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .p(10)
          .gap(6)
          .overflow_y_scrollbar()
          .when(!sub, (el) =>
            el.child(div().p(12).text_color(t.dim).child("Waiting for subagent activity…"))
          )
          .when(Boolean(sub) && events.length === 0, (el) =>
            el.child(div().p(12).text_color(t.dim).child("No tool calls or messages yet."))
          )
          .children(
            events.map((ev, idx) =>
              v_flex()
                .id(`ev-${idx}-${ev.at}`)
                .px(9)
                .py(6)
                .gap(2)
                .rounded(6)
                .bg(t.surface)
                .border(1)
                .border_color(ev.isError ? t.blocked : t.border)
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .child(
                      div()
                        .font_semibold()
                        .text_size(12)
                        .text_color(
                          ev.isError
                            ? t.blocked
                            : ev.kind === "tool_start"
                              ? t.working
                              : ev.kind === "text"
                                ? t.accent
                                : t.foreground
                        )
                        .child(
                          ev.kind === "tool_start"
                            ? `▶ ${ev.label}`
                            : ev.kind === "tool_end"
                              ? `${ev.isError ? "✕" : "✓"} ${ev.label}`
                              : ev.label
                        )
                    )
                    .child(div().flex_1())
                    .child(div().text_size(10.5).text_color(t.dim).child(formatTime(ev.at)))
                )
                .when(Boolean(ev.detail), (el) =>
                  el.child(div().text_size(11.5).text_color(t.muted).child(ev.detail))
                )
            )
          )
      );
  }
}
