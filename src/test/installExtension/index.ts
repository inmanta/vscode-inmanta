import { innerRun } from "../index";

export function run(): Promise<void> {
    return innerRun("./installExtension/installExtension.test.js");
}