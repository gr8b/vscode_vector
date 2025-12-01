import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { assemble, assembleAndWrite } from './assembler';
import { openEmulatorPanel, pauseEmulatorPanel, resumeEmulatorPanel, runFramePanel } from './emulatorUI';

export function activate(context: vscode.ExtensionContext) {
  // gather included files (resolve .include recursively)
  function findIncludedFiles(srcPath: string, content: string, out = new Set<string>(), depth = 0): Set<string> {
    if (!srcPath) return out;
    if (depth > 16) return out;
    out.add(path.resolve(srcPath));
    const lines = content.split(/\r?\n/);
    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li];
      // strip comments
      const trimmed = raw.replace(/\/\/.*$|;.*$/, '').trim();
      const m = trimmed.match(/^\.include\s+["']([^"']+)["']/i);
      if (m) {
        let incPath = m[1];
        if (!path.isAbsolute(incPath)) {
          incPath = path.resolve(path.dirname(srcPath), incPath);
        }
        if (!out.has(path.resolve(incPath))) {
          // read file and recurse
          try {
            const incText = fs.readFileSync(incPath, 'utf8');
            findIncludedFiles(incPath, incText, out, depth + 1);
          } catch (err) {
            // ignore missing include here; assembler would've reported it.
          }
        }
      }
    }
    return out;
  }
  const disposable = vscode.commands.registerCommand('i8080.compile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showErrorMessage('Open an .asm file to compile'); return; }
    const doc = editor.document;
    if (!doc.fileName.endsWith('.asm')) { vscode.window.showWarningMessage('File does not have .asm extension, still attempting to assemble.'); }
    const src = doc.getText();
    // pass the document file path so assembler can resolve .include relative paths
    const outPath = doc.fileName.replace(/\.asm$/i, '.rom');
    // use assembleAndWrite which prints formatted errors/warnings to stderr/stdout
    const writeRes = assembleAndWrite(src, outPath, doc.fileName);
    if (!writeRes.success) {
      // assembleAndWrite already printed formatted errors to stderr, but keep the popup
      const errMsg = writeRes.errors ? writeRes.errors.join('; ') : 'Assemble failed';
      // Also write the formatted errors to the Output panel so they are visible
      try {
        const outCh = vscode.window.createOutputChannel('Devector');
        outCh.appendLine(`Devector: Compilation failed:\n${errMsg}`);
        if (writeRes.errors && writeRes.errors.length) {
          for (const e of writeRes.errors) {
            outCh.appendLine(e);
            outCh.appendLine('');
          }
        }
        outCh.show(true);
      } catch (e) { /* ignore any output channel errors */ }
      //vscode.window.showErrorMessage('Compilation failed: ' + errMsg);
      return;
    }
    // Also write success and timing info to the Output panel
    try {
      const outCh = vscode.window.createOutputChannel('Devector');
      const timeMsg = (writeRes as any).timeMs !== undefined ? `${(writeRes as any).timeMs}` : '';
      outCh.appendLine(`Devector: Compilation succeeded to ${path.basename(outPath)} in ${timeMsg} ms`);
      outCh.show(true);
    } catch (e) {}
    // Add tokens for editor breakpoints (source line breakpoints) across
    // the main asm and all recursively included files. The assembler writes
    // token file `<out>_.json`; read it, add a `breakpoints` key and write it back.
    try {
      const includedFiles = new Set<string>(Array.from(findIncludedFiles(doc.fileName, src)));

      // Build token path (same logic as in assembler.ts)
      let tokenPath: string;
      if (/\.[^/.]+$/.test(outPath)) tokenPath = outPath.replace(/\.[^/.]+$/, '_.json');
      else tokenPath = outPath + '_.json';

      // If the token file exists, read and update it
      if (fs.existsSync(tokenPath)) {
        try {
          const tokenText = fs.readFileSync(tokenPath, 'utf8');
          const tokens = JSON.parse(tokenText);
          // Clear existing breakpoints so we store the current set freshly
          tokens.breakpoints = {};

          // Map included file basenames to absolute paths for matching
          const basenameToPaths = new Map<string, Set<string>>();
          for (const f of Array.from(includedFiles)) {
            const b = path.basename(f);
            let s = basenameToPaths.get(b);
            if (!s) { s = new Set(); basenameToPaths.set(b, s); }
            s.add(path.resolve(f));
          }

          // Iterate all VS Code breakpoints and pick those that are in included files
          const allBps = vscode.debug.breakpoints;
          for (const bp of allBps) {
            if ((bp as vscode.SourceBreakpoint).location) {
              const srcBp = bp as vscode.SourceBreakpoint;
              const uri = srcBp.location.uri;
              if (!uri || uri.scheme !== 'file') continue;
              const bpPath = path.resolve(uri.fsPath);
              const bpBase = path.basename(bpPath);
              // Only include if file is one of the included files
              if (!basenameToPaths.has(bpBase)) continue;
              const pathsForBase = basenameToPaths.get(bpBase)!;
              if (!pathsForBase.has(bpPath)) continue;

              // Breakpoint line numbers in the token file should be 1-based
              const lineNum = srcBp.location.range.start.line + 1;
              const entry = { line: lineNum, enabled: !!bp.enabled } as any;

              // Attach label and addr if matching label exists in tokens
              if (tokens.labels) {
                for (const [labelName, labInfo] of Object.entries(tokens.labels)) {
                  try {
                    // tokens store src as just basename in many cases
                    if ((labInfo as any).src && (labInfo as any).src === bpBase && (labInfo as any).line === lineNum) {
                      entry.label = labelName;
                      entry.addr = (labInfo as any).addr;
                      break;
                    }
                  } catch (e) {}
                }
              }

              if (!tokens.breakpoints[bpBase]) tokens.breakpoints[bpBase] = [];
              tokens.breakpoints[bpBase].push(entry);
            }
          }

          // Write back tokens file with the new breakpoints section
          try {
            fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 4), 'utf8');
            // Log to Output channel how many breakpoints written for visibility
            try {
              const outCh2 = vscode.window.createOutputChannel('Devector');
              let cnt = 0;
              for (const v of Object.values(tokens.breakpoints || {})) cnt += (v as any[]).length;
              outCh2.appendLine(`Devector: Saved ${cnt} breakpoint(s) into ${tokenPath}`);
              outCh2.show(true);
            } catch (e) {}
          } catch (err) {
            console.error('Failed to write breakpoints into token file:', err);
          }
        } catch (err) {
          console.error('Failed to read token file for writing breakpoints:', err);
        }
      }
    } catch (err) {
      console.error('Failed to gather editor breakpoints during compile:', err);
    }
    //vscode.window.showInformationMessage(`Assembled to ${path.basename(outPath)}`);
  });

  context.subscriptions.push(disposable);

  const runDisposable = vscode.commands.registerCommand('i8080.run', async () => {
    openEmulatorPanel(context);
  });
  context.subscriptions.push(runDisposable);

  // Register a debug configuration provider so the debugger is visible and
  // VS Code can present debug configurations and a F5 launch option.
  const dbgProvider: vscode.DebugConfigurationProvider = {
    provideDebugConfigurations(folder, token) {
      return [
        {
          type: 'i8080', request: 'launch', name: 'Launch i8080', program: '${file}'
        }
      ];
    },
    resolveDebugConfiguration(folder, config, token) {
      // If no program is set, try to use the active editor file
      if (!config || !config.program) {
        const ed = vscode.window.activeTextEditor;
        if (ed && ed.document && ed.document.fileName) config = config || {} as any, config.program = ed.document.fileName;
      }
      return config;
    }
  };
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('i8080', dbgProvider));

  const pauseDisposable = vscode.commands.registerCommand('i8080.pause', async () => {
    pauseEmulatorPanel();
  });
  context.subscriptions.push(pauseDisposable);

  const resumeDisposable = vscode.commands.registerCommand('i8080.resume', async () => {
    resumeEmulatorPanel();
  });
  context.subscriptions.push(resumeDisposable);

  const runFrameDisposable = vscode.commands.registerCommand('i8080.runFrame', async () => {
    // Ensure the emulator panel is open before running instructions
    await openEmulatorPanel(context);
    // then run the instruction batch
    runFramePanel();
  });
  context.subscriptions.push(runFrameDisposable);

  // Toggle breakpoint command: toggles a SourceBreakpoint at the current cursor line
  const toggleBp = vscode.commands.registerCommand('i8080.toggleBreakpoint', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const doc = ed.document;
    // Only operate on files (not untitled) and only asm
    if (!doc || doc.isUntitled || !doc.fileName.endsWith('.asm')) return;
    const line = ed.selection.active.line;
    const uri = doc.uri;
    const existing = vscode.debug.breakpoints.filter((b) => {
      if (!(b instanceof vscode.SourceBreakpoint)) return false;
      const sb = b as vscode.SourceBreakpoint;
      if (!sb.location || !sb.location.uri) return false;
      if (sb.location.uri.fsPath !== uri.fsPath) return false;
      return sb.location.range.start.line === line;
    }) as vscode.SourceBreakpoint[];

    if (existing.length) {
      vscode.debug.removeBreakpoints(existing);
    } else {
      const loc = new vscode.Location(uri, new vscode.Position(line, 0));
      const sb = new vscode.SourceBreakpoint(loc, true);
      vscode.debug.addBreakpoints([sb]);
    }
  });
  context.subscriptions.push(toggleBp);

  // Intercept built-in toggle command to handle gutter clicks that toggle breakpoints
  async function toggleBreakpointFromArg(arg: any) {
    const outCh = vscode.window.createOutputChannel('Devector');
    try {
      // Determine target uri and line robustly
      let uri: vscode.Uri | undefined;
      let line: number | undefined;

      // Common shapes the editor may pass as arg
      if (arg) {
        if (arg.uri) {
          if (typeof arg.uri === 'string') uri = vscode.Uri.parse(arg.uri);
          else uri = arg.uri as vscode.Uri;
        }
        if (!uri && arg.location && arg.location.uri) {
          if (typeof arg.location.uri === 'string') uri = vscode.Uri.parse(arg.location.uri);
          else uri = arg.location.uri as vscode.Uri;
        }
        if (!uri && arg.source && arg.source.path) {
          uri = vscode.Uri.file(arg.source.path);
        }
        if (!uri && arg.resource) {
          if (typeof arg.resource === 'string') uri = vscode.Uri.parse(arg.resource);
          else uri = arg.resource as vscode.Uri;
        }
        // lines
        if (typeof arg.line === 'number') {
          line = (arg.line <= 0) ? arg.line : (arg.line - 1);
        }
        if (arg.location && arg.location.range) {
          const r = arg.location.range;
          if (r.start) line = r.start.line;
          else if (typeof r.startLine === 'number') line = r.startLine - 1;
        }
        if (!line && arg.range && arg.range.start) line = arg.range.start.line;
      }
      if (!uri) {
        const ed = vscode.window.activeTextEditor;
        if (ed) uri = ed.document.uri;
      }
      if (line === undefined || line === null) {
        const ed = vscode.window.activeTextEditor;
        if (ed) line = ed.selection.active.line;
      }
      if (!uri || line === undefined || line === null) {
        outCh.appendLine('Devector: toggleBreakpoint override - could not determine uri/line from args: ' + JSON.stringify(arg));
        return;
      }
      const existing = vscode.debug.breakpoints.filter((b) => {
        if (!(b instanceof vscode.SourceBreakpoint)) return false;
        const sb = b as vscode.SourceBreakpoint;
        if (!sb.location || !sb.location.uri) return false;
        const sbPath = sb.location.uri.fsPath;
        return (sbPath === uri!.fsPath) && (sb.location.range.start.line === line);
      }) as vscode.SourceBreakpoint[];
      if (existing.length) {
        vscode.debug.removeBreakpoints(existing);
        outCh.appendLine(`Devector: Removed breakpoint at ${uri.fsPath}:${line+1}`);
      } else {
        const loc = new vscode.Location(uri, new vscode.Position(line, 0));
        const sb = new vscode.SourceBreakpoint(loc, true);
        vscode.debug.addBreakpoints([sb]);
        outCh.appendLine(`Devector: Added breakpoint at ${uri.fsPath}:${line+1}`);
      }
    } catch (e) {
      outCh.appendLine('Devector: toggleBreakpoint override failed: ' + (e && (e as any).message ? (e as any).message : String(e)));
    }
  }
  const overrideBuiltinToggle = vscode.commands.registerCommand('editor.debug.action.toggleBreakpoint', (arg: any) => toggleBreakpointFromArg(arg));
  context.subscriptions.push(overrideBuiltinToggle);
  // Provide additional registrations for common variant commands the editor may use
  const cmdNames = [
    'editor.action.debug.toggleBreakpoint', 'editor.action.toggleBreakpoint', 'workbench.debug.action.toggleBreakpoints', 'editor.debug.action.toggleConditionalBreakpoint', 'editor.action.debug.toggleConditionalBreakpoint', 'editor.action.debug.toggleLogPoint', 'editor.debug.action.toggleLogPoint'
  ];
  for (const name of cmdNames) {
    try {
      const reg = vscode.commands.registerCommand(name, (arg: any) => toggleBreakpointFromArg(arg));
      context.subscriptions.push(reg);
    } catch (e) {
      // ignore failures to register (some core commands may not be overrideable)
    }
  }

  // CodeLens provider removed: toggling of breakpoints is now done via gutter,
  // F9, and the 'i8080.toggleBreakpoint' command. The CodeLens option was
  // distracting and has been removed per request.

  // (No onDidExecuteCommand API in stable; command logging isn't available.)
  // Helper to write breakpoints for the active asm editor into its tokens file
  async function writeBreakpointsForActiveEditor() {
    const ed2 = vscode.window.activeTextEditor;
    if (!ed2) return;
    const doc2 = ed2.document;
    if (!doc2 || doc2.isUntitled || !doc2.fileName.endsWith('.asm')) return;
    const src2 = doc2.getText();
    const mainPath2 = doc2.fileName;
    try {
      const included = findIncludedFiles(mainPath2, src2, new Set<string>());
      let tokenPath2: string;
      const outPath2 = mainPath2.replace(/\.asm$/i, '.rom');
      if (/\.[^/.]+$/.test(outPath2)) tokenPath2 = outPath2.replace(/\.[^/.]+$/, '_.json');
      else tokenPath2 = outPath2 + '_.json';
      if (!fs.existsSync(tokenPath2)) return;
      const tokenText2 = fs.readFileSync(tokenPath2, 'utf8');
      const tokens2 = JSON.parse(tokenText2);
      tokens2.breakpoints = {};
      const basenameToPaths = new Map<string, Set<string>>();
      for (const f of Array.from(included)) {
        const b = path.basename(f);
        let s = basenameToPaths.get(b);
        if (!s) { s = new Set(); basenameToPaths.set(b, s); }
        s.add(path.resolve(f));
      }
      const allBps2 = vscode.debug.breakpoints;
      for (const bp of allBps2) {
        if ((bp as vscode.SourceBreakpoint).location) {
          const srcBp = bp as vscode.SourceBreakpoint;
          const uri = srcBp.location.uri;
          if (!uri || uri.scheme !== 'file') continue;
          const bpPath = path.resolve(uri.fsPath);
          const bpBase = path.basename(bpPath);
          if (!basenameToPaths.has(bpBase)) continue;
          const pathsForBase = basenameToPaths.get(bpBase)!;
          if (!pathsForBase.has(bpPath)) continue;
          const lineNum = srcBp.location.range.start.line + 1;
          const entry = { line: lineNum, enabled: !!bp.enabled } as any;
          if (tokens2.labels) {
            for (const [labelName, labInfo] of Object.entries(tokens2.labels)) {
              try {
                if ((labInfo as any).src && (labInfo as any).src === bpBase && (labInfo as any).line === lineNum) {
                  entry.label = labelName;
                  entry.addr = (labInfo as any).addr;
                  break;
                }
              } catch (e) {}
            }
          }
          if (!tokens2.breakpoints[bpBase]) tokens2.breakpoints[bpBase] = [];
          tokens2.breakpoints[bpBase].push(entry);
        }
      }
      fs.writeFileSync(tokenPath2, JSON.stringify(tokens2, null, 4), 'utf8');
    } catch (e) {
      console.error('writeBreakpointsForActiveEditor failed:', e);
    }
  }

  // Persist breakpoints whenever they change in the debugger model
  context.subscriptions.push(vscode.debug.onDidChangeBreakpoints(async (ev) => {
    // Only write tokens if we have an active asm editor
    await writeBreakpointsForActiveEditor();
  }));

  // Selection-change heuristic removed: clicking in source no longer toggles
  // breakpoints. Gutter clicks (or F9/context menu/commands) should be used
  // to toggle breakpoints. This prevents accidental toggles when clicking
  // inside the text.
}

export function deactivate() {}
