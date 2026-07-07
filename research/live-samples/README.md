# Live samples — pre-fix (RED)

Captured at mission reproduction step (2026-07-06) against the live native
host on 127.0.0.1:51784. The Firefox extension is at commit 4311a84 with
`extension/src/selectors.js` covering only EN/DE/FR/ES/PT/IT/NL.

Files:
- `mountain.json` — query "what is the tallest mountain in the world"
- `romeo.json`   — query "who wrote romeo and juliet"
- `capital.json`  — query "what is the capital of australia"

Each `--raw` sample shows `ok:true, citations:[], html` with no
`<span class="citation-marker"><code>[CITE-N]</code></span>` markers, even
though the page renders Russian citation buttons with
`aria-label="Посмотреть ссылки по теме"` and `data-amic="true"` /
`data-icl-uuid` attributes.

Citation buttons found in the captured HTML are still `disabled="true"`,
suggesting a race: Google's UI enables "View related links" buttons shortly
after the answer completes. The current `waitForAiCompletion` (which keys off
the feedback SVG / aria-label) can fire before the citation buttons are
enabled. This is a separate timing concern; the selector miss is the
dominant cause (no selector matches Cyrillic `ссылки`).
