/**
 * pi-answer
 *
 * Interactive Q&A command for pi. Adapted from:
 * https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/answer.ts
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { complete, completeSimple, type Api, type Model, type ProviderStreamOptions, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

interface ExtractedQuestion {
	question: string;
	context?: string;
	recommendedAnswer?: string;
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional context that helps answer the question",
      "recommendedAnswer": "Optional concise answer the user likely wants to give"
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Be concise with question text
- Include context only when it provides essential information for answering
- Include recommendedAnswer only when the answer is strongly implied by the conversation or a safe default is obvious
- Keep recommendedAnswer concise and write it as the user's answer, not as an explanation
- If no questions are found, return {"questions": []}

Example output:
{
  "questions": [
    {
      "question": "What is your preferred database?",
      "context": "We can only configure MySQL and PostgreSQL because of what is implemented.",
      "recommendedAnswer": "PostgreSQL"
    },
    {
      "question": "Should we use TypeScript or JavaScript?"
    }
  ]
}`;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const GHOST_CURSOR = "\x1b[7m \x1b[0m";
const GHOST_STYLE = "\x1b[2;90m";
const ANSI_RESET = "\x1b[0m";
type AnswerThinking = (typeof THINKING_LEVELS)[number];

interface AnswerSettings {
	model?: {
		provider: string;
		id: string;
	};
	thinking?: AnswerThinking;
}

interface ExtractionFailure {
	error: string;
}

type ExtractionUiResult = ExtractionResult | ExtractionFailure | null;

function getSettingsPath(): string {
	return join(getAgentDir(), "pi-answer.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isAnswerThinking(value: unknown): value is AnswerThinking {
	return typeof value === "string" && THINKING_LEVELS.includes(value as AnswerThinking);
}

function parseAnswerSettings(value: unknown): AnswerSettings {
	if (!isRecord(value)) return {};

	const settings: AnswerSettings = {};
	if (isRecord(value.model) && typeof value.model.provider === "string" && typeof value.model.id === "string") {
		settings.model = { provider: value.model.provider, id: value.model.id };
	}
	if (isAnswerThinking(value.thinking)) settings.thinking = value.thinking;
	return settings;
}

function getErrorCode(error: unknown): string | undefined {
	return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

async function loadAnswerSettings(): Promise<AnswerSettings> {
	try {
		return parseAnswerSettings(JSON.parse(await readFile(getSettingsPath(), "utf8")));
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return {};
		return {};
	}
}

async function saveAnswerSettings(settings: AnswerSettings): Promise<void> {
	const settingsPath = getSettingsPath();
	await mkdir(dirname(settingsPath), { recursive: true });
	await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function formatModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function sameModel(a: Model<Api> | undefined, b: Model<Api> | undefined): boolean {
	return Boolean(a && b && a.provider === b.provider && a.id === b.id);
}

function isExtractionFailure(result: ExtractionUiResult): result is ExtractionFailure {
	return isRecord(result) && typeof result.error === "string";
}

function buildThinkingOffOptions(
	model: Model<Api>,
	baseOptions: ProviderStreamOptions,
): ProviderStreamOptions {
	const options: ProviderStreamOptions = { ...baseOptions };

	if (model.api === "anthropic-messages") {
		options.thinkingEnabled = false;
	} else if (model.api === "openai-codex-responses") {
		options.reasoningEffort = "none";
		options.reasoningSummary = null;
	} else if (model.api === "google-generative-ai" || model.api === "google-vertex") {
		options.thinking = { enabled: false };
	}

	return options;
}

async function completeForExtraction(
	model: Model<Api>,
	userMessage: UserMessage,
	auth: { apiKey?: string; headers?: Record<string, string> },
	signal: AbortSignal,
	thinking: AnswerThinking,
) {
	const context = { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] };
	const baseOptions: ProviderStreamOptions = { apiKey: auth.apiKey, headers: auth.headers, signal };

	if (thinking === "off") {
		return complete(model, context, buildThinkingOffOptions(model, baseOptions));
	}

	return completeSimple(model, context, { ...baseOptions, reasoning: thinking });
}

async function resolveExtractionSettings(
	ctx: ExtensionContext,
): Promise<{ model: Model<Api>; thinking: AnswerThinking; warning?: string } | null> {
	const settings = await loadAnswerSettings();
	const thinking = settings.thinking ?? "off";
	let warning: string | undefined;

	if (settings.model) {
		const savedModel = ctx.modelRegistry.find(settings.model.provider, settings.model.id);
		if (savedModel && ctx.modelRegistry.hasConfiguredAuth(savedModel)) {
			return { model: savedModel, thinking };
		}
		warning = savedModel
			? `Saved answer model ${settings.model.provider}/${settings.model.id} has no configured auth; using current model.`
			: `Saved answer model ${settings.model.provider}/${settings.model.id} is unavailable; using current model.`;
	}

	if (!ctx.model) return null;
	return { model: ctx.model, thinking, warning };
}

function parseExtractionResult(text: string): ExtractionResult | null {
	try {
		let jsonText = text;
		const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) jsonText = jsonMatch[1].trim();

		const parsed = JSON.parse(jsonText) as unknown;
		if (!isRecord(parsed) || !Array.isArray(parsed.questions)) return null;

		const questions: ExtractedQuestion[] = [];
		for (const item of parsed.questions) {
			if (!isRecord(item) || typeof item.question !== "string") continue;
			const question: ExtractedQuestion = { question: item.question };
			if (typeof item.context === "string" && item.context.trim()) question.context = item.context;
			if (typeof item.recommendedAnswer === "string" && item.recommendedAnswer.trim()) {
				question.recommendedAnswer = item.recommendedAnswer;
			}
			questions.push(question);
		}
		return { questions };
	} catch {
		// ignored
	}
	return null;
}

class QnAComponent implements Component {
	private readonly questions: ExtractedQuestion[];
	private readonly answers: string[];
	private currentIndex = 0;
	private readonly editor: Editor;
	private readonly tui: TUI;
	private readonly onDone: (result: string | null) => void;
	private showingConfirmation = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	private readonly dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private readonly bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private readonly cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private readonly green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private readonly yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
	private readonly gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

	constructor(questions: ExtractedQuestion[], tui: TUI, onDone: (result: string | null) => void) {
		this.questions = questions;
		this.answers = questions.map(() => "");
		this.tui = tui;
		this.onDone = onDone;

		const editorTheme: EditorTheme = {
			borderColor: this.dim,
			selectList: {
				selectedPrefix: this.cyan,
				selectedText: (s: string) => `\x1b[44m${s}\x1b[0m`,
				description: this.gray,
				scrollInfo: this.dim,
				noMatch: this.yellow,
			},
		};

		this.editor = new Editor(tui, editorTheme);
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};
	}

	private saveCurrentAnswer(): void {
		this.answers[this.currentIndex] = this.editor.getText();
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.questions.length) return;
		this.saveCurrentAnswer();
		this.currentIndex = index;
		this.editor.setText(this.answers[index] || "");
		this.invalidate();
	}

	private getCurrentRecommendation(): string | undefined {
		const recommendation = this.questions[this.currentIndex]?.recommendedAnswer?.trim();
		return recommendation && this.editor.getText().length === 0 ? recommendation : undefined;
	}

	private acceptRecommendation(): boolean {
		const recommendation = this.getCurrentRecommendation();
		if (!recommendation) return false;
		this.editor.setText(recommendation);
		this.invalidate();
		this.tui.requestRender();
		return true;
	}

	private submit(): void {
		this.saveCurrentAnswer();

		const parts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i];
			const a = this.answers[i]?.trim() || "(no answer)";
			parts.push(`Q: ${q.question}`);
			if (q.context) parts.push(`> ${q.context}`);
			parts.push(`A: ${a}`);
			parts.push("");
		}

		this.onDone(parts.join("\n").trim());
	}

	private cancel(): void {
		this.onDone(null);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}

		if (matchesKey(data, Key.right) && this.acceptRecommendation()) return;

		if (matchesKey(data, Key.tab)) {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.up) && this.editor.getText() === "") {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
				return;
			}
		}
		if (matchesKey(data, Key.down) && this.editor.getText() === "") {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
				return;
			}
		}

		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			this.saveCurrentAnswer();
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
			} else {
				this.showingConfirmation = true;
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const boxWidth = Math.min(width - 4, 120);
		const contentWidth = boxWidth - 4;
		const horizontalLine = (count: number) => "─".repeat(count);
		const padToWidth = (line: string): string => line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		const emptyBoxLine = (): string => this.dim("│") + " ".repeat(boxWidth - 2) + this.dim("│");
		const boxLine = (content: string, leftPad = 2): string => {
			const paddedContent = " ".repeat(leftPad) + content;
			const rightPad = Math.max(0, boxWidth - visibleWidth(paddedContent) - 2);
			return this.dim("│") + paddedContent + " ".repeat(rightPad) + this.dim("│");
		};

		lines.push(padToWidth(this.dim("╭" + horizontalLine(boxWidth - 2) + "╮")));
		const title = `${this.bold(this.cyan("Questions"))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`;
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));

		const progressParts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const answered = (this.answers[i]?.trim() || "").length > 0;
			const current = i === this.currentIndex;
			progressParts.push(current ? this.cyan("●") : answered ? this.green("●") : this.dim("○"));
		}
		lines.push(padToWidth(boxLine(progressParts.join(" "))));
		lines.push(padToWidth(emptyBoxLine()));

		const q = this.questions[this.currentIndex];
		for (const line of wrapTextWithAnsi(`${this.bold("Q:")} ${q.question}`, contentWidth)) {
			lines.push(padToWidth(boxLine(line)));
		}

		if (q.context) {
			lines.push(padToWidth(emptyBoxLine()));
			for (const line of wrapTextWithAnsi(this.gray(`> ${q.context}`), contentWidth - 2)) {
				lines.push(padToWidth(boxLine(line)));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		const answerPrefix = this.bold("A: ");
		const editorWidth = contentWidth - 7;
		const recommendation = this.getCurrentRecommendation();
		const editorLines = recommendation
			? renderGhostSuggestionLines(this.editor.render(editorWidth), editorWidth, recommendation)
			: this.editor.render(editorWidth);
		for (let i = 1; i < editorLines.length - 1; i++) {
			lines.push(padToWidth(boxLine(i === 1 ? answerPrefix + editorLines[i] : "   " + editorLines[i])));
		}

		lines.push(padToWidth(emptyBoxLine()));
		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
		if (this.showingConfirmation) {
			const confirmMsg = `${this.yellow("Submit all answers?")} ${this.dim("(Enter/y to confirm, Esc/n to cancel)")}`;
			lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
		} else {
			const controls = `${this.dim("Tab/Enter")} next · ${this.dim("Shift+Tab")} prev · ${this.dim("Shift+Enter")} newline · ${this.dim("Esc")} cancel`;
			lines.push(padToWidth(boxLine(truncateToWidth(controls, contentWidth))));
		}
		lines.push(padToWidth(this.dim("╰" + horizontalLine(boxWidth - 2) + "╯")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

function renderGhostSuggestionLines(lines: string[], width: number, text: string): string[] {
	const contentLineIndex = lines.length >= 3 ? 1 : lines.findIndex((line) => line.includes(GHOST_CURSOR));
	if (contentLineIndex === -1) return lines;

	const ghost = `${GHOST_STYLE}${truncateToWidth(text, Math.max(0, width - 1))}${ANSI_RESET}`;
	const rendered = GHOST_CURSOR + ghost;
	return lines.map((line, index) =>
		index === contentLineIndex ? rendered + " ".repeat(Math.max(0, width - visibleWidth(rendered))) : line,
	);
}

function getAvailableModels(modelRegistry: ModelRegistry, currentModel?: Model<Api>): Model<Api>[] {
	const models = [...modelRegistry.getAvailable()];
	if (currentModel && !models.some((model) => sameModel(model, currentModel))) models.unshift(currentModel);
	return models.sort((a, b) => formatModel(a).localeCompare(formatModel(b)));
}

export default function (pi: ExtensionAPI) {
	const answerSettingsHandler = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("answer-settings requires interactive mode", "error");
			return;
		}

		const currentSettings = await loadAnswerSettings();
		const modelChoices = new Map<string, Model<Api>>();
		const useCurrentLabel = ctx.model ? `Use current model (${formatModel(ctx.model)})` : "Use current model";
		const clearLabel = "Clear saved answer settings";
		const cancelLabel = "Cancel";
		const options: string[] = [];

		if (ctx.model) options.push(useCurrentLabel);
		for (const model of getAvailableModels(ctx.modelRegistry, ctx.model)) {
			const label = `${formatModel(model)} — ${model.name}`;
			modelChoices.set(label, model);
			options.push(label);
		}
		if (currentSettings.model || currentSettings.thinking) options.push(clearLabel);
		options.push(cancelLabel);

		if (options.length === 1) {
			ctx.ui.notify("No available models", "error");
			return;
		}

		const modelChoice = await ctx.ui.select("Answer model", options);
		if (!modelChoice || modelChoice === cancelLabel) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		if (modelChoice === clearLabel) {
			await saveAnswerSettings({});
			ctx.ui.notify("Answer settings cleared", "info");
			return;
		}

		const nextSettings: AnswerSettings = {};
		const selectedModel = modelChoices.get(modelChoice);
		if (selectedModel) nextSettings.model = { provider: selectedModel.provider, id: selectedModel.id };

		const currentThinking = currentSettings.thinking ?? "off";
		const thinkingOptions = THINKING_LEVELS.map((level) => (level === currentThinking ? `${level} (current)` : level));
		const thinkingChoice = await ctx.ui.select("Answer thinking", thinkingOptions);
		if (!thinkingChoice) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		const thinking = thinkingChoice.split(" ", 1)[0];
		if (!isAnswerThinking(thinking)) {
			ctx.ui.notify("Invalid thinking level", "error");
			return;
		}

		nextSettings.thinking = thinking;
		await saveAnswerSettings(nextSettings);

		const modelText = nextSettings.model ? `${nextSettings.model.provider}/${nextSettings.model.id}` : "current model";
		ctx.ui.notify(`Answer settings saved: ${modelText}, thinking ${thinking}`, "info");
	};

	const answerHandler = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("answer requires interactive mode", "error");
			return;
		}

		const branch = ctx.sessionManager.getBranch();
		let lastAssistantText: string | undefined;

		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (!("role" in msg) || msg.role !== "assistant") continue;

			if (msg.stopReason !== "stop") {
				ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
				return;
			}

			const textParts = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text);
			if (textParts.length > 0) {
				lastAssistantText = textParts.join("\n");
				break;
			}
		}

		if (!lastAssistantText) {
			ctx.ui.notify("No assistant messages found", "error");
			return;
		}

		const extractionSettings = await resolveExtractionSettings(ctx);
		if (!extractionSettings) {
			ctx.ui.notify("No model selected", "error");
			return;
		}
		if (extractionSettings.warning) ctx.ui.notify(extractionSettings.warning, "warning");

		const extractionModel = extractionSettings.model;
		const extractionThinking = extractionSettings.thinking;
		const extractionResult = await ctx.ui.custom<ExtractionUiResult>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(
				tui,
				theme,
				`Extracting questions using ${formatModel(extractionModel)} (${extractionThinking})...`,
			);
			loader.onAbort = () => done(null);

			const doExtract = async (): Promise<ExtractionUiResult> => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel);
				if (!auth.ok) return { error: auth.error };

				const userMessage: UserMessage = {
					role: "user",
					content: [{ type: "text", text: lastAssistantText }],
					timestamp: Date.now(),
				};

				const response = await completeForExtraction(
					extractionModel,
					userMessage,
					{ apiKey: auth.apiKey, headers: auth.headers },
					loader.signal,
					extractionThinking,
				);

				if (response.stopReason === "aborted") return null;
				if (response.stopReason === "error") {
					return { error: response.errorMessage ?? "Model returned an error." };
				}

				const responseText = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				const parsed = parseExtractionResult(responseText);
				if (!parsed) {
					const suffix = responseText.trim() ? `: ${truncateToWidth(responseText.trim(), 200)}` : ".";
					return { error: `Model returned invalid extraction JSON${suffix}` };
				}

				return parsed;
			};

			doExtract()
				.then(done)
				.catch((error) => done({ error: error instanceof Error ? error.message : String(error) }));
			return loader;
		});

		if (extractionResult === null) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		if (isExtractionFailure(extractionResult)) {
			ctx.ui.notify(`Could not extract questions: ${extractionResult.error}`, "error");
			return;
		}

		if (extractionResult.questions.length === 0) {
			ctx.ui.notify("No questions found in the last message", "info");
			return;
		}

		const answersResult = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
			return new QnAComponent(extractionResult.questions, tui, done);
		});

		if (answersResult === null) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		pi.sendMessage(
			{
				customType: "answers",
				content: "I answered your questions in the following way:\n\n" + answersResult,
				display: true,
			},
			{ triggerTurn: true },
		);
	};

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A",
		handler: (_args, ctx) => answerHandler(ctx),
	});

	pi.registerCommand("answer-settings", {
		description: "Configure the model and thinking level used by /answer",
		handler: (_args, ctx) => answerSettingsHandler(ctx),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer questions",
		handler: answerHandler,
	});
}
