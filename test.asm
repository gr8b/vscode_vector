; It starts at 0x0100 so labels/addresses are stable.
.org 0x100
DI
HLT

; label examples
LABEL_ONE: CALL sub
LABEL_TWO: CALL sub

sub:
	INR C
	RET

; -------------------------
; include i8080 instruction set test
.include "test_i8080_set.asm"