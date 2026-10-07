import type { InspectorCurrent, InspectorSelection } from "./editor-element-inspector.js";
import type { ShapeVisibilityRequest } from "./editor-session.js";
import type { EditorImportActivity } from "./editor-json-import-controls.js";

export interface VisibilityControlsOptions {
  readonly form: HTMLFormElement;
  readonly visible: HTMLInputElement;
  readonly button: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly activity: EditorImportActivity;
  readonly getSelection: () => InspectorSelection | null;
  readonly getCurrent: () => InspectorCurrent | null;
  readonly setShapeVisibility: (request: ShapeVisibilityRequest) => Promise<void>;
  readonly onPublished: () => string;
}

/** Borrows authored metadata only; publication and resource ownership stay with the session. */
export function mountEditorVisibilityControls(options: VisibilityControlsOptions) {
  const { form, visible, button, status, activity, getSelection, getCurrent, setShapeVisibility, onPublished } = options;
  let ready = false;
  let busy = false;
  let sharedBusy = false;
  let sharedOriginOwn = false;
  let sharedHadCurrent = false;
  let sharedDocumentId: string | undefined;
  let sharedRevisionId: string | undefined;
  let disposed = false;
  let remembered: InspectorSelection | null = null;
  const inheritedHidden = (doc: InspectorCurrent["document"], target: string) => {
    const seen = new Set<string>();
    const walk = (id: string, hidden: boolean): boolean => {
      const element = doc.elements.find((candidate) => candidate.id === id);
      if (!element || seen.has(id)) return false;
      seen.add(id);
      if (id === target) return hidden;
      return element.type === "group" && element.childrenIds.some((child) => walk(child, hidden || element.visible === false));
    };
    return doc.rootIds.some((root) => walk(root, false));
  };
  const selectedShape = () => {
    const token = getSelection();
    const current = getCurrent();
    if (!token || !current || token.documentId !== current.documentId || token.revisionId !== current.revisionId) return null;
    const element = current.document.elements.find((candidate) => candidate.id === token.elementId);
    return element?.type === "shape"
      ? { token, element, hidden: inheritedHidden(current.document, token.elementId) }
      : null;
  };
  const report = (state: string, message: string) => {
    status.dataset.visibilityStatus = state;
    status.textContent = message;
  };
  const failure = (published: boolean) => {
    if (disposed) return;
    try {
      report("error", published
        ? "Visibility published, but rendering failed. Refresh to view the published draft."
        : "Visibility edit failed. Check the selected shape. Other elements remain read-only. If another tab changed this draft, refresh to review it.");
    } catch {
      // A broken status node must not prevent lane settlement or trigger recursive reporting.
    }
  };
  const guidance = () => getCurrent()
    ? "Select a published shape to edit its authored visibility. Other elements remain read-only."
    : "Create a scene or import JSON first to edit a published shape visibility.";
  const editing = (hidden: boolean) => hidden
    ? "This shape sits inside a hidden ancestor group, so it stays hidden until that ancestor is visible. Authored visibility is optional."
    : "Set whether this published shape is drawn. An absent authored flag defaults to visible.";
  const update = () => {
    const disabled = disposed || !ready || busy || sharedBusy || !selectedShape();
    button.disabled = disabled;
    visible.disabled = disabled;
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
      visible.checked = selected?.element.visible ?? true;
      // Preserve the typed draft on same-source refresh and own feedback during shared work.
      if (ready && !busy && !sharedBusy) report("idle", selected ? editing(selected.hidden) : guidance());
    }
    update();
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (disposed || !ready || busy || sharedBusy) return;
    const selected = selectedShape();
    if (!selected) return;
    const checked = visible.checked;
    // Re-check after the value read: a synchronous getter must not reenter past this snapshot.
    if (disposed || !ready || busy || sharedBusy) return;
    const request = Object.freeze({ documentId: selected.token.documentId, revisionId: selected.token.revisionId,
      elementId: selected.token.elementId, visible: checked });
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
        report("pending", `Visibility edit pending for ${request.documentId} / ${request.revisionId}.`);
        await setShapeVisibility(request);
        publicationSucceeded = true;
        if (!disposed) {
          const message = onPublished();
          if (!disposed) report("success", `Authored visibility edit complete. ${message}`);
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
          report("idle", selected ? editing(selected.hidden) : guidance());
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
