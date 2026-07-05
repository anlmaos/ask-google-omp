/**
 * Server-side parser for Google AI Mode HTML.
 *
 * Receives the raw `main-col` inner HTML (with injected `<span class="citation-marker">`
 * markers from the extension's DOM extraction) and the citation array produced by the
 * SERPO click-chain. Produces a single markdown answer with inline [1][2] citations and
 * a Sources section.
 *
 * Uses cheerio (jQuery-like DOM) and turndown (HTML->markdown) so we can unit-test it
 * without a browser.
 */

import * as cheerio from "cheerio";
import TurndownService from "turndown";

interface Source {
  title: string;
  url: string;
  domain: string;
}

interface Citation {
  marker_id: number;
  sources: Source[];
}

// Disclaimer cutoff markers (multilanguage). Everything after the first match is dropped.
const CUTOFF_MARKERS = [
  "KI-Antworten können Fehler enthalten",
  "Öffentlicher Link wird erstellt",
  "AI-generated answers may contain mistakes",
  "AI can make mistakes",
  "Generative AI is experimental",
  "AI overviews are experimental",
  "AI-reacties kunnen fouten bevatten",
  "Las respuestas de la IA pueden contener errores",
  "pueden contener errores",
  "Más información",
  "Les réponses de l'IA peuvent contenir des erreurs",
  "peuvent contenir des erreurs",
  "Plus d'informations",
  "Le risposte dell'IA possono contenere errori",
  "possono contenere errori",
  "Ulteriori informazioni",
  "ИИ может ошибаться",
];

// Common Google page chrome labels. These are matched only as full markdown
// lines/headings to avoid truncating legitimate answer text.
const UI_CHROME_LINE_MARKERS = [
  // English
  "Copy",
  "Share link",
  "Good answer",
  "Bad answer",
  // Spanish
  "Copiar",
  "Compartir enlace",
  "Buena respuesta",
  "Mala respuesta",
  // French
  "Copier",
  "Partager le lien",
  "Bonne réponse",
  "Mauvaise réponse",
  // German
  "Kopieren",
  "Link teilen",
  "Gute Antwort",
  "Schlechte Antwort",
  // Portuguese
  "Compartilhar link",
  "Boa resposta",
  "Resposta ruim",
  // Italian
  "Copia",
  "Condividi link",
  "Buona risposta",
  "Risposta negativa",
  // Dutch
  "Kopiëren",
  "Link delen",
  "Goed antwoord",
  "Slecht antwoord",
  // Russian
  "Копировать",
  "Поделиться ссылкой",
  "Хороший ответ",
  "Плохой ответ",
  // Japanese
  "コピー",
  "リンクを共有",
  "良い回答",
  "悪い回答",
  // Chinese
  "复制",
  "分享链接",
  "回答很好",
  "回答不好",
];

const UI_CHROME_LINE_MARKER_SET = new Set(
  UI_CHROME_LINE_MARKERS.map((line) => normalizeUiChromeLine(line))
);

/**
 * Build a Turndown service configured to preserve [CITE-N] markers as plain text and
 * strip elements Google emits that we do not want in markdown.
 */
function buildTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "*",
    codeBlockStyle: "fenced",
    linkStyle: "inlined",
    emDelimiter: "_",
    strongDelimiter: "**",
  });

  td.remove(["script", "style", "noscript", "svg"]);

  // Strip empty link anchors in one rule.
  td.addRule("skipEmptyLinks", {
    filter: (node: any) => {
      if (node.nodeName !== "A") return false;
      return (node.textContent?.trim() === "") && !node.querySelector("img");
    },
    replacement: () => "",
  });

  return td;
}

/**
 * Replace every [CITE-N] marker in `md` with [i][j]... shared citation references
 * and accumulate a flat Sources array (sorted by the marker order).
 */
function embedCitations(md: string, citations: Citation[]): { markdown: string; sources: Source[] } {
  // Build sources array and marker -> [start,end) range in ascending marker_id order.
  const sources: Source[] = [];
  const ranges = new Map<number, [number, number]>();
  for (const c of [...citations].sort((a, b) => (a.marker_id ?? 999) - (b.marker_id ?? 999))) {
    const srcs = Array.isArray(c.sources) ? c.sources : [];
    if (srcs.length > 0) {
      const start = sources.length;
      sources.push(...srcs);
      ranges.set(c.marker_id, [start, sources.length]);
    }
  }

  // Replace in DESC marker_id order so replacements don't disturb the offsets
  // of subsequent markers in the string.
  let out = md;
  for (const c of [...citations].sort((a, b) => (b.marker_id ?? 999) - (a.marker_id ?? 999))) {
    const marker = `[CITE-${c.marker_id}]`;
    if (!out.includes(marker)) continue;
    const r = ranges.get(c.marker_id);
    if (!r) { out = out.split(marker).join(""); continue; }
    let footnotes = "";
    for (let i = r[0]; i < r[1]; i++) footnotes += `[${i + 1}]`;
    out = out.split(marker).join(footnotes);
  }
  out = out.replace(/\[CITE-\d+\]/g, "");
  return { markdown: out, sources };
}

function normalizeUiChromeLine(line: string): string {
  return line
    .replace(/\u00a0/g, " ")
    .replace(/^[\s#>*_`-]+/, "")
    .replace(/[\s*_`]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function cutAtUiChromeLine(md: string): string {
  const lines = md.split("\n");
  const cutoffIndex = lines.findIndex((line) =>
    UI_CHROME_LINE_MARKER_SET.has(normalizeUiChromeLine(line))
  );
  if (cutoffIndex === -1) return md;
  return lines.slice(0, cutoffIndex).join("\n");
}

function postProcess(md: string): string {
  let s = md;
  // Strip ==highlighting== markers.
  s = s.replace(/==/g, "");
  // Remove empty links.
  s = s.replace(/\[\]\([^)]*\)/g, "");
  // Cut off at the first disclaimer marker found.
  for (const marker of CUTOFF_MARKERS) {
    const idx = s.indexOf(marker);
    if (idx !== -1) {
      s = s.substring(0, idx);
      break;
    }
  }
  s = cutAtUiChromeLine(s);
  // Smart line merging for broken sentences.
  s = s.replace(/([^.!?\n])\n([^\n#*0-9-])/g, "$1 $2");
  // Reduce runs of blank lines.
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/**
 * Convert Google AI Mode HTML into grounded markdown with inline citations.
 *
 * The HTML is expected to have been extracted from `[data-container-id="main-col"]`
 * after the SERPO click-chain injected `<span class="citation-marker"><code>[CITE-N]</code></span>`
 * spans. We strip those markers before running turndown so the placeholders survive as
 * literal text, then map them to real footnote markers using the citation sources.
 */
export function parseAiResponse(
  html: string,
  citations: Citation[] = []
): { ok: true; markdown: string } | { ok: false; error: string } {
  try {
    if (!html || !html.trim()) {
      return { ok: false, error: "Empty HTML was returned from the page" };
    }

    // Replace citation markers in the HTML with [CITE-N] literal text.
    // Turndown WILL escape the brackets to \[CITE-N\]; we undo that
    // AFTER turndown runs so our embedCitations marker replacement works.
    const cleaned = html.replace(
      /<span[^>]*class="citation-marker"[^>]*><code>\[CITE-(\d+)\]<\/code><\/span>/g,
      "[CITE-$1]"
    );

    cheerio.load(cleaned)("script,style,noscript,svg").remove();

    const td = buildTurndown();
    let markdown = td.turndown(cleaned);

    if (!markdown.trim()) {
      return { ok: false, error: "Turndown produced empty markdown from the page HTML" };
    }

    // Turndown escapes [ ] for markdown safety; undo that on our literal markers.
    markdown = markdown.replace(/\\\[CITE-(\d+)\\\]/g, "[CITE-$1]");

    const { markdown: mdWithCitations, sources } = embedCitations(markdown, citations);
    let processed = postProcess(mdWithCitations);

    if (sources.length > 0) {
      processed += "\n\n---\n\n## Sources\n\n";
      sources.forEach((s, i) => {
        processed += `[${i + 1}] ${s.title || s.domain}  \n${s.url}\n\n`;
      });
    }

    return { ok: true, markdown: processed };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Allow running standalone for debugging CLI: `npx tsx src/parser.ts < dumped.html`
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import("node:fs");
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node src/parser.ts <html-file.json>   (json must be { html, citations })");
    process.exit(2);
  }
  const data = JSON.parse(fs.readFileSync(path, "utf8"));
  const result = parseAiResponse(data.html || "", data.citations || []);
  if (result.ok) {
    console.log(result.markdown);
  } else {
    console.error("parse error:", result.error);
    process.exit(1);
  }
}
