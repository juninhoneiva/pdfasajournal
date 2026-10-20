/** Import dialog (ApplicationV2). */

import { MODULE_ID } from "../constants.js";
import { DEFAULT_OPTIONS } from "../core/convert.js";
import { importPdf } from "./importer.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const STORED_OPTIONS = [
  "pages",
  "images",
  "transparentBackgrounds",
  "backgroundTolerance",
  "includePageBackgrounds",
  "skipRepeatedImages",
  "removeHeadersFooters",
  "columnMode",
  "groupBy",
  "joinHyphens",
  "joinContinuations",
  "maxImageSize"
];

export class PdfImportApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "pdf-as-journal-import",
    tag: "form",
    classes: ["pdfj-app"],
    window: { title: "PDFJ.Title", icon: "fa-solid fa-file-pdf", resizable: true },
    position: { width: 540, height: Math.min(800, window.innerHeight - 60) },
    form: { handler: PdfImportApp.#onSubmit, closeOnSubmit: false, submitOnChange: false }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/import-dialog.hbs` }
  };

  #busy = false;

  async _prepareContext() {
    const saved = game.settings.get(MODULE_ID, "lastOptions") ?? {};
    const options = { ...DEFAULT_OPTIONS, ...saved };
    const folders = game.folders
      .filter(f => f.type === "JournalEntry")
      .map(f => ({ id: f.id, name: " ".repeat(Math.max(0, (f.depth ?? 1) - 1) * 2) + f.name }));
    return {
      options,
      folders,
      groupModes: {
        section: "PDFJ.GroupBy.Section",
        page: "PDFJ.GroupBy.Page"
      },
      columnModes: {
        grid: "PDFJ.ColumnMode.Grid",
        flow: "PDFJ.ColumnMode.Flow"
      }
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const form = this.element;
    const input = form.querySelector("input[name=pdfFile]");
    const zone = form.querySelector(".pdfj-dropzone");
    const label = form.querySelector(".pdfj-file-name");
    const nameInput = form.querySelector("input[name=name]");
    const showFile = () => {
      const file = input.files?.[0];
      label.textContent = file ? file.name : game.i18n.localize("PDFJ.NoFile");
      if (file && !nameInput.value) nameInput.value = file.name.replace(/\.pdf$/i, "");
    };
    const range = form.querySelector("input[name=backgroundTolerance]");
    range?.addEventListener("input", () => (form.querySelector(".pdfj-range-value").textContent = range.value));
    zone.addEventListener("click", () => input.click());
    input.addEventListener("change", showFile);
    zone.addEventListener("dragover", ev => {
      ev.preventDefault();
      zone.classList.add("dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      zone.classList.remove("dragover");
      const file = [...(ev.dataTransfer?.files ?? [])].find(f => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
      if (!file) return;
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      showFile();
    });
  }

  #setProgress(text, current, total) {
    const box = this.element.querySelector(".pdfj-progress");
    box.hidden = false;
    box.querySelector(".pdfj-progress-label").textContent = text;
    const bar = box.querySelector("progress");
    bar.max = total || 1;
    bar.value = current;
  }

  static async #onSubmit(event, form, formData) {
    if (this.#busy) return;
    const file = form.querySelector("input[name=pdfFile]").files?.[0];
    if (!file) {
      ui.notifications.warn(game.i18n.localize("PDFJ.NoFile"));
      return;
    }
    const data = formData.object;
    const options = {};
    for (const key of STORED_OPTIONS) if (key in data) options[key] = data[key];
    for (const key of ["images", "transparentBackgrounds", "includePageBackgrounds", "skipRepeatedImages", "removeHeadersFooters", "joinHyphens", "joinContinuations"]) {
      options[key] = !!data[key];
    }
    options.backgroundTolerance = Number(options.backgroundTolerance) || DEFAULT_OPTIONS.backgroundTolerance;
    options.maxImageSize = Number(options.maxImageSize) || DEFAULT_OPTIONS.maxImageSize;
    await game.settings.set(MODULE_ID, "lastOptions", options);

    this.#busy = true;
    form.querySelectorAll("input, select, button").forEach(el => (el.disabled = true));
    const stageLabel = {
      read: "PDFJ.Progress.Read",
      layout: "PDFJ.Progress.Layout",
      create: "PDFJ.Progress.Create"
    };
    try {
      const entry = await importPdf({
        data: await file.arrayBuffer(),
        fileName: file.name,
        name: data.name?.trim(),
        folder: data.folder || null,
        options,
        onProgress: ({ stage, current, total }) =>
          this.#setProgress(game.i18n.format(stageLabel[stage] ?? stage, { current, total }), current, total)
      });
      ui.notifications.info(game.i18n.format("PDFJ.Done", { name: entry.name, pages: entry.pages.size }));
      entry.sheet.render(true);
      await this.close();
    } catch (err) {
      console.error(`${MODULE_ID} |`, err);
      ui.notifications.error(game.i18n.format("PDFJ.Error", { message: err.message }));
      form.querySelectorAll("input, select, button").forEach(el => (el.disabled = false));
    } finally {
      this.#busy = false;
    }
  }
}
