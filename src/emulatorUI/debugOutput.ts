import CPU, { CpuState } from "../emulator/cpu_i8080";
import { FRAME_W } from "../emulator/display";
import { Hardware } from "../emulator/hardware";
import { HardwareReq } from "../emulator/hardware_reqs";
import { AddrSpace, MemDebug } from "../emulator/memory";


// helper: read cpu/memory state and return a compact debug object
export function getDebugState(hardware: Hardware)
: { global_addr: number,
    state: CpuState,
    opcode: number,
    byte1: number,
    byte2: number,
    instr_len: number }
{
  const state: CpuState = hardware?.Request(HardwareReq.GET_CPU_STATE)["data"] ?? new CpuState();
  const mem_debug_state = hardware?.Request(HardwareReq.GET_MEM_DEBUG_STATE)["data"] ?? new MemDebug();
  const global_addr = mem_debug_state.instrGlobalAddr;
  const opcode = mem_debug_state.instr[0] ?? 0;
  const byte1 = mem_debug_state.instr[1] ?? 0;
  const byte2 = mem_debug_state.instr[2] ?? 0;
  const instr_len = CPU.GetInstrLen(opcode);

  return { global_addr, state, opcode, byte1, byte2, instr_len};
}

// helper: format a single debug line from hardware state
export function getDebugLine(hardware: Hardware)
: string
{
    const s = getDebugState(hardware!);
    const cc = s.state.cc;

    const addrHex = s.global_addr.toString(16).toUpperCase().padStart(6, '0');
    const opHex = s.opcode.toString(16).toUpperCase().padStart(2, '0');
    const byteHex1 = s.instr_len > 1 ?
                    s.byte1.toString(16).toUpperCase().padStart(2, '0') :
                    '  ';
    const byteHex2 = s.instr_len > 2 ?
                    s.byte2.toString(16).toUpperCase().padStart(2, '0') :
                    '  ';

    const display_data = hardware.Request(HardwareReq.GET_DISPLAY_DATA);
    const x = display_data["rasterPixel"];
    const y = display_data["rasterLine"];
    const scrollIdx = display_data["scrollIdx"];

    const line = `${addrHex}  ${opHex} ${byteHex1} ${byteHex2}  `+
      `A=${(s.state.regs.af.a).toString(16).toUpperCase().padStart(2,'0')} `+
      `BC=${(s.state.regs.bc.word).toString(16).toUpperCase().padStart(4,'0')} `+
      `DE=${(s.state.regs.de.word).toString(16).toUpperCase().padStart(4,'0')} `+
      `HL=${(s.state.regs.hl.word).toString(16).toUpperCase().padStart(4,'0')} `+
      `SP=${(s.state.regs.sp.word).toString(16).toUpperCase().padStart(4,'0')} ` +
      `S${s.state.regs.af.s ? '1' : '0'} ` +
      `Z${s.state.regs.af.z ? '1' : '0'} ` +
      `AC${s.state.regs.af.ac ? '1' : '0'} ` +
      `P${s.state.regs.af.p ? '1' : '0'} ` +
      `CY${s.state.regs.af.c ? '1' : '0'} ` +
      `CC=${cc.toString(10).toUpperCase().padStart(12,'0')} ` +
      `scr=${x.toString(10).toUpperCase().padStart(3,'0')}/` +
      `${y.toString(10).toUpperCase().padStart(3,'0')} ` +
      `scrl=${scrollIdx.toString(16).toUpperCase().padStart(2,'0')}`;

    return line;
}