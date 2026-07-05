import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

async function importParserModule() {
  const source = readFileSync(new URL("../src/parser.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const dir = mkdtempSync(join(process.cwd(), ".parser-test-"));
  const modulePath = join(dir, "parser.mjs");
  writeFileSync(modulePath, compiled.outputText, "utf8");
  try {
    return await import(`file://${modulePath}?cacheBust=${Date.now()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parseAiResponse strips Russian Google UI chrome after the answer", async () => {
  const { parseAiResponse } = await importParserModule();

  const result = parseAiResponse(`
    <div>
      <p>The capital of France is <strong>Paris</strong>.</p>
      <div>Копировать</div>
      <h1>Поделиться ссылкой</h1>
      <div>Хороший ответ</div>
      <div>Плохой ответ</div>
    </div>
  `);

  assert.equal(result.ok, true);
  assert.match(result.markdown, /Paris/);
  assert.doesNotMatch(result.markdown, /Копировать|Поделиться|Хороший ответ|Плохой ответ/);
});

test("parseAiResponse strips Google UI chrome in top 10 common UI languages", async () => {
  const { parseAiResponse } = await importParserModule();
  const cases = [
    ["English", ["Copy", "Share link", "Good answer", "Bad answer"]],
    ["Spanish", ["Copiar", "Compartir enlace", "Buena respuesta", "Mala respuesta"]],
    ["French", ["Copier", "Partager le lien", "Bonne réponse", "Mauvaise réponse"]],
    ["German", ["Kopieren", "Link teilen", "Gute Antwort", "Schlechte Antwort"]],
    ["Portuguese", ["Copiar", "Compartilhar link", "Boa resposta", "Resposta ruim"]],
    ["Italian", ["Copia", "Condividi link", "Buona risposta", "Risposta negativa"]],
    ["Dutch", ["Kopiëren", "Link delen", "Goed antwoord", "Slecht antwoord"]],
    ["Russian", ["Копировать", "Поделиться ссылкой", "Хороший ответ", "Плохой ответ"]],
    ["Japanese", ["コピー", "リンクを共有", "良い回答", "悪い回答"]],
    ["Chinese", ["复制", "分享链接", "回答很好", "回答不好"]],
  ];

  for (const [language, labels] of cases) {
    const result = parseAiResponse(`
      <div>
        <p>The answer for ${language} remains in English.</p>
        <div>${labels[0]}</div>
        <h1>${labels[1]}</h1>
        <div>${labels[2]}</div>
        <div>${labels[3]}</div>
      </div>
    `);

    assert.equal(result.ok, true, language);
    assert.match(result.markdown, /remains in English/, language);
    for (const label of labels) {
      assert.doesNotMatch(result.markdown, new RegExp(label), language);
    }
  }
});
