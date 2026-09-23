import { createHash } from "node:crypto";
import {
  readFile,
  lstat,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";
import { canonicalize } from "json-canonicalize";
import { SceneDocumentV1Schema } from "../src/schemas/scene-document-v1.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generated = resolve(
  packageRoot,
  "src/generated/scene-document-v1-validator.generated.mjs",
);
const expectedHashFile = generated.replace(/\.mjs$/, ".sha256");
const expectedContractFile = resolve(
  packageRoot,
  "src/validation/scene-document-v1-validator-contract.ts",
);
const scratch = resolve(
  packageRoot,
  "../../node_modules/.cache/particle-studio/scene-document-validator",
);
const options = {
  strict: true,
  code: { esm: true, source: true, lines: true },
} as const;
const versions = { "@sinclair/typebox": "0.34.52", ajv: "8.20.0" };

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(source: string) {
  return source.replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");
}

async function expected(file: string, pattern: RegExp) {
  const value = (await readFile(file, "utf8")).match(pattern)?.[1];
  if (!value) throw new Error(`VALIDATOR_EXPECTED_VALUE_INVALID:${file}`);
  return value;
}

async function contract() {
  const generator = await readFile(fileURLToPath(import.meta.url));
  const manifest = canonicalize({
    contractVersion: "particle-studio-validator-contract-v1",
    schemaId: SceneDocumentV1Schema.$id,
    schema: { ...SceneDocumentV1Schema },
    generatorSha256: sha256(generator),
    versions,
    options,
    exportShape: "default-validator-plus-contract-v1",
    normalization: "lf-one-terminal-newline-v1",
  });
  return `sha256:${sha256(manifest)}`;
}

function candidate(fingerprint: string) {
  const ajv = new Ajv2020(options);
  const source = standaloneCode(ajv, ajv.compile(SceneDocumentV1Schema));
  return normalize(
    `${source}\nexport const SCENE_DOCUMENT_V1_VALIDATOR_CONTRACT = ${JSON.stringify(fingerprint)};\n`,
  );
}

function assertSafe(source: string) {
  if (
    /from\s+["'](?:@sinclair\/typebox|ajv)/.test(source) ||
    /\b(?:eval|Function)\s*\(/.test(source)
  ) {
    throw new Error("VALIDATOR_GENERATED_RUNTIME_UNSAFE");
  }
}

async function candidates() {
  const fingerprint = await contract();
  const first = candidate(fingerprint);
  const second =
    process.env.PARTICLE_STUDIO_TEST_ALTER_SECOND_CANDIDATE === "1"
      ? `${candidate(fingerprint)}// test drift\n`
      : candidate(fingerprint);
  assertSafe(first);
  assertSafe(second);
  if (first !== second) throw new Error("VALIDATOR_CANDIDATES_DIFFER");
  return { fingerprint, source: first, hash: sha256(first) };
}

async function checkedCandidates() {
  const result = await candidates();
  const expectedContract = await expected(
    expectedContractFile,
    /"(sha256:[a-f0-9]{64})"/,
  );
  const expectedHash = await expected(expectedHashFile, /^([a-f0-9]{64})\n$/);
  if (result.fingerprint !== expectedContract)
    throw new Error(`VALIDATOR_CONTRACT_MISMATCH:${result.fingerprint}`);
  if (result.hash !== expectedHash)
    throw new Error(`VALIDATOR_FULL_SHA_MISMATCH:${result.hash}`);
  return result;
}

async function generate() {
  await rm(generated, { force: true });
  const result = await checkedCandidates();
  const temporary = `${generated}.tmp-${process.pid}`;
  await rm(temporary, { force: true });
  await writeFile(temporary, result.source, { encoding: "utf8", flag: "wx" });
  await rename(temporary, generated);
  console.log(`contract=${result.fingerprint}\nsha256=${result.hash}`);
}

async function verify() {
  const result = await checkedCandidates();
  const info = await lstat(generated).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink())
    throw new Error("VALIDATOR_GENERATED_OUTPUT_MISSING_OR_UNSAFE");
  const installed = await readFile(generated, "utf8");
  if (installed !== result.source || sha256(installed) !== result.hash)
    throw new Error("VALIDATOR_INSTALLED_BYTES_MISMATCH");
}

async function main() {
  const mode = process.argv[2];
  try {
    if (mode === "clean") return await rm(generated, { force: true });
    await mkdir(scratch, { recursive: true });
    if (mode === "hash") {
      const result = await candidates();
      console.log(`contract=${result.fingerprint}\nsha256=${result.hash}`);
    } else if (mode === "generate") await generate();
    else if (mode === "verify") await verify();
    else throw new Error("VALIDATOR_MODE_INVALID");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
