import type { InspectorCurrent, InspectorSelection } from "./editor-element-inspector.js";
import type { ShapeFillColorRequest } from "./editor-session.js";
import type { EditorImportActivity } from "./editor-json-import-controls.js";

interface FillColorControlsOptions {
  readonly form: HTMLFormElement;
  readonly fillColor: HTMLInputElement;
  readonly button: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly activity: EditorImportActivity;
  readonly getSelection: () => InspectorSelection | null;
  readonly getCurrent: () => InspectorCurrent | null;
  readonly setShapeFillColor: (request: ShapeFillColorRequest) => Promise<unknown>;
  readonly onPublished: () => string;
}

/** Borrows authored metadata only; publication and resource ownership stay with the session. */
export function mountEditorFillColorControls(options: FillColorControlsOptions) {
  const { form, fillColor, button, status, activity, getSelection, getCurrent, setShapeFillColor, onPublished } = options;
  let ready = false;
  let busy = false;
  let sharedBusy = false;
  let sharedOriginOwn = false;
  let sharedHadCurrent = false;
  let sharedDocumentId: string | undefined;
  let sharedRevisionId: string | undefined;
  let disposed = false;
  let remembered: InspectorSelection | null = null;
  const selectedShape = () => {
    const token = getSelection();
    const current = getCurrent();
    if (!token || !current || token.documentId !== current.documentId || token.revisionId !== current.revisionId) return null;
    const element = current.document.elements.find((candidate) => candidate.id === token.elementId);
    return element?.type === "shape" ? { token, element } : null;
  };
  const report = (state: string, message: string) => {
    status.dataset.fillColorStatus = state;
    status.textContent = message;
  };
  const failure = (published: boolean) => {
    if (disposed) return;
    try {
      report("error", published
        ? "Fill color published, but rendering failed. Refresh to view the published draft; the renderer falls back to black when no authored color remains."
        : "Fill color edit failed. Check the selected shape and local PNG assets. If another tab changed this draft, refresh to review it.");
    } catch {
      // A broken status node must not prevent lane settlement or trigger recursive reporting.
    }
  };
  const guidance = () => getCurrent()
    ? "Select a published shape to edit its authored fill color. Other elements remain read-only."
    : "Create a scene or import JSON first to edit a published shape fill color.";
  const editing = (element: { readonly fillColor?: string }) => element.fillColor === undefined
    ? "Edit authored fill color as #RRGGBB, then Apply fill color. Absent colors render black (#000000) by fallback."
    : "Edit authored fill color as #RRGGBB, then Apply fill color.";
  const update = () => {
    const disabled = disposed || !ready || busy || sharedBusy || !selectedShape();
    button.disabled = disabled;
    fillColor.disabled = disabled;
    form.setAttribute("aria-busy", String(busy || sharedBusy));
  };
  const syncSelection = () => {
    if (disposed) return;
    const selected = selectedShape();
    const next = selected?.token ?? null;
    const changed = next?.documentId !== remembered?.documentId || next?.revisionId !== remembered?.revisionId ||
      next?.elementId !== remembered?.elementId;
    if (changed) {
      remembered = next;
      fillColor.value = selected?.element.fillColor ?? "";
      // Preserve typed values on same-source refresh and own feedback during shared work.
      if (ready && !busy && !sharedBusy) report("idle", selected ? editing(selected.element) : guidance());
    }
    update();
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (disposed || !ready || busy || sharedBusy) return;
    const selected = selectedShape();
    if (!selected) return;
    const raw = fillColor.value;
    // Re-check after the value read: a synchronous getter must not reenter past this snapshot.
    if (disposed || !ready || busy || sharedBusy) return;
    if (raw.length !== 7 || !/^#[0-9A-Fa-f]{6}$/.test(raw)) {
      report("error", "Fill color requires an exact seven-character #RRGGBB value without alpha or shorthand.");
      return;
    }
    const request = Object.freeze({ documentId: selected.token.documentId, revisionId: selected.token.revisionId,
      elementId: selected.token.elementId, fillColor: raw });
    // Freeze all four scalars and exclude reentry before begin can invoke synchronous callbacks.
    busy = true;
    void (async () => {
      let acquired = false;
      let publicationSucceeded = false;
      try {
        if (!activity.begin()) return;
        acquired = true;
        if (disposed) return;
        update();
        report("pending", `Fill color edit pending for ${request.documentId} / ${request.revisionId}.`);
        await setShapeFillColor(request);
        publicationSucceeded = true;
        if (!disposed) {
          const message = onPublished();
          if (!disposed) report("success", `Authored fill color edit complete. ${message}`);
        }
      } catch {
        failure(publicationSucceeded);
      } finally {
        busy = false;
        if (!disposed) {
          try {
            if (acquired) activity.end();
          } catch {
            failure(publicationSucceeded);
          } finally {
            if (!disposed) {
              try { update(); } catch { failure(publicationSucceeded); }
            }
          }
        }
      }
    })();
  };
  form.addEventListener("submit", submit);
  update();
  return Object.freeze({
    syncSelection,
    setReady(value: boolean) {
      if (disposed) return;
      const changed = ready !== value;
      ready = value;
      syncSelection();
      if (changed && ready && !busy && !sharedBusy && !selectedShape()) report("idle", guidance());
    },
    setBusy(value: boolean) {
      if (disposed) return;
      if (!sharedBusy && value) {
        const current = getCurrent();
        // Own work clears local busy before END: retain origin across that callback.
        sharedOriginOwn = busy;
        sharedHadCurrent = current !== null;
        sharedDocumentId = current?.documentId;
        sharedRevisionId = current?.revisionId;
      }
      const externalSettlement = sharedBusy && !value && !sharedOriginOwn;
      sharedBusy = value;
      if (externalSettlement && ready) {
        const current = getCurrent();
        if ((current !== null) !== sharedHadCurrent || current?.documentId !== sharedDocumentId ||
          current?.revisionId !== sharedRevisionId) {
          // Inspector refresh consumes source changes while busy, so refresh guidance explicitly.
          syncSelection();
          const selected = selectedShape();
          report("idle", selected ? editing(selected.element) : guidance());
        }
      }
      update();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        form.removeEventListener("submit", submit);
      } finally {
        update();
      }
    },
  });
}
