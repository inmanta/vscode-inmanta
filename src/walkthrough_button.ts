import { StatusBarAlignment, window } from "vscode";
import { traceLog } from "./logTracer";

/**
 * Adds the Setup assistant button to the status bar.
 * The button is only visible when an Inmanta file is active.
 */
export function addSetupAssistantButton() {
	traceLog("add Setup assistant");
	const inmantaWalkthroughButton = window.createStatusBarItem(StatusBarAlignment.Left);
	inmantaWalkthroughButton.text = "$(book) Inmanta Setup assistant";
	inmantaWalkthroughButton.command = "inmanta.openWalkthrough";
	inmantaWalkthroughButton.tooltip = "Open the Inmanta extension Setup assistant";
	inmantaWalkthroughButton.show();

	// Hide the button if the active editor is not a inmanta file
	function updateInmantaWalkthroughButtonVisibility() {
		const editor = window.activeTextEditor;
		if (editor && editor.document.languageId === "inmanta") {
			inmantaWalkthroughButton.show();
		} else {
			inmantaWalkthroughButton.hide();
		}
	}

	// Update the button visibility when the extension is activated
	updateInmantaWalkthroughButtonVisibility();
	// Update the button visibility when the active editor changes
	window.onDidChangeActiveTextEditor(updateInmantaWalkthroughButtonVisibility);
}
