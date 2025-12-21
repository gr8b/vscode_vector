import * as type from './type';

export enum AddrSpace { RAM = 0, STACK = 1, GLOBAL = 2 }
export enum MemType { ROM = 0, RAM = 1 }

export const ROM_LOAD_ADDR = 0x0100;
export const MEM_64K = 64 * 1024;
export const RAM_DISK_PAGE_LEN = MEM_64K;
export const RAMDISK_PAGES_MAX = 4;
export const MEMORY_RAMDISK_LEN = RAMDISK_PAGES_MAX * MEM_64K;
export const RAM_DISK_MAX = 8;

export const MEMORY_MAIN_LEN = MEM_64K;
export const MEMORY_GLOBAL_LEN = MEMORY_MAIN_LEN + MEMORY_RAMDISK_LEN * RAM_DISK_MAX;

export const MAPPING_MODE_MASK = 0b11110000;

export const BOOT_ROM_LEN_MAX = 64 * 1024; // 64KB


export class MemMapping {
  pageRam: number = 0;     // 0-1 bits, The index of the RAM Disk 64k page accessed in the Memory-Mapped Mode
  pageStack: number = 0;   // 2-3 bits, The index of the RAM Disk 64k page accessed in the Stack Mode
  modeStack: boolean = false;  // 4 bit, Enables the Stack Mode
  modeRamA: boolean = false;   // 5 bit, Enables the Memory-Mapped Mode with mapping for range [0xA000-0xDFFF]
  modeRam8: boolean = false;   // 6 bit, Enables the Memory-Mapped Mode with mapping for range [0x8000-0x9FFF]
  modeRamE: boolean = false;   // 7 bit, Enables the Memory-Mapped Mode with mapping for range [0xE000-0xFFFF]

  get byte(): number {
    let data = (this.pageRam) | ((this.pageStack) << 2);
    data |= (this.modeStack ? 0b00010000 : 0);
    data |= (this.modeRamA ? 0b00100000 : 0);
    data |= (this.modeRam8 ? 0b01000000 : 0);
    data |= (this.modeRamE ? 0b10000000 : 0);
    return data;
  }

  set byte(data: number) {
    this.pageRam = data & 0x03;
    this.pageStack = (data >> 2) & 0x03;
    this.modeStack = (data & 0b00010000) !== 0;
    this.modeRamA = (data & 0b00100000) !== 0;
    this.modeRam8 = (data & 0b01000000) !== 0;
    this.modeRamE = (data & 0b10000000) !== 0;
  }

  Erase(): void {
    this.pageRam = 0;
    this.pageStack = 0;
    this.modeStack = false;
    this.modeRamA = false;
    this.modeRam8 = false;
    this.modeRamE = false;
  }

  IsRamModeEnabled(): boolean {
    return this.modeRamA || this.modeRam8 || this.modeRamE;
  }
  clone(): MemMapping {
    const copy = new MemMapping();
    copy.pageRam = this.pageRam;
    copy.pageStack = this.pageStack;
    copy.modeStack = this.modeStack;
    copy.modeRamA = this.modeRamA;
    copy.modeRam8 = this.modeRam8;
    copy.modeRamE = this.modeRamE;
    return copy;
  }
};


type GetGlobalAddrFuncType = (addr: number, addrSpace: AddrSpace) => number;

export class MemUpdate {
  mappings: MemMapping[] = Array.from({length: RAM_DISK_MAX}, () => new MemMapping());
  // current active mapping state
  ramdiskIdx = 0;

  clone(): MemUpdate {
    const copy = new MemUpdate();
    copy.ramdiskIdx = this.ramdiskIdx;
    copy.mappings = this.mappings.map(m => m.clone());
    return copy;
  }
};

export class MemDebug{
			instrGlobalAddr: number = 0;
			instr: number[] = [0, 0, 0]; // opcode; addrL; addrH
			instrLen: number = 0;
			readGlobalAddr: number[] = [0, 0];
			read: number[] = [0, 0];
			readLen: number = 0;
			writeGlobalAddr: number[] = [0, 0];
			write: number[] = [0, 0];
			writeLen: number = 0;
			beforeWrite: number[] = [0, 0];

  Init(): void {
    this.instrLen = this.readLen = this.writeLen = 0;
  }
  clone(): MemDebug {
    const copy = new MemDebug();
    copy.instrGlobalAddr = this.instrGlobalAddr;
    copy.instr = this.instr.slice(0);
    copy.instrLen = this.instrLen;
    copy.readGlobalAddr = this.readGlobalAddr.slice(0);
    copy.read = this.read.slice(0);
    copy.readLen = this.readLen;
    copy.writeGlobalAddr = this.writeGlobalAddr.slice(0);
    copy.write = this.write.slice(0);
    copy.writeLen = this.writeLen;
    copy.beforeWrite = this.beforeWrite.slice(0);
    return copy;
  }
};

export class MemState {
	update: MemUpdate = new MemUpdate();
  debug: MemDebug = new MemDebug();
  ram: Uint8Array | null = null;
  GetGlobalAddrFunc: GetGlobalAddrFuncType | null = null;

  constructor(_getGlobalAddrFunc: GetGlobalAddrFuncType | null,
              ram: Uint8Array | null) {
    this.GetGlobalAddrFunc = _getGlobalAddrFunc;
    this.ram = ram;
  }
}

export class Memory {
  _ram: Uint8Array = new Uint8Array(MEMORY_GLOBAL_LEN);
  _rom: Uint8Array = new Uint8Array(0);

  _state = new MemState(this.GetGlobalAddr.bind(this), this._ram);

  // Number of RAM Disks with mapping enabled. This is used to detect exceptions
  mappingsEnabled = 0;

  memType: MemType = MemType.ROM;
  _ramDiskClearAfterRestart: boolean = false;
  _pathBootData: string = '';
  result: type.EmulatorResult = new type.EmulatorResult();


  constructor(bootRom: Uint8Array | undefined, ramDisk: Uint8Array | undefined, ramDiskClearAfterRestart: boolean = false)
  {
    this._ramDiskClearAfterRestart = ramDiskClearAfterRestart;
    if (bootRom){
      if (bootRom.length > BOOT_ROM_LEN_MAX) {
        this.result.addWarning(`Boot ROM size ${bootRom.length} exceeds max ${BOOT_ROM_LEN_MAX}.`);
      }
      else {
        this._rom = bootRom;
      }
    }
    else this.result.addWarning(`Boot ROM is undefined.`)

    if (ramDisk && ramDisk.length === MEMORY_RAMDISK_LEN * RAM_DISK_MAX) {
      this._ram.set(ramDisk, MEMORY_MAIN_LEN);
    }
    else this.result.addWarning(`RAM Disk is undefined or has incorrect size.`)
  }


  get ramDisk(): Uint8Array {
    return this._ram.subarray(MEMORY_MAIN_LEN, MEMORY_GLOBAL_LEN);
  }


  // HW reset (BLK + VVOD keys)
  Reset()
  {
    // clear the global RAM or the main RAM depending on the setting
    const erase_len = this._ramDiskClearAfterRestart ? MEMORY_GLOBAL_LEN : MEMORY_MAIN_LEN;
    this._state.ram?.fill(0, 0, erase_len);

    this.memType = MemType.ROM;
    this.InitRamDiskMapping();
  }

  InitRamDiskMapping() {
    for (let mapping of this._state.update.mappings) {
      mapping.Erase();
    }

    this._state.update.ramdiskIdx = 0;
    this.mappingsEnabled = 0;
  }

  Restart() {
	this.memType = MemType.RAM;
	this.InitRamDiskMapping();
  }

  SetMemType(_memType: MemType) {
	this.memType = _memType;
  }

  SetRam(_addr: number, _data: Uint8Array) {
    this._ram.set(_data, _addr);
  }

  SetByteGlobal(globalAddr: number, data: number) {
    this._ram[globalAddr] = data;
  }

  GetByteGlobal(globalAddr: number): number {
    return this._ram[globalAddr];
  }

  GetByte(addr: number, addrSpace: AddrSpace = AddrSpace.RAM): number {
  const globalAddr = this.GetGlobalAddr(addr, addrSpace);

  return this.memType === MemType.ROM && globalAddr < this._rom.length ?
    this._rom[globalAddr] : this._ram[globalAddr];
  }

  // accessed by the CPU for instruction fetch
  // byteNum = 0 for the first byte stored by instr, 1 for the second
  // byteNum is 0, 1, or 2
  CpuReadInstr(addr: number, addrSpace: AddrSpace, byteNum: number): number {
    const globalAddr = this.GetGlobalAddr(addr, addrSpace);
    const val = this.memType === MemType.ROM && globalAddr < this._rom.length ?
      this._rom[globalAddr] : this._ram[globalAddr];

    // debug
    if (byteNum === 0) {
      this._state.debug.instrGlobalAddr = globalAddr;
    }
    this._state.debug.instr[byteNum] = val;
    return val;
  }

  CpuInvokesRst7()
  {
    this._state.debug.instr[0] = 0xFF; // OPCODE_RST7
  }

  // accessed by the CPU
  // byteNum = 0 for the first byte stored by instr, 1 for the second
  // byteNum is 0 or 1
  CpuRead(addr: number, addrSpace: AddrSpace, byteNum: number): number {
    const globalAddr = this.GetGlobalAddr(addr, addrSpace);

    // debug
    this._state.debug.readGlobalAddr[byteNum] = globalAddr;
    this._state.debug.readLen = byteNum + 1;

    // return byte
    const value = this.memType === MemType.ROM && globalAddr < this._rom.length ?
      this._rom[globalAddr] : this._ram[globalAddr];
    return value;
  }

  // accessed by the CPU
  // byteNum = 0 for the first byte stored by instr, 1 for the second
  // byteNum is 0 or 1
  CpuWrite(addr: number, value: number, addrSpace: AddrSpace = AddrSpace.RAM, byteNum: number): void {
    const globalAddr = this.GetGlobalAddr(addr, addrSpace);

    // debug
    this._state.debug.beforeWrite[byteNum] = this._ram[globalAddr];
    this._state.debug.writeGlobalAddr[byteNum] = globalAddr;
    this._state.debug.writeLen = byteNum + 1;
    this._state.debug.write[byteNum] = value;

    // store byte
    this._ram[globalAddr] = value;
  }

  // Read 4 bytes from every screen buffer.
  // All of these bytes are visually at the same position on the screen
  GetScreenBytes(screenAddrOffset: number): number {
    const byte8 = this._ram[0x8000 + screenAddrOffset];
    const byteA = this._ram[0xA000 + screenAddrOffset];
    const byteC = this._ram[0xC000 + screenAddrOffset];
    const byteE = this._ram[0xE000 + screenAddrOffset];
    return (byte8 << 24) | (byteA << 16) | (byteC << 8) | byteE;
  }

  // Convert a 16-bit addr to a global addr depending on the ram/stack mapping modes
  GetGlobalAddr(addr: number, addrSpace: AddrSpace): number {
    addr = addr & 0xffff;
    let mapping = this._state.update.mappings;
    let ramdiskIdx = this._state.update.ramdiskIdx;

    // if no mapping enabled, return addr
    if (!(mapping[ramdiskIdx].byte & MAPPING_MODE_MASK)) return addr;

    const md = mapping[ramdiskIdx];

    // STACK mapping
    if (md.modeStack && addrSpace === AddrSpace.STACK)
    {
      const pageStack = mapping[ramdiskIdx].pageStack;
      const pageIndex = pageStack + 1 + ramdiskIdx * 4;
      return pageIndex * RAM_DISK_PAGE_LEN + addr;
    }

    // The ram mapping can be applied to a stack operation as well if the addr falls into the ram-mapping range
    if ((md.modeRamA && addr >= 0xA000 && addr < 0xE000) ||
        (md.modeRam8 && addr >= 0x8000 && addr < 0xA000) ||
        (md.modeRamE && addr >= 0xE000))
    {
      const pageRam = mapping[ramdiskIdx].pageRam;
      const pageIndex = pageRam + 1 + ramdiskIdx * 4;
      return pageIndex * RAM_DISK_PAGE_LEN + addr;
    }

    return addr;
  }

  // It raises an exception if the mapping is enabled for more than one RAM Disk.
  // It used the first enabled RAM Disk during an exception
  SetRamDiskMode(fddIdx: number, data: number)
  {
    this._state.update.mappings[fddIdx].byte = data;

    // Check how many mappings are enabled
    this.mappingsEnabled = 0;
    for (let i = 0; i < RAM_DISK_MAX; i++)
    {
      const mappingByte = this._state.update.mappings[i].byte;
      if (mappingByte & MAPPING_MODE_MASK) {
        this.mappingsEnabled++;
        if (this.mappingsEnabled > 1) {
          break;
        }
        this._state.update.ramdiskIdx = i;
      }
    }
  }

  // It raises an exception if the mapping is enabled for more than one RAM Disk.
  IsException()
  {
    const exception = this.mappingsEnabled > 1;
    // Reset the counter for the next check
    this.mappingsEnabled = 0;
    return exception;
  }


  get state(): MemState {
    return this._state;
  }

  get ram(): Uint8Array {
    return this._ram;
  }

}

export default Memory;
