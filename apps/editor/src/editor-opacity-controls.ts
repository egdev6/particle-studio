import type { InspectorCurrent, InspectorSelection } from "./editor-element-inspector.js";
import type { ShapeOpacityRequest } from "./editor-session.js";
import type { EditorImportActivity } from "./editor-json-import-controls.js";

interface OpacityControlsOptions {
  readonly form: HTMLFormElement;
  readonly opacity: HTMLInputElement;
  readonly button: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly activity: EditorImportActivity;
  readonly getSelection: () => InspectorSelection | null;
  readonly getCurrent: () => InspectorCurrent | null;
  readonly setShapeOpacity: (request: ShapeOpacityRequest) => Promise<unknown>;
  readonly onPublished: () => string;
}

/** Borrows authored metadata only; publication and resource ownership stay with the session. */
export function mountEditorOpacityControls(options: OpacityControlsOptions) {
  const { form, opacity, button, status, activity, getSelection, getCurrent, setShapeOpacity, onPublished } = options;
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
    status.dataset.opacityStatus = state;
    status.textContent = message;
  };
  const failure = (published: boolean) => {
    if (disposed) return;
    try {
      report("error", published
        ? "Opacity published, but rendering failed. Refresh to view the published draft; tracks may override authored opacity."
        : "Opacity edit failed. Check the selected shape and local PNG assets. If another tab changed this draft, refresh to review it.");
    } catch {
      // A broken status node must not prevent lane settlement or trigger recursive reporting.
    }
  };
  const guidance = () => getCurrent()
    ? "Select a published shape to edit its authored opacity. Other elements remain read-only."
    : "Create a scene or import JSON first to edit published shape opacity.";
  const editing = "Edit authored opacity from 0 to 1, then Apply opacity. Animation tracks may override it.";
  const update = () => {
    const disabled = disposed || !ready || busy || sharedBusy || !selectedShape();
    button.disabled = disabled;
    opacity.disabled = disabled;
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
      opacity.value = selected ? String(selected.element.opacity) : "";
      // Preserve typed values on same-source refresh and own feedback during shared work.
      if (ready && !busy && !sharedBusy) report("idle", selected ? editing : guidance());
    }
    update();
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (disposed || !ready || busy || sharedBusy) return;
    const selected = selectedShape();
    if (!selected) return;
    const raw = opacity.value;
    if (!raw.trim()) {
      report("error", "Opacity requires a nonempty finite value from 0 to 1.");
      return;
    }
    const request = Object.freeze({ documentId: selected.token.documentId, revisionId: selected.token.revisionId,
      elementId: selected.token.elementId, opacity: Number(raw) });
    if (!Number.isFinite(request.opacity) || request.opacity < 0 || request.opacity > 1) {
      report("error", "Opacity requires a finite value from 0 to 1.");
      return;
    }
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
        report("pending", `Opacity edit pending for ${request.documentId} / ${request.revisionId}.`);
        await setShapeOpacity(request);
        publicationSucceeded = true;
        if (!disposed) {
          const message = onPublished();
          if (!disposed) report("success", `Authored opacity edit complete; animation tracks may override it. ${message}`);
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
          report("idle", selectedShape() ? editing : guidance());
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
