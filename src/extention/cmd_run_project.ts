import * as vscode from 'vscode';
import * as ext_prg from './project';
import { openEmulatorPanel } from '../emulatorUI';


export async function runProject(
	devectorOutput: vscode.OutputChannel,
	context: vscode.ExtensionContext)
: Promise<void>
{
	const selected = await ext_prg.pickProject(devectorOutput);
	if (!selected) return;
	
	const ready = await ext_prg.ensureRomReady(devectorOutput, selected, { compile: false });
	if (!ready) return;
	
	await openEmulatorPanel(context, devectorOutput, selected);
}

////////////////////////////////////////////////////////////////////////////////
//
// ANYTHING BELOW UNCHECKED YET
//
////////////////////////////////////////////////////////////////////////////////
