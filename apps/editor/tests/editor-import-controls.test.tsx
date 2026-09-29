import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

import {
  EditorImportControls,
  type EditorImportRequest,
} from "../src/editor-import-controls.js";

const IMAGE_ERROR = "Image import failed. Check the PNG file, then try again.";
const JSON_ERROR = "Editable JSON import failed. Check the JSON, then try again.";
const MISSING_FILE = "Select a PNG file to import.";

function pngFile(name = "particles.png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

function renderControls(
  workflow: (request: EditorImportRequest) => Promise<unknown> = vi.fn(async () => "ignored"),
) {
  const view = render(<EditorImportControls workflow={workflow} />);
  const scope = within(view.container);
  return {
    ...scope,
    workflow,
    selectPngFile(file: File) {
      fireEvent.change(scope.getByLabelText("PNG file"), { target: { files: [file] } });
    },
    typeEditableJson(text: string) {
      fireEvent.change(scope.getByLabelText("Editable JSON"), { target: { value: text } });
    },
    importImage() {
      fireEvent.click(scope.getByRole("button", { name: "Import image" }));
    },
    importEditableJson() {
      fireEvent.click(scope.getByRole("button", { name: "Import editable JSON" }));
    },
  };
}

describe("editor import controls", () => {
  afterEach(cleanup);

  it("starts idle with native, labelled controls and an accessible status", () => {
    const view = renderControls();
    expect(view.getByRole("status").textContent).toBe("No import yet.");
    const fileInput = view.getByLabelText("PNG file");
    expect(fileInput.getAttribute("type")).toBe("file");
    expect(fileInput.getAttribute("accept")).toBe("image/png");
    expect(view.getByLabelText("Editable JSON").tagName).toBe("TEXTAREA");
    for (const name of ["Import image", "Import editable JSON"]) {
      const button = view.getByRole("button", { name });
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
    }
    expect(view.workflow).not.toHaveBeenCalled();
  });

  it("forwards the selected PNG file alone on image import and ignores the returned value", async () => {
    const file = pngFile();
    const view = renderControls();
    view.selectPngFile(file);
    view.typeEditableJson('{"tracks":[]}');
    view.importImage();
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Import complete."));
    expect(view.workflow).toHaveBeenCalledExactlyOnceWith({ kind: "image-import", file });
  });

  it("imports edited JSON alone without any file selected and ignores the returned value", async () => {
    const view = renderControls();
    view.typeEditableJson('{"tracks":[]}');
    view.importEditableJson();
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Import complete."));
    expect(view.workflow).toHaveBeenCalledExactlyOnceWith({
      kind: "editable-json-import",
      editableJson: '{"tracks":[]}',
    });
  });

  it("reports a missing PNG file with an alert and never invokes the workflow", async () => {
    const view = renderControls();
    view.importImage();
    expect(view.getByRole("alert").textContent).toBe(MISSING_FILE);
    expect(view.workflow).not.toHaveBeenCalled();
    view.selectPngFile(pngFile());
    view.importImage();
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Import complete."));
  });

  it("surfaces stable per-action alerts without leaking internals on failure", async () => {
    const syncThrow = renderControls(
      vi.fn(() => {
        throw new Error("sha worker exploded with internal detail");
      }),
    );
    syncThrow.selectPngFile(pngFile());
    syncThrow.importImage();
    await waitFor(() => expect(syncThrow.getByRole("alert").textContent).toBe(IMAGE_ERROR));
    expect(syncThrow.getByRole("alert").textContent).not.toContain("sha worker");

    const asyncReject = renderControls(
      vi.fn(async (request: EditorImportRequest) => {
        if (request.kind === "editable-json-import") {
          throw new Error("durable write failed with credential detail");
        }
        return "ignored";
      }),
    );
    asyncReject.typeEditableJson("{}");
    asyncReject.importEditableJson();
    await waitFor(() => expect(asyncReject.getByRole("alert").textContent).toBe(JSON_ERROR));
    expect(asyncReject.getByRole("alert").textContent).not.toContain("credential");
  });

  it("retries by re-running the same action with corrected current input after sync failure", async () => {
    const workflow = vi.fn((request: EditorImportRequest): Promise<unknown> | never => {
      if (request.kind === "editable-json-import" && request.editableJson === "broken") {
        throw new Error("internal detail");
      }
      return Promise.resolve("ignored");
    });
    const view = renderControls(workflow);
    view.typeEditableJson("broken");
    view.importEditableJson();
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe(JSON_ERROR));
    view.typeEditableJson('{"fixed":true}');
    view.importEditableJson();
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Import complete."));
    expect(view.workflow).toHaveBeenCalledTimes(2);
    expect(view.workflow).toHaveBeenLastCalledWith({
      kind: "editable-json-import",
      editableJson: '{"fixed":true}',
    });
  });

  it("retries by re-running the same action with corrected current input after async failure", async () => {
    let failImageImport = true;
    const workflow = vi.fn(async (request: EditorImportRequest) => {
      if (request.kind === "image-import" && failImageImport) {
        throw new Error("internal detail");
      }
      return "ignored";
    });
    const view = renderControls(workflow);
    const staleFile = pngFile("stale.png");
    view.selectPngFile(staleFile);
    view.importImage();
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe(IMAGE_ERROR));
    failImageImport = false;
    const correctedFile = pngFile("corrected.png");
    view.selectPngFile(correctedFile);
    view.importImage();
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Import complete."));
    expect(view.workflow).toHaveBeenCalledTimes(2);
    expect(view.workflow).toHaveBeenLastCalledWith({ kind: "image-import", file: correctedFile });
  });

  it("guards rapid repeated activation while pending and disables both actions", async () => {
    let resolveImport: (value: unknown) => void = () => {};
    const workflow = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveImport = resolve;
        }),
    );
    const view = renderControls(workflow);
    view.selectPngFile(pngFile());
    view.importImage();
    view.importImage();
    expect(view.workflow).toHaveBeenCalledTimes(1);
    expect(view.getByRole("status").textContent).toBe("Import in progress.");
    expect((view.getByLabelText("PNG file") as HTMLInputElement).disabled).toBe(true);
    expect((view.getByLabelText("Editable JSON") as HTMLTextAreaElement).disabled).toBe(true);
    for (const name of ["Import image", "Import editable JSON"]) {
      expect((view.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    resolveImport("ignored");
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Import complete."));
    expect(view.workflow).toHaveBeenCalledTimes(1);
  });

  it("guards cross-action same-tick activation triggered from inside the workflow", async () => {
    let jsonButton: HTMLButtonElement | null = null;
    const workflow = vi.fn(async (request: EditorImportRequest) => {
      if (request.kind === "image-import") {
        fireEvent.click(jsonButton as HTMLButtonElement);
      }
      return "ignored";
    });
    const view = renderControls(workflow);
    jsonButton = view.getByRole("button", { name: "Import editable JSON" }) as HTMLButtonElement;
    view.selectPngFile(pngFile());
    view.importImage();
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Import complete."));
    expect(view.workflow).toHaveBeenCalledTimes(1);
    expect(view.workflow).toHaveBeenCalledWith({ kind: "image-import", file: expect.any(File) });
  });

  it("gives each mounted instance its own label associations and input ids", () => {
    const first = renderControls();
    const second = renderControls();
    const inputs = [first, second].map(
      (view) => view.getByLabelText("PNG file") as HTMLInputElement,
    );
    const textareas = [first, second].map(
      (view) => view.getByLabelText("Editable JSON") as HTMLTextAreaElement,
    );
    expect(inputs[0]?.id).not.toBe("");
    expect(inputs[0]?.id).not.toBe(inputs[1]?.id);
    expect(textareas[0]?.id).not.toBe(textareas[1]?.id);
    expect(textareas[0]?.id).not.toBe("");
  });
});
