/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Flexpilot AI. All rights reserved.
 *  Licensed under the GPL-3.0 License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { logger } from '../logger';
import { registerDisposable } from '../context';
import { modelProviderManager } from '../providers';
import { setContext } from '../utilities';
import { register as panelChatRegister } from '../interfaces/panel-chat';
import { register as inlineChatRegister } from '../interfaces/inline-chat';
import { register as renameSymbolRegister } from '../interfaces/rename-symbol';
import { register as editingSessionRegister } from '../interfaces/editing-session';
import { register as terminalChatRegister } from '../interfaces/terminal-chat';
import { register as completionsRegister } from '../interfaces/inline-completion';

// Flag to check if the agents are activated
let isAgentsActivated = false;

/**
 * Handles Zynk activation — registers all chat participants and model providers.
 */
const handler = async () => {
	// Always mark as logged in (no GitHub auth required)
	await setContext('isLoggedIn', true);
	await setContext('isNetworkConnected', true);

	if (!isAgentsActivated) {
		isAgentsActivated = true;

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Zynk',
			cancellable: false,
		}, async (progress) => {
			progress.report({ message: 'Initializing model providers' });
			await modelProviderManager.initialize();

			progress.report({ message: 'Registering Chat Participants' });
			await completionsRegister();
			await panelChatRegister();
			await inlineChatRegister();
			await renameSymbolRegister();
			await editingSessionRegister();
			await terminalChatRegister();
		});
	}
};

/**
 * Registers the internet connection check command for the Zynk extension.
 */
export const registerCheckInternetConnectionCommand = () => {
	registerDisposable(vscode.commands.registerCommand('zynk.checkInternetConnection', handler));
	logger.info('Command `zynk.checkInternetConnection` registered');
};
