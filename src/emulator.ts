export type Registers = {
  A: number;
  B: number;
  C: number;
  D: number;
  E: number;
  H: number;
  L: number;
  SP: number;
  PC: number;
  flags: { Z: boolean };
};

export class Emulator {
  memory: Uint8Array;
  regs: Registers;
  running = false;
  breakpoints = new Set<number>();

  constructor(size = 0x10000) {
    this.memory = new Uint8Array(size);
    this.regs = { A: 0, B: 0, C: 0, D: 0, E: 0, H: 0, L: 0, SP: 0xfffe, PC: 0, flags: { Z: false } };
  }

  load(buffer: Buffer, address = 0) {
    this.memory.set(buffer, address);
    this.regs.PC = address;
  }

  readByte(addr: number) { return this.memory[addr & 0xffff]; }
  writeByte(addr: number, v: number) { this.memory[addr & 0xffff] = v & 0xff; }

  getReg(code: number) {
    switch (code) {
      case 0: return this.regs.B;
      case 1: return this.regs.C;
      case 2: return this.regs.D;
      case 3: return this.regs.E;
      case 4: return this.regs.H;
      case 5: return this.regs.L;
      case 6: // M (memory at HL)
        const hl = (this.regs.H << 8) | this.regs.L;
        return this.readByte(hl);
      case 7: return this.regs.A;
    }
    return 0;
  }

  setReg(code: number, val: number) {
    val &= 0xff;
    switch (code) {
      case 0: this.regs.B = val; break;
      case 1: this.regs.C = val; break;
      case 2: this.regs.D = val; break;
      case 3: this.regs.E = val; break;
      case 4: this.regs.H = val; break;
      case 5: this.regs.L = val; break;
      case 6: // M
        const hl = (this.regs.H << 8) | this.regs.L;
        this.writeByte(hl, val); break;
      case 7: this.regs.A = val; break;
    }
    this.regs.flags.Z = (val === 0);
  }

  step(): { halted: boolean; pc: number } {
    const pc = this.regs.PC;
    const op = this.readByte(pc);
    // NOP
    if (op === 0x00) { this.regs.PC++; return { halted: false, pc }; }
    // HLT
    if (op === 0x76) { return { halted: true, pc }; }

    // MVI r,byte
    const mviList = [0x06, 0x0e, 0x16, 0x1e, 0x26, 0x2e, 0x36, 0x3e];
    if (mviList.includes(op)) {
      const regIndex = mviList.indexOf(op);
      const val = this.readByte(pc + 1);
      this.setReg(regIndex, val);
      this.regs.PC += 2;
      return { halted: false, pc };
    }

    // MOV r1,r2 (0x40 - 0x7f)
    if ((op & 0xc0) === 0x40) {
      const d = (op >> 3) & 0x7;
      const s = op & 0x7;
      const val = this.getReg(s);
      this.setReg(d, val);
      this.regs.PC += 1;
      return { halted: false, pc };
    }

    // LDA (0x3A) little endian address
    if (op === 0x3A) {
      const lo = this.readByte(pc + 1);
      const hi = this.readByte(pc + 2);
      const addr = (hi << 8) | lo;
      this.regs.A = this.readByte(addr);
      this.regs.PC += 3;
      return { halted: false, pc };
    }

    // STA (0x32)
    if (op === 0x32) {
      const lo = this.readByte(pc + 1);
      const hi = this.readByte(pc + 2);
      const addr = (hi << 8) | lo;
      this.writeByte(addr, this.regs.A);
      this.regs.PC += 3;
      return { halted: false, pc };
    }

    // JMP (0xC3), JZ (0xCA), JNZ (0xC2)
    if (op === 0xC3 || op === 0xCA || op === 0xC2) {
      const lo = this.readByte(pc + 1);
      const hi = this.readByte(pc + 2);
      const addr = (hi << 8) | lo;
      if (op === 0xC3) {
        this.regs.PC = addr; return { halted: false, pc };
      }
      if (op === 0xCA) {
        if (this.regs.flags.Z) { this.regs.PC = addr; } else { this.regs.PC += 3; } return { halted: false, pc };
      }
      if (op === 0xC2) {
        if (!this.regs.flags.Z) { this.regs.PC = addr; } else { this.regs.PC += 3; } return { halted: false, pc };
      }
    }

    // CALL (0xCD)
    if (op === 0xCD) {
      const lo = this.readByte(pc + 1);
      const hi = this.readByte(pc + 2);
      const addr = (hi << 8) | lo;
      const ret = (pc + 3) & 0xffff;
      // push high then low onto stack (stack grows down)
      this.regs.SP = (this.regs.SP - 1) & 0xffff;
      this.writeByte(this.regs.SP, (ret >> 8) & 0xff);
      this.regs.SP = (this.regs.SP - 1) & 0xffff;
      this.writeByte(this.regs.SP, ret & 0xff);
      this.regs.PC = addr;
      return { halted: false, pc };
    }

    // RET (0xC9)
    if (op === 0xC9) {
      const low = this.readByte(this.regs.SP);
      const high = this.readByte((this.regs.SP + 1) & 0xffff);
      this.regs.PC = (high << 8) | low;
      this.regs.SP = (this.regs.SP + 2) & 0xffff;
      return { halted: false, pc };
    }

    // LXI rp, d16 (0x01,0x11,0x21,0x31)
    if (op === 0x01 || op === 0x11 || op === 0x21 || op === 0x31) {
      const lo = this.readByte(pc + 1);
      const hi = this.readByte(pc + 2);
      const val = (hi << 8) | lo;
      if (op === 0x01) { this.regs.B = (val >> 8) & 0xff; this.regs.C = val & 0xff; }
      if (op === 0x11) { this.regs.D = (val >> 8) & 0xff; this.regs.E = val & 0xff; }
      if (op === 0x21) { this.regs.H = (val >> 8) & 0xff; this.regs.L = val & 0xff; }
      if (op === 0x31) { this.regs.SP = val & 0xffff; }
      this.regs.PC += 3;
      return { halted: false, pc };
    }

    // ADD r (0x80 + r)
    if ((op & 0xf8) === 0x80) {
      const r = op & 0x7;
      const val = this.getReg(r);
      const res = (this.regs.A + val) & 0xff;
      this.regs.A = res;
      this.regs.flags.Z = (res === 0);
      this.regs.PC += 1;
      return { halted: false, pc };
    }

    // INR r (0x04 + r<<3) and DCR r (0x05 + r<<3)
    const upper = op & 0b00111000;
    const base = op & 0x07;
    if ((op & 0b11000111) === 0x04) { // INR
      const r = (op >> 3) & 0x7;
      const val = (this.getReg(r) + 1) & 0xff;
      this.setReg(r, val);
      this.regs.flags.Z = (val === 0);
      this.regs.PC += 1;
      return { halted: false, pc };
    }
    if ((op & 0b11000111) === 0x05) { // DCR
      const r = (op >> 3) & 0x7;
      const val = (this.getReg(r) - 1) & 0xff;
      this.setReg(r, val);
      this.regs.flags.Z = (val === 0);
      this.regs.PC += 1;
      return { halted: false, pc };
    }

    // Unknown opcode: treat as NOP and advance
    this.regs.PC += 1;
    return { halted: false, pc };
  }

  runUntilBreakpointOrHalt(maxSteps = 100000): { halted: boolean; pc: number; stoppedOnBreakpoint: boolean } {
    let steps = 0;
    while (steps++ < maxSteps) {
      if (this.breakpoints.has(this.regs.PC)) return { halted: false, pc: this.regs.PC, stoppedOnBreakpoint: true };
      const res = this.step();
      if (res.halted) return { halted: true, pc: res.pc, stoppedOnBreakpoint: false };
    }
    return { halted: false, pc: this.regs.PC, stoppedOnBreakpoint: false };
  }
}
