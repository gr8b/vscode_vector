const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, '..', 'test.asm');
const outBin = path.join(__dirname, '..', 'test.rom');

const src = fs.readFileSync(srcPath, 'utf8');
const asm = require('../out/assembler');

const res = asm.assembleAndWrite(src, outBin);
if (!res.success) {
  console.error('Assembly failed:', res.errors || 'unknown error');
  process.exit(2);
}
console.log('Wrote', res.path);
