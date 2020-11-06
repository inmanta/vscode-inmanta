import { innerRun } from "../index";

export function run(): Promise<void> {
    return innerRun("./loadExtension/loadExtension.test.js");
}