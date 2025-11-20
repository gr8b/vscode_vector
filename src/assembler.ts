import * as fs from 'fs';

type AssembleResult = {
  success: boolean;
  output?: Buffer;
  map?: Record<number, number>; // source line (1-based) -> address
  errors?: string[];
};

const regCodes: Record<string, number> = {
  B: 0,
  C: 1,
  D: 2,
  E: 3,
  H: 4,
  L: 5,
  M: 6,
  A: 7
};

const mviOpcodes = {
  B: 0x06,
  C: 0x0e,
  D: 0x16,
  E: 0x1e,
  H: 0x26,
  L: 0x2e,
  M: 0x36,
  A: 0x3e
} as Record<string, number>;

function toByte(v: string): number | null {
  if (/^0x[0-9a-fA-F]+$/.test(v)) return parseInt(v.slice(2), 16) & 0xff;
  if (/^[0-9]+$/.test(v)) return parseInt(v, 10) & 0xff;
  return null;
}

function parseAddressToken(v: string, labels?: Map<string, number>): number | null {
  if (/^0x[0-9a-fA-F]+$/.test(v)) return parseInt(v.slice(2), 16) & 0xffff;
  if (/^\$[0-9a-fA-F]+$/.test(v)) return parseInt(v.slice(1), 16) & 0xffff;
  if (/^[0-9]+$/.test(v)) return parseInt(v, 10) & 0xffff;
  if (labels && labels.has(v)) return labels.get(v)! & 0xffff;
  return null;
}

export function assemble(source: string): AssembleResult {
  const lines = source.split(/\r?\n/);
  const labels = new Map<string, number>();
  let addr = 0;
  const errors: string[] = [];

  // First pass: labels and address calculation
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    // handle optional leading label (either with colon or bare before an opcode/directive)
    const tokens = line.split(/\s+/);
    let labelHere: string | null = null;
    if (tokens[0].endsWith(':')) {
      labelHere = tokens[0].slice(0, -1);
      tokens.shift();
      if (!tokens.length) {
        if (labels.has(labelHere)) errors.push(`Duplicate label ${labelHere} at ${i + 1}`);
        labels.set(labelHere, addr);
        continue;
      }
    } else if (tokens.length >= 2 && /^\.?org$/i.test(tokens[1])) {
      // bare label before a directive, e.g. "start .org 0x100"
      labelHere = tokens[0];
      tokens.shift();
    }

    const op = tokens[0].toUpperCase();

    if (op === 'DB') {
      // DB value [,value]
      const rest = line.slice(2).trim();
      const parts = rest.split(',').map(p => p.trim());
      addr += parts.length;
      continue;
    }

    if (op === '.ORG' || op === 'ORG') {
      // .org addr
      const rest = tokens.slice(1).join(' ');
      const aTok = rest.trim().split(/\s+/)[0];
      const val = parseAddressToken(aTok, labels);
      if (val === null) { errors.push(`Bad ORG address '${aTok}' at ${i + 1}`); continue; }
      addr = val;
      if (labelHere) {
        if (labels.has(labelHere)) errors.push(`Duplicate label ${labelHere} at ${i + 1}`);
        labels.set(labelHere, addr);
      }
      continue;
    }

    if (op === 'MVI') {
      addr += 2; // opcode + data
      continue;
    }

    if (op === 'LXI') {
      addr += 3;
      continue;
    }

    if (op === 'MOV') {
      addr += 1;
      continue;
    }

    if (op === 'LDA' || op === 'STA' || op === 'JMP' || op === 'JZ' || op === 'JNZ' || op === 'CALL') {
      addr += 3;
      continue;
    }

    if (op === 'ADD' || op === 'INR' || op === 'DCR' || op === 'RET' || op === 'HLT' || op === 'NOP') {
      addr += 1;
      continue;
    }

    // unknown -> error
    errors.push(`Unknown or unsupported opcode '${op}' at line ${i + 1}`);
  }

  if (errors.length) return { success: false, errors };

  // Second pass: generate bytes and source-line map
  addr = 0;
  const out: number[] = [];
  const map: Record<number, number> = {};

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const srcLine = i + 1;
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*:$/.test(line)) continue; // label only

    // handle optional leading label on the same line
    const tokens = line.split(/\s+/);
    let labelHere: string | null = null;
    if (tokens[0].endsWith(':')) {
      labelHere = tokens[0].slice(0, -1);
      tokens.shift();
      if (!tokens.length) { map[srcLine] = addr; continue; }
    } else if (tokens.length >= 2 && /^\.?org$/i.test(tokens[1])) {
      labelHere = tokens[0];
      tokens.shift();
    }

    map[srcLine] = addr;

    const op = tokens[0].toUpperCase();

    if (op === 'DB') {
      const rest = line.slice(2).trim();
      const parts = rest.split(',').map(p => p.trim());
      for (const p of parts) {
        let val = toByte(p);
        if (val === null) {
          if (/^'.'$/.test(p)) val = p.charCodeAt(1);
          else { errors.push(`Bad DB value '${p}' at ${srcLine}`); val = 0; }
        }
        out.push(val & 0xff);
        addr++;
      }
      continue;
    }

    if (op === '.ORG' || op === 'ORG') {
      const aTok = tokens.slice(1).join(' ').trim().split(/\s+/)[0];
      const val = parseAddressToken(aTok, labels);
      if (val === null) { errors.push(`Bad ORG address '${aTok}' at ${srcLine}`); continue; }
      addr = val;
      // label for this ORG (if present) was already registered in first pass; nothing to emit
      continue;
    }

    if (op === 'MVI') {
      // MVI R,byte
      const args = line.slice(3).trim();
      const m = args.split(',').map(s => s.trim());
      if (m.length !== 2) { errors.push(`Bad MVI syntax at ${srcLine}`); continue; }
      const r = m[0].toUpperCase();
      const val = toByte(m[1]);
      if (!(r in mviOpcodes) || val === null) { errors.push(`Bad MVI operands at ${srcLine}`); continue; }
      out.push(mviOpcodes[r]);
      out.push(val & 0xff);
      addr += 2;
      continue;
    }

    if (op === 'MOV') {
      // MOV D,S
      const args = line.slice(3).trim();
      const m = args.split(',').map(s => s.trim());
      if (m.length !== 2) { errors.push(`Bad MOV syntax at ${srcLine}`); continue; }
      const d = m[0].toUpperCase();
      const s = m[1].toUpperCase();
      if (!(d in regCodes) || !(s in regCodes)) { errors.push(`Bad MOV registers at ${srcLine}`); continue; }
      const opcode = 0x40 + (regCodes[d] << 3) + regCodes[s];
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    if (op === 'LDA' || op === 'STA' || op === 'JMP' || op === 'JZ' || op === 'JNZ' || op === 'CALL') {
      const arg = tokens[1];
      let target = 0;
      if (/^[0-9]+$/.test(arg) || /^0x[0-9a-fA-F]+$/.test(arg)) {
        target = parseInt(arg);
      } else if (labels.has(arg)) {
        target = labels.get(arg)!;
      } else {
        errors.push(`Unknown label or address '${arg}' at ${srcLine}`);
        target = 0;
      }
      let opcode = 0;
      if (op === 'LDA') opcode = 0x3A;
      if (op === 'STA') opcode = 0x32;
      if (op === 'JMP') opcode = 0xC3;
      if (op === 'JZ') opcode = 0xCA;
      if (op === 'JNZ') opcode = 0xC2;
      if (op === 'CALL') opcode = 0xCD;
      out.push(opcode & 0xff);
      // little endian address
      out.push(target & 0xff);
      out.push((target >> 8) & 0xff);
      addr += 3;
      continue;
    }

    if (op === 'LXI') {
      // LXI RP, d16  (e.g., LXI B,0x1234)
      const args = line.slice(3).trim();
      const parts = args.split(',').map(s => s.trim());
      if (parts.length !== 2) { errors.push(`Bad LXI syntax at ${srcLine}`); continue; }
      const rp = parts[0].toUpperCase();
      const val = parts[1];
      let opcode = -1;
      if (rp === 'B') opcode = 0x01;
      if (rp === 'D') opcode = 0x11;
      if (rp === 'H') opcode = 0x21;
      if (rp === 'SP') opcode = 0x31;
      if (opcode < 0) { errors.push(`Bad LXI register pair at ${srcLine}`); continue; }
      let target = 0;
      if (/^0x[0-9a-fA-F]+$/.test(val)) target = parseInt(val.slice(2), 16);
      else if (/^[0-9]+$/.test(val)) target = parseInt(val);
      else if (labels.has(val)) target = labels.get(val)!;
      else { errors.push(`Bad LXI value '${val}' at ${srcLine}`); target = 0; }
      out.push(opcode & 0xff);
      out.push(target & 0xff);
      out.push((target >> 8) & 0xff);
      addr += 3;
      continue;
    }

    if (op === 'ADD') {
      // ADD r
      const r = tokens[1].toUpperCase();
      if (!(r in regCodes)) { errors.push(`Bad ADD reg at ${srcLine}`); continue; }
      const opcode = 0x80 + regCodes[r];
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    if (op === 'INR' || op === 'DCR') {
      // INR r or DCR r
      const r = tokens[1].toUpperCase();
      if (!(r in regCodes)) { errors.push(`Bad ${op} reg at ${srcLine}`); continue; }
      const base = op === 'INR' ? 0x04 : 0x05;
      const opcode = base + (regCodes[r] << 3);
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    if (op === 'RET') { out.push(0xC9); addr += 1; continue; }

    if (op === 'HLT') { out.push(0x76); addr += 1; continue; }
    if (op === 'NOP') { out.push(0x00); addr += 1; continue; }

    errors.push(`Unhandled opcode '${op}' at ${srcLine}`);
  }

  if (errors.length) return { success: false, errors };

  return { success: true, output: Buffer.from(out), map };
}

// convenience when using from extension
export function assembleAndWrite(source: string, outPath: string): { success: boolean; path?: string; errors?: string[] } {
  const res = assemble(source);
  if (!res.success || !res.output) return { success: false, errors: res.errors };
  fs.writeFileSync(outPath, res.output);
  return { success: true, path: outPath };
}
