const fs = require('fs');
const path = require('path');

const asmPath = path.join(__dirname, '..', 'test.asm');
const jsonPath = path.join(__dirname, '..', 'test.json');

function parseAddressToken(v, labels) {
  if (!v) return null;
  v = v.trim();
  if (/^0x[0-9a-fA-F]+$/.test(v)) return parseInt(v.slice(2), 16) & 0xffff;
  if (/^\$[0-9a-fA-F]+$/.test(v)) return parseInt(v.slice(1), 16) & 0xffff;
  if (/^[0-9]+$/.test(v)) return parseInt(v, 10) & 0xffff;
  if (labels && labels.has(v)) return labels.get(v) & 0xffff;
  return null;
}

function collectLabels(source) {
  const lines = source.split(/\r?\n/);
  const labels = new Map();
  let addr = 0;
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    let labelHere = null;
    if (tokens[0].endsWith(':')) {
      labelHere = tokens[0].slice(0, -1);
      tokens.shift();
      if (!tokens.length) {
        if (labels.has(labelHere)) errors.push(`Duplicate label ${labelHere} at ${i+1}`);
        labels.set(labelHere, addr);
        continue;
      }
    } else if (tokens.length >= 2 && /^\.?org$/i.test(tokens[1])) {
      labelHere = tokens[0];
      tokens.shift();
    }

    const op = tokens[0].toUpperCase();

    if (op === 'DB') {
      const rest = line.slice(2).trim();
      const parts = rest.split(',').map(p => p.trim());
      addr += parts.length;
      continue;
    }

    if (op === '.ORG' || op === 'ORG') {
      const rest = tokens.slice(1).join(' ');
      const aTok = rest.trim().split(/\s+/)[0];
      const val = parseAddressToken(aTok, labels);
      if (val === null) { errors.push(`Bad ORG address '${aTok}' at ${i+1}`); continue; }
      addr = val;
      if (labelHere) {
        if (labels.has(labelHere)) errors.push(`Duplicate label ${labelHere} at ${i+1}`);
        labels.set(labelHere, addr);
      }
      continue;
    }

    if (op === 'MVI') { addr += 2; continue; }
    if (op === 'LXI') { addr += 3; continue; }
    if (op === 'MOV') { addr += 1; continue; }
    if (op === 'LDA' || op === 'STA' || op === 'JMP' || op === 'JZ' || op === 'JNZ' || op === 'CALL') { addr += 3; continue; }
    if (op === 'ADD' || op === 'INR' || op === 'DCR' || op === 'RET' || op === 'HLT' || op === 'NOP') { addr += 1; continue; }

    errors.push(`Unknown or unsupported opcode '${op}' at line ${i+1}`);
  }

  return { labels, errors };
}

try {
  const src = fs.readFileSync(asmPath, 'utf8');
  const { labels, errors } = collectLabels(src);
  if (errors && errors.length) {
    console.error('Warning: issues while collecting labels:', errors);
  }

  // read existing JSON or create a basic template
  let cfg = {};
  if (fs.existsSync(jsonPath)) {
    cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } else {
    cfg = {
      breakpoints: [],
      codePerfs: null,
      comments: null,
      consts: null,
      labels: {},
      memoryEdits: null,
      scripts: null,
      watchpoints: null
    };
  }

  const labelsObj = {};
  for (const [k, v] of labels) {
    labelsObj[k] = '0x' + v.toString(16).toUpperCase().padStart(4, '0');
  }

  cfg.labels = labelsObj;

  fs.writeFileSync(jsonPath, JSON.stringify(cfg, null, 4), 'utf8');
  console.log('Updated', jsonPath);
} catch (err) {
  console.error('Failed to update test.json:', err);
  process.exit(1);
}
