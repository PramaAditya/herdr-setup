// Projects & Sections manager view for Todoist Hub.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { COLOR_SWATCHES, todoistColor } from "./format.js";

export function initProjectState(view) {
  view.newProjColor = "blue";
  view.editingProjId = null;
  view.editingProjColor = "charcoal";
  view.confirmDeleteProjId = null;
  view.showArchivedProjects = false;
  view.creatingProj = false;

  view.newProjInput = InputState.new({ placeholder: "New project name (Enter)..." });
  view.renameProjInput = InputState.new({ placeholder: "Rename project..." });
  view.newSectionInput = InputState.new({ placeholder: "+ New section in project (Enter)..." });

  view.newProjInput.on("submit", (_e, cx) => submitCreateProject(view, cx));
  view.renameProjInput.on("submit", (_e, cx) => submitRenameProject(view, cx));
  view.newSectionInput.on("submit", (_e, cx) => submitCreateSection(view, cx));
}

export function releaseProjectState(view) {
  view.newProjInput?.release();
  view.renameProjInput?.release();
  view.newSectionInput?.release();
}

function submitCreateProject(view, cx) {
  const name = view.newProjInput.value().trim();
  if (!name || view.creatingProj) return;
  view.creatingProj = true;
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      const created = await view.store.createProject({ name, color: view.newProjColor });
      if (created?.id) {
        view.newProjInput.set_value("");
      }
    } catch (err) {
      view.store.error = String(err?.message || err);
    } finally {
      view.creatingProj = false;
      cx.notify();
    }
  });
}

function startEditProject(view, proj, cx) {
  if (view.editingProjId === proj.id) {
    view.editingProjId = null;
    view.confirmDeleteProjId = null;
    cx.notify();
    return;
  }
  view.editingProjId = proj.id;
  view.editingProjColor = proj.color || "charcoal";
  view.confirmDeleteProjId = null;
  view.renameProjInput.set_value(proj.name || "");
  view.newSectionInput.set_value("");
  cx.notify();
}

function submitRenameProject(view, cx) {
  const projId = view.editingProjId;
  const name = view.renameProjInput.value().trim();
  if (!projId || !name) return;
  cx.spawn(async (cx) => {
    try {
      await view.store.updateProject(projId, { name, color: view.editingProjColor });
      view.editingProjId = null;
    } catch (err) {
      view.store.error = String(err?.message || err);
    } finally {
      cx.notify();
    }
  });
}

function submitCreateSection(view, cx) {
  const projId = view.editingProjId;
  const name = view.newSectionInput.value().trim();
  if (!projId || !name) return;
  cx.spawn(async (cx) => {
    try {
      await view.store.createSection(projId, name);
      view.newSectionInput.set_value("");
    } catch (err) {
      view.store.error = String(err?.message || err);
    } finally {
      cx.notify();
    }
  });
}

function colorStrip(prefix, selected, t, onPick) {
  return h_flex()
    .flex_wrap()
    .gap(5)
    .items_center()
    .children(
      COLOR_SWATCHES.map((c) => {
        const hex = todoistColor(c);
        const on = selected === c;
        return div()
          .id(`${prefix}-col-${c}`)
          .size(15)
          .rounded_full()
          .bg(hex)
          .cursor_pointer()
          .border(on ? 2 : 1)
          .border_color(on ? t.foreground : t.border)
          .tooltip(c.replace(/_/g, " "))
          .on_click((_e, cx) => onPick(c, cx));
      })
    );
}

export function renderProjectsManager(view, t, cx) {
  const store = view.store;

  return v_flex()
    .id("td-projects-mgr")
    .size_full()
    .min_h(0)
    .bg(t.background)
    // Header
    .child(
      h_flex()
        .h(38)
        .flex_none()
        .px(10)
        .gap(8)
        .items_center()
        .bg(t.surface)
        .border_b(1)
        .border_color(t.border)
        .child(
          div()
            .id("td-pm-back")
            .px(6)
            .py(3)
            .rounded(5)
            .cursor_pointer()
            .text_size(12)
            .text_color(t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => {
              view.managingProjects = false;
              view.editingProjId = null;
              cx.notify();
            })
            .child("← Back")
        )
        .child(div().font_semibold().text_size(12.5).text_color(t.foreground).child("Projects & Sections"))
        .child(div().text_size(11).text_color(t.dim).child(String(store.projects.length)))
    )
    // Body
    .child(
      v_flex()
        .id("td-pm-scroll")
        .flex_1()
        .min_h(0)
        .overflow_y_scrollbar()
        .p(10)
        .gap(10)
        // New project card
        .child(
          v_flex()
            .p(9)
            .gap(7)
            .rounded(8)
            .bg(t.surface)
            .border(1)
            .border_color(t.border)
            .child(div().text_size(11.5).font_semibold().text_color(t.muted).child("New Project"))
            .child(
              h_flex()
                .gap(6)
                .child(
                  Input.new(view.newProjInput)
                    .flex_1()
                    .min_w(0)
                    .h(26)
                    .px(8)
                    .rounded(5)
                    .bg(t.input)
                    .border(1)
                    .border_color(t.border)
                    .text_size(12)
                    .text_color(t.foreground)
                )
                .child(
                  div()
                    .id("td-pm-create")
                    .px(10)
                    .h(26)
                    .flex()
                    .items_center()
                    .rounded(5)
                    .cursor_pointer()
                    .bg(t.accent)
                    .text_size(11.5)
                    .text_color(t.background)
                    .on_click((_e, cx) => submitCreateProject(view, cx))
                    .child(view.creatingProj ? "…" : "Create")
                )
            )
            .child(
              colorStrip("newp", view.newProjColor, t, (c, cx) => {
                view.newProjColor = c;
                cx.notify();
              })
            )
        )
        // Active projects list
        .child(
          v_flex()
            .gap(5)
            .children(
              store.projects.map((proj) => {
                const isInbox = Boolean(proj.inbox_project || proj.is_inbox_project);
                const isEditing = view.editingProjId === proj.id;
                const isConfirmDel = view.confirmDeleteProjId === proj.id;
                const count = store.countForProject(proj.id);
                const secs = store.sectionsForProject(proj.id);

                return v_flex()
                  .id(`td-pm-p-${proj.id}`)
                  .rounded(7)
                  .bg(t.surface)
                  .border(1)
                  .border_color(isEditing ? t.accent : t.border)
                  .overflow_hidden()
                  .child(
                    h_flex()
                      .px(9)
                      .py(7)
                      .gap(7)
                      .items_center()
                      .hover((s) => s.bg(t.hover))
                      .child(div().size(8).rounded_full().bg(todoistColor(proj.color, t.dim)).flex_none())
                      .child(
                        div()
                          .flex_1()
                          .min_w(0)
                          .truncate()
                          .text_size(12.5)
                          .font_medium()
                          .text_color(t.foreground)
                          .cursor_pointer()
                          .on_click((_e, cx) => {
                            view.managingProjects = false;
                            view.setActiveView(isInbox ? "inbox" : "project", proj.id, cx);
                          })
                          .child(proj.name)
                      )
                      .child(div().text_size(11).text_color(t.dim).child(String(count)))
                      .when(!isInbox, (row) =>
                        row
                          .child(
                            div()
                              .id(`td-pm-fav-${proj.id}`)
                              .px(5)
                              .py(1)
                              .rounded(4)
                              .text_size(11.5)
                              .cursor_pointer()
                              .text_color(proj.is_favorite ? t.working : t.dim)
                              .hover((s) => s.bg(t.raised))
                              .tooltip(proj.is_favorite ? "Unfavorite" : "Favorite")
                              .on_click((_e, cx) => {
                                cx.spawn(async () => {
                                  await store.updateProject(proj.id, { is_favorite: !proj.is_favorite });
                                });
                              })
                              .child(proj.is_favorite ? "★" : "☆")
                          )
                          .child(
                            div()
                              .id(`td-pm-edit-${proj.id}`)
                              .px(6)
                              .py(2)
                              .rounded(4)
                              .text_size(11)
                              .cursor_pointer()
                              .bg(isEditing ? t.selected : t.raised)
                              .text_color(isEditing ? t.foreground : t.muted)
                              .hover((s) => s.bg(t.selected).text_color(t.foreground))
                              .on_click((_e, cx) => startEditProject(view, proj, cx))
                              .child(isEditing ? "Done" : "Edit")
                          )
                      )
                  )
                  .when(isEditing && !isInbox, (card) =>
                    card.child(
                      v_flex()
                        .p(9)
                        .gap(8)
                        .border_t(1)
                        .border_color(t.border)
                        .bg(t.background)
                        // Rename & color
                        .child(
                          h_flex()
                            .gap(6)
                            .child(
                              Input.new(view.renameProjInput)
                                .flex_1()
                                .min_w(0)
                                .h(26)
                                .px(8)
                                .rounded(5)
                                .bg(t.input)
                                .border(1)
                                .border_color(t.border)
                                .text_size(12)
                                .text_color(t.foreground)
                            )
                            .child(
                              div()
                                .id(`td-pm-save-${proj.id}`)
                                .px(8)
                                .h(26)
                                .flex()
                                .items_center()
                                .rounded(5)
                                .cursor_pointer()
                                .bg(t.accent)
                                .text_size(11.5)
                                .text_color(t.background)
                                .on_click((_e, cx) => submitRenameProject(view, cx))
                                .child("Save")
                            )
                        )
                        .child(
                          colorStrip(`edp-${proj.id}`, view.editingProjColor, t, (c, cx) => {
                            view.editingProjColor = c;
                            cx.notify();
                          })
                        )
                        // Sections inside this project
                        .child(
                          v_flex()
                            .gap(4)
                            .pt(4)
                            .border_t(1)
                            .border_color(t.border)
                            .child(div().text_size(11).font_semibold().text_color(t.muted).child(`Sections (${secs.length})`))
                            .children(
                              secs.map((sec) =>
                                h_flex()
                                  .id(`td-pm-sec-${sec.id}`)
                                  .px(7)
                                  .py(4)
                                  .gap(6)
                                  .rounded(5)
                                  .bg(t.surface)
                                  .items_center()
                                  .child(div().flex_1().truncate().text_size(11.5).text_color(t.foreground).child(sec.name))
                                  .child(
                                    div()
                                      .id(`td-pm-sec-del-${sec.id}`)
                                      .px(5)
                                      .rounded(4)
                                      .text_size(11)
                                      .text_color(t.dim)
                                      .cursor_pointer()
                                      .hover((s) => s.bg(t.hover).text_color(t.blocked))
                                      .tooltip("Delete section and its tasks")
                                      .on_click((_e, cx) => {
                                        cx.spawn(async () => {
                                          await store.deleteSection(sec.id);
                                        });
                                      })
                                      .child("×")
                                  )
                              )
                            )
                            .child(
                              Input.new(view.newSectionInput)
                                .w_full()
                                .h(25)
                                .px(7)
                                .rounded(5)
                                .bg(t.input)
                                .border(1)
                                .border_color(t.border)
                                .text_size(11.5)
                                .text_color(t.foreground)
                            )
                        )
                        // Archive / Delete project buttons
                        .child(
                          h_flex()
                            .gap(6)
                            .pt(4)
                            .border_t(1)
                            .border_color(t.border)
                            .child(
                              div()
                                .id(`td-pm-arch-${proj.id}`)
                                .px(8)
                                .py(3)
                                .rounded(5)
                                .text_size(11)
                                .cursor_pointer()
                                .bg(t.raised)
                                .text_color(t.muted)
                                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                                .on_click((_e, cx) => {
                                  view.editingProjId = null;
                                  cx.spawn(async () => {
                                    await store.archiveProject(proj.id);
                                  });
                                })
                                .child("Archive")
                            )
                            .child(div().flex_1())
                            .child(
                              div()
                                .id(`td-pm-del-${proj.id}`)
                                .px(8)
                                .py(3)
                                .rounded(5)
                                .text_size(11)
                                .cursor_pointer()
                                .bg(isConfirmDel ? t.blocked : t.raised)
                                .text_color(isConfirmDel ? t.background : t.blocked)
                                .hover((s) => s.bg(t.blocked).text_color(t.background))
                                .on_click((_e, cx) => {
                                  if (!isConfirmDel) {
                                    view.confirmDeleteProjId = proj.id;
                                    cx.notify();
                                    return;
                                  }
                                  view.editingProjId = null;
                                  view.confirmDeleteProjId = null;
                                  cx.spawn(async () => {
                                    await store.deleteProject(proj.id);
                                  });
                                })
                                .child(isConfirmDel ? "Confirm Delete?" : "Delete Project")
                            )
                        )
                    )
                  );
              })
            )
        )
        // Archived projects toggle
        .child(
          v_flex()
            .gap(5)
            .pt(6)
            .border_t(1)
            .border_color(t.border)
            .child(
              h_flex()
                .id("td-pm-arch-toggle")
                .px(6)
                .py(4)
                .rounded(5)
                .cursor_pointer()
                .text_size(11.5)
                .text_color(t.muted)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => {
                  view.showArchivedProjects = !view.showArchivedProjects;
                  if (view.showArchivedProjects) {
                    cx.spawn(async () => {
                      await store.loadArchivedProjects();
                    });
                  }
                  cx.notify();
                })
                .child(view.showArchivedProjects ? "▾ Archived Projects" : "▸ Show Archived Projects")
            )
            .when(view.showArchivedProjects, (el) =>
              el
                .when(store.archivedProjects.length === 0, (r) =>
                  r.child(div().px(8).text_size(11.5).text_color(t.dim).child("No archived projects."))
                )
                .children(
                  store.archivedProjects.map((proj) =>
                    h_flex()
                      .id(`td-pm-archived-${proj.id}`)
                      .px(9)
                      .py(6)
                      .gap(7)
                      .rounded(6)
                      .bg(t.surface)
                      .border(1)
                      .border_color(t.border)
                      .items_center()
                      .child(div().size(7).rounded_full().bg(todoistColor(proj.color, t.dim)).flex_none())
                      .child(div().flex_1().truncate().text_size(12).text_color(t.muted).child(proj.name))
                      .child(
                        div()
                          .id(`td-pm-unarch-${proj.id}`)
                          .px(7)
                          .py(2)
                          .rounded(4)
                          .text_size(11)
                          .cursor_pointer()
                          .bg(t.raised)
                          .text_color(t.foreground)
                          .hover((s) => s.bg(t.selected))
                          .on_click((_e, cx) => {
                            cx.spawn(async () => {
                              await store.unarchiveProject(proj.id);
                            });
                          })
                          .child("Restore")
                      )
                  )
                )
            )
        )
    );
}
