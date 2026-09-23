export type StandaloneValidationIssue = {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly message?: string;
};

export type SceneDocumentV1StandaloneValidator = ((
  value: unknown,
) => boolean) & {
  readonly errors: readonly StandaloneValidationIssue[] | null;
};

export const SCENE_DOCUMENT_V1_VALIDATOR_CONTRACT: string;

declare const validateSceneDocumentV1: SceneDocumentV1StandaloneValidator;

export default validateSceneDocumentV1;
