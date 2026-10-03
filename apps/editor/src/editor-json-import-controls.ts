import type { EditorImportStatus, EditorImportWorkflow } from "./editor-import-controls.js";

export interface EditorImportActivity {
  begin(): boolean;
  end(): void;
}

interface JsonControlsOptions {
  readonly form: HTMLFormElement;
  readonly input: HTMLTextAreaElement;
  readonly button: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly workflow: EditorImportWorkflow;
  readonly onImported: () => string;
  readonly activity?: EditorImportActivity;
  readonly createButton?: HTMLButtonElement;
  readonly createScene?: () => Promise<unknown>;
  readonly hasCurrent?: () => boolean;
  readonly onCreated?: () => string;
}

/** Vanilla controls over the existing workflow, without session/resource authority. */
export function mountEditorJsonImportControls(options: JsonControlsOptions) {
  const { form, input, button, status, workflow, onImported, activity,
    createButton, createScene, hasCurrent, onCreated } = options;
  let ready = false;
  let busy = false;
  let sharedBusy = false;
  let disposed = false;
  const update = () => {
    input.disabled = button.disabled = disposed || !ready || busy || sharedBusy;
    if (createButton) {
      createButton.disabled = button.disabled || !createScene || !onCreated || Boolean(hasCurrent?.());
    }
    form.setAttribute("aria-busy", String(busy || sharedBusy));
  };
  const report = (state: EditorImportStatus, message: string) => {
    status.dataset.importStatus = state;
    status.textContent = message;
  };
  const activate = (event: Event, creating: boolean) => {
    event.preventDefault();
    if (disposed || !ready || busy || sharedBusy) return;
    if (creating && (!createScene || !onCreated || hasCurrent?.())) return;
    const editableJson = creating ? "" : input.value;
    if (activity && !activity.begin()) return;
    busy = true;
    update();
    report("pending", creating ? "Scene creation in progress." : "Import in progress.");
    void (async () => {
      try {
        if (creating) await createScene!();
        else await workflow({ kind: "editable-json-import", editableJson });
        if (!disposed) report("success", creating ? `Scene created. ${onCreated!()}` : `Import complete. ${onImported()}`);
      } catch {
        if (!disposed) report("error", creating
          ? "Scene creation failed. Check local storage, then try again. If another tab changed this draft, refresh to review it."
          : "Editable JSON import failed. Check the JSON and locally stored PNG assets, then try again. If another tab changed this draft, refresh to review it.");
      } finally {
        busy = false;
        activity?.end();
        if (!disposed) update();
      }
    })();
  };
  const submit = (event: Event) => activate(event, false);
  const create = (event: Event) => activate(event, true);
  form.addEventListener("submit", submit);
  createButton?.addEventListener("click", create);
  update();
  return Object.freeze({
    setBusy(value: boolean) {
      if (disposed) return;
      sharedBusy = value;
      update();
    },
    setReady(value: boolean) {
      if (disposed) return;
      ready = value;
      update();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      form.removeEventListener("submit", submit);
      createButton?.removeEventListener("click", create);
      update();
    },
  });
}
