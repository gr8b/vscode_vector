const fs = require('fs');
const path = require('path');

function walkDir(dir, filelist = []) {
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walkDir(full, filelist);
    else filelist.push(full);
  }
  return filelist;
}

function resolveLocalLabelKey(name, file) {
  if (!name || name[0] !== '@') return name;
  const base = file ? path.basename(file, path.extname(file)) : 'memory';
  return '@' + name.slice(1) + '_' + base;
}

function findAsmFiles(root) {
  return walkDir(root).filter(f => f.toLowerCase().endsWith('.asm'));
}

function extractLabelsFromFile(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const res = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const withoutComments = raw.replace(/;.*$/, '');
    if (!withoutComments.trim()) continue;
    // label-only or label before instruction: token0 ends with ':'
    const mLabel = withoutComments.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:$|\s.*$)/);
    if (mLabel) {
      const name = mLabel[1];
      res.push({ name, file, line: i + 1, text: raw.trim() });
      continue;
    }
    // bare label before .org: e.g. "start .org 0x100"
    const mOrg = withoutComments.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+\.?org\b/i);
    if (mOrg) {
      const name = mOrg[1];
      res.push({ name, file, line: i + 1, text: raw.trim() });
    }
  }
  return res;
}

function main() {
  const root = process.cwd();
  const asmFiles = findAsmFiles(root);
  const occurrences = new Map();
  for (const f of asmFiles) {
    const labels = extractLabelsFromFile(f);
    for (const lbl of labels) {
      const key = resolveLocalLabelKey(lbl.name, lbl.file);
      if (!occurrences.has(key)) occurrences.set(key, []);
      occurrences.get(key).push(lbl);
    }
  }

  // Filter duplicates (more than one occurrence)
  const dupKeys = Array.from(occurrences.keys()).filter(k => occurrences.get(k).length > 1);
  if (!dupKeys.length) return;

  for (const k of dupKeys) {
    const items = occurrences.get(k);
    console.log(`Duplicated label: ${k} (total ${items.length})`);
    for (const it of items) {
      console.log(`  ${it.file}:${it.line}: ${it.text}`);
    }
    console.log('');
  }
}

main();
