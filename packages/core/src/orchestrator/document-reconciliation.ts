import crypto from 'node:crypto';
import {
  documentSnapshotsCurrent,
  readDocumentEvidence,
  type DocumentCell,
  type DocumentEvidence,
  type DocumentReaderOptions,
} from './document-evidence.js';
import {
  renderCalculationDocument,
  type DocumentRenderResult,
} from './document-render.js';

export const DOCUMENT_VALIDATOR_VERSION = 'calculation-v1.0.0';
export interface CalculationCriteria {
  template: 'calculation-v1';
  currency: string;
  scale: number;
  rounding: 'half_up' | 'half_even';
}
export interface EvidenceValue {
  value: string;
  sourceSha256: string;
  anchor: string;
  formula?: string;
}
export interface ResolvedValue {
  state: 'known' | 'missing' | 'ambiguous' | 'conflicting';
  value?: string;
  evidence: EvidenceValue[];
}
export interface DocumentIssue {
  code: string;
  severity: 'fail' | 'incomplete';
  anchor?: string;
}
interface Extracted {
  fields: Record<string, EvidenceValue[]>;
  rows: Map<
    string,
    {
      quantity: EvidenceValue[];
      price: EvidenceValue[];
      amount: EvidenceValue[];
    }
  >;
  issues: DocumentIssue[];
}
export interface DocumentReconciliationReport {
  validatorVersion: string;
  criteriaSha256: string;
  status: 'pass' | 'fail' | 'incomplete';
  assurance: 'diagnostic_only';
  humanAcceptance: 'not_recorded';
  /** Rasterization/visual review is separate from arithmetic reconciliation. */
  visualReview: 'required_separately';
  render: DocumentRenderResult | null;
  sources: DocumentEvidence['snapshot'][];
  final: DocumentEvidence['snapshot'] | null;
  coverage: Array<{ sha256: string; format: 'pdf' | 'xlsx'; units: string[] }>;
  sourceFields: Record<string, ResolvedValue>;
  finalFields: Record<string, ResolvedValue>;
  rows: Array<{
    id: string;
    quantity: ResolvedValue;
    price: ResolvedValue;
    amount: ResolvedValue;
    sourceQuantity: ResolvedValue;
    sourcePrice: ResolvedValue;
    sourceAmount: ResolvedValue;
    computedAmount?: string;
  }>;
  computedTotal?: string;
  issues: DocumentIssue[];
}
const FIELDS = [
  'Organization',
  'Person',
  'Document',
  'Date',
  'Currency',
  'Total',
] as const;
const FIELD_LABELS: Record<string, (typeof FIELDS)[number]> = {
  Organization: 'Organization',
  Person: 'Person',
  Document: 'Document',
  Date: 'Date',
  Currency: 'Currency',
  Total: 'Total',
  Организация: 'Organization',
  ФИО: 'Person',
  Документ: 'Document',
  Дата: 'Date',
  Валюта: 'Currency',
  Итого: 'Total',
};
const DECIMAL = /^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/;
function decimal(raw: string): { value: bigint; scale: number } {
  if (!DECIMAL.test(raw)) throw new Error('invalid_decimal');
  const [integer, fraction = ''] = raw.split('.');
  return { value: BigInt(integer + fraction), scale: fraction.length };
}
function canonical(raw: string): string {
  const parsed = decimal(raw);
  return format(parsed.value, parsed.scale)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}
function format(value: bigint, scale: number): string {
  const sign = value < 0n ? '-' : '';
  const digits = (value < 0n ? -value : value)
    .toString()
    .padStart(scale + 1, '0');
  return scale
    ? `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`
    : `${sign}${digits}`;
}
function round(
  value: bigint,
  from: number,
  to: number,
  mode: CalculationCriteria['rounding'],
): bigint {
  if (from <= to) return value * 10n ** BigInt(to - from);
  const factor = 10n ** BigInt(from - to);
  const sign = value < 0n ? -1n : 1n;
  const absolute = value < 0n ? -value : value;
  const quotient = absolute / factor;
  const remainder = absolute % factor;
  const increment =
    remainder * 2n > factor ||
    (remainder * 2n === factor && (mode === 'half_up' || quotient % 2n !== 0n));
  return sign * (quotient + (increment ? 1n : 0n));
}
export function exactLineAmount(
  quantity: string,
  price: string,
  criteria: CalculationCriteria,
): string {
  validateCalculationCriteria(criteria);
  const a = decimal(quantity),
    b = decimal(price);
  return format(
    round(
      a.value * b.value,
      a.scale + b.scale,
      criteria.scale,
      criteria.rounding,
    ),
    criteria.scale,
  );
}
export function validateCalculationCriteria(
  value: unknown,
): asserts value is CalculationCriteria {
  const c = value as CalculationCriteria;
  if (
    !c ||
    c.template !== 'calculation-v1' ||
    !/^[A-Z]{3}$/.test(c.currency) ||
    !Number.isInteger(c.scale) ||
    c.scale < 0 ||
    c.scale > 6 ||
    !['half_up', 'half_even'].includes(c.rounding) ||
    Object.keys(c).some(
      (k) => !['template', 'currency', 'scale', 'rounding'].includes(k),
    )
  )
    throw new Error('invalid_calculation_criteria');
}
export function calculationCriteriaSha256(
  criteria: CalculationCriteria,
): string {
  validateCalculationCriteria(criteria);
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        template: criteria.template,
        currency: criteria.currency,
        scale: criteria.scale,
        rounding: criteria.rounding,
      }),
    )
    .digest('hex');
}
function resolve(
  values: EvidenceValue[],
  numeric = false,
  money?: CalculationCriteria,
): ResolvedValue {
  if (!values.length) return { state: 'missing', evidence: [] };
  try {
    const normalized = values.map((v) => {
      if (!numeric) return v.value.normalize('NFC').trim().replace(/\s+/g, ' ');
      // Formula caches may carry binary floating-point residue. Compare them
      // at the explicit monetary scale, while preserving the original lexeme.
      // The allowlisted formula is independently recomputed below.
      if (money && v.formula !== undefined) {
        const n = decimal(v.value);
        return canonical(
          format(
            round(n.value, n.scale, money.scale, money.rounding),
            money.scale,
          ),
        );
      }
      return canonical(v.value);
    });
    if (normalized.some((v) => !v))
      return { state: 'missing', evidence: values };
    return new Set(normalized).size === 1
      ? { state: 'known', value: normalized[0], evidence: values }
      : { state: 'conflicting', evidence: values };
  } catch {
    return { state: 'ambiguous', evidence: values };
  }
}
function coverage(
  documents: DocumentEvidence[],
): DocumentReconciliationReport['coverage'] {
  return documents.map((document) => ({
    sha256: document.snapshot.sha256,
    format: document.content.format,
    units:
      document.content.format === 'pdf'
        ? document.content.pages.map((page) => `page:${page.number}`)
        : document.content.sheets.map((sheet) => `sheet:${sheet.name}`),
  }));
}
function extract(
  document: DocumentEvidence,
  criteria: CalculationCriteria,
): Extracted {
  const output: Extracted = {
    fields: Object.fromEntries(FIELDS.map((f) => [f, []])),
    rows: new Map(),
    issues: [],
  };
  const add = (
    list: EvidenceValue[],
    value: string,
    anchor: string,
    formula?: string,
  ) =>
    list.push({
      value,
      sourceSha256: document.snapshot.sha256,
      anchor,
      ...(formula !== undefined ? { formula } : {}),
    });
  const row = (id: string) => {
    if (!output.rows.has(id))
      output.rows.set(id, { quantity: [], price: [], amount: [] });
    else
      output.issues.push({ code: 'duplicate_item_id', severity: 'incomplete' });
    return output.rows.get(id)!;
  };
  if (document.content.format === 'pdf') {
    for (const page of document.content.pages) {
      if (!page.lines.some((line) => line.trim()))
        output.issues.push({
          code: 'page_without_extractable_text',
          severity: 'incomplete',
          anchor: `page:${page.number}`,
        });
      page.lines.forEach((line, index) => {
        const anchor = `page:${page.number}/line:${index + 1}`;
        const field =
          /^(Organization|Person|Document|Date|Currency|Total|Организация|ФИО|Документ|Дата|Валюта|Итого):\s*(.*)$/.exec(
            line.trim(),
          );
        if (field) add(output.fields[FIELD_LABELS[field[1]]], field[2], anchor);
        const item =
          /^(?:ITEM|Позиция)\s+([A-Z][A-Z0-9_-]{0,31})\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)$/.exec(
            line.trim(),
          );
        if (item) {
          const target = row(item[1]);
          add(target.quantity, item[2].trim(), anchor);
          add(target.price, item[3].trim(), anchor);
          add(target.amount, item[4].trim(), anchor);
        } else if (/^(?:ITEM|Позиция)\s/.test(line.trim()))
          output.issues.push({
            code: 'unparsed_item',
            severity: 'incomplete',
            anchor,
          });
        else if (
          !field &&
          /\d/.test(line) &&
          !/^(?:USD amounts rounded half up to 2 decimal places\.|Synthetic source \/ page \d+ of \d+|-- \d+ of \d+ --)$/.test(
            line.trim(),
          )
        )
          output.issues.push({
            code: 'unmapped_numeric_text',
            severity: 'incomplete',
            anchor,
          });
      });
    }
  } else {
    for (const sheet of document.content.sheets) {
      const cells = new Map(sheet.cells.map((cell) => [cell.address, cell]));
      const anchor = (address: string) => `${sheet.name}!${address}`;
      const numeric = (address: string, list: EvidenceValue[]) => {
        const cell = cells.get(address);
        if (cell && cell.value !== '') {
          add(list, cell.value, anchor(address), cell.formula);
          if (cell.type !== 'n')
            output.issues.push({
              code: 'numeric_cell_type',
              severity: 'incomplete',
              anchor: anchor(address),
            });
        }
      };
      const acceptedFormulas = new Set<string>();
      const numericAddresses = new Set<string>();
      const itemRows: number[] = [];
      for (const cell of sheet.cells) {
        if (!/^A[1-9]\d*$/.test(cell.address)) continue;
        const r = Number(cell.address.slice(1));
        const fieldName = Object.hasOwn(FIELD_LABELS, cell.value)
          ? FIELD_LABELS[cell.value]
          : undefined;
        if (fieldName) {
          const address = `${fieldName === 'Total' ? 'E' : 'C'}${r}`;
          const value = cells.get(address);
          if (fieldName === 'Total') {
            numeric(address, output.fields.Total);
            numericAddresses.add(address);
          } else if (value) {
            add(
              output.fields[fieldName],
              value.value,
              anchor(address),
              value.formula,
            );
            if (
              !['s', 'inlineStr', 'str'].includes(value.type) ||
              value.formula !== undefined
            )
              output.issues.push({
                code: 'field_requires_literal_text',
                severity: 'incomplete',
                anchor: anchor(address),
              });
          }
        }
        const item = /^(?:ITEM|Позиция) ([A-Z][A-Z0-9_-]{0,31})$/.exec(
          cell.value,
        );
        if (item) {
          itemRows.push(r);
          const target = row(item[1]);
          numeric(`C${r}`, target.quantity);
          numeric(`D${r}`, target.price);
          numeric(`E${r}`, target.amount);
          for (const column of ['C', 'D', 'E'])
            numericAddresses.add(`${column}${r}`);
          const f = cells.get(`E${r}`)?.formula;
          if (
            f !== undefined &&
            criteria.rounding === 'half_up' &&
            f.replace(/\s/g, '').toUpperCase() ===
              `ROUND(C${r}*D${r},${criteria.scale})`
          )
            acceptedFormulas.add(`E${r}`);
        } else if (/^(?:ITEM|Позиция)\s/.test(cell.value))
          output.issues.push({
            code: 'unparsed_item',
            severity: 'incomplete',
            anchor: anchor(cell.address),
          });
      }
      if (itemRows.length) {
        const headerRows = sheet.cells.filter(
          (cell) =>
            /^A[1-9]\d*$/.test(cell.address) &&
            ['Line', 'Позиция'].includes(cell.value),
        );
        if (
          headerRows.length !== 1 ||
          !headerRows.every((cell) => {
            const r = cell.address.slice(1);
            return (
              ['Quantity', 'Количество'].includes(
                cells.get(`C${r}`)?.value || '',
              ) &&
              ['Unit price', 'Цена'].includes(
                cells.get(`D${r}`)?.value || '',
              ) &&
              ['Amount', 'Сумма'].includes(cells.get(`E${r}`)?.value || '')
            );
          })
        )
          output.issues.push({
            code: 'item_headers_ambiguous',
            severity: 'incomplete',
            anchor: sheet.name,
          });
      }
      for (const cell of sheet.cells) {
        if (
          cell.type === 'n' &&
          cell.value !== '' &&
          !numericAddresses.has(cell.address)
        )
          output.issues.push({
            code: 'unmapped_numeric_cell',
            severity: 'incomplete',
            anchor: anchor(cell.address),
          });
        if (cell.type === 'e')
          output.issues.push({
            code: 'formula_error',
            severity: 'incomplete',
            anchor: anchor(cell.address),
          });
        if (cell.formula === undefined) continue;
        const total = /^E(\d+)$/.exec(cell.address);
        if (
          total &&
          FIELD_LABELS[cells.get(`A${total[1]}`)?.value || ''] === 'Total' &&
          itemRows.length
        ) {
          const first = Math.min(...itemRows),
            last = Math.max(...itemRows);
          const emptyGaps = Array.from(
            { length: last - first + 1 },
            (_, i) => i + first,
          ).every((r) => itemRows.includes(r) || !cells.get(`E${r}`)?.value);
          if (
            emptyGaps &&
            cell.formula.replace(/\s/g, '').toUpperCase() ===
              `SUM(E${first}:E${last})`
          )
            acceptedFormulas.add(cell.address);
        }
        if (!acceptedFormulas.has(cell.address))
          output.issues.push({
            code: 'unsupported_formula',
            severity: 'incomplete',
            anchor: anchor(cell.address),
          });
      }
    }
  }
  return output;
}

export function reconcileDocumentEvidence(
  sources: DocumentEvidence[],
  final: DocumentEvidence,
  criteria: CalculationCriteria,
): DocumentReconciliationReport {
  validateCalculationCriteria(criteria);
  const allSources = sources.map((source) => extract(source, criteria));
  const output = extract(final, criteria);
  const issues = [...allSources.flatMap((s) => s.issues), ...output.issues];
  const sourceFields: Record<string, ResolvedValue> = {},
    finalFields: Record<string, ResolvedValue> = {};
  const unresolved = (value: ResolvedValue, field: string) => {
    if (value.state !== 'known')
      issues.push({
        code: `${field}_${value.state}`,
        severity: 'incomplete',
        anchor: value.evidence[0]?.anchor,
      });
  };
  for (const field of FIELDS) {
    sourceFields[field] = resolve(
      allSources.flatMap((s) => s.fields[field]),
      field === 'Total',
      criteria,
    );
    finalFields[field] = resolve(
      output.fields[field],
      field === 'Total',
      criteria,
    );
    unresolved(sourceFields[field], `source_${field}`);
    unresolved(finalFields[field], `final_${field}`);
    if (
      sourceFields[field].state === 'known' &&
      finalFields[field].state === 'known' &&
      sourceFields[field].value !== finalFields[field].value
    )
      issues.push({
        code: `${field}_mismatch`,
        severity: 'fail',
        anchor: finalFields[field].evidence[0]?.anchor,
      });
  }
  for (const fields of [sourceFields, finalFields]) {
    if (
      fields.Currency.state === 'known' &&
      fields.Currency.value !== criteria.currency
    )
      issues.push({
        code: 'currency_mismatch',
        severity: 'fail',
        anchor: fields.Currency.evidence[0]?.anchor,
      });
    if (fields.Date.state === 'known') {
      const date = fields.Date.value!;
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date
      ) {
        fields.Date.state = 'ambiguous';
        delete fields.Date.value;
        issues.push({
          code: 'ambiguous_date',
          severity: 'incomplete',
          anchor: fields.Date.evidence[0]?.anchor,
        });
      }
    }
  }
  const sourceIds = new Set(allSources.flatMap((s) => [...s.rows.keys()]));
  const ids = new Set([...sourceIds, ...output.rows.keys()]);
  if (!ids.size) issues.push({ code: 'missing_items', severity: 'incomplete' });
  let sum = 0n,
    complete = true;
  const rows: DocumentReconciliationReport['rows'] = [];
  for (const id of [...ids].sort()) {
    const finalRow = output.rows.get(id);
    const record: DocumentReconciliationReport['rows'][number] = {
      id,
      quantity: resolve(finalRow?.quantity ?? [], true),
      price: resolve(finalRow?.price ?? [], true),
      amount: resolve(finalRow?.amount ?? [], true, criteria),
      sourceQuantity: resolve(
        allSources.flatMap((s) => s.rows.get(id)?.quantity ?? []),
        true,
      ),
      sourcePrice: resolve(
        allSources.flatMap((s) => s.rows.get(id)?.price ?? []),
        true,
      ),
      sourceAmount: resolve(
        allSources.flatMap((s) => s.rows.get(id)?.amount ?? []),
        true,
        criteria,
      ),
    };
    for (const field of ['quantity', 'price', 'amount'] as const) {
      const source = resolve(
        allSources.flatMap((s) => s.rows.get(id)?.[field] ?? []),
        true,
        field === 'amount' ? criteria : undefined,
      );
      unresolved(source, `source_${id}_${field}`);
      unresolved(record[field], `final_${id}_${field}`);
      if (
        source.state === 'known' &&
        record[field].state === 'known' &&
        source.value !== record[field].value
      )
        issues.push({
          code: `item_${field}_mismatch`,
          severity: 'fail',
          anchor: record[field].evidence[0]?.anchor,
        });
    }
    if (
      record.quantity.state === 'known' &&
      record.price.state === 'known' &&
      record.amount.state === 'known'
    ) {
      record.computedAmount = exactLineAmount(
        record.quantity.value!,
        record.price.value!,
        criteria,
      );
      sum += decimal(record.computedAmount).value;
      if (canonical(record.computedAmount) !== record.amount.value)
        issues.push({
          code: 'line_arithmetic',
          severity: 'fail',
          anchor: record.amount.evidence[0]?.anchor,
        });
    } else complete = false;
    // A matching final must not legitimize an internally wrong source calculation.
    const q = resolve(
      allSources.flatMap((s) => s.rows.get(id)?.quantity ?? []),
      true,
    );
    const p = resolve(
      allSources.flatMap((s) => s.rows.get(id)?.price ?? []),
      true,
    );
    const a = resolve(
      allSources.flatMap((s) => s.rows.get(id)?.amount ?? []),
      true,
      criteria,
    );
    if (
      [q, p, a].every((v) => v.state === 'known') &&
      canonical(exactLineAmount(q.value!, p.value!, criteria)) !== a.value
    )
      issues.push({
        code: 'source_line_arithmetic',
        severity: 'fail',
        anchor: a.evidence[0]?.anchor,
      });
    rows.push(record);
  }
  const computedTotal =
    complete && ids.size ? format(sum, criteria.scale) : undefined;
  if (
    computedTotal !== undefined &&
    finalFields.Total.state === 'known' &&
    canonical(computedTotal) !== finalFields.Total.value
  )
    issues.push({
      code: 'total_arithmetic',
      severity: 'fail',
      anchor: finalFields.Total.evidence[0]?.anchor,
    });
  return {
    validatorVersion: DOCUMENT_VALIDATOR_VERSION,
    criteriaSha256: calculationCriteriaSha256(criteria),
    status: issues.some((i) => i.severity === 'fail')
      ? 'fail'
      : issues.length
        ? 'incomplete'
        : 'pass',
    assurance: 'diagnostic_only',
    humanAcceptance: 'not_recorded',
    visualReview: 'required_separately',
    render: null,
    sources: sources.map((s) => s.snapshot),
    final: final.snapshot,
    coverage: coverage([...sources, final]),
    sourceFields,
    finalFields,
    rows,
    computedTotal,
    issues,
  };
}

export async function checkCalculationDocuments(options: {
  sources: string[];
  final: string;
  criteria: CalculationCriteria;
  reader: DocumentReaderOptions;
  render?: {
    outputDirectory: string;
    rendererPath: string;
    sofficeCommand?: string;
  };
}): Promise<DocumentReconciliationReport> {
  validateCalculationCriteria(options.criteria);
  if (!options.sources.length || options.sources.length > 8)
    throw new Error('source_count');
  const sources: DocumentEvidence[] = [];
  let final: DocumentEvidence | null = null;
  try {
    for (const filename of options.sources)
      sources.push(await readDocumentEvidence(filename, options.reader));
    final = await readDocumentEvidence(options.final, options.reader);
    const report = reconcileDocumentEvidence(sources, final, options.criteria);
    if (options.render) {
      report.render = await renderCalculationDocument({
        filename: options.final,
        expectedSha256: final.snapshot.sha256,
        ...options.render,
        pythonCommand: options.reader.pythonCommand,
      });
      if (report.render.status === 'rendered') {
        const text = (report.render.text || '').replace(/\s+/g, ' ');
        const decimalText = text.replace(/(?<=\d),(?=\d)/g, '.');
        const renderedNumbers = new Set(
          [
            ...decimalText.matchAll(
              /(?<![\p{L}\p{N}.])-?(?:0|[1-9]\d*)(?:\.\d+)?(?![\p{L}\p{N}.])/gu,
            ),
          ].flatMap((match) => {
            try {
              return [canonical(match[0])];
            } catch {
              return [];
            }
          }),
        );
        const required = [
          ...Object.values(report.finalFields)
            .filter((v) => v.state === 'known')
            .map((v) => v.value!),
          ...report.rows.map((r) => r.id),
          ...report.rows.flatMap((r) =>
            [r.quantity, r.price, r.amount]
              .filter((v) => v.state === 'known')
              .map((v) => v.value!),
          ),
        ];
        if (
          required.some((value) => {
            const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const numeric = DECIMAL.test(value);
            if (numeric) return !renderedNumbers.has(canonical(value));
            const boundary = '[\\p{L}\\p{N}]';
            return !new RegExp(
              `(?<!${boundary})${escaped}(?!${boundary})`,
              'u',
            ).test(numeric ? decimalText : text);
          })
        ) {
          report.render.status = 'incomplete';
          report.render.code = 'rendered_content_missing';
        }
        delete report.render.text;
      }
    }
    if (report.render?.status !== 'rendered') {
      if (report.status === 'pass') report.status = 'incomplete';
      report.issues.push({
        code: report.render?.code || 'render_not_configured',
        severity: 'incomplete',
      });
    }
    // Reopen the final and every original after validation; the report is bound
    // to the snapshots actually parsed, not to a later mutable path's contents.
    if (!documentSnapshotsCurrent([...report.sources, final.snapshot])) {
      report.status = 'incomplete';
      report.issues.push({ code: 'document_changed', severity: 'incomplete' });
    }
    return report;
  } catch {
    return {
      validatorVersion: DOCUMENT_VALIDATOR_VERSION,
      criteriaSha256: calculationCriteriaSha256(options.criteria),
      status: 'incomplete',
      assurance: 'diagnostic_only',
      humanAcceptance: 'not_recorded',
      visualReview: 'required_separately',
      render: null,
      sources: sources.map((s) => s.snapshot),
      final: final?.snapshot ?? null,
      coverage: coverage(final ? [...sources, final] : sources),
      sourceFields: {},
      finalFields: {},
      rows: [],
      issues: [{ code: 'document_reader_incomplete', severity: 'incomplete' }],
    };
  }
}

/** Freshness only. An arbitrary JSON report is never proof of a trusted pass. */
export function documentReportCurrent(
  report: DocumentReconciliationReport,
  criteria: CalculationCriteria,
): boolean {
  return (
    report.validatorVersion === DOCUMENT_VALIDATOR_VERSION &&
    report.criteriaSha256 === calculationCriteriaSha256(criteria) &&
    !!report.final &&
    documentSnapshotsCurrent([...report.sources, report.final])
  );
}
