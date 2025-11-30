#!/usr/bin/env node
// Find the first difference between two text files, line by line.

// Usage: node scripts/find-first-diff.js [aFile] [bFile]
// example:
//    node .\scripts\find-first-diff.js test\asm_test_all_i8080_set\putup.debug.log test\asm_test_all_i8080_set\putup_trace_log.txt

const fs = require('fs');
const path = require('path');

const [, , aArg, bArg] = process.argv;
const aPath = aArg || path.join('test', 'asm_test_all_i8080_set', 'fill_erase_scr_set_pal.debug.log');
const bPath = bArg || path.join('test', 'asm_test_all_i8080_set', 'fill_erase_scr_set_pal_trace_log_2025-11-29_21-34.txt');

function readLines(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    // Keep empty trailing line semantics consistent
    return raw.split(/\r?\n/);
  } catch (err) {
    console.error(`ERROR: cannot read file '${p}': ${err.message}`);
    process.exit(2);
  }
}

const aLines = readLines(aPath);
const bLines = readLines(bPath);
const aLen = aLines.length;
const bLen = bLines.length;
const minLen = Math.min(aLen, bLen);

let firstDiff = -1;
for (let i = 0; i < minLen; i++) {
  if (aLines[i] !== bLines[i]) { firstDiff = i + 1; break; }
}

if (firstDiff === -1) {
  if (aLen === bLen) {
    console.log(`NO DIFFERENCE: files are identical (lines=${aLen})`);
    process.exit(0);
  } else {
    console.log(`NO DIFFERENCE IN FIRST ${minLen} LINES; file lengths differ: ${aPath}=${aLen}, ${bPath}=${bLen}`);
    process.exit(0);
  }
} else {
  console.log(`FIRST DIFFERENCE AT LINE ${firstDiff}`);
  console.log(`- ${aPath} (line ${firstDiff}):`);
  console.log(aLines[firstDiff - 1]);
  console.log(`- ${bPath} (line ${firstDiff}):`);
  console.log(bLines[firstDiff - 1]);
  console.log('---');
  console.log(`Compared up to line ${minLen}. lengths: ${aPath}=${aLen}, ${bPath}=${bLen}`);
  process.exit(0);
}
