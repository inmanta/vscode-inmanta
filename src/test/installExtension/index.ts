import { innerRun } from "../index";

export function run(): Promise<void> {
    return innerRun("./installExtension/**/*.test.js");
}