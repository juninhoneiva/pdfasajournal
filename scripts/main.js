import { MODULE_ID } from "./constants.js";
import { PdfImportApp } from "./foundry/import-app.js";
import { importPdf } from "./foundry/importer.js";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "imageSource", {
    name: "PDFJ.Settings.ImageSource.Name",
    hint: "PDFJ.Settings.ImageSource.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "data"
  });
  game.settings.register(MODULE_ID, "imageDirectory", {
    name: "PDFJ.Settings.ImageDirectory.Name",
    hint: "PDFJ.Settings.ImageDirectory.Hint",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });
  game.settings.register(MODULE_ID, "lastOptions", {
    scope: "client",
    config: false,
    type: Object,
    default: {}
  });

  const module = game.modules.get(MODULE_ID);
  module.api = {
    importPdf,
    /** Opens the import dialog. */
    open: () => new PdfImportApp().render(true)
  };
});

function canImport() {
  return game.user.isGM || (game.user.can("JOURNAL_CREATE") && game.user.can("FILES_UPLOAD"));
}

// Button in the Journal sidebar (v12 passes jQuery, v13 an HTMLElement).
Hooks.on("renderJournalDirectory", (app, html) => {
  if (!canImport()) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".pdfj-import-button")) return;
  const actions = root.querySelector(".header-actions");
  if (!actions) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pdfj-import-button";
  button.innerHTML = `<i class="fa-solid fa-file-pdf"></i> ${game.i18n.localize("PDFJ.Button")}`;
  button.addEventListener("click", () => new PdfImportApp().render(true));
  actions.append(button);
});
