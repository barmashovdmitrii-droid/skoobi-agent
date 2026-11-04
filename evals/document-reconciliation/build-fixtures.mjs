// Run using the bundled artifact-tool runtime, with dependencies linked in a
// temporary authoring directory. Never installs anything in a live instance.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Workbook, SpreadsheetFile, FileBlob } from '@oai/artifact-tool';

const destination = path.resolve(process.argv[2]);
await fs.mkdir(destination, { recursive: true });
for (const variant of [
  'good',
  'wrong-line',
  'wrong-total',
  'missing-date',
  'unknown-formula',
  'conflicting',
  'missing-quantity',
  'good-russian',
]) {
  if (process.argv[3] && process.argv[3] !== variant) continue;
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add('Calculation');
  sheet.showGridLines = false;
  sheet.getRange('A2').values = [['Synthetic calculation']];
  sheet.getRange('A4:C8').values = [
    [
      'Organization',
      null,
      variant === 'conflicting' ? 'Example Company B' : 'Example Company A',
    ],
    ['Person', null, 'Example Person'],
    ['Document', null, 'DEMO-001'],
    ['Date', null, variant === 'missing-date' ? null : '2026-01-02'],
    ['Currency', null, 'USD'],
  ];
  sheet.getRange('A10').values = [
    ['Amounts rounded half up to 2 decimal places.'],
  ];
  sheet.getRange('A11').values = [
    ['Blank column B intentionally preserves cell addresses.'],
  ];
  sheet.getRange('A20:E22').values = [
    ['Line', null, 'Quantity', 'Unit price', 'Amount'],
    ['ITEM L01', null, variant === 'missing-quantity' ? null : 3, 0.335, null],
    ['ITEM L02', null, 2, 1.005, null],
  ];
  sheet.getRange('E21').formulas = [
    [variant === 'unknown-formula' ? '=ABS(C21*D21)' : '=ROUND(C21*D21,2)'],
  ];
  sheet.getRange('E22').formulas = [['=ROUND(C22*D22,2)']];
  if (variant === 'wrong-line') sheet.getRange('E21').values = [[9.99]];
  sheet.getRange('A24').values = [['Total']];
  sheet.getRange('E24').formulas = [['=SUM(E21:E22)']];
  if (variant === 'wrong-total') sheet.getRange('E24').values = [[3.0]];
  if (variant === 'good-russian') {
    sheet.getRange('A2').values = [['Тестовый расчёт']];
    sheet.getRange('A4:A8').values = [
      ['Организация'],
      ['ФИО'],
      ['Документ'],
      ['Дата'],
      ['Валюта'],
    ];
    sheet.getRange('A10').values = [
      ['Округление половины вверх до двух знаков.'],
    ];
    sheet.getRange('A11').values = [
      ['Пустой столбец B сохраняет исходные адреса ячеек.'],
    ];
    sheet.getRange('A20:E20').values = [
      ['Позиция', null, 'Количество', 'Цена', 'Сумма'],
    ];
    sheet.getRange('A21:A22').values = [['Позиция L01'], ['Позиция L02']];
    sheet.getRange('A24').values = [['Итого']];
  }
  sheet.getRange('A1:E25').format.font = { name: 'Arial', size: 11 };
  sheet.getRange('A2').format.font = { size: 18, bold: true };
  sheet.getRange('A1:A25').format.columnWidth = 24;
  sheet.getRange('B1:B25').format.columnWidth = 4;
  sheet.getRange('C1:C25').format.columnWidth = 28;
  sheet.getRange('D1:E25').format.columnWidth = 18;
  sheet.getRange('A1:E25').format.rowHeight = 22;
  sheet.getRange('A20:E20').format = {
    fill: '#26384A',
    font: { color: '#FFFFFF', bold: true },
  };
  sheet.getRange('D21:D22').setNumberFormat('0.000');
  sheet.getRange('E21:E24').setNumberFormat('0.00');
  sheet.getRange('A24:E24').format.borders = {
    top: { style: 'thin', color: '#26384A' },
  };
  sheet.getRange('A24:E24').format.font = { bold: true };
  sheet.freezePanes.freezeRows(20);
  workbook.recalculate();
  const inspect = await workbook.inspect({
    kind: 'table',
    range: 'Calculation!A20:E24',
    include: 'values,formulas',
    tableMaxRows: 5,
    tableMaxCols: 5,
  });
  await fs.writeFile(
    path.join(destination, `${variant}.inspect.json`),
    JSON.stringify(inspect),
  );
  const file = await SpreadsheetFile.exportXlsx(workbook);
  await file.save(path.join(destination, `${variant}.xlsx`));
  // Reopen the actual export before rendering. The screenshot represents the
  // exported workbook, rather than just the in-memory authoring model.
  const reopened = await SpreadsheetFile.importXlsx(
    await FileBlob.load(path.join(destination, `${variant}.xlsx`)),
  );
  const image = await reopened.render({
    sheetName: 'Calculation',
    range: 'A1:E25',
    scale: 1.5,
  });
  await fs.writeFile(
    path.join(destination, `${variant}.png`),
    new Uint8Array(await image.arrayBuffer()),
  );
}
