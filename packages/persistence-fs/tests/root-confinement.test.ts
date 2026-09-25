import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  RootConfinementError,
  createRootConfinement,
  prepareCreateTarget,
  resolveExistingPath,
  verifyCreatedTarget,
} from "../src/index.js";

let fixture: string | undefined;

async function roots() {
  fixture = await mkdtemp(join(tmpdir(), "particle-studio-fs-"));
  const workspace = join(fixture, "workspace");
  const documents = join(fixture, "documents");
  const outputs = join(fixture, "outputs");
  await Promise.all([mkdir(workspace), mkdir(documents), mkdir(outputs)]);
  return { workspace, documents, outputs };
}

async function confinement() {
  return createRootConfinement(await roots());
}

function expectCode(code: RootConfinementError["code"]) {
  return expect.objectContaining({ code });
}

afterEach(async () => {
  if (fixture !== undefined) await rm(fixture, { recursive: true, force: true });
  fixture = undefined;
});

describe("root startup", () => {
  it("canonicalizes three distinct existing directory roots", async () => {
    const configured = await roots();
    const authority = await createRootConfinement(configured);
    await writeFile(join(configured.workspace, "present.txt"), "present");

    await expect(
      resolveExistingPath(authority, {
        role: "workspace",
        path: "present.txt",
      }),
    ).resolves.toMatchObject({
      role: "workspace",
      path: join(configured.workspace, "present.txt"),
    });
  });

  it("rejects non-absolute, unavailable, non-directory, equal, nested, and aliased roots", async () => {
    const configured = await roots();
    const file = join(fixture!, "file");
    const nested = join(configured.workspace, "nested");
    const alias = join(fixture!, "workspace-alias");
    await Promise.all([writeFile(file, "x"), mkdir(nested), symlink(configured.workspace, alias)]);

    await expect(
      createRootConfinement({ ...configured, workspace: "relative" }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_ROOT_INVALID"));
    await expect(
      createRootConfinement({ ...configured, workspace: join(fixture!, "missing") }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_ROOT_UNAVAILABLE"));
    await expect(
      createRootConfinement({ ...configured, workspace: file }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_ROOT_NOT_DIRECTORY"));
    await expect(
      createRootConfinement({ ...configured, documents: configured.workspace }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_ROOT_OVERLAP"));
    await expect(
      createRootConfinement({ ...configured, documents: nested }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_ROOT_OVERLAP"));
    await expect(
      createRootConfinement({ ...configured, documents: alias }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_ROOT_OVERLAP"));
  });

  it("does not mistake sibling-prefix directory names for nested roots", async () => {
    fixture = await mkdtemp(join(tmpdir(), "particle-studio-fs-"));
    const workspace = join(fixture, "root");
    const documents = join(fixture, "root-sibling");
    const outputs = join(fixture, "outputs");
    await Promise.all([mkdir(workspace), mkdir(documents), mkdir(outputs)]);
    await writeFile(join(documents, "foreign.txt"), "foreign");
    await symlink(documents, join(workspace, "root-sibling"));
    const authority = await createRootConfinement({
      workspace,
      documents,
      outputs,
    });

    await expect(
      resolveExistingPath(authority, {
        role: "workspace",
        path: "root-sibling/foreign.txt",
      }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_EXISTING_PATH_OUTSIDE_ROLE"));
  });
});

describe("operation-bound existing paths", () => {
  it("resolves an existing path only after canonical containment in its bound role", async () => {
    const configured = await roots();
    const authority = await createRootConfinement(configured);
    await writeFile(join(configured.documents, "draft.json"), "{}");
    await symlink(configured.documents, join(configured.workspace, "documents-link"));

    await expect(
      resolveExistingPath(authority, { role: "documents", path: "draft.json" }),
    ).resolves.toMatchObject({ role: "documents" });
    await expect(
      resolveExistingPath(authority, {
        role: "workspace",
        path: "documents-link/draft.json",
      }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_EXISTING_PATH_OUTSIDE_ROLE"));
  });

  it("rejects ambiguous, traversal, absolute, device, UNC, and NUL operation paths", async () => {
    const authority = await confinement();
    for (const path of [
      "",
      ".",
      "./entry",
      "entry/",
      "../entry",
      "entry/../other",
      "/absolute",
      "\\\\server\\share",
      "\\\\?\\C:\\device",
      "C:\\device",
      "entry\u0000suffix",
      "CON",
      "prn.txt",
      "Aux.JSON",
      "NUL.data",
      "COM1",
      "com2.txt",
      "COM3",
      "com4.txt",
      "COM5",
      "com6.txt",
      "COM7",
      "com8.txt",
      "COM9",
      "LPT1",
      "lpt2.txt",
      "LPT3",
      "lpt4.txt",
      "LPT5",
      "lpt6.txt",
      "LPT7",
      "lpt8.txt",
      "LPT9",
      "entry:stream",
      "nested:stream/entry",
      "nested/entry:stream",
      "entry.",
      "entry ",
      "nested./entry",
      "nested/entry ",
    ]) {
      await expect(
        resolveExistingPath(authority, { role: "workspace", path }),
      ).rejects.toThrow(expectCode("PERSISTENCE_FS_OPERATION_PATH_INVALID"));
    }
    await expect(
      resolveExistingPath(authority, { role: "other" as never, path: "entry" }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_ROLE_INVALID"));
  });

  it("preserves ordinary dot-containing operation components", async () => {
    const configured = await roots();
    const authority = await createRootConfinement(configured);
    await mkdir(join(configured.workspace, "revisions"));
    await writeFile(join(configured.workspace, "revisions", "draft.v1.json"), "{}");

    await expect(
      resolveExistingPath(authority, {
        role: "workspace",
        path: "revisions/draft.v1.json",
      }),
    ).resolves.toMatchObject({
      path: join(configured.workspace, "revisions", "draft.v1.json"),
    });
    await expect(
      prepareCreateTarget(authority, {
        role: "workspace",
        path: "revisions/draft.v2.json",
      }),
    ).resolves.toMatchObject({
      leafName: "draft.v2.json",
      targetPath: join(configured.workspace, "revisions", "draft.v2.json"),
    });
  });

  it("fails closed for missing targets and symlink escapes", async () => {
    const configured = await roots();
    const authority = await createRootConfinement(configured);
    const outside = join(fixture!, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "secret");
    await symlink(outside, join(configured.workspace, "escape"));

    await expect(
      resolveExistingPath(authority, { role: "workspace", path: "missing" }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_EXISTING_PATH_UNAVAILABLE"));
    await expect(
      resolveExistingPath(authority, { role: "workspace", path: "escape/secret" }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_EXISTING_PATH_OUTSIDE_ROLE"));
  });
});

describe("operation-bound create targets", () => {
  it("returns only a canonical verified parent, leaf, and target before a writer creates it", async () => {
    const configured = await roots();
    const authority = await createRootConfinement(configured);
    const nested = join(configured.outputs, "nested");
    const nestedAlias = join(configured.outputs, "nested-alias");
    await mkdir(nested);
    await symlink(nested, nestedAlias);

    await expect(
      prepareCreateTarget(authority, {
        role: "outputs",
        path: "nested-alias/result.json",
      }),
    ).resolves.toMatchObject({
      role: "outputs",
      parentPath: nested,
      leafName: "result.json",
      targetPath: join(nested, "result.json"),
    });
  });

  it("rejects pre-existing leaves, missing or non-directory parents, symlink escapes, and cross-role parents", async () => {
    const configured = await roots();
    const authority = await createRootConfinement(configured);
    const parentFile = join(configured.outputs, "parent-file");
    const outside = join(fixture!, "outside");
    await Promise.all([writeFile(join(configured.outputs, "exists"), "x"), writeFile(parentFile, "x"), mkdir(outside)]);
    await symlink(outside, join(configured.outputs, "escape"));
    await symlink(configured.documents, join(configured.outputs, "documents-link"));

    await expect(
      prepareCreateTarget(authority, { role: "outputs", path: "exists" }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_CREATE_TARGET_EXISTS"));
    await expect(
      prepareCreateTarget(authority, { role: "outputs", path: "missing/leaf" }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_CREATE_PARENT_UNAVAILABLE"));
    await expect(
      prepareCreateTarget(authority, { role: "outputs", path: "parent-file/leaf" }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_CREATE_PARENT_NOT_DIRECTORY"));
    await expect(
      prepareCreateTarget(authority, { role: "outputs", path: "escape/leaf" }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_CREATE_TARGET_OUTSIDE_ROLE"));
    await expect(
      prepareCreateTarget(authority, { role: "outputs", path: "documents-link/leaf" }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_CREATE_TARGET_OUTSIDE_ROLE"));
  });

  it("applies the same path grammar to create targets", async () => {
    const authority = await confinement();
    for (const path of [
      "",
      ".",
      "child/../leaf",
      "/leaf",
      "C:\\leaf",
      "leaf\u0000suffix",
      "CON",
      "prn.txt",
      "Aux.JSON",
      "NUL.data",
      "COM1",
      "com2.txt",
      "COM3",
      "com4.txt",
      "COM5",
      "com6.txt",
      "COM7",
      "com8.txt",
      "COM9",
      "LPT1",
      "lpt2.txt",
      "LPT3",
      "lpt4.txt",
      "LPT5",
      "lpt6.txt",
      "LPT7",
      "lpt8.txt",
      "LPT9",
      "leaf:stream",
      "nested:stream/leaf",
      "nested/leaf:stream",
      "leaf.",
      "leaf ",
      "nested./leaf",
      "nested/leaf ",
    ]) {
      await expect(
        prepareCreateTarget(authority, { role: "outputs", path }),
      ).rejects.toThrow(expectCode("PERSISTENCE_FS_OPERATION_PATH_INVALID"));
    }
  });

  it("rechecks created targets through realpath before exposing them", async () => {
    const configured = await roots();
    const authority = await createRootConfinement(configured);
    const prepared = await prepareCreateTarget(authority, {
      role: "outputs",
      path: "result.json",
    });
    await writeFile(prepared.targetPath, "created");

    await expect(verifyCreatedTarget(authority, prepared)).resolves.toMatchObject({
      role: "outputs",
      path: join(configured.outputs, "result.json"),
    });
  });

  it("fails closed when the created name is missing or resolves outside its prepared role", async () => {
    const configured = await roots();
    const authority = await createRootConfinement(configured);
    const missing = await prepareCreateTarget(authority, {
      role: "outputs",
      path: "missing.json",
    });
    const escaped = await prepareCreateTarget(authority, {
      role: "outputs",
      path: "escaped.json",
    });
    const outside = join(fixture!, "outside.json");
    await writeFile(outside, "outside");
    await symlink(outside, escaped.targetPath);

    await expect(verifyCreatedTarget(authority, missing)).rejects.toThrow(
      expectCode("PERSISTENCE_FS_CREATED_TARGET_UNAVAILABLE"),
    );
    await expect(verifyCreatedTarget(authority, escaped)).rejects.toThrow(
      expectCode("PERSISTENCE_FS_CREATED_TARGET_OUTSIDE_ROLE"),
    );
    await expect(
      verifyCreatedTarget(authority, {
        role: "outputs",
        parentPath: configured.outputs,
        leafName: "forged.json",
        targetPath: join(configured.outputs, "forged.json"),
      }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_PREPARED_TARGET_INVALID"));
  });
});
