import type { PngPlacement } from "./browser-editor-session.js";
import type { EditorImportActivity } from "./editor-json-import-controls.js";
import type { EditorImportStatus } from "./editor-import-controls.js";

interface PngControlsOptions {
  readonly form: HTMLFormElement;
  readonly input: HTMLInputElement;
  readonly rectangle: Readonly<Record<keyof PngPlacement, HTMLInputElement>>;
  readonly button: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly importPng: (file: File, rectangle: PngPlacement) => Promise<unknown>;
  readonly onImported: () => string;
  readonly activity: EditorImportActivity;
}

/** Captures user inputs only; the facade owns publication and resource lifetimes. */
export function mountEditorPngImportControls(options: PngControlsOptions) {
  const { form, input, rectangle, button, status, importPng, onImported, activity } = options;
  let ready = false;
  let hasCurrent = false;
  let busy = false;
  let sharedBusy = false;
  let disposed = false;
  const update = () => {
    const disabled = disposed || !ready || !hasCurrent || busy || sharedBusy;
    input.disabled = button.disabled = disabled;
    for (const field of Object.values(rectangle)) field.disabled = disabled;
    form.setAttribute("aria-busy", String(busy || sharedBusy));
  };
  const report = (state: EditorImportStatus, message: string) => {
    status.dataset.importStatus = state;
    status.textContent = message;
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (disposed || !ready || !hasCurrent || busy || sharedBusy) return;
    const file = input.files?.[0];
    if (!file) { report("error", "Select a PNG file to import."); return; }
    const captured = { x: Number(rectangle.x.value), y: Number(rectangle.y.value),
      width: Number(rectangle.width.value), height: Number(rectangle.height.value) };
    if (Object.values(rectangle).some((field) => field.value.trim() === "") ||
      !Object.values(captured).every(Number.isFinite) || captured.width <= 0 || captured.height <= 0) {
      report("error", "PNG placement needs finite x/y and positive finite width/height in scene units.");
      return;
    }
    if (!activity.begin()) return;
    busy = true;
    update();
    report("pending", "PNG import in progress.");
    void (async () => {
      try {
        await importPng(file, captured);
        if (!disposed) report("success", `PNG import complete. ${onImported()}`);
      } catch {
        if (!disposed) report("error", "PNG import failed. Check the PNG file and placement, then try again. If another tab changed this draft, refresh to review it.");
      } finally {
        busy = false;
        activity.end();
        if (!disposed) update();
      }
    })();
  };
  form.addEventListener("submit", submit);
  update();
  return Object.freeze({
    setReady(value: boolean, editableCurrent: boolean) {
      if (disposed) return;
      const changed = ready !== value || hasCurrent !== editableCurrent;
      ready = value;
      hasCurrent = editableCurrent;
      if (changed && ready) report("idle", hasCurrent ? "Select a PNG file and placement in scene units."
        : "Create a scene or import JSON first to create an editable document.");
      update();
    },
    setBusy(value: boolean) {
      if (disposed) return;
      sharedBusy = value;
      update();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      form.removeEventListener("submit", submit);
      update();
    },
  });
}
