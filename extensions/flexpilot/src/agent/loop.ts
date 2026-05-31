import * as vscode from 'vscode';
import { logger } from '../logger';
import { getToolSchemas, invokeTool } from './tools';

const MAX_ITERATIONS = 15;

export interface AgentLoopOptions {
	messages: vscode.LanguageModelChatMessage[];
	model: vscode.LanguageModelChat;
	response: vscode.ChatResponseStream;
	token: vscode.CancellationToken;
	returnTokenUsage: boolean;
}

export const runAgentLoop = async (opts: AgentLoopOptions): Promise<string> => {
	const { messages, model, response, token, returnTokenUsage } = opts;
	const tools = getToolSchemas();

	if (!tools.length) {
		return runSingleShot(opts);
	}

	let iteration = 0;
	let finalText = '';

	while (iteration < MAX_ITERATIONS && !token.isCancellationRequested) {
		iteration++;
		logger.info(`[agent] iteration ${iteration} — sending request with ${messages.length} messages, ${tools.length} tools, toolMode=${toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto'}`);
		logger.debug(`[agent] messages JSON: ${JSON.stringify(messages.map(m => ({ role: m.role, contentLength: JSON.stringify(m.content).length })))}`);

		const toolMode = iteration === 1
			? vscode.LanguageModelChatToolMode.Required
			: vscode.LanguageModelChatToolMode.Auto;

		logger.info('[agent] calling model.sendRequest...');
		const { text } = await model.sendRequest(
			messages,
			{ tools, toolMode, modelOptions: { returnTokenUsage } },
			token
		);
		logger.info('[agent] model.sendRequest returned stream');

		const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
		const toolResultParts: vscode.LanguageModelToolResultPart[] = [];

		let partCount = 0;
		for await (const part of text as AsyncIterable<any>) {
			partCount++;
			logger.debug(`[agent] received part #${partCount}: type=${part instanceof vscode.LanguageModelTextPart ? 'text' : part instanceof vscode.LanguageModelToolCallPart ? 'tool-call' : typeof part}`);
			if (part instanceof vscode.LanguageModelTextPart) {
				response.markdown(part.value);
				finalText += part.value;
				assistantParts.push(part);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				response.progress(`Running tool: ${part.name}`);
				logger.info(`[agent] tool call: ${part.name} (callId=${part.callId}, input=${JSON.stringify(part.input).slice(0, 200)})`);
				assistantParts.push(part);
				const result = await invokeTool(part.name, part.input as Record<string, unknown>);
				logger.info(`[agent] tool result for ${part.name}: ${result.slice(0, 200)}...`);
				toolResultParts.push(new vscode.LanguageModelToolResultPart(part.callId, [new vscode.LanguageModelTextPart(result)]));
			}
		}

		logger.info(`[agent] iteration ${iteration} complete: ${partCount} parts, ${toolResultParts.length} tool results`);
		if (toolResultParts.length === 0) {
			logger.info('[agent] no tool calls in response; finishing loop');
			break;
		}
		logger.info(`[agent] appending ${assistantParts.length} assistant parts + ${toolResultParts.length} tool results to messages`);

		messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
		messages.push(vscode.LanguageModelChatMessage.User(toolResultParts));
	}

	return finalText;
};

const runSingleShot = async (opts: AgentLoopOptions): Promise<string> => {
	const { messages, model, response, token, returnTokenUsage } = opts;
	const { text } = await model.sendRequest(messages, { modelOptions: { returnTokenUsage } }, token);
	let result = '';
	for await (const part of text as AsyncIterable<any>) {
		if (part instanceof vscode.LanguageModelTextPart) {
			response.markdown(part.value);
			result += part.value;
		}
	}
	return result;
};
