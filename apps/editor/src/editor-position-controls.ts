import type { InspectorCurrent, InspectorSelection } from "./editor-element-inspector.js";
import type { ShapePositionRequest } from "./editor-session.js";
import type { EditorImportActivity } from "./editor-json-import-controls.js";

interface PositionControlsOptions {
  readonly form: HTMLFormElement;
  readonly position: Readonly<Record<"x" | "y", HTMLInputElement>>;
  readonly button: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly activity: EditorImportActivity;
  readonly getSelection: () => InspectorSelection | null;
  readonly getCurrent: () => InspectorCurrent | null;
  readonly setShapePosition: (request: ShapePositionRequest) => Promise<unknown>;
  readonly onPublished: () => string;
}

/** Borrows authored metadata only; the session owns publication and resources. */
export function mountEditorPositionControls(options: PositionControlsOptions) {
  const { form, position, button, status, activity, getSelection, getCurrent, setShapePosition, onPublished } = options;
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
    status.dataset.positionStatus = state;
    status.textContent = message;
  };
  const guidance = () => getCurrent()
    ? "Select a published shape to edit its authored local X/Y position. Other elements remain read-only."
    : "Create a scene or import JSON first to edit a published shape position.";
  const update = () => {
    const disabled = disposed || !ready || busy || sharedBusy || !selectedShape();
    button.disabled = disabled;
    position.x.disabled = disabled;
    position.y.disabled = disabled;
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
      position.x.value = selected ? String(selected.element.x) : "";
      position.y.value = selected ? String(selected.element.y) : "";
      // Busy and same-source refreshes must not overwrite typed input or the
      // result of an action, including committed-publication render warnings.
      if (ready && !busy && !sharedBusy) report("idle", selected
        ? "Edit both authored local coordinates, then Apply position." : guidance());
    }
    update();
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (disposed || !ready || busy || sharedBusy) return;
    const selected = selectedShape();
    if (!selected) return;
    const rawX = position.x.value;
    const rawY = position.y.value;
    if (!rawX.trim() || !rawY.trim()) {
      report("error", "Position requires nonempty finite X and Y in local scene units.");
      return;
    }
    const request = Object.freeze({ documentId: selected.token.documentId, revisionId: selected.token.revisionId,
      elementId: selected.token.elementId, x: Number(rawX), y: Number(rawY) });
    if (!Number.isFinite(request.x) || !Number.isFinite(request.y)) {
      report("error", "Position requires finite X and Y in local scene units.");
      return;
    }
    // Capture the entire pair and source before begin can synchronously refresh
    // controls or mutate inputs. Metadata is never permission to bypass the lane.
    busy = true;
    if (!activity.begin()) {
      busy = false;
      update();
      return;
    }
    update();
    report("pending", `Position edit pending for ${request.documentId} / ${request.revisionId}.`);
    void (async () => {
      let publicationSucceeded = false;
      try {
        await setShapePosition(request);
        publicationSucceeded = true;
        if (!disposed) report("success", `Position edit complete. ${onPublished()}`);
      } catch {
        if (!disposed) report("error", publicationSucceeded
          ? "Position published, but rendering failed. Refresh to view the published draft."
          : "Position edit failed. Check the selected shape and local PNG assets. If another tab changed this draft, refresh to review it.");
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
        // Capture origin now: own work resets busy before activity.end, and its
        // publication result or render warning must survive shared settlement.
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
          // Inspection refreshes while shared-busy, consuming selection changes
          // without reporting guidance. Also cover blank's null-to-current source.
          syncSelection();
          report("idle", selectedShape()
            ? "Edit both authored local coordinates, then Apply position." : guidance());
        }
      }
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
