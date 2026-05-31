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
		logger.debug(`[agent] iteration ${iteration}`);

		const toolMode = iteration === 1
			? vscode.LanguageModelChatToolMode.Required
			: vscode.LanguageModelChatToolMode.Auto;

		const { text } = await model.sendRequest(
			messages,
			{ tools, toolMode, modelOptions: { returnTokenUsage } },
			token
		);

		const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
		const toolResultParts: vscode.LanguageModelToolResultPart[] = [];

		for await (const part of text as AsyncIterable<any>) {
			if (part instanceof vscode.LanguageModelTextPart) {
				response.markdown(part.value);
				finalText += part.value;
				assistantParts.push(part);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				response.progress(`Running tool: ${part.name}`);
				logger.info(`[agent] tool call: ${part.name}`);
				assistantParts.push(part);
				const result = await invokeTool(part.name, part.input as Record<string, unknown>);
				toolResultParts.push(new vscode.LanguageModelToolResultPart(part.callId, [new vscode.LanguageModelTextPart(result)]));
			}
		}

		if (toolResultParts.length === 0) {
			logger.debug('[agent] no tool calls; finishing');
			break;
		}

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
