import * as vscode from 'vscode';
import * as ext_utils from './utils';

// Toggle breakpoint command: toggles a SourceBreakpoint at the current cursor line
export async function toggleBreakpoint()
{
	const ed = vscode.window.activeTextEditor;
	if (!ed) return;
	const doc = ed.document;
	// Only operate on files (not untitled) and only asm
	if (!doc || doc.isUntitled || !doc.fileName.toLowerCase().endsWith('.asm')) return;
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
		if (!ext_utils.isAsmBreakpointLine(doc, line)) {
			ext_utils.reportInvalidBreakpointLine();
			return;
		}
		const loc = new vscode.Location(uri, new vscode.Position(line, 0));
		const sb = new vscode.SourceBreakpoint(loc, true);
		vscode.debug.addBreakpoints([sb]);
	}
}


// Intercept built-in toggle command to handle gutter clicks that toggle breakpoints
export async function toggleBreakpointFromArg(
	devectorOutput: vscode.OutputChannel,
	arg: any)
{
	try {
		let { uri, line } = ext_utils.extractTargetFromArg(arg);

		if (!uri || line === undefined) {
			const ed = vscode.window.activeTextEditor;
			if (ed) {
				if (!uri) uri = ed.document.uri;
				if (line === undefined) line = ed.selection.active.line;
			}
		}

		if (!uri || line === undefined) {
			ext_utils.logOutput(devectorOutput, 'Devector: toggleBreakpoint override - missing uri/line for toggle');
			return;
		}

		const targetUri = uri;

		const targetLine = Math.max(0, Math.floor(line));
		const matching = vscode.debug.breakpoints.filter((bp) => {
			if (!(bp instanceof vscode.SourceBreakpoint)) return false;
			const sb = bp as vscode.SourceBreakpoint;
			const bpUri = sb.location?.uri;
			if (!bpUri) return false;
			return (bpUri.fsPath === targetUri.fsPath) && (sb.location.range.start.line === targetLine);
		}) as vscode.SourceBreakpoint[];

		if (matching.length) {
			vscode.debug.removeBreakpoints(matching);
			ext_utils.logOutput(devectorOutput, `Devector: Removed breakpoint at ${targetUri.fsPath}:${targetLine + 1}`);
			return;
		}

		if (targetUri.scheme === 'file' && targetUri.fsPath.toLowerCase().endsWith('.asm')) {
			const doc = await ext_utils.openDocument(devectorOutput, targetUri);
			if (doc && !ext_utils.isAsmBreakpointLine(doc, targetLine)) {
				ext_utils.reportInvalidBreakpointLine();
				return;
			}
		}

		const newBp = new vscode.SourceBreakpoint(new vscode.Location(targetUri, new vscode.Position(targetLine, 0)), true);
		vscode.debug.addBreakpoints([newBp]);
		ext_utils.logOutput(devectorOutput, `Devector: Added breakpoint at ${targetUri.fsPath}:${targetLine + 1}`);
	} catch (e) {
		ext_utils.logOutput(devectorOutput, 'Devector: toggleBreakpoint override failed: ' + (e instanceof Error ? e.message : String(e)));
	}
}