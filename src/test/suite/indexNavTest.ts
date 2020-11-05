import { innerRun } from "./index";

export function run(): Promise<void> {
    return innerRun("./suite/navigation.test.js");
}