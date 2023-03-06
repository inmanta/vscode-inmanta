import * as fs from 'fs';
import { ErrorHandler, Message, ErrorAction, CloseAction, ErrorHandlerResult, CloseHandlerResult } from 'vscode-languageclient';


/**
 * Checks if a file or directory exists at the specified path.
 * @param filePath The path to the file or directory.
 * @returns true if the file or directory exists, false otherwise.
 */
export function fileOrDirectoryExists(filePath: string): boolean {
	try {
	  fs.accessSync(filePath);
	  return true;
	} catch (error) {
	  return false;
	}
  }

/**
 * Logs a message to the console with a timestamp and a tag.
 * @param message The message to be logged.
 */
export function log(message: string) {
	console.log(`[${new Date().toUTCString()}][vscode-inmanta] ${message}`);
}


/**
 * An implementation of the ErrorHandler interface for the language server client.
 */
export class LsErrorHandler implements ErrorHandler{
	error(error: Error, message: Message | undefined, count: number | undefined): ErrorHandlerResult {;
		return {action: ErrorAction.Shutdown};
	}

	closed(): CloseHandlerResult{
		return {action: CloseAction.DoNotRestart};
	}

}
