; test.asm - extended instruction set
.org 0x100
LXI H,0x8000    ; set HL to point to 0x8000
MVI A,0x05      ; A = 5
MVI B,0x03      ; B = 3
ADD B           ; A = A + B => 8
INR A           ; A = 9
DCR B           ; B = 2

CALL sub        ; call subroutine
HLT
HLT
LABEL_ONE:
		NOP

sub:
	INR C         ; increment C
	RET
