import { CpuState } from "./cpu_i8080";
import { DisplayState } from "./display";
import { HardwareReq } from "./hardware_reqs";
import { IOState } from "./io";
import { MemState } from "./memory";

export type ReqData = {
  [ key: string ]: any
};

export type DebugFunc = (
  (cpuState: CpuState ,
   memoryState: MemState,
   ioState: IOState,
   displayState: DisplayState) => boolean);

export type DebugReqHandlingFunc =
  ((req: HardwareReq,
    data: ReqData,
    cpuState: CpuState ,
    memoryState: MemState,
    ioState: IOState,
    displayState: DisplayState) => ReqData);