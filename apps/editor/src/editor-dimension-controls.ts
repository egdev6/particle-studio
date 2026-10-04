import type { InspectorCurrent, InspectorSelection } from "./editor-element-inspector.js";
import type { ShapeDimensionsRequest } from "./editor-session.js";
import type { EditorImportActivity } from "./editor-json-import-controls.js";

interface DimensionControlsOptions {
  readonly form: HTMLFormElement;
  readonly dimensions: Readonly<Record<"width" | "height", HTMLInputElement>>;
  readonly button: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly activity: EditorImportActivity;
  readonly getSelection: () => InspectorSelection | null;
  readonly getCurrent: () => InspectorCurrent | null;
  readonly setShapeDimensions: (request: ShapeDimensionsRequest) => Promise<unknown>;
  readonly onPublished: () => string;
}

/** Borrows authored metadata only; the session owns publication and resources. */
export function mountEditorDimensionControls(options: DimensionControlsOptions) {
  const { form, dimensions, button, status, activity, getSelection, getCurrent, setShapeDimensions, onPublished } = options;
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
    status.dataset.dimensionStatus = state;
    status.textContent = message;
  };
  const guidance = () => getCurrent()
    ? "Select a published shape to edit its authored local width/height. Other elements remain read-only."
    : "Create a scene or import JSON first to edit published shape dimensions.";
  const update = () => {
    const disabled = disposed || !ready || busy || sharedBusy || !selectedShape();
    button.disabled = disabled;
    dimensions.width.disabled = disabled;
    dimensions.height.disabled = disabled;
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
      dimensions.width.value = selected ? String(selected.element.width) : "";
      dimensions.height.value = selected ? String(selected.element.height) : "";
      // Busy and same-source refreshes must not overwrite typed input or the
      // result of an action, including committed-publication render warnings.
      if (ready && !busy && !sharedBusy) report("idle", selected
        ? "Edit both authored local dimensions, then Apply dimensions." : guidance());
    }
    update();
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (disposed || !ready || busy || sharedBusy) return;
    const selected = selectedShape();
    if (!selected) return;
    const rawWidth = dimensions.width.value;
    const rawHeight = dimensions.height.value;
    if (!rawWidth.trim() || !rawHeight.trim()) {
      report("error", "Dimensions require nonempty finite positive width and height in local scene units.");
      return;
    }
    const request = Object.freeze({ documentId: selected.token.documentId, revisionId: selected.token.revisionId,
      elementId: selected.token.elementId, width: Number(rawWidth), height: Number(rawHeight) });
    if (!Number.isFinite(request.width) || !Number.isFinite(request.height) || request.width <= 0 || request.height <= 0) {
      report("error", "Dimensions require finite positive width and height in local scene units.");
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
    report("pending", `Dimension edit pending for ${request.documentId} / ${request.revisionId}.`);
    void (async () => {
      let publicationSucceeded = false;
      try {
        await setShapeDimensions(request);
        publicationSucceeded = true;
        if (!disposed) report("success", `Dimension edit complete. ${onPublished()}`);
      } catch {
        if (!disposed) report("error", publicationSucceeded
          ? "Dimensions published, but rendering failed. Refresh to view the published draft."
          : "Dimension edit failed. Check the selected shape and local PNG assets. If another tab changed this draft, refresh to review it.");
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
            ? "Edit both authored local dimensions, then Apply dimensions." : guidance());
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
