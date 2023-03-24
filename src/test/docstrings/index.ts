import { innerRun } from "../index";

export function run(): Promise<void> {
    return innerRun("./docstrings/docstrings.test.js");
}
