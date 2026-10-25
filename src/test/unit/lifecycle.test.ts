import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseCsv, writeCsv } from "../../lifecycle/csv";
import { applyEdit, referencesTo } from "../../lifecycle/edit";
import { expand, LsmLifecycle } from "../../lifecycle/expand";
import { buildGraph } from "../../lifecycle/graph";
import { lint } from "../../lifecycle/lint";
import { deleteStateInMetadata, emptyMetadata, parseMetadata, renameStateInMetadata, setLayout, upsertScenario } from "../../lifecycle/metadata";
import { isFlagColumn, parseLifecycleCsv, parseStatesCsv, parseTransfer } from "../../lifecycle/model";
import { compileContexts, runScenario, Simulator } from "../../lifecycle/simulator";

const fixtures = path.resolve(__dirname, "../../../src/test/unit/fixtures");
const lifecycleText = fs.readFileSync(path.join(fixtures, "lifecycle.csv"), "utf8");
const statesText = fs.readFileSync(path.join(fixtures, "states.csv"), "utf8");

function load(text = lifecycleText): LsmLifecycle {
    return expand(parseLifecycleCsv(text, parseStatesCsv(statesText)).states);
}

suite("lifecycle csv", () => {
    test("round trip keeps the text", () => {
        assert.strictEqual(writeCsv(parseCsv(lifecycleText)), lifecycleText);
        const crlf = 'a,b\r\n"x, y",""\r\n';
        assert.strictEqual(writeCsv(parseCsv(crlf)), crlf);
    });

    test("round trip keeps blank lines and ragged rows", () => {
        for (const text of ["a,b\n\n1,2\n\n", "a,b\n1,2,extra\n3\n", "a,b\n1,2"]) {
            assert.strictEqual(writeCsv(parseCsv(text)), text);
        }
        const header = "name,label,current,previous,desired_state,on_create\n";
        const after = applyEdit(header + "a,info,,,x,b,note\n\nb,,,,x\n", { kind: "setCell", state: "b", column: "label", value: "info" });
        assert.strictEqual(after, header + "a,info,,,x,b,note\n\nb,info,,,x\n");
    });

    test("quoted cells", () => {
        const table = parseCsv('a,b\n"x, ""y""","multi\nline"\n');
        assert.deepStrictEqual(table.rows[0].values, ['x, "y"', "multi\nline"]);
    });

    test("transfer expressions", () => {
        assert.deepStrictEqual(parseTransfer("up"), { validate: false, rollback: false, target: "up", escape: null });
        assert.deepStrictEqual(parseTransfer("validate(up, down)"), { validate: true, rollback: false, target: "up", escape: "down" });
        assert.deepStrictEqual(parseTransfer("rollback(up)"), { validate: false, rollback: true, target: "up", escape: null });
        assert.strictEqual(parseTransfer(" up"), null);
        assert.strictEqual(parseTransfer("up2"), null);
    });

    test("annotations default to the states csv", () => {
        const states = parseStatesCsv(statesText);
        const lifecycle = parseLifecycleCsv(lifecycleText, states);
        const creating = lifecycle.states.find((s) => s.name === "creating")!;
        assert.deepStrictEqual(creating.annotations, { web_icon: "FaPlus", web_label: "Creating" });
        assert.deepStrictEqual(creating.triggers.on_delete, ["validate(deleting)"]);
        const failed = lifecycle.states.find((s) => s.name === "updating_failed")!;
        assert.deepStrictEqual(failed.triggers.on_api_set_state, ["rollback(rolling_back)", "up"]);
        assert.deepStrictEqual(states.columns, ["purge", "starting", "description"]);
        assert.ok(isFlagColumn(states, "purge"));
        assert.ok(!isFlagColumn(states, "description"));
    });
});

suite("lifecycle expansion", () => {
    test("states and initial state", () => {
        const lsm = load();
        assert.strictEqual(lsm.initialState, "start");
        assert.deepStrictEqual(lsm.alternativeInitialStates, []);
        assert.ok(lsm.states.get("terminated")!.deleted);
        assert.ok(!lsm.states.get("start")!.deleted);
        assert.ok(lsm.states.get("up")!.exportResources);
        assert.ok(lsm.states.has("validating_creating_from_start"));
        assert.ok(lsm.states.has("rejected_updating_from_up"));
    });

    test("validation states", () => {
        const lsm = load();
        const validating = lsm.states.get("validating_updating_from_up")!;
        assert.strictEqual(validating.validateSelf, "candidate");
        assert.strictEqual(validating.previousAttrSetOnValidate, "active");
        assert.deepStrictEqual(validating.desiredState, { onExport: "up", onValidateSelf: "updating", onValidateOthers: "up" });
        assert.strictEqual(validating.annotations.web_label, "Validating updating");

        const validation = lsm.transfers.find((t) => t.source === validating.name && t.validate)!;
        assert.strictEqual(validation.target, "updating");
        assert.strictEqual(validation.error, "rejected_updating_from_up");
        assert.strictEqual(validation.targetOperation, "promote");

        const retry = lsm.transfers.find((t) => t.source === "rejected_updating_from_up" && t.origin.role === "retry")!;
        assert.ok(retry.onUpdate && !retry.apiSetState);
        const cancel = lsm.transfers.find((t) => t.source === "rejected_updating_from_up" && t.origin.role === "cancel")!;
        assert.strictEqual(cancel.target, "up");
        assert.strictEqual(cancel.targetOperation, "clear candidate");

        const cancelCreate = lsm.transfers.find((t) => t.source === "rejected_creating_from_start" && t.origin.role === "cancel")!;
        assert.strictEqual(cancelCreate.target, "terminated");
    });

    test("operations", () => {
        const lsm = load();
        const deploy = (source: string) => lsm.transfers.find((t) => t.source === source && t.resourceBased)!;
        assert.strictEqual(deploy("updating").targetOperation, "clear rollback");
        assert.strictEqual(deploy("updating").targetSameDesiredState, false);
        assert.strictEqual(deploy("up").targetSameDesiredState, true);
        assert.strictEqual(deploy("rolling_back").targetOperation, "clear candidate");
        assert.strictEqual(deploy("up").nonCompliant, "degraded");
        const rollback = lsm.transfers.find((t) => t.source === "updating" && t.apiSetState)!;
        assert.strictEqual(rollback.target, "rolling_back");
        assert.strictEqual(rollback.targetOperation, "rollback");
    });
});

suite("lifecycle checks", () => {
    const codes = (text: string) => lint(parseLifecycleCsv(text, parseStatesCsv(statesText)), parseStatesCsv(statesText)).map((i) => i.code);

    test("the fixture is clean", () => {
        assert.deepStrictEqual(codes(lifecycleText), []);
    });

    test("broken lifecycles", () => {
        const header = "name,label,current,previous,desired_state,on_create,on_update,on_delete,on_api_set_state,on_auto,on_deployed,on_failed,on_non_compliant\n";
        const found = codes(
            header +
                "start,,,,unmanaged,creating,,,,,,,\n" +
                "creating,info,active,,creating,,,,\"validate(up, start)\",,up,,\n" +
                "up,bogus,active,,nope,,uppp,, start,,up,up,\n" +
                "lost,info,active,,up,,,,,,up,up,\n",
        );
        for (const code of ["deployed-without-failed", "invalid-transfer", "unknown-state", "unknown-desired-state", "unknown-label", "unreachable"]) {
            assert.ok(found.includes(code), `${code} in ${found}`);
        }
    });
});

suite("lifecycle edits", () => {
    test("set transfers only rewrites that row", () => {
        const after = applyEdit(lifecycleText, { kind: "addTransfer", state: "failed", trigger: "on_api_set_state", value: "up" });
        const before = lifecycleText.split("\n");
        const changed = after.split("\n").filter((line, i) => line !== before[i]);
        assert.deepStrictEqual(changed, ["failed,danger,active,,up,,validate(updating),validate(deleting),up,,up,failed,degraded,"]);
    });

    test("rename updates references", () => {
        const after = applyEdit(lifecycleText, { kind: "renameState", from: "deleting", to: "removing" });
        assert.deepStrictEqual(referencesTo(after, "deleting"), []);
        assert.strictEqual(referencesTo(after, "removing").length, 7);
        assert.ok(after.includes("removing,info,active,,deleting,"));
        assert.ok(after.includes('"validate(creating, terminated)"'));
    });

    test("delete removes references", () => {
        const after = applyEdit(lifecycleText, { kind: "deleteState", name: "degraded" });
        assert.deepStrictEqual(referencesTo(after, "degraded"), []);
        assert.ok(after.includes("up,success,active,,up,,validate(updating),validate(deleting),,,up,failed,,Up"));
    });

    test("add state and annotation column", () => {
        let after = applyEdit(lifecycleText, { kind: "addState", name: "paused", desiredState: "up", after: "up" });
        after = applyEdit(after, { kind: "setCell", state: "paused", column: "web_stage", value: "operate" });
        const table = parseCsv(after);
        assert.strictEqual(table.header.values.at(-1), "web_stage");
        assert.strictEqual(table.rows[4].values[0], "paused");
        assert.strictEqual(table.rows[4].values.at(-1), "operate");
    });
});

suite("lifecycle simulator", () => {
    test("create, update and roll back", () => {
        const result = runScenario(load(), {
            steps: ["create", "validation_ok", "deployed", "update", "validation_ok", "failed", "set_state:rolling_back", "deployed"],
            expect: "up",
        });
        assert.ok(result.passed, result.failure);
        const sets = result.steps.map((s) => s.instance.sets);
        assert.deepStrictEqual(sets[4], { candidate: null, active: 2, rollback: 1 });
        assert.deepStrictEqual(sets[6], { candidate: 2, active: 1, rollback: null });
        assert.deepStrictEqual(sets[7], { candidate: null, active: 1, rollback: null });
    });

    test("rejected events", () => {
        const sim = new Simulator(load());
        const step = sim.apply(sim.instanceIn("deleting"), { kind: "update" });
        assert.ok(step.rejected);
        const options = sim.options(sim.instanceIn("deleting"));
        assert.ok(!options.find((o) => o.event.kind === "delete")!.enabled);
    });

    test("validation failure and cancel", () => {
        const result = runScenario(load(), { start: "up", steps: ["update", "validation_failed", "set_state:up"], expect: "up" });
        assert.ok(result.passed, result.failure);
        assert.strictEqual(result.steps[1].instance.state, "rejected_updating_from_up");
        assert.strictEqual(result.steps[2].instance.sets.candidate, null);
    });

    test("compile contexts", () => {
        const lsm = load();
        const [exp, self, others] = compileContexts(lsm.states.get("validating_updating_from_up")!);
        assert.strictEqual(exp.desiredState, "up");
        assert.strictEqual(self.desiredState, "updating");
        assert.strictEqual(self.attributes, "candidate");
        assert.strictEqual(others.desiredState, "up");
        assert.strictEqual(compileContexts(lsm.states.get("up")!)[1].desiredState, null);
    });
});

suite("lifecycle graph and metadata", () => {
    test("views", () => {
        const lifecycle = parseLifecycleCsv(lifecycleText);
        const lsm = expand(lifecycle.states);
        const csv = buildGraph("csv", lifecycle.states, lsm, emptyMetadata());
        assert.strictEqual(csv.nodes.length, 12);
        assert.deepStrictEqual(csv.nodes.find((n) => n.id === "up")!.selfLoops, ["deployed"]);
        const edge = csv.edges.find((e) => e.id === "start>creating")!;
        assert.ok(edge.details[0].validate);
        const full = buildGraph("lsm", lifecycle.states, lsm, emptyMetadata());
        assert.strictEqual(full.nodes.length, lsm.states.size);
        const desired = buildGraph("desired", lifecycle.states, lsm, emptyMetadata());
        assert.deepStrictEqual(desired.nodes.map((n) => n.id), ["unmanaged", "creating", "up", "updating", "rolling_back", "deleting"]);
    });

    test("metadata edits keep comments", () => {
        let text = "# my notes\nversion: 1\nstages:\n  - {id: up, name: Operate, column: 2}\n";
        text = setLayout(text, { up: { x: 10.4, y: 20 } });
        text = upsertScenario(text, { name: "happy", steps: ["create", "validation_ok"], expect: "creating" });
        text = renameStateInMetadata(text, "creating", "building");
        assert.ok(text.startsWith("# my notes\n"));
        const { metadata, errors } = parseMetadata(text);
        assert.deepStrictEqual(errors, []);
        assert.deepStrictEqual(metadata.layout.up, { x: 10, y: 20 });
        assert.deepStrictEqual(metadata.scenarios[0], { name: "happy", start: undefined, steps: ["create", "validation_ok"], expect: "building" });
        assert.strictEqual(metadata.stages[0].name, "Operate");
    });

    test("metadata follows renamed and deleted states", () => {
        let text = "layout:\n  a: {x: 1, y: 2}\ntransfers:\n  - {source: a, trigger: on_update, target: b, web_action: Go}\n";
        text += "scenarios:\n  - {name: s, steps: [\"set_state: a\", create], expect: a}\n";
        const renamed = parseMetadata(renameStateInMetadata(text, "a", "c")).metadata;
        assert.deepStrictEqual(renamed.scenarios[0].steps, ["set_state:c", "create"]);
        assert.strictEqual(renamed.transfers[0].source, "c");
        const deleted = parseMetadata(deleteStateInMetadata(text, "a")).metadata;
        assert.deepStrictEqual(deleted.layout, {});
        assert.deepStrictEqual(deleted.transfers, []);
    });
});
