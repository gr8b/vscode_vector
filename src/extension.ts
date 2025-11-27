import * as vscode from 'vscode';
import * as path from 'path';
import { assemble, assembleAndWrite } from './assembler';
import { openEmulatorPanel, pauseEmulatorPanel, resumeEmulatorPanel, runFramePanel } from './emulatorUI';

export function activate(context: vscode.ExtensionContext) {
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
    //vscode.window.showInformationMessage(`Assembled to ${path.basename(outPath)}`);
  });

  context.subscriptions.push(disposable);

  const runDisposable = vscode.commands.registerCommand('i8080.run', async () => {
    openEmulatorPanel(context);
  });
  context.subscriptions.push(runDisposable);

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
}

export function deactivate() {}
