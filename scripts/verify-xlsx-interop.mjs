import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), 'jiange-xlsx-interop-'));
const python = process.env.JIANGE_XLSX_PYTHON || 'python3';
try {
  const source = join(temp, 'source.xlsx'), roundtrip = join(temp, 'roundtrip.xlsx'), exported = join(temp, 'exported.xlsx');
  execFileSync(python, ['-c', `
from openpyxl import Workbook
from openpyxl.styles import Font
import sys
w = Workbook(); s = w.active; s.title = '计划'
s['A1'] = '项目'; s['A1'].font = Font(bold=True)
s['A2'] = '研发'; s['B2'] = 8; s['C2'] = True; s['D2'] = '=B2*2'; s['E2'] = '#DIV/0!'
w.create_sheet('汇总')['A1'] = '待核对'; w.save(sys.argv[1])
`, source], { stdio: 'inherit' });
  const entry = pathToFileURL(join(root, 'packages/sheet-sdk/src/index.ts')).href;
  writeFileSync(join(temp, 'check.mts'), `
import { readFileSync, writeFileSync } from 'node:fs';
import { readXlsx, writeXlsx } from ${JSON.stringify(entry)};
const input = await readXlsx(readFileSync(process.argv[2]));
if (input.workbook.sheets[0].name !== '计划' || !input.warnings.includes('styles_not_preserved')) throw Error('import mismatch');
writeFileSync(process.argv[3], writeXlsx(input.workbook));
writeFileSync(process.argv[4], writeXlsx({sheets:[{name:'Data',cells:[{row:0,col:0,value:'=literal'}, {row:0,col:1,value:8}, {row:1,col:1,formula:'=B1*2',value:16}, {row:0,col:2,value:true}, {row:1,col:2,value:'line1\\rline2'}]}]}));
`);
  execFileSync('pnpm', ['--filter', '@jiange/collab', 'exec', 'tsx', join(temp, 'check.mts'), source, roundtrip, exported], { cwd: root, stdio: 'inherit' });
  execFileSync(python, ['-c', `
from openpyxl import load_workbook
import sys
w = load_workbook(sys.argv[1], data_only=False)
assert w.sheetnames == ['计划', '汇总']
s = w['计划']; assert (s['A2'].value, s['B2'].value, s['C2'].value, s['D2'].value, s['E2'].value) == ('研发', 8, True, '=B2*2', '#DIV/0!')
x = load_workbook(sys.argv[2], data_only=False)['Data']; assert x['A1'].value == '=literal' and x['A1'].data_type == 's'
assert x['B2'].value == '=B1*2' and x['C1'].value is True
assert x['C2'].value == 'line1\\rline2'
assert load_workbook(sys.argv[2], data_only=True)['Data']['B2'].value == 16
`, roundtrip, exported], { stdio: 'inherit' });
  console.log('OpenPyXL XLSX import, export and formula-cache interoperability passed.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
