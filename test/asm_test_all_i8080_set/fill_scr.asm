.org 0x100
START:
  LXI SP, 0x8000
clear_screen:
  LXI H, 0x8000
  MVI B, 0x00
  CALL fill_scr
fill_scr_8000:
  LXI H, 0x8000
  MVI B, 0xFF
  CALL fill_scr
JMP clear_screen

; HL - start of screen memory
; B - value to fill with
fill_scr:
@loop:
  MOV M, B
  INX H
  MOV A, H
  ORA L
  JNZ @loop
  CALL pause
  RET

pause:
  MVI C, 0xFF
@loop:
  NOP
  DCR C
  JNZ @loop
  RET