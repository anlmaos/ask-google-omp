import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

async function importQueryModule() {
  const source = readFileSync(new URL("../src/query.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString("base64")}`
  );
}

test("toGoogleAiModeQuery asks Google AI Mode to answer in English", async () => {
  const { toGoogleAiModeQuery } = await importQueryModule();

  const shaped = toGoogleAiModeQuery("latest stable Node.js LTS version");

  assert.match(shaped, /^latest stable Node\.js LTS version/);
  assert.match(shaped, /answer in English/i);
  assert.match(shaped, /Do not use the browser UI language/i);
});

test("toGoogleAiModeQuery avoids duplicating the English instruction", async () => {
  const { toGoogleAiModeQuery } = await importQueryModule();

  const shaped = toGoogleAiModeQuery(
    "what is the capital of France? Please answer in English."
  );

  assert.equal(
    shaped,
    "what is the capital of France? Please answer in English."
  );
});
