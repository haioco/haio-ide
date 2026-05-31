/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Flexpilot AI. All rights reserved.
 *  Licensed under the GPL-3.0 License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { logger } from '../logger';
import { getWelcomeMessage, buildRequest } from '../prompts/editing-session';
import { parseTokenUsage } from '../utilities';
import { runAgentLoop } from '../agent/loop';
import { modelConfigs } from '../context';
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
	// TODO: Add prompt variables like #file, #sym, etc.. into the subsequent requests to maintain context
	try {
		// Build the request messages
		const messages = await buildRequest(response, context, request);
		logger.debug('Request messages for editing session: \n\n' + JSON.stringify(messages, null, 2));

		// Check if the user has requested token usage
		const returnTokenUsage = vscode.workspace.getConfiguration().get<boolean>('zynk.editingSession.showTokenUsage') ?? false;

		// Determine if this model supports tool calls
		const config = getModelConfig(request.model);
		const supportsToolCalls = config?.supportsToolCalls ?? false;
		logger.info(`[editing-session] model=${request.model.name} version=${request.model.version} supportsToolCalls=${supportsToolCalls} (config found=${!!config})`);

		let responseText: string = '';
		let isAtleastOneFileModified = false;

		if (supportsToolCalls) {
			// Agentic loop: model uses create_file / edit_file tools directly
			logger.info('[editing-session] routing through agent loop');
			responseText = await runAgentLoop({ messages, model: request.model, response, token, returnTokenUsage });
			isAtleastOneFileModified = responseText.includes('Created') || responseText.includes('Edited');
			logger.info(`[editing-session] agent loop done. fileModified=${isAtleastOneFileModified}, responseLength=${responseText.length}`);
		} else {
			// Fallback: XML-based file modification streaming
			response.progress('Generating Edits');
			const { text } = await request.model.sendRequest(messages, { modelOptions: { returnTokenUsage } }, token);

			// Track the files and text edits that have been pushed to the response
			const markdownPushed: string[] = [];
			const textEditPushed: string[] = [];

			for await (const chunk of text) {
				// Check if the chunk is a text part or token usage part
				const tokenUsage = parseTokenUsage(chunk);
				if (tokenUsage) {
					if (returnTokenUsage) { response.warning(tokenUsage); }
					continue;
				}

				// append the text part to the final response text
				responseText = responseText.concat(chunk);

				// split by <file-modification> so that you dont have to wait for the close tag to stream response.
				for (const item of responseText.split('<file-modification>')) {
					const desc = item.match(/<change-description>([^]*?)<\/change-description>/);
					const file = item.match(/<complete-file-uri>([^]*?)<\/complete-file-uri>/);
					const code = item.match(/<updated-file-content>([^]*?)<\/updated-file-content>/);
					const partialCode = item.split('<updated-file-content>')[1] || '';

					// Check if the description and file are present
					if (!desc?.length || !file?.length) { continue; }

					// Push the markdown and code block parts to the response
					const fileUri = vscode.Uri.parse(file[1].trim());
					if (!markdownPushed.includes(fileUri.toString())) {
						response.markdown(desc[1].trim());
						response.push(new vscode.ChatResponseMarkdownPart('\n\n```\n'));
						response.push(new vscode.ChatResponseCodeblockUriPart(fileUri));
						response.push(new vscode.ChatResponseMarkdownPart('\n```\n\n'));
						markdownPushed.push(fileUri.toString());
						vscode.window.showTextDocument(fileUri);
					}

					// Push the text edit part to the response if the complete code block is present
					if (code?.length && !textEditPushed.includes(fileUri.toString())) {
						isAtleastOneFileModified = true;
						const document = await vscode.workspace.openTextDocument(fileUri);
						const prefixSpaces = (document.getText().match(/^\s*/) || [''])[0];
						const suffixSpaces = (document.getText().match(/\s*$/) || [''])[0];
						const newCode = prefixSpaces + code[1].trim() + suffixSpaces;
						response.push(
							new vscode.ChatResponseTextEditPart(
								fileUri, new vscode.TextEdit(new vscode.Range(0, 0, 10000000, 0), newCode)
							)
						);
						response.push(new vscode.ChatResponseTextEditPart(fileUri, true));
						textEditPushed.push(fileUri.toString());
					}

					// Simulate the progress of the response generation streaming
					else if (!code?.length && partialCode) {
						const lineNumber = partialCode.trim().split('\n').length;
						response.push(
							new vscode.ChatResponseTextEditPart(
								fileUri,
								new vscode.TextEdit(new vscode.Range(lineNumber, 0, lineNumber, 0), '')
							)
						);
					}
				}
			}

			// Push the final response text if no files were modified
			if (!isAtleastOneFileModified) {
				response.push(new vscode.ChatResponseMarkdownPart(responseText));
			}
		}

		// Return the metadata for the response
		logger.debug('Response text for editing session: \n\n' + responseText);
		return { metadata: { response: responseText, request: request.prompt, isSuccess: isAtleastOneFileModified } };
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
	chatParticipant = vscode.chat.createChatParticipant('zynk.editing.session', chatRequestHandler);

	// Set up welcome message and sample questions providers
	chatParticipant.welcomeMessageProvider = welcomeMessageProvider;

	// Set up requester information
	chatParticipant.iconPath = new vscode.ThemeIcon('copilot');
	chatParticipant.requester = {
		name: 'User',
	};
	logger.info('Editing Session chat participant registered');
};

/**
 * Disposes of the disposable resource if it exists.
 */
export const dispose = async () => {
	if (chatParticipant) { await chatParticipant.dispose(); }
};
