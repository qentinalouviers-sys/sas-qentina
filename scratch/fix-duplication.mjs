import fs from 'fs';
import path from 'path';

const filePath = path.resolve(process.cwd(), 'src/app/(dashboard)/banque/page.tsx');
const content = fs.readFileSync(filePath, 'utf-8');

const isCrlf = content.includes('\r\n');
const lines = content.split(/\r?\n/);

console.log("Line 1353 to remove:", lines[1352]);
console.log("Line 1359 to remove:", lines[1358]);

// Double check we are removing the correct block
if (lines[1352].trim() === 'return (' && lines[1358].trim().includes('partnerName = partner')) {
  lines.splice(1352, 7);
  const newContent = lines.join(isCrlf ? '\r\n' : '\n');
  fs.writeFileSync(filePath, newContent, 'utf-8');
  console.log("Successfully spliced out duplicate lines.");
} else {
  console.error("Safety check failed. Lines did not match.");
}
