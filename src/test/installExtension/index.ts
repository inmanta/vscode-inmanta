import { innerRun } from "../index";

export function run(): Promise<void> {
    // TODO: Temporarily excluding extensionFunctionalities.test.js
    return innerRun("./installExtension/!(extensionFunctionalities).test.js");
}