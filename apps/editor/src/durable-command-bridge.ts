import {
  createCommandSession,
  type CommandSession,
  type ElementIdSource,
} from "@particle-studio/commands";
import type { SceneDocumentV1 } from "@particle-studio/scene-document";

type SessionResult = ReturnType<CommandSession["dispatch"]>;
type DurablePublishFailure = {
  readonly ok: false;
  readonly error: { readonly code: "DURABLE_PUBLISH_FAILED" };
};

export type DurableCommandBridgeResult = SessionResult | DurablePublishFailure;

export type DurableCommandBridge = {
  dispatch(command: unknown): Promise<DurableCommandBridgeResult>;
  undo(): Promise<DurableCommandBridgeResult>;
  redo(): Promise<DurableCommandBridgeResult>;
  snapshot(): ReturnType<CommandSession["snapshot"]>;
};

export type DurableCommandBridgeOptions = {
  readonly documentId: string;
  readonly document: SceneDocumentV1;
  readonly idSource?: ElementIdSource;
  readonly publish: (candidate: SceneDocumentV1) => Promise<void>;
};

const durablePublishFailure = (): DurablePublishFailure => ({
  ok: false,
  error: { code: "DURABLE_PUBLISH_FAILED" },
});

class EditorDurableCommandBridge implements DurableCommandBridge {
  #active: CommandSession;
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: DurableCommandBridgeOptions) {
    this.#active = createCommandSession(
      options.documentId,
      options.document,
      options.idSource,
    );
  }

  dispatch(command: unknown): Promise<DurableCommandBridgeResult> {
    let isolatedCommand: unknown;
    try {
      isolatedCommand = structuredClone(command);
    } catch {
      isolatedCommand = undefined;
    }
    return this.#enqueue((session) => session.dispatch(isolatedCommand));
  }

  undo(): Promise<DurableCommandBridgeResult> {
    return this.#enqueue((session) => session.undo());
  }

  redo(): Promise<DurableCommandBridgeResult> {
    return this.#enqueue((session) => session.redo());
  }

  snapshot(): ReturnType<CommandSession["snapshot"]> {
    return this.#active.snapshot();
  }

  #enqueue(
    operation: (session: CommandSession) => SessionResult,
  ): Promise<DurableCommandBridgeResult> {
    const result = this.#tail.then(() => this.#publishOperation(operation));
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #publishOperation(
    operation: (session: CommandSession) => SessionResult,
  ): Promise<DurableCommandBridgeResult> {
    try {
      const candidate = this.#active.fork();
      const result = operation(candidate);
      if (!result.ok) return result;

      const publication: unknown = await this.options.publish(
        candidate.snapshot().document,
      );
      if (publication !== undefined) return durablePublishFailure();
      this.#active = candidate;
      return result;
    } catch {
      return durablePublishFailure();
    }
  }
}

export function createDurableCommandBridge(
  options: DurableCommandBridgeOptions,
): DurableCommandBridge {
  return new EditorDurableCommandBridge(options);
}
