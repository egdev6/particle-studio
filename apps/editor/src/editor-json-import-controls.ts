import type { EditorImportStatus, EditorImportWorkflow } from "./editor-import-controls.js";

interface JsonControlsOptions {
  readonly form: HTMLFormElement;
  readonly input: HTMLTextAreaElement;
  readonly button: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly workflow: EditorImportWorkflow;
  readonly onImported: () => string;
}

/** Vanilla controls over the existing workflow, without session/resource authority. */
export function mountEditorJsonImportControls(options: JsonControlsOptions) {
  const { form, input, button, status, workflow, onImported } = options;
  let ready = false;
  let busy = false;
  let disposed = false;
  const update = () => {
    input.disabled = button.disabled = disposed || !ready || busy;
    form.setAttribute("aria-busy", String(busy));
  };
  const report = (state: EditorImportStatus, message: string) => {
    status.dataset.importStatus = state;
    status.textContent = message;
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (disposed || !ready || busy) return;
    const editableJson = input.value;
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
        if (!disposed) update();
      }
    })();
  };
  form.addEventListener("submit", submit);
  update();
  return Object.freeze({
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
