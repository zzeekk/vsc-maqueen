import * as vscode from 'vscode';
import path from 'path';
import { exec } from 'child_process';
import os from 'os';
import { promises as fs } from 'fs';
import { CustomError, errorType, Exception, forwardError, getErrorMessage } from '../exception';
import { l10n } from 'vscode';


function getMicrobitDrives() {
    return new Promise<string[]>(async (resolve, reject) => {
        const platform = os.platform();
        if (os.platform() === 'darwin') {
            // macOS - Volumes werden in /Volumes gemountet
            exec('diskutil list external physical', async (error, stdout, stderr) => {
                if (error) {
                    reject(new Exception(`Error when retrieving the volumes: ${stderr}`, 317));
                } else {
                    const drives = stdout.split('\n').filter(drive => drive.match(/[0.9]:/)).map(d => d.split(/  +/g)[2]);
                    const mdrives = drives.filter(drive => drive.match(/^MICROBIT( [0-9])?$/) !== null).map(drive => path.join('/Volumes', drive));
                    if (mdrives.length === 0&&drives.length !== 0) {
                        const driveOptions = drives.map(d => ({
                            label: d
                        }));
                        const selectedDrive = await vscode.window.showQuickPick(driveOptions, {
                            placeHolder: l10n.t('Select a Micro:bit drive.')
                        });
                        if (selectedDrive) {
                            resolve([path.join('/Volumes', selectedDrive.label)]);
                            return;
                        }
                        reject(new CustomError('No micro:bit was found.', errorType.noMicrobit, 311));
                    } else {
                        resolve(mdrives);
                    }
                }
            });
        } else if (os.platform() === 'win32') {
            // Windows - try Get-CimInstance first, fall back to wmic
            exec('Get-CimInstance Win32_LogicalDisk | Select DeviceID, VolumeName | ConvertTo-Json', (error, stdout, stderr) => {
                if (error) {
                    // Fallback to wmic if PowerShell command fails
                    exec('wmic logicaldisk get name,volumename /format:list', (wmicError, wmicStdout, wmicStderr) => {
                        if (wmicError) {
                            reject(new Exception(`Error when retrieving the volumes: ${wmicStderr}`, 318));
                            return;
                        }
                        // Parse wmic output: Name=C:, VolumeName=MICROBIT, etc.
                        const lines = wmicStdout.split('\n').filter(line => line.trim().length > 0);
                        const drives: { name: string; volumeName: string }[] = [];
                        for (let i = 0; i < lines.length; i += 2) {
                            const nameMatch = lines[i].match(/Name=(.+)/);
                            const volMatch = lines[i + 1]?.match(/VolumeName=(.+)/);
                            if (nameMatch && volMatch) {
                                drives.push({ name: nameMatch[1].trim(), volumeName: volMatch[1].trim() });
                            }
                        }
                        const mdrives = drives.filter(d => d.volumeName === 'MICROBIT').map(d => d.name);
                        if (!mdrives || mdrives.length === 0) {
                            reject(new CustomError('No micro:bit was found.', errorType.noMicrobit, 311));
                        } else {
                            resolve(mdrives);
                        }
                    });
                } else {
                    let drives = JSON.parse(stdout);
                    if(!Array.isArray(drives)){
                        drives = [drives];
                    }
                    const mdrives = drives.filter((drive: { VolumeName: string; }) => drive.VolumeName == "MICROBIT");
                    if (!mdrives || mdrives.length === 0) {
                        reject(new CustomError('No micro:bit was found.', errorType.noMicrobit, 311));
                    } else {
                        const r:string[] = mdrives.map((drive: { DeviceID: string; })=>drive.DeviceID);
                        resolve(r);
                    }
                }
            });
        } else if (platform === "linux") {
            exec('df', async (error, stdout, stderr) => {
                if (error) {
                    reject(new Exception(`Error when retrieving the volumes: ${stderr}`, 317));
                } else {
                    const drives = stdout.split('\n').filter(drive => drive.match(/\/media\/.*\/MICROBIT/)).map(d => d.split(/ +/g)[5]);;
                    if (!drives || drives.length === 0) {
                        reject(new CustomError('No micro:bit was found.', errorType.noMicrobit, 311));
                    } else {
                        resolve(drives);
                    }
                }
            });
        }
        else {
            reject(new CustomError('Unsupported operating system', errorType.platForm, 400));
            //callback([]);
        }
    });
}
export async function flashMicrobit(extensionPath: string, send: Function, customFirmwarePath?: string) {
    const sourceFilePath = customFirmwarePath || path.join(extensionPath, 'micropython.hex');
    try {
        const microbitDrives = await getMicrobitDrives();
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(sourceFilePath));
        const fileSizeKB = (data.length / 1024).toFixed(2);
        send(l10n.t({ message: 'Flashing firmware ({0} KB) to Micro:bit...', args: [fileSizeKB], comment: ['{0}: File size in KB'] }));
        
        for (let i = 0; i < microbitDrives.length; i++) {
            const targetFilePath = path.join(microbitDrives[i], 'MICROBIT.hex');
            await writeFileToMicrobit(data, targetFilePath, send);
        }
    } catch (err: any) {
        throw forwardError(err, getErrorMessage(err), errorType.flash, 322);
    }
}
async function writeFileToMicrobit(data: Uint8Array, targetPath: string, send: Function) {
    try {
        const totalBytes = data.length;
        const chunkSize = 64 * 1024; // 64 KB chunks
        let bytesWritten = 0;

        send(l10n.t({ message: 'Writing to {0}...', args: [targetPath], comment: ['{0}: Path to Micro:bit'] }));

        // Write file in chunks and report progress
        for (let offset = 0; offset < totalBytes; offset += chunkSize) {
            const chunk = data.slice(offset, Math.min(offset + chunkSize, totalBytes));
            await fs.writeFile(targetPath, Buffer.from(chunk), { flag: offset === 0 ? 'w' : 'a' });
            
            bytesWritten = Math.min(offset + chunkSize, totalBytes);
            const percentComplete = ((bytesWritten / totalBytes) * 100).toFixed(1);
            const mbWritten = (bytesWritten / 1024 / 1024).toFixed(2);
            const mbTotal = (totalBytes / 1024 / 1024).toFixed(2);
            
            send(l10n.t({ message: 'Progress: {0}% ({1} MB / {2} MB)', args: [percentComplete, mbWritten, mbTotal], comment: ['{0}: Percentage, {1}: MB written, {2}: MB total'] }));
        }

        send(l10n.t({ message: '{0} has been flashed successfully.', args: [targetPath], comment: ['{0}: Path to Micro:bit'] }));
    } catch (err: any) {
        new Exception(getErrorMessage(err), 319);
        vscode.window.showErrorMessage(l10n.t({ message: 'The following error occurred when flashing {0}: {1}', args: [targetPath, err.message], comment: ['{0}: Path to Micro:bit', '{1}: Error message'] }));
    }
}

export async function copyFileToMicrobit(extensionPath: string) {
    await getMicrobitDrives();
}