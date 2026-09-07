// Dump sheet names, headers and first rows of an xlsx so we can learn its shape.
const path = require('path');
const ExcelJS = require('exceljs');

async function main() {
  const file = process.argv[2];
  const maxRows = Number(process.argv[3] || 8);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  console.log('FILE:', path.basename(file));
  wb.eachSheet((ws) => {
    console.log(`\n=== SHEET "${ws.name}"  rows=${ws.rowCount} cols=${ws.columnCount} ===`);
    for (let r = 1; r <= Math.min(ws.rowCount, maxRows); r++) {
      const row = ws.getRow(r);
      const vals = [];
      for (let c = 1; c <= ws.columnCount; c++) {
        let v = row.getCell(c).value;
        if (v && typeof v === 'object') v = v.text ?? v.result ?? v.richText?.map((t) => t.text).join('') ?? JSON.stringify(v);
        vals.push(v === null || v === undefined ? '' : String(v));
      }
      console.log(`r${r}: ` + vals.join(' | '));
    }
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
