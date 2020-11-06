import { innerRun } from "../index";

export function run(): Promise<void> {
    return innerRun("./compile/compile.test.js");
}