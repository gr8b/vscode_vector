# Intel 8080 Assembler + Debugger (Minimal)

This is a minimal VS Code extension that provides:

- A tiny two-pass assembler for a subset of the Intel 8080 instruction set.
- A very small 8080 emulator.
- A debug adapter exposing basic features: breakpoints, continue, step, view registers.

Quick start

1. Install dependencies:

```pwsh
npm install
```

2. Build the extension (produces `out/`):

```pwsh
npm run compile
```

3. Open this folder in VS Code and press F5 to run the Extension Development Host.

4. In the Extension Host open an `.asm` source file and run the command `Compile i8080 Assembly` (or use a debug configuration of type `i8080`).

Notes

- This project implements a minimal subset of instructions (labels, DB, MVI, MOV, LDA, STA, JMP, JZ, JNZ, HLT, NOP). The assembler will emit a `.bin` next to the source file.
- The debugger is intentionally small and meant for experimentation/demo purposes.

Sample test launch

You can run the included `test.asm` automatically using the sample launch configuration in `.vscode/test.launch.json`.

- Open `test.asm` in the Extension Development Host (or your workspace).
- Start the configuration named `Run test.asm (i8080)` from the Run and Debug view or use the command palette to select it. It will assemble `test.asm` (if needed) and launch the `i8080` debug adapter.

If you prefer to include the configuration in your workspace `launch.json`, copy the contents of `.vscode/test.launch.json` into `.vscode/launch.json`.


How to assemble, update labels and run the emulator
---------------------------------------------------

- **Compile the TypeScript (build the extension / tools)**

	```pwsh
	npm install
	npm run compile
	```

- **Assemble `test.asm` into `test.rom`**

	We include a small runner at `scripts/run-assembler.js` which uses the compiled assembler in `out/` and writes `test.rom` in the workspace root.

	```pwsh
	node .\scripts\run-assembler.js
	```

- **Update `test.json` with labels extracted from the assembly source**

	The helper script `scripts/update-test-json.js` parses `test.asm`, collects labels and addresses, and writes them into `test.json` under the `labels` object (addresses are written as `0xHHHH`). Run:

	```pwsh
	node .\scripts\update-test-json.js
	```

- **Run the external emulator**

	If you have the external emulator `devector.exe` available at `https://github.com/parallelno/Devector`, launch it with the produced ROM:

	```pwsh
	devector.exe test.rom
	```

	The emulator will load the ROM and print runtime traces to the console. If you see messages like "File loaded" and "Break: elapsed cpu cycles", the ROM ran and hit a breakpoint or halted.

Notes and tips
-------------

- The assembler supports `.org` directives (decimal, `0x..`, or `$..` syntax). Use `.org 0x100` to start assembling at address `0x0100`.
- Labels produced by the assembler are included in `test.json` as `"label": "0xHHHH"`. The debugger/emulator can use these labels for breakpoints.
- If you want a single npm command to run everything (compile, assemble, update labels, and run the emulator), you can add a script to `package.json`. Example (PowerShell-aware usage may require wrapping commands):

	```json
	"scripts": {
		"assemble:run": "npm run compile && node ./scripts/run-assembler.js && node ./scripts/update-test-json.js && C:\\Work\\Programming\\devector\\bin\\devector.exe C:\\Work\\Programming\\vscode_vector\\test.rom"
	}
	```

	Adjust the emulator path to where `devector.exe` is installed on your machine.

If you'd like, I can add the `assemble:run` npm script to `package.json` for convenience. (I won't modify it without your permission.)
