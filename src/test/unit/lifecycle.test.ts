import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseCsv, writeCsv } from "../../lifecycle/csv";
import { applyEdit, FileChange, referencesTo } from "../../lifecycle/edit";
import { expand, LsmLifecycle } from "../../lifecycle/expand";
import { buildGraph, stageOf } from "../../lifecycle/graph";
import { lint } from "../../lifecycle/lint";
import {
    applyMetadataOp,
    deleteStateInMetadata,
    emptyMetadata,
    emptyTexts,
    metadataIssues,
    parseMetadata,
    renameStateInMetadata,
    setLayout,
    upsertScenario,
} from "../../lifecycle/metadata";
import { isFlagColumn, parseLifecycleCsv, parseStatesCsv, parseTransfer } from "../../lifecycle/model";
import { compileContexts, runScenario, Simulator } from "../../lifecycle/simulator";
import { consoleView } from "../../lifecycle/console";
import { addStage, deleteStage, moveToStage, renameStage } from "../../lifecycle/stages";
import { checkCell, lifecycleTable, planChanges, statesTable, suggestCell, TableContext, transfersTable } from "../../lifecycle/table";

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
        let text = "# my notes\nversion: 1\nstage_layout:\n  up: {column: 2}\n";
        text = setLayout(text, { up: { x: 10.4, y: 20 } });
        text = upsertScenario(text, { name: "happy", steps: ["create", "validation_ok"], expect: "creating" });
        assert.ok(text.startsWith("# my notes\n"));
        const stages = "id,name,description\nup,Operate,\n";
        const { metadata, errors } = parseMetadata({ ...emptyTexts(), stages, studio: renameStateInMetadata({ ...emptyTexts(), studio: text }, "creating", "building").studio });
        assert.deepStrictEqual(errors, []);
        assert.deepStrictEqual(metadata.layout.up, { x: 10, y: 20 });
        assert.deepStrictEqual(metadata.scenarios[0], { name: "happy", start: undefined, steps: ["create", "validation_ok"], expect: "building" });
        assert.deepStrictEqual(metadata.stages[0], { id: "up", name: "Operate", column: 2, row: undefined, description: undefined });
    });

    test("metadata follows renamed and deleted states", () => {
        const texts = {
            ...emptyTexts(),
            transfers: "source,trigger,target,web_action\na,on_update,b,Go\nb,on_update,c,Stay\n",
            studio: "layout:\n  a: {x: 1, y: 2}\nscenarios:\n  - {name: s, steps: [\"set_state: a\", create], expect: a}\n",
        };
        const renamed = renameStateInMetadata(texts, "a", "c");
        assert.strictEqual(renamed.transfers, "source,trigger,target,web_action\nc,on_update,b,Go\nb,on_update,c,Stay\n");
        assert.deepStrictEqual(parseMetadata(renamed).metadata.scenarios[0].steps, ["set_state:c", "create"]);
        const deleted = parseMetadata(deleteStateInMetadata(texts, "a")).metadata;
        assert.deepStrictEqual(deleted.layout, {});
        assert.deepStrictEqual(deleted.transfers.map((e) => e.source), ["b"]);
    });
});

suite("lifecycle web console preview", () => {
    test("badge and actions", () => {
        const lsm = load();
        const metadata = emptyMetadata();
        metadata.transfers.push({ source: "updating_failed", trigger: "on_api_set_state", target: "up", annotations: { web_button_label: "Give up the update", web_advanced_state: true, web_confirm: "Sure?" } });
        metadata.transfers.push({ source: "updating_failed", trigger: "on_delete", target: "deleting", annotations: { web_confirm: "Really delete?" } });
        const view = consoleView(lsm, metadata, "updating_failed", "lab1");
        assert.deepStrictEqual(view.badge, { text: "updating_failed", label: "danger", icon: null, description: null, plain: false });
        assert.ok(!view.edit.enabled);
        assert.deepStrictEqual(view.delete, { enabled: true, confirm: "Really delete?" });
        assert.deepStrictEqual(view.setState.map((a) => [a.target, a.label, a.confirm]), [["rolling_back", "rolling_back", "Are you sure you want to set state of instance lab1 to rolling_back?"]]);
        assert.deepStrictEqual(view.advanced.map((a) => [a.label, a.confirm]), [["Give up the update", "Sure?"]]);
    });

    test("labels of generated states", () => {
        const lsm = load();
        const view = consoleView(lsm, emptyMetadata(), "rejected_updating_from_up");
        assert.strictEqual(view.badge.text, "Rejected updating");
        assert.strictEqual(view.badge.icon, "FaBan");
        // cancel goes back to up, whose web_label is Up
        assert.deepStrictEqual(view.setState.map((a) => a.label), ["Up"]);
        assert.ok(view.edit.enabled);
    });
});

suite("lifecycle stages", () => {
    // The states of desired state up get the stage running from the states csv
    const statesWithStage = statesText.replace("web_icon\n", "web_icon,web_stage\n").replace("Deployed,\n", "Deployed,,running\n");

    function apply(change: FileChange, csv = lifecycleText, states = statesWithStage): { csv: string; states: string } {
        return { csv: change.csv.reduce(applyEdit, csv), states: change.states.reduce(applyEdit, states) };
    }

    function stages(texts: { csv: string; states: string }): Record<string, string> {
        const lifecycle = parseLifecycleCsv(texts.csv, parseStatesCsv(texts.states));
        return Object.fromEntries(lifecycle.states.map((x) => [x.name, stageOf(x)]));
    }

    const lifecycle = () => parseLifecycleCsv(lifecycleText, parseStatesCsv(statesWithStage));

    test("move a state to a stage and back", () => {
        const moved = apply(moveToStage(lifecycle(), parseStatesCsv(statesWithStage), "failed", "creating"));
        assert.strictEqual(stages(moved).failed, "creating");
        const states = parseStatesCsv(moved.states);
        const back = apply(moveToStage(parseLifecycleCsv(moved.csv, states), states, "failed", "running"), moved.csv, moved.states);
        // Back in its default stage, the cell is empty again
        const failed = parseLifecycleCsv(back.csv).states.find((x) => x.name === "failed")!;
        assert.deepStrictEqual(failed.ownAnnotations, {});
        assert.strictEqual(stages(back).failed, "running");
    });

    test("rename a stage set in the states csv and a stage defaulting to the desired state", () => {
        const states = parseStatesCsv(statesWithStage);
        const running = renameStage(lifecycle(), states, [], "running", "operational");
        assert.deepStrictEqual(running.csv, []);
        assert.deepStrictEqual(running.metadata, [{ kind: "renameStage", from: "running", to: "operational" }]);
        const renamed = stages(apply(running));
        assert.deepStrictEqual(["up", "failed", "degraded"].map((s) => renamed[s]), ["operational", "operational", "operational"]);

        const creating = stages(apply(renameStage(lifecycle(), states, [], "creating", "provisioning")));
        assert.strictEqual(creating.creating, "provisioning");
        assert.strictEqual(creating.creating_failed, "provisioning");
        assert.strictEqual(creating.updating, "updating");

        assert.throws(() => renameStage(lifecycle(), states, [], "creating", "running"), /already exists/);
        assert.throws(() => renameStage(lifecycle(), states, [{ id: "spare" }], "creating", "spare"), /already exists/);
        assert.throws(() => renameStage(lifecycle(), states, [], "creating", "a stage"), /can only hold/);
    });

    test("delete a stage", () => {
        const states = parseStatesCsv(statesWithStage);
        const moved = apply(moveToStage(lifecycle(), states, "deleting", "running"));
        const deleted = apply(deleteStage(parseLifecycleCsv(moved.csv, states), states, "running"), moved.csv, moved.states);
        const result = stages(deleted);
        assert.strictEqual(result.deleting, "deleting");
        assert.strictEqual(result.up, "up");
    });

    test("add a stage", () => {
        assert.deepStrictEqual(addStage(lifecycle(), [], "spare", "Spare").metadata, [{ kind: "upsertStage", stage: { id: "spare", name: "Spare" } }]);
        assert.throws(() => addStage(lifecycle(), [], "running", "Running"), /already exists/);
        assert.throws(() => addStage(lifecycle(), [{ id: "spare" }], "spare", "Spare"), /already exists/);
    });

    test("stage definitions in the stages csv", () => {
        let texts = applyMetadataOp(emptyTexts(), { kind: "setStages", stages: [{ id: "creating", name: "Creating" }, { id: "up", name: "Up" }] });
        texts = applyMetadataOp(texts, { kind: "upsertStage", stage: { id: "deleting", name: "Deleting", description: "Going away" } });
        texts = applyMetadataOp(texts, { kind: "moveStage", id: "deleting", delta: -1 });
        texts = applyMetadataOp(texts, { kind: "renameStage", from: "up", to: "running" });
        texts = applyMetadataOp(texts, { kind: "upsertStage", stage: { id: "creating", name: "Provisioning", column: 0 } });
        assert.strictEqual(texts.stages, "id,name,description\ncreating,Provisioning,\ndeleting,Deleting,Going away\nrunning,Up,\n");
        assert.deepStrictEqual(parseMetadata(texts).metadata.stages, [
            { id: "creating", name: "Provisioning", column: 0, row: undefined, description: undefined },
            { id: "deleting", name: "Deleting", column: undefined, row: undefined, description: "Going away" },
            { id: "running", name: "Up", column: undefined, row: undefined, description: undefined },
        ]);
        texts = applyMetadataOp(texts, { kind: "deleteStage", id: "deleting" });
        // Redeclaring keeps the definitions
        texts = applyMetadataOp(texts, { kind: "setStages", stages: [{ id: "running", name: "Up" }, { id: "creating", name: "Creating" }] });
        assert.deepStrictEqual(parseMetadata(texts).metadata.stages.map((st) => [st.id, st.name, st.column]), [["running", "Up", undefined], ["creating", "Creating", 0]]);

        texts = { ...texts, studio: setLayout(texts.studio, { up: { x: 1, y: 2 }, failed: { x: 3, y: 4 } }) };
        texts = applyMetadataOp(texts, { kind: "removeLayout", states: ["up"] });
        assert.deepStrictEqual(Object.keys(parseMetadata(texts).metadata.layout), ["failed"]);
    });

    test("transfer annotations in the transfers csv", () => {
        const entry = { source: "up", trigger: "on_update" as const, target: "updating" };
        let texts = applyMetadataOp(emptyTexts(), { kind: "setTransferAnnotations", entry: { ...entry, annotations: { web_confirm: "Sure, with a comma?" } } });
        texts = applyMetadataOp(texts, { kind: "setTransferAnnotations", entry: { source: "up", trigger: "on_delete", target: "deleting", annotations: { web_advanced_state: true } } });
        assert.strictEqual(texts.transfers, 'source,trigger,target,web_confirm,web_advanced_state\nup,on_update,updating,"Sure, with a comma?",\nup,on_delete,deleting,,true\n');
        assert.deepStrictEqual(parseMetadata(texts).metadata.transfers[1].annotations, { web_advanced_state: true });
        // Removing the last annotation drops the row, other files are left alone
        const cleared = applyMetadataOp(texts, { kind: "setTransferAnnotations", entry: { ...entry, annotations: {} } });
        assert.strictEqual(cleared.transfers, "source,trigger,target,web_confirm,web_advanced_state\nup,on_delete,deleting,,true\n");
        assert.strictEqual(cleared.studio, "");
        assert.deepStrictEqual(parseMetadata({ ...emptyTexts(), transfers: "source,trigger,target,label\n" }).errors, [
            { file: "transfers", message: "The columns label are not annotations, the factory rejects them" },
        ]);
    });

    test("empty declared stages are shown in the csv view", () => {
        const metadata = emptyMetadata();
        metadata.stages.push({ id: "spare", name: "Spare" });
        const graph = buildGraph("csv", lifecycle().states, load(), metadata);
        assert.ok(graph.stages.some((st) => st.id === "spare" && st.declared));
        assert.ok(!buildGraph("lsm", lifecycle().states, load(), metadata).stages.some((st) => st.id === "spare"));
    });

    test("transfer annotations must match a transfer the factory annotates", () => {
        const metadata = emptyMetadata();
        const entry = (source: string, trigger: string, target: string) => ({ source, trigger, target, annotations: { web_button_label: "x" } }) as (typeof metadata.transfers)[number];
        metadata.transfers.push(
            entry("updating_failed", "on_api_set_state", "up"),
            entry("updating_failed", "on_api_set_state", "rolling_back"),
            entry("up", "on_update", "updating"),
            entry("up", "on_deployed", "up"),
            entry("nope", "on_update", "up"),
            entry("up", "on_failed", "failed"),
            entry("up", "on_update", "up"),
        );
        assert.deepStrictEqual(metadataIssues(metadata, lifecycle().states), [
            "transfer nope.on_update -> up: no state nope",
            "transfer up.on_failed -> failed: the factory doesn't annotate on_failed transfers",
            "transfer up.on_update -> up: up has no such transfer",
        ]);
    });
});

suite("lifecycle table", () => {
    const states = parseStatesCsv(statesText);
    const lifecycle = parseLifecycleCsv(lifecycleText, states);
    const context: TableContext = {
        states: lifecycle.states.map((s) => s.name),
        desiredStates: states.options.map((o) => o.name),
        stages: [],
        icons: ["FaCheck", "FaRocket"],
    };

    test("typed columns of the lifecycle csv", () => {
        const model = lifecycleTable(lifecycle, lint(lifecycle, states));
        const kinds = Object.fromEntries(model.columns.map((c) => [c.key, c.kind]));
        assert.deepStrictEqual([kinds.name, kinds.label, kinds.current, kinds.on_update, kinds.on_api_set_state, kinds.web_icon], ["name", "label", "set", "transfer", "transfers", "icon"]);
        // The annotation columns keep their order when a column is added to the csv
        assert.deepStrictEqual(model.columns.filter((c) => c.group === "Annotations").map((c) => c.key).slice(0, 4), ["web_label", "web_icon", "web_stage", "web_description"]);
        assert.strictEqual(model.rows.find((r) => r.id === "up")?.cells.on_update, "validate(updating)");
    });

    test("checks while typing", () => {
        const model = lifecycleTable(lifecycle, []);
        const column = (key: string) => model.columns.find((c) => c.key === key)!;
        assert.deepStrictEqual(checkCell(column("on_update"), "validate(updating, nowhere)", "up", model, context).map((i) => i.message), ["validate(updating, nowhere): no state nowhere"]);
        assert.deepStrictEqual(checkCell(column("on_api_set_state"), "up, rollback(up)", "up", model, context), []);
        assert.strictEqual(checkCell(column("on_deployed"), "validate(up)", "up", model, context)[0].severity, "warning");
        assert.deepStrictEqual(checkCell(column("name"), "creating", "up", model, context).map((i) => i.message), ["creating already exists"]);
        assert.strictEqual(checkCell(column("label"), "red", "up", model, context)[0].severity, "error");
        assert.strictEqual(checkCell(column("web_icon"), "FaNope", "up", model, context)[0].severity, "warning");
    });

    test("suggestions", () => {
        const model = lifecycleTable(lifecycle, []);
        const column = (key: string) => model.columns.find((c) => c.key === key)!;
        assert.deepStrictEqual(suggestCell(column("on_update"), "validate(upd", context).map((s) => s.value), ["validate(updating)", "validate(updating_failed)"]);
        assert.deepStrictEqual(suggestCell(column("on_update"), "validate(updating, fa", context).map((s) => s.value), ["validate(updating, failed)"]);
        // The last expression of on_api_set_state is completed
        assert.deepStrictEqual(suggestCell(column("on_api_set_state"), "up, rollback(roll", context).map((s) => s.value), ["up, rollback(rolling_back)"]);
        // Resource transfers only take a state
        assert.deepStrictEqual(suggestCell(column("on_deployed"), "upd", context).map((s) => s.value), ["updating", "updating_failed"]);
        assert.deepStrictEqual(suggestCell(column("label"), "da", context).map((s) => s.value), ["danger"]);
    });

    test("changed cells become edits of their file", () => {
        const model = lifecycleTable(lifecycle, []);
        const change = planChanges(model, [
            { row: "up", column: "name", value: "running" },
            { row: "up", column: "on_api_set_state", value: "updating,deleting" },
            { row: "up", column: "label", value: "success" },
        ], lifecycle, emptyMetadata());
        assert.deepStrictEqual(change.csv, [
            { kind: "setCell", state: "up", column: "on_api_set_state", value: "updating, deleting" },
            { kind: "renameState", from: "up", to: "running" },
        ]);

        const desired = planChanges(statesTable(states, []), [{ row: "up", column: "name", value: "running" }], lifecycle, emptyMetadata());
        assert.deepStrictEqual(desired.states, [{ kind: "setCell", state: "up", column: "name", value: "running" }]);
        assert.ok(desired.csv.length > 0 && desired.csv.every((op) => op.kind === "setCell" && op.column === "desired_state" && op.value === "running"));

        const metadata = emptyMetadata();
        metadata.transfers.push({ source: "up", trigger: "on_delete", target: "deleting", annotations: { web_confirm: "Sure?" } });
        const transfers = transfersTable(lifecycle, metadata);
        const id = "up on_delete deleting";
        assert.strictEqual(transfers.rows.find((r) => r.id === id)?.cells.web_confirm, "Sure?");
        assert.deepStrictEqual(planChanges(transfers, [{ row: id, column: "web_advanced_state", value: "true" }, { row: id, column: "source", value: "x" }], lifecycle, metadata).metadata, [
            { kind: "setTransferAnnotations", entry: { source: "up", trigger: "on_delete", target: "deleting", annotations: { web_confirm: "Sure?", web_advanced_state: true } } },
        ]);
    });
});
