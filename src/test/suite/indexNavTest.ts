import { inner_run } from "./index";

export function run(): Promise<void> {
    return inner_run("./suite/navigation.test.js");
}