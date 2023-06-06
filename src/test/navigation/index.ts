import { innerRun } from "../index";

export function run(): Promise<void> {
    return innerRun("./navigation/navigation.test.js");
}
