# Calculation document pilot

This is a deliberately narrow, local diagnostic for one versioned calculation
template. It compares complete source PDF/XLSX files with the actual final file,
recomputes line amounts and totals with decimal `BigInt` arithmetic, reopens the
final, and renders it. It neither edits sources nor accepts instructions found
inside documents. All committed fixtures are synthetic.

## Run the shipped checker

Build the project in an isolated checkout. Node 22, Python 3 and the declared
root reader dependencies are needed. PDF rasterization uses the existing
`pdf-parse` renderer. XLSX rendering additionally needs an installed LibreOffice;
it is optional and never downloaded or installed automatically.

```sh
node dist/scripts/document-check.js \
  --source evals/document-reconciliation/fixtures/good.pdf \
  --final evals/document-reconciliation/fixtures/good.xlsx \
  --criteria evals/document-reconciliation/criteria.json \
  --report /tmp/calculation-report.json \
  --renders /tmp/calculation-render
```

Both output paths must be new. `--soffice /absolute/path/to/soffice` selects an
existing viewer; `--python` selects Python. Output reports are mode 0600 and
render directories 0700 because evidence may contain private source text.
Exit codes are 0 diagnostic pass, 1 identified mismatch, 2 incomplete/error.
Missing viewers, unsupported content, limits, or unknown formulas yield
`incomplete`, never success. Review the rendered PNGs separately.

The reproducible action evaluation opens real saved files, not mocked reader
results. It includes good PDF and XLSX finals, a fourth-page contradiction,
wrong row 21 and a wrong total:

```sh
SKOOBI_TEST_SOFFICE=/absolute/path/to/soffice \
  node evals/document-reconciliation/run.mjs /tmp/calculation-evaluation
```

## Template and numeric contract

PDF uses literal `Organization:`, `Person:`, `Document:`, `Date:`, `Currency:`,
`Total:` labels and `ITEM L01 | quantity | unit-price | amount` lines. All pages
are read; evidence includes SHA256 plus page and extracted-line anchors. Anchors
are textual positions, not a claim about a PDF table's geometry. Scanned pages
without text are incomplete; OCR and general document/table understanding are
outside this pilot.

The strict Russian aliases are `Организация`, `ФИО`, `Документ`, `Дата`,
`Валюта`, `Итого`, and `Позиция L01` for item IDs. The XLSX headers may read
`Позиция`, `Количество`, `Цена`, `Сумма`; fixed A/C/D/E positions still apply.
`Заказчик` and `Исполнитель` are not guessed to be the same role. Other layouts
need a separately reviewed template mapping, not an LLM assertion of a match.

XLSX labels occur in column A, their literal values in C; Total's value is in E.
An item label such as `ITEM L01` occupies A, quantity C, unit price D, amount E.
Blank columns and rows remain blank; addresses refer to actual OOXML A1 cells
on every sheet. Dates are literal ISO `YYYY-MM-DD` strings. General Excel date
serials are intentionally not guessed. Metadata fields require literal text.

The host criteria specify currency, decimal places and half-up/half-even
rounding. Each line is rounded, then the rounded lines are summed. There is no
currency conversion or inferred rounding policy. Raw decimal lexemes and formula
text remain in evidence. Formula caches may contain binary residue; caches of
approved monetary formulas are compared at the explicitly specified scale.
Quantities/prices and independently calculated results never use JavaScript
floating-point arithmetic.

Only `ROUND(C21*D21,2)` with the actual row/scale and half-up policy, and a bounded
`SUM(E21:E22)` covering all item rows, are supported. A cache alone cannot prove
these formulas: the checker independently recomputes them. Unknown functions,
external links, named formulas, hidden sheets/rows/columns, merges, macros,
ambiguous numeric text, duplicate IDs or contradictory sources are incomplete.
Swapped or unknown item headers and unmapped numeric cells/text also abstain.
The preview's first-three-page and first-twenty-row limits are never used.

## Rendering and assurance boundaries

The reader and renderer receive an already hashed immutable byte buffer over
stdin. The final is reopened after checking, and every input is rehashed after
rendering. Reports bind source/final hashes, criteria hash and validator version;
changed bytes or criteria invalidate freshness. `documentReportCurrent` checks
freshness only: arbitrary JSON with a `pass` is never a trusted receipt.

PDF rendering opens and rasterizes all pages in a bounded child. XLSX first
passes the ZIP/XML preflight, then a fresh LibreOffice profile opens a private
copy. Macros are disabled, external relationships are rejected, and only the
pilot's local ROUND/SUM formulas reach the viewer. Each sheet is exported to one
PDF page, then all pages become PNGs. The report records page coverage, bounded
dimensions, image hashes and whether required text survived the render. This
does not establish aesthetic quality, pixel visibility of every label, or
correctness in every Excel/viewer implementation. Human visual acceptance is
recorded separately and is never inferred from delivery or rasterization.

Input limits are 16 MiB/file, 8 sources, 100 PDF pages; XLSX additionally has
512 ZIP entries, 32 MiB expanded, 12 sheets, 20,000 cells, 2,000 rows and 64
columns. The ZIP preflight rejects traversal, duplicates, symlinks, encryption,
XML entities and external relationships without extracting files. Child heap,
output and wall-clock limits are enforced; this is not an OS sandbox or a hard
native-memory limit. Same-user full-owner processes can alter checker code and
state, so the report says `diagnostic_only`, never tamper-proof or approved.

For host-approved required artifacts the existing acceptance registry also
supports `kind: "calculation-v1"` with `criteria` and
`sources: [{"path":"/absolute/source.pdf","sha256":"<64 hex digits>"}]`.
Registration checks the canonical paths and current source hashes. The host
independently reruns the checker on protected source/final copies; model-provided
JSON never enters the signer. Worker bytes are pinned, and checker/runtime and
dependency paths must be outside producer-writable roots. Every delivery checks
current source versions and sends the verified protected final snapshot.

The default full-owner deployment still returns inconclusive for trusted
acceptance. The macOS artifact-job controller can establish a real isolated producer for an explicit job; a caller boundary flag cannot grant signing authority. Direct full-access calls remain inconclusive. Trusted
XLSX acceptance requires the actual native LibreOffice executable, not a wrapper
that could delegate into writable code. Receipt fields explicitly retain
`visualReview: "not_recorded"` and
`renderAssessment: "openability_and_text_smoke_only"`; their pass covers only the
document contract, not human approval or universal layout correctness. The
optional `SKOOBI_TEST_SOFFICE_NATIVE` action-eval setting exercises real XLSX
receipt generation and invalidation; its producer copy now runs under actual macOS Seatbelt before the independent document checker. Other platforms return inconclusive for trusted receipts.

## Fixture maintenance

`build-pdf-fixtures.py` uses ReportLab for authoring only.
`build-fixtures.mjs` uses the bundled artifact-tool authoring runtime, calculates
once, exports, reimports and renders each workbook. These authoring tools are
not production dependencies. Keep only PDF/XLSX synthetic fixtures in source;
place inspection output and rendered QA images in a private review directory.
The regular tests exercise real PDF/XLSX readers and PDF rendering without
requiring LibreOffice; the action evaluation additionally requires the actual
XLSX viewer and must pass before claiming that route was checked.
