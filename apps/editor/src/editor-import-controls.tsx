import { useId, useRef, useState } from "react";

export type EditorImportRequest =
  | { readonly kind: "image-import"; readonly file: File }
  | { readonly kind: "editable-json-import"; readonly editableJson: string };

export type EditorImportWorkflow = (request: EditorImportRequest) => Promise<unknown>;

export type EditorImportStatus = "idle" | "pending" | "success" | "error";

const IDLE_MESSAGE = "No import yet.";
const PENDING_MESSAGE = "Import in progress.";
const SUCCESS_MESSAGE = "Import complete.";
const MISSING_FILE_MESSAGE = "Select a PNG file to import.";
const IMAGE_ERROR_MESSAGE = "Image import failed. Check the PNG file, then try again.";
const JSON_ERROR_MESSAGE = "Editable JSON import failed. Check the JSON, then try again.";

export function EditorImportControls({
  workflow,
}: {
  readonly workflow: EditorImportWorkflow;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [editableJson, setEditableJson] = useState("");
  const [status, setStatus] = useState<EditorImportStatus>("idle");
  const [message, setMessage] = useState(IDLE_MESSAGE);
  const pendingRef = useRef(false);
  const fileInputId = useId();
  const jsonInputId = useId();

  const runImport = async (
    request: EditorImportRequest,
    failureMessage: string,
  ): Promise<void> => {
    if (pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    setStatus("pending");
    setMessage(PENDING_MESSAGE);
    try {
      await workflow(request);
      setStatus("success");
      setMessage(SUCCESS_MESSAGE);
    } catch {
      setStatus("error");
      setMessage(failureMessage);
    } finally {
      pendingRef.current = false;
    }
  };

  const handleImageImportClick = (): void => {
    if (pendingRef.current) {
      return;
    }
    if (file === null) {
      setStatus("error");
      setMessage(MISSING_FILE_MESSAGE);
      return;
    }
    void runImport({ kind: "image-import", file }, IMAGE_ERROR_MESSAGE);
  };

  const handleJsonImportClick = (): void => {
    if (pendingRef.current) {
      return;
    }
    void runImport({ kind: "editable-json-import", editableJson }, JSON_ERROR_MESSAGE);
  };

  const pending = status === "pending";
  return (
    <section aria-label="Editor import controls">
      <div>
        <label htmlFor={fileInputId}>PNG file</label>
        <input
          id={fileInputId}
          type="file"
          accept="image/png"
          disabled={pending}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
          }}
        />
      </div>
      <div>
        <label htmlFor={jsonInputId}>Editable JSON</label>
        <textarea
          id={jsonInputId}
          value={editableJson}
          disabled={pending}
          onChange={(event) => {
            setEditableJson(event.target.value);
          }}
        />
      </div>
      <button type="button" disabled={pending} onClick={handleImageImportClick}>
        Import image
      </button>
      <button type="button" disabled={pending} onClick={handleJsonImportClick}>
        Import editable JSON
      </button>
      {status === "error" ? (
        <p role="alert">{message}</p>
      ) : (
        <p role="status">{message}</p>
      )}
    </section>
  );
}
