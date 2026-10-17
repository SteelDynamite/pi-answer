import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as util from "node:util";
import * as tui from "@earendil-works/pi-tui";
import ts from "typescript";

// Compile the owned source in memory; expose internals only in this test module.
const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(`${source}\nexport { parseExtractionResult, extractQuestions, QnAComponent, ExtractionLoader };`, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function load(api = {}) {
	const module = { exports: {} };
	new Function("require", "module", "exports", compiled)((name) => {
		if (name === "@earendil-works/pi-ai") return api;
		if (name === "@earendil-works/pi-tui") return tui;
		if (name === "node:util") return util;
		throw new Error(`Unexpected import: ${name}`);
	}, module, module.exports);
	return module.exports;
}
const { parseExtractionResult, QnAComponent, ExtractionLoader } = load();
const screen = { requestRender() {}, terminal: { rows: 40, columns: 80 } };
const theme = { fg: (_name, text) => text };
const model = { provider: "openai", id: "gpt-5.6-terra", api: "openai-responses" };
const question = { question: "Database?", context: "Choose one.", recommendedAnswer: "PostgreSQL" };
const response = (text) => ({ stopReason: "stop", content: [{ type: "text", text }] });
const extracted = (questions = [question]) => response(JSON.stringify({ questions }));
const assistant = (text, stopReason = "stop") => ({ type: "message", message: { role: "assistant", stopReason, content: [{ type: "text", text }] } });

function harness({ result = extracted(), branch = [assistant("Database?")], editors = ["PostgreSQL"], custom, registeredModel = model } = {}) {
	const calls = { sends: [], notices: [], editors: [], requests: [], lookups: [], auth: 0 };
	const registry = {
		find: (provider, id) => { calls.lookups.push([provider, id]); assert.deepEqual([provider, id], ["openai", "gpt-5.6-terra"]); return registeredModel; },
		getApiKeyAndHeaders: async (receivedModel) => { assert.equal(receivedModel, registeredModel); calls.auth++; return { ok: true, apiKey: "test-key", headers: { test: "header" } }; },
	};
	const api = { complete: async (...args) => { calls.requests.push(args); return result; } };
	const ctx = {
		hasUI: true,
		modelRegistry: registry,
		sessionManager: { getBranch: () => branch },
		ui: {
			notify: (...args) => calls.notices.push(args),
			custom: custom ?? (async () => undefined),
			editor: async (...args) => { calls.editors.push(args); return editors.shift(); },
		},
	};
	let command, shortcut;
	load(api).default({
		registerCommand(name, options) { assert.equal(name, "answer"); command = options.handler; },
		registerShortcut(key, options) { assert.equal(key, "ctrl+."); shortcut = options.handler; },
		sendMessage: (...args) => calls.sends.push(args),
	});
	return { calls, ctx, run: () => command("", ctx), shortcut: () => shortcut(ctx) };
}

for (const text of ["", "not JSON", "null", "[]", '{"questions":{}}', '```json\n{"questions":\n```']) {
	test(`rejects malformed extraction ${JSON.stringify(text)}`, () => assert.equal(parseExtractionResult(text), null));
}
test("parses fenced JSON; ignores invalid items and optional fields", () => {
	assert.deepEqual(parseExtractionResult('```json\n{"questions":[null,3,{}, {"question":7}, {"question":"OK?","context":[],"recommendedAnswer":false}]}\n```'), { questions: [{ question: "OK?" }] });
});
test("preserves Unicode and multiline plain text", () => {
	const q = { question: "日本語?\n🙂", context: "one\ntwo", recommendedAnswer: "café\n中文" };
	assert.deepEqual(parseExtractionResult(JSON.stringify({ questions: [q] })), { questions: [q] });
});

const controls = ["\x1b]52;c;VEVTVA==\x07", "\x1b]52;c;VEVTVA==\x1b\\", "\x1b[2J", "\x1b[31m", "\x9b2J", "\x1bPpayload\x1b\\", "\x00\x07\x08\x0b\x0c\x7f", "\x1b]unfinished"];
for (const [index, control] of controls.entries()) {
	test(`strips terminal controls from every extracted field (${index})`, () => {
		const parsed = parseExtractionResult(JSON.stringify({ questions: [{ question: `${control}Question?`, context: `${control}Context`, recommendedAnswer: `${control}Answer` }] }));
		for (const value of Object.values(parsed.questions[0])) assert.doesNotMatch(value, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
	});
}
test("sanitization preserves visible text around terminal sequences", () => {
	const parsed = parseExtractionResult(JSON.stringify({ questions: [{
		question: "Before \x1b[31mred\x1b[0m after?",
		context: "Before\x1b]52;c;VEVTVA==\x07 after",
		recommendedAnswer: "日本語\x1b[2J café\n🙂",
	}] }));
	assert.deepEqual(parsed.questions, [{ question: "Before red after?", context: "Before after", recommendedAnswer: "日本語 café\n🙂" }]);
});
test("RPC titles and prefills receive sanitized text", async () => {
	const h = harness({ result: extracted([{ question: "\x1b[2JQuestion?", context: "\x1b[31mContext\x1b[0m", recommendedAnswer: "\x1b]52;c;VEVTVA==\x07Answer" }]) });
	await h.run();
	assert.deepEqual(h.calls.editors, [["Question 1/1\n\nQuestion?\n\nContext: Context", "Answer"]]);
});
test("normalizes CR and tabs before layout", () => {
	const parsed = parseExtractionResult(JSON.stringify({ questions: [{ question: "a\r\nb\rc\td" }] }));
	assert.equal(parsed.questions[0].question, "a\nb\nc   d");
});

test("loader lines fit narrow terminals", () => {
	const loader = new ExtractionLoader(screen, theme, "Extracting...");
	try {
		for (const width of [0, 1, 5, 14, 19, 20, 80]) {
			for (const line of loader.render(width)) assert.ok(tui.visibleWidth(line) <= width, `width ${width}: got ${tui.visibleWidth(line)}`);
		}
	} finally { loader.dispose(); }
});
test("loader clipping preserves normal-width borders and handles colored wide labels", () => {
	const colored = { fg: (_name, text) => `\x1b[36m${text}\x1b[0m` };
	const label = "Extracting 中文🙂";
	const loader = new ExtractionLoader(screen, colored, label);
	try {
		const lines = loader.render(80).map(util.stripVTControlCharacters);
		assert.equal(lines[0], "╭" + "─".repeat(78) + "╮");
		assert.equal(lines.at(-1), "╰" + "─".repeat(78) + "╯");
		assert.ok(lines.some((line) => line.includes(label)));
		assert.ok(lines.some((line) => line.includes("Esc cancel")));
		for (const width of [0, 1, 5, 14, 19, 20, 80]) {
			for (const line of loader.render(width)) assert.ok(tui.visibleWidth(line) <= width);
		}
	} finally { loader.dispose(); }
});
test("parsed CRLF/CJK recommendation previews on one line and submits all lines", () => {
	const parsed = parseExtractionResult(JSON.stringify({ questions: [{ question: "言語?", recommendedAnswer: "日本語\r\n中文" }] }));
	let result;
	const component = new QnAComponent(parsed.questions, screen, (value) => { result = value; });
	const lines = component.render(80).map(util.stripVTControlCharacters);
	assert.ok(lines.some((line) => line.includes("日本語 中文")));
	for (const line of lines) assert.doesNotMatch(line, /[\r\n]/);
	component.handleInput("\x1b[C");
	component.handleInput("\r");
	component.handleInput("y");
	assert.equal(result, "Q: 言語?\nA: 日本語\n中文");
});
test("multiline ghost recommendations cannot inject physical render lines", () => {
	const component = new QnAComponent([{ ...question, recommendedAnswer: "first\nsecond" }], screen, () => {});
	for (const line of component.render(80)) assert.doesNotMatch(line, /[\r\n]/);
});
test("Right Arrow accepts recommendation; navigation preserves edits; confirmation submits", () => {
	let result;
	const component = new QnAComponent([question, { question: "Language?" }], screen, (value) => { result = value; });
	component.handleInput("\x1b[C");
	component.handleInput("\t");
	component.handleInput("TypeScript");
	component.handleInput("\x1b[Z");
	component.handleInput("\r");
	component.handleInput("\r");
	assert.equal(result, undefined);
	component.handleInput("y");
	assert.equal(result, "Q: Database?\n> Choose one.\nA: PostgreSQL\n\nQ: Language?\nA: TypeScript");
});
test("accepting a multiline recommendation preserves its full text", () => {
	let result;
	const component = new QnAComponent([{ question: "Details?", recommendedAnswer: "first\nsecond" }], screen, (value) => { result = value; });
	component.render(80);
	component.handleInput("\x1b[C");
	for (const line of component.render(80)) assert.doesNotMatch(line, /[\r\n]/);
	component.handleInput("\r");
	component.handleInput("y");
	assert.equal(result, "Q: Details?\nA: first\nsecond");
});
test("Escape cancels questionnaire without an answer", () => {
	let result;
	const component = new QnAComponent([question], screen, (value) => { result = value; });
	component.handleInput("partial");
	component.handleInput("\x1b");
	assert.equal(result, null);
});

test("RPC submission passes resolved auth to module completion", async () => {
	const h = harness();
	await h.run();
	assert.equal(h.calls.requests.length, 1);
	assert.equal(h.calls.requests[0][0], model);
	assert.equal(h.calls.requests[0][1].messages[0].content[0].text, "Database?");
	assert.ok(h.calls.requests[0][2].signal instanceof AbortSignal);
	assert.equal(h.calls.auth, 1);
	assert.equal(h.calls.requests[0][2].apiKey, "test-key");
	assert.deepEqual(h.calls.requests[0][2].headers, { test: "header" });
	assert.equal(h.calls.editors[0][1], "PostgreSQL");
	assert.equal(h.calls.sends.length, 1);
	assert.equal(h.calls.sends[0][0].customType, "answers");
	assert.equal(h.calls.sends[0][1].triggerTurn, true);
	assert.match(h.calls.sends[0][0].content, /A: PostgreSQL$/);
});
for (const api of ["openai-responses", "openai-codex-responses"]) {
	for (const entry of ["run", "shortcut"]) {
		test(`${entry} uses fixed unified OpenAI model and preserves ${api} transport`, async () => {
			const registeredModel = { ...model, api };
			const h = harness({ registeredModel });
			h.ctx.model = { provider: "anthropic", id: "session-model" };
			await h[entry]();
			assert.deepEqual(h.calls.lookups, [["openai", "gpt-5.6-terra"]]);
			assert.equal(h.calls.requests.length, 1);
			assert.equal(h.calls.requests[0][0], registeredModel);
			assert.equal(h.calls.requests[0][0].api, api);
			assert.equal(h.calls.auth, 1);
			assert.match(h.calls.notices[0][0], /openai\/gpt-5\.6-terra/);
			assert.equal(h.calls.sends.length, 1);
		});
	}
}
test("missing fixed OpenAI model reports error without provider or model fallback", async () => {
	const h = harness({ registeredModel: null });
	await h.run();
	assert.deepEqual(h.calls.lookups, [["openai", "gpt-5.6-terra"]]);
	assert.deepEqual(h.calls.notices, [["Required model unavailable: openai/gpt-5.6-terra", "error"]]);
	assert.equal(h.calls.auth, 0);
	assert.equal(h.calls.requests.length, 0);
	assert.equal(h.calls.editors.length, 0);
	assert.equal(h.calls.sends.length, 0);
});
test("auth failure does not invoke model", async () => {
	const h = harness();
	h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: "Missing credentials" });
	await h.run();
	assert.equal(h.calls.requests.length, 0);
	assert.match(h.calls.notices.at(-1)[0], /Missing credentials/);
});
for (const answer of [undefined, "", "   "]) {
	test(`RPC cancellation discards partial answers: ${JSON.stringify(answer)}`, async () => {
		const h = harness({ result: extracted([question, question]), editors: ["first", answer] });
		await h.run();
		assert.equal(h.calls.sends.length, 0);
		assert.equal(h.calls.editors.length, 2);
	});
}
for (const result of [extracted([]), response("not JSON"), { stopReason: "aborted" }, { stopReason: "error", errorMessage: "failed" }]) {
	test(`does not open dialogs or submit after extraction problem: ${JSON.stringify(result)}`, async () => {
		const h = harness({ result });
		await h.run();
		assert.equal(h.calls.editors.length, 0);
		assert.equal(h.calls.sends.length, 0);
		assert.equal(h.calls.notices.length, 2);
	});
}
for (const result of [response("\x1b]52;c;VEVTVA==\x07not JSON"), { stopReason: "error", errorMessage: "\x1b[2Jfailed" }]) {
	test(`error notifications remove terminal controls: ${JSON.stringify(result)}`, async () => {
		const h = harness({ result });
		await h.run();
		assert.doesNotMatch(h.calls.notices.at(-1)[0], /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
	});
}
test("uses latest completed assistant text on active branch", async () => {
	const h = harness({ branch: [assistant("old"), { type: "custom" }, assistant("latest")] });
	await h.shortcut();
	assert.equal(h.calls.requests[0][1].messages[0].content[0].text, "latest");
});
for (const branch of [[], [assistant("incomplete", "error")]]) {
	test(`missing or incomplete assistant stops before extraction: ${JSON.stringify(branch)}`, async () => {
		const h = harness({ branch });
		await h.run();
		assert.equal(h.calls.requests.length, 0);
		assert.equal(h.calls.sends.length, 0);
	});
}
test("noninteractive mode stops before extraction", async () => {
	const h = harness();
	h.ctx.hasUI = false;
	await h.run();
	assert.equal(h.calls.requests.length, 0);
	assert.match(h.calls.notices[0][0], /interactive mode/);
});
test("terminal cancellation aborts extraction without falling back to RPC", async () => {
	const h = harness({ custom: (factory) => new Promise((resolve) => {
		const loader = factory(screen, theme, {}, resolve);
		loader.handleInput("\x1b");
		loader.dispose();
	}) });
	await h.run();
	assert.equal(h.calls.requests[0][2].signal.aborted, true);
	assert.equal(h.calls.editors.length, 0);
	assert.equal(h.calls.sends.length, 0);
});
test("terminal extraction and questionnaire complete through custom callbacks", async () => {
	let screens = 0;
	const h = harness({ custom: (factory) => new Promise((resolve) => {
		let component;
		component = factory(screen, theme, {}, (value) => { component?.dispose?.(); resolve(value); });
		if (++screens === 2) {
			component.render(80);
			component.handleInput("\x1b[C");
			component.handleInput("\r");
			component.handleInput("y");
		}
	}) });
	await h.run();
	assert.equal(screens, 2);
	assert.equal(h.calls.editors.length, 0);
	assert.equal(h.calls.sends.length, 1);
});
