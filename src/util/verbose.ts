import * as vscode from 'vscode';

export const verboseChannel = vscode.window.createOutputChannel("MaqueenVerbose");

export function verbose(message: string){
    verboseChannel.appendLine(message);
}