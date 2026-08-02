import fs from 'fs';
import path from 'path';

const filePath = path.resolve(process.cwd(), 'src/app/(dashboard)/banque/page.tsx');
const content = fs.readFileSync(filePath, 'utf-8');

const lines = content.split('\n');
for (let i = 1340; i < 1375; i++) {
  if (lines[i]) {
    console.log(`${i + 1}: [${lines[i].length} chars] -> "${lines[i]}"`);
  }
}
