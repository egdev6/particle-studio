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
}

/** Vanilla controls over the existing workflow, without session/resource authority. */
export function mountEditorJsonImportControls(options: JsonControlsOptions) {
  const { form, input, button, status, workflow, onImported, activity } = options;
  let ready = false;
  let busy = false;
  let sharedBusy = false;
  let disposed = false;
  const update = () => {
    input.disabled = button.disabled = disposed || !ready || busy || sharedBusy;
    form.setAttribute("aria-busy", String(busy || sharedBusy));
  };
  const report = (state: EditorImportStatus, message: string) => {
    status.dataset.importStatus = state;
    status.textContent = message;
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (disposed || !ready || busy || sharedBusy) return;
    const editableJson = input.value;
    if (activity && !activity.begin()) return;
    busy = true;
    update();
    report("pending", "Import in progress.");
    void (async () => {
      try {
        await workflow({ kind: "editable-json-import", editableJson });
        if (!disposed) report("success", `Import complete. ${onImported()}`);
      } catch {
        if (!disposed) report("error", "Editable JSON import failed. Check the JSON and locally stored PNG assets, then try again. If another tab changed this draft, refresh to review it.");
      } finally {
        busy = false;
        activity?.end();
        if (!disposed) update();
      }
    })();
  };
  form.addEventListener("submit", submit);
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
      update();
    },
  });
}
