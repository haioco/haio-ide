/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Flexpilot AI. All rights reserved.
 *  Licensed under the GPL-3.0 License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { logger } from '../logger';
import { panelChatPrompts, getWelcomeMessage, buildTitleProviderRequest, buildFollowupProviderRequest, buildRequest, getProjectOverviewText } from '../prompts/panel-chat';
import { usagePreferences, modelConfigs } from '../context';
import { parseTokenUsage } from '../utilities';
import { runAgentLoop } from '../agent/loop';
import { IModelConfig } from '../types';

/**
 * Provides welcome messages and sample questions for the Flexpilot chat panel.
 */
const welcomeMessageProvider: vscode.ChatWelcomeMessageProvider = {
	provideWelcomeMessage: async () => {
		return {
			icon: new vscode.ThemeIcon('copilot'),
			title: 'Ask Zynk',
			message: getWelcomeMessage('User'),
		};
	},

	provideSampleQuestions: async () => {
		return [{ prompt: '/help - Get help with Zynk commands' }];
	}
};

/**
 * Provides a chat title based on the user's prompt and context history.
 */
const titleProvider: vscode.ChatTitleProvider = {
	provideChatTitle: async (context: vscode.ChatContext, token: vscode.CancellationToken) => {
		try {
			// Get the model ID for chat suggestions
			const modelId = usagePreferences.get('preference.chat-title');
			if (!modelId) { return undefined; }

			// Prepare messages for the chat
			const messages = buildTitleProviderRequest(context);
			logger.debug('Request messages for chat title: \n\n' + JSON.stringify(messages, null, 2));

			// Get the chat model for the followup
			const [chatModel] = await vscode.lm.selectChatModels({ id: modelId });
			if (!chatModel) {
				throw new Error('Model not registered for chat title');
			}

			// Generate the chat response
			const { text } = await chatModel.sendRequest(messages, {}, token);
			let responseText: string = '';
			for await (const chunk of text) {
				responseText = responseText.concat(chunk);
			}

			// Check if the title is present in the response
			const title = responseText.match(/<chat-summary-title>([^]*?)<\/chat-summary-title>/);
			if (!title?.length) { return undefined; }

			// Return the chat title after trimming the text if present
			logger.debug('Response text for chat title: \n\n' + responseText);
			return title[1].trim() || undefined;
		} catch (error) {
			// Log and notify error if any
			logger.notifyError('Error processing `Chat Title` request', error);
			return undefined;
		}
	},
};

/**
 * Provides follow-up suggestions for chat interactions.
 */
const followupProvider: vscode.ChatFollowupProvider = {
	provideFollowups: async (result, context, token) => {
		try {
			// Check if the result has the necessary metadata
			if (!result.metadata?.response || !result.metadata?.request) { return []; }

			// Get the model ID for chat suggestions
			const modelId = usagePreferences.get('preference.chat-suggestions');
			if (!modelId) {
				return [{ prompt: 'Model not configured for chat suggestions' }];
			}

			// Prepare messages for the chat
			const messages = buildFollowupProviderRequest(result, context);
			logger.debug('Request messages for follow up: \n\n' + JSON.stringify(messages, null, 2));

			// Get the chat model for the followup
			const [chatModel] = await vscode.lm.selectChatModels({ id: modelId });
			if (!chatModel) {
				throw new Error('Model not registered for chat suggestions');
			}

			// Generate the chat response
			const { text } = await chatModel.sendRequest(messages, {}, token);
			let responseText: string = '';
			for await (const chunk of text) {
				responseText = responseText.concat(chunk);
			}

			// Check if the follow-up question is present in the response
			const question = responseText.match(/<follow-up-question>([^]*?)<\/follow-up-question>/);
			if (!question?.length) { return []; }

			// Return the follow-up question after trimming the text if present
			logger.debug('Response text for follow up: \n\n' + responseText);
			return [{ prompt: question[1].trim() }];
		} catch (error) {
			// Log and notify error if any
			logger.notifyError('Error processing `Chat Suggestions` request', error);
			return [{ prompt: 'Error generating followups' }];
		}
	},
};

/**
 * Handles chat requests by preparing and sending messages to the chat model, and processing the response.
 */
const getModelConfig = (model: vscode.LanguageModelChat): IModelConfig | undefined => {
	for (const configId of modelConfigs.list()) {
		const config = modelConfigs.get<IModelConfig>(configId);
		if (config && (config.nickname === model.name || config.version === model.version)) {
			return config;
		}
	}
	return undefined;
};

const chatRequestHandler: vscode.ChatExtendedRequestHandler = async (request, context, response, token) => {
	try {
		// Prepare messages for the chat
		const messages = await buildRequest(request, context, request.model.version, response);
		logger.debug('Request messages for panel chat: \n\n' + JSON.stringify(messages, null, 2));

		// Check if the user has requested token usage
		const returnTokenUsage = vscode.workspace.getConfiguration().get<boolean>('zynk.panelChat.showTokenUsage');

		// Determine if this model supports tool calls
		const config = getModelConfig(request.model);
		const supportsToolCalls = config?.supportsToolCalls ?? false;

		let responseText: string = '';

		if (supportsToolCalls) {
			// Agentic loop with tool calling
			responseText = await runAgentLoop({ messages, model: request.model, response, token, returnTokenUsage });
		} else {
			// Fallback: inject workspace overview for non-tool models so they still have context
			try {
				const overview = await getProjectOverviewText();
				messages.splice(1, 0, vscode.LanguageModelChatMessage.User(
					`Workspace context:\n${overview}`
				));
			} catch (e) { /* ignore if no workspace */ }

			const { text } = await request.model.sendRequest(messages, { modelOptions: { returnTokenUsage } }, token);
			for await (const chunk of text) {
				const tokenUsage = parseTokenUsage(chunk);
				if (tokenUsage) {
					if (returnTokenUsage) { response.warning(tokenUsage); }
					continue;
				}
				response.markdown(chunk);
				responseText = responseText.concat(chunk);
			}
		}

		// Return the metadata for the response
		logger.debug('Response text for panel chat: \n\n' + responseText);
		return { metadata: { response: responseText, request: request.prompt } };
	} catch (error) {
		// Log and return error details if any
		logger.error(error as Error);
		response.button({ command: 'zynk.viewLogs', title: 'View Logs' });
		return {
			metadata: { response: 'Unable to process request', request: request.prompt },
			errorDetails: { message: 'Error processing request' },
		};
	}
};

let chatParticipant: vscode.ChatParticipant | undefined;

/**
 * Registers a new panel chat participant for the Flexpilot extension.
 */
export const register = async () => {
	// Dispose of the existing participant if it exists
	if (chatParticipant) { await chatParticipant.dispose(); }

	// Create the chat participant
	chatParticipant = vscode.chat.createChatParticipant('zynk.panel.default', chatRequestHandler);

	// Set up welcome message and sample questions providers
	chatParticipant.welcomeMessageProvider = welcomeMessageProvider;
	chatParticipant.titleProvider = titleProvider;
	chatParticipant.followupProvider = followupProvider;

	// Configure help text prefix
	chatParticipant.helpTextPrefix = panelChatPrompts.getHelpTextPrefix();

	// Set up requester information
	chatParticipant.iconPath = new vscode.ThemeIcon('copilot');
	chatParticipant.requester = {
		name: 'User',
	};
	logger.info('Panel chat participant registered');
};

/**
 * Disposes of the disposable resource if it exists.
 */
export const dispose = async () => {
	if (chatParticipant) { await chatParticipant.dispose(); }
};
