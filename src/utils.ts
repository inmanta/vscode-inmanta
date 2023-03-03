import * as fs from 'fs';

export function fileOrDirectoryExists(filePath: string): boolean {
	try {
	  fs.accessSync(filePath);
	  return true;
	} catch (error) {
	  return false;
	}
  }

export function log(message: string) {
	console.log(`[${new Date().toUTCString()}][vscode-inmanta] ${message}`);
}
