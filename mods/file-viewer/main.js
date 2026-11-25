import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { props, readTextFile, settings, theme, writeTextFile } from "herdr";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };

export default class FileViewer extends View {
  init(_props, cx) {
    this.code = null;
    this.error = null;
    this.loading = true;
    this.loadedPath = null;
    this.savedText = "";
    this.dirty = false;
    this.saving = false;
    this.saveMsg = null;
    this.saveErr = false;
    this.truncated = false;
    this.load(cx);
  }

  load(cx) {
    const { path, on } = props() ?? {};
    this.loadedPath = path ?? null;
    this.code?.release();
    this.code = null;
    this.error = null;
    this.loading = true;
    this.dirty = false;
    this.saveMsg = null;
    this.saveErr = false;
    this.truncated = false;
    if (!path) {
      this.loading = false;
      this.error = "No file specified";
      cx.notify();
      return;
    }
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(path, { on: on ?? null });
        if (this.loadedPath !== path) return;
        if (text === null) {
          this.error = "This file is no longer available";
          return;
        }
        if (text.includes("\0")) {
          this.error = "Binary file · no text preview";
          return;
        }
        const t = theme();
        const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "txt";
        this.truncated = text.length > 400000;
        this.savedText = text;
        const readonly = this.truncated || Boolean(on);
        this.code = EditorState.new({
          language: LANG[ext] ?? ext,
          readonly,
          value: this.truncated ? text.slice(0, 400000) + "\n… (file truncated, read-only)" : text,
          syntax: {
            keyword: t.ansi5,
            string: t.ansi2,
            comment: t.dim,
            function: t.ansi4,
            type: t.ansi3,
            number: t.ansi1,
            constant: t.ansi6,
          },
        });
        if (!readonly) {
          this.code.on("change", (_e, cx) => {
            if (!this.code) return;
            this.dirty = this.code.value() !== this.savedText;
            if (this.dirty) {
              this.saveMsg = null;
              this.saveErr = false;
            }
            cx.notify();
          });
        }
      } catch {
        if (this.loadedPath === path) this.error = "Cannot preview this file (binary, too large, or unreadable)";
      } finally {
        if (this.loadedPath === path) this.loading = false;
        cx.notify();
      }
    });
  }

  save(cx) {
    const { path, on } = props() ?? {};
    if (!path || !this.code || this.saving || this.truncated || on) return;
    const nextText = this.code.value();
    if (nextText === this.savedText) {
      this.dirty = false;
      cx.notify();
      return;
    }
    this.saving = true;
    this.saveMsg = "Saving…";
    this.saveErr = false;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(path, nextText, this.savedText);
        this.savedText = nextText;
        this.dirty = this.code ? this.code.value() !== this.savedText : false;
        this.saveMsg = "Saved";
        this.saveErr = false;
      } catch {
        this.saveMsg = "File changed on disk — reload first";
        this.saveErr = true;
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();
    const { path, label, on } = props() ?? {};
    if (path && path !== this.loadedPath) this.load(cx);
    const font = this.code ? settings() : null;
    const readonly = this.truncated || Boolean(on);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .on_key_down((e, cx) => {
        if ((e.modifiers.control || e.modifiers.platform) && e.key.toLowerCase() === "s") {
          cx.stop_propagation();
          this.save(cx);
        }
      })
      .child(
        h_flex()
          .h(34)
          .flex_none()
          .px(12)
          .gap(8)
          .items_center()
          .bg(t.surface)
          .border_b(1)
          .border_color(t.border)
          .child(svg("mods/files/file.svg").size(13).flex_none().text_color(this.dirty ? t.accent : t.muted))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(this.dirty ? t.foreground : t.muted).child(label || path || ""))
          .when(this.dirty, (el) => el.child(div().size(6).rounded_full().bg(t.accent).tooltip("Unsaved changes")))
          .when(Boolean(this.saveMsg), (el) =>
            el.child(div().text_size(11).text_color(this.saveErr ? t.blocked : t.done).child(this.saveMsg))
          )
          .when(readonly, (el) =>
            el.child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(10.5).text_color(t.dim).child("Read-only"))
          )
          .when(!readonly && Boolean(this.code), (el) =>
            el.child(
              div()
                .id("file-viewer-save")
                .px(8)
                .py(2)
                .rounded(5)
                .text_size(11.5)
                .cursor_pointer()
                .bg(this.dirty ? t.accent : t.raised)
                .text_color(this.dirty ? t.background : t.muted)
                .hover((s) => s.bg(this.dirty ? t.accent : t.hover).text_color(this.dirty ? t.background : t.foreground))
                .on_click((_e, cx) => this.save(cx))
                .child(this.saving ? "Saving…" : "Save")
            )
          )
          .child(
            div()
              .id("file-viewer-reload")
              .px(7)
              .py(2)
              .rounded(5)
              .text_size(11.5)
              .text_color(t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.load(cx))
              .child("Reload")
          )
      )
      .child(
        this.code
          ? Editor.new(this.code).font_family(font.font_family).text_size(font.font_size).flex_1().min_h(0)
          : div().p(16).text_color(t.dim).child(this.error || (this.loading ? "Loading file…" : ""))
      );
  }
}
