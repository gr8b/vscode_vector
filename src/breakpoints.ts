import { Breakpoint } from './breakpoint';
import { CpuState } from './cpu_i8080';
import { MemState } from './memory';
import { BpStatus } from './breakpoint';


export default class Breakpoints {
  breakpoints = new Map<number, Breakpoint>();
  private _updates: number = 0;

  Add(bp: Breakpoint): void {
    this._updates++;
    if (this.breakpoints.has(bp.addr)) {
      let old_bp = this.breakpoints.get(bp.addr)!;
      old_bp.Update(bp);
    }
    this.breakpoints.set(bp.addr, bp);
  }

  Del(addr: number): void {
    if (this.breakpoints.delete(addr)) {
      this._updates++;
    }
  }

  Check(cpuState: CpuState, memState: MemState): boolean {
    let bp = this.breakpoints.get(cpuState.regs.pc.word)
    if (bp === undefined) return false;

    let status = bp.CheckStatus(cpuState, memState);

    if (bp.autoDel) {
      this.Del(bp.addr);
      this._updates++;
    }

    return status;
  }

  Clear(): void {
    this.breakpoints.clear();
    this._updates++;
  }

  GetStatus(addr: number): BpStatus{
    return this.breakpoints.get(addr)?.status ?? BpStatus.DELETED;
  }

  SetStatus(addr: number, status: BpStatus){
    this._updates++;
    let bp = this.breakpoints.get(addr);
    if (bp !== undefined) {
      bp.status = status;
      return;
    }
    this.breakpoints.set(addr, new Breakpoint(addr));
  }

  get updates (): number {
    return this._updates;
  }

}