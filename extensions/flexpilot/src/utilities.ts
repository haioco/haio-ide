/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Flexpilot AI. All rights reserved.
 *  Licensed under the GPL-3.0 License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILanguageConfig } from './types';
import { LANGUAGES } from './constants';

/**
 * Retrieves or creates a GitHub authentication session (optional, used only if available).
 */
export const getGitHubSession = async (options?: { createIfNone: boolean }): Promise<vscode.AuthenticationSession | undefined> => {
	const session = await vscode.authentication.getSession(
		'github',
		['public_repo', 'user:email'],
		{ createIfNone: !!options?.createIfNone },
	);
	return session;
};

/**
 * Retrieves the Token Usage from the given chunk.
 */
export const parseTokenUsage = (chunk: string): string | undefined => {
	const tokenUsage = chunk.match(/<zynk-llm-token-usage>([^]*?)<\/zynk-llm-token-usage>/);
	if (tokenUsage) {
		const tokenUsageJson = JSON.parse(tokenUsage[1].trim());
		return [
			`Prompt Tokens: ${tokenUsageJson.promptTokens}`,
			`Completion Tokens: ${tokenUsageJson.completionTokens}`
		].join(', ');
	}
	return undefined;
};

/**
 * Sets a context key with a specified boolean value in the Visual Studio Code environment.
 */
export const setContext = async (key: string, value: boolean) => {
	await vscode.commands.executeCommand('setContext', `zynk:${key}`, value);
};

/**
 * Returns the URL unchanged (no CORS proxy needed for direct API access).
 */
export const corsEnableUrl = (url: string) => {
	return url;
};

/**
 * Retrieves the type of the given terminal based on its shell path.
 */
export const getTerminalType = (terminal?: vscode.Terminal): string => {
	if (
		terminal &&
		'shellPath' in terminal.creationOptions &&
		terminal.creationOptions.shellPath
	) {
		const shellName = terminal.creationOptions.shellPath.replace(/\\/g, '/').split('/').pop();
		switch (true) {
			case shellName === 'bash.exe':
				return 'Git Bash';
			case shellName?.startsWith('pwsh'):
			case shellName?.startsWith('powershell'):
				return 'powershell';
			case Boolean(shellName?.trim()):
				return shellName?.split('.')[0] || 'sh';
		}
	}
	const defaultType = process.platform === 'win32' ? 'powershell' : 'sh';
	return defaultType;
};

/**
 * Retrieves the end-of-line sequence for a given document.
 */
export const getEol = (document: vscode.TextDocument): string => {
	return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
};

/**
 * Retrieves the language configuration for a given language ID.
 */
export const getLanguageConfig = (languageId: string): ILanguageConfig => {
	if (LANGUAGES[languageId]) {
		return LANGUAGES[languageId];
	} else {
		return { markdown: languageId, comment: { start: '//', end: '' } };
	}
};

