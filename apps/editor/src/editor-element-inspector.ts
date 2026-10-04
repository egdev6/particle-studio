import type { SceneDocumentV1 } from "@particle-studio/scene-document";

/** Borrowed publication metadata only: no image handles or release authority. */
export interface InspectorCurrent {
  readonly documentId: string;
  readonly revisionId: string;
  readonly document: SceneDocumentV1;
}
export interface InspectorSelection {
  readonly documentId: string;
  readonly revisionId: string;
  readonly elementId: string;
}
interface InspectorOptions {
  readonly select: HTMLSelectElement;
  readonly details: HTMLElement;
  readonly status: HTMLElement;
  readonly onSelectionChange?: () => void;
}

/** Ephemeral DOM selection; the caller owns publication and resource lifetimes. */
export function mountEditorElementInspector(options: InspectorOptions) {
  const { select, details, status, onSelectionChange } = options;
  let current: InspectorCurrent | null = null;
  let selectedId = "";
  let ready = false;
  let busy = false;
  let disposed = false;
  let notifiedSelection: InspectorSelection | null = null;
  const getSelection = (): InspectorSelection | null => {
    if (disposed || !ready || !current || !current.documentId || !current.revisionId ||
      !current.document.elements.some((element) => element.id === selectedId)) return null;
    return Object.freeze({ documentId: current.documentId, revisionId: current.revisionId, elementId: selectedId });
  };
  const notify = () => {
    const next = getSelection();
    if (next?.documentId === notifiedSelection?.documentId &&
      next?.revisionId === notifiedSelection?.revisionId && next?.elementId === notifiedSelection?.elementId) return;
    notifiedSelection = next;
    onSelectionChange?.();
  };

  const rebuildOptions = () => {
    const placeholder = select.ownerDocument.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose a scene element";
    select.replaceChildren(placeholder);
    for (const element of current?.document.elements ?? []) {
      const option = select.ownerDocument.createElement("option");
      option.value = element.id;
      option.textContent = `${element.id} (${element.type})`;
      select.append(option);
    }
  };
  const update = () => {
    const element = current?.document.elements.find((candidate) => candidate.id === selectedId);
    if (!element) selectedId = "";
    // Restore remembered selection even after a forced change while disabled.
    select.value = selectedId;
    select.disabled = !ready || !current || busy;
    details.textContent = element ? JSON.stringify(element, null, 2) : "";
    const source = current ? `Published source ${current.documentId} / ${current.revisionId}.` : "";
    if (busy) {
      status.textContent = `Inspection pending while an owned action settles. ${source}`;
    } else if (!ready) {
      status.textContent = "Element inspection unavailable until healthy startup.";
    } else if (!current) {
      status.textContent = "Create blank scene or import JSON to inspect published elements.";
    } else {
      status.textContent = `${source} ${element ? `Inspecting ${element.id} (${element.type}).` : "Choose a scene element to inspect."}`;
    }
    notify();
  };
  const change = () => {
    if (disposed) return;
    if (!ready || !current || busy) {
      update();
      return;
    }
    const element = current.document.elements.find((candidate) => candidate.id === select.value);
    selectedId = element?.id ?? "";
    update();
  };
  select.addEventListener("change", change);
  rebuildOptions();
  update();

  return Object.freeze({
    getSelection,
    setCurrent(value: InspectorCurrent | null) {
      if (disposed) return;
      if (current?.documentId !== value?.documentId || current?.revisionId !== value?.revisionId) {
        selectedId = "";
      }
      current = value;
      rebuildOptions();
      update();
    },
    setReady(value: boolean) {
      if (disposed) return;
      ready = value;
      update();
    },
    setBusy(value: boolean) {
      if (disposed) return;
      busy = value;
      update();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      select.removeEventListener("change", change);
      select.disabled = true;
      current = null;
      notify();
    },
  });
}
