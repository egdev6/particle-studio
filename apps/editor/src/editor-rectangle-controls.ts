import type { PngPlacement } from "./browser-editor-session.js";
import type { EditorImportActivity } from "./editor-json-import-controls.js";

interface RectangleControlsOptions {
  readonly form: HTMLFormElement;
  readonly rectangle: Readonly<Record<keyof PngPlacement, HTMLInputElement>>;
  readonly button: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly addRectangle: (geometry: PngPlacement) => Promise<unknown>;
  readonly onCreated: () => string;
  readonly activity: EditorImportActivity;
}

/** Input-only controller: the session owns commands, publication and resources. */
export function mountEditorRectangleControls(options: RectangleControlsOptions) {
  const { form, rectangle, button, status, addRectangle, onCreated, activity } = options;
  let ready = false;
  let hasCurrent = false;
  let busy = false;
  let sharedBusy = false;
  let disposed = false;
  const update = () => {
    const disabled = disposed || !ready || !hasCurrent || busy || sharedBusy;
    button.disabled = disabled;
    for (const field of Object.values(rectangle)) field.disabled = disabled;
    form.setAttribute("aria-busy", String(busy || sharedBusy));
  };
  const report = (state: string, message: string) => {
    status.dataset.importStatus = state;
    status.textContent = message;
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (disposed || !ready || !hasCurrent || busy || sharedBusy) return;
    const geometry = { x: Number(rectangle.x.value), y: Number(rectangle.y.value),
      width: Number(rectangle.width.value), height: Number(rectangle.height.value) };
    if (Object.values(rectangle).some((field) => field.value.trim() === "") ||
      !Object.values(geometry).every(Number.isFinite) || geometry.width <= 0 || geometry.height <= 0) {
      report("error", "Rectangle needs finite x/y and positive finite width/height in scene units.");
      return;
    }
    if (!activity.begin()) return;
    busy = true;
    update();
    report("pending", "Rectangle creation in progress.");
    void (async () => {
      let publicationSucceeded = false;
      try {
        await addRectangle(geometry);
        publicationSucceeded = true;
        if (!disposed) report("success", `Rectangle creation complete. ${onCreated()}`);
      } catch {
        if (!disposed) report("error", publicationSucceeded
          ? "Rectangle created, but rendering failed. Refresh to view the published draft."
          : "Rectangle creation failed. Check the geometry and locally stored PNG assets, then try again. If another tab changed this draft, refresh to review it.");
      } finally {
        busy = false;
        if (!disposed) {
          activity.end();
          update();
        }
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
      if (changed && ready) report("idle", hasCurrent ? "Add a rectangle in root scene coordinates (opacity 1)."
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
