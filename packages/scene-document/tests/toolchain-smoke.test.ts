import { Type } from "@sinclair/typebox";
import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";
import { canonicalize } from "json-canonicalize";
import { describe, expect, it } from "vitest";

function generateValidatorSource() {
  const schema = Type.Object({ value: Type.String() });
  const ajv = new Ajv2020({ code: { source: true } });

  return standaloneCode(ajv, ajv.compile(schema));
}

describe("scene-document validation and canonicalization toolchain", () => {
  it("imports the selected environment-neutral tools", () => {
    expect(generateValidatorSource()).toContain("function");
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("generates a validator that rejects malformed data deterministically", () => {
    const module = { exports: undefined as unknown };

    new Function("module", "exports", generateValidatorSource())(
      module,
      module.exports,
    );

    expect(module.exports).toBeTypeOf("function");
    expect((module.exports as (value: unknown) => boolean)({ value: 1 })).toBe(
      false,
    );
    expect(canonicalize({ b: [2, 1], a: { d: true, c: null } })).toBe(
      '{"a":{"c":null,"d":true},"b":[2,1]}',
    );
  });
});
