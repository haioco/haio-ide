import * as vscode from 'vscode';
import { logger } from '../logger';

export interface ZynkTool {
	name: string;
	description: string;
	inputSchema: object;
	invoke: (args: Record<string, unknown>) => Promise<string>;
}

const MAX_TREE_DEPTH = 4;
const MAX_TREE_FILES = 200;

const ignoredGlobs = ['**/.git/**', '**/node_modules/**', '**/.build/**', '**/out/**', '**/dist/**', '**/.next/**', '**/.venv/**', '**/__pycache__/**', '**/.DS_Store'];

async function buildTree(uri: vscode.Uri, depth: number, count: { value: number }): Promise<string> {
	if (depth > MAX_TREE_DEPTH || count.value > MAX_TREE_FILES) { return ''; }
	const entries = await vscode.workspace.fs.readDirectory(uri);
	const lines: string[] = [];
	for (const [name, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
		if (name.startsWith('.') && name !== '.github') { continue; }
		const prefix = '  '.repeat(depth);
		if (type === vscode.FileType.Directory) {
			lines.push(`${prefix}${name}/`);
			count.value++;
			if (count.value <= MAX_TREE_FILES) {
				lines.push(await buildTree(vscode.Uri.joinPath(uri, name), depth + 1, count));
			}
		} else if (type === vscode.FileType.File) {
			lines.push(`${prefix}${name}`);
			count.value++;
		}
	}
	return lines.join('\n');
}

export const getProjectOverview: ZynkTool = {
	name: 'get_project_overview',
	description: 'Returns a high-level summary of the workspace: folder name, file tree (depth-limited), and contents of key files (README, package.json, pyproject.toml, etc.).',
	inputSchema: { type: 'object', properties: {}, required: [] },
	invoke: async () => {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || !folders.length) { return 'No workspace folder is open.'; }
		const root = folders[0].uri;
		const name = folders[0].name;
		const tree = await buildTree(root, 0, { value: 0 });

		const keyFiles = ['README.md', 'README', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Makefile', 'CMakeLists.txt'];
		const fileContents: string[] = [];
		for (const fname of keyFiles) {
			try {
				const uri = vscode.Uri.joinPath(root, fname);
				const data = await vscode.workspace.fs.readFile(uri);
				const text = new TextDecoder().decode(data);
				const truncated = text.length > 3000 ? text.slice(0, 3000) + '\n... (truncated)' : text;
				fileContents.push(`--- ${fname} ---\n${truncated}`);
			} catch { /* ignore missing */ }
		}

		return [
			`Workspace: ${name}`,
			'File Tree:',
			tree,
			'Key Files:',
			...fileContents,
		].join('\n');
	}
};

export const listDir: ZynkTool = {
	name: 'list_dir',
	description: 'List files and directories inside a given path.',
	inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Relative path from workspace root, or absolute file URI.' } }, required: ['path'] },
	invoke: async (args) => {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders) { return 'No workspace open.'; }
		const raw = String(args.path);
		const uri = raw.startsWith('file:') ? vscode.Uri.parse(raw) : vscode.Uri.joinPath(folders[0].uri, raw);
		const entries = await vscode.workspace.fs.readDirectory(uri);
		const dirs = entries.filter(([, t]) => t === vscode.FileType.Directory).map(([n]) => `${n}/`).sort();
		const files = entries.filter(([, t]) => t === vscode.FileType.File).map(([n]) => n).sort();
		return [...dirs, ...files].join('\n') || '(empty directory)';
	}
};

export const readFile: ZynkTool = {
	name: 'read_file',
	description: 'Read the contents of a file, optionally a specific line range.',
	inputSchema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Relative path from workspace root, or absolute file URI.' },
			start_line: { type: 'number', description: '1-based start line (optional).' },
			end_line: { type: 'number', description: '1-based end line (optional).' }
		},
		required: ['path']
	},
	invoke: async (args) => {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders) { return 'No workspace open.'; }
		const raw = String(args.path);
		const uri = raw.startsWith('file:') ? vscode.Uri.parse(raw) : vscode.Uri.joinPath(folders[0].uri, raw);
		const data = await vscode.workspace.fs.readFile(uri);
		let text = new TextDecoder().decode(data);
		const start = args.start_line ? Number(args.start_line) : undefined;
		const end = args.end_line ? Number(args.end_line) : undefined;
		if (start !== undefined || end !== undefined) {
			const lines = text.split('\n');
			const s = Math.max(0, (start || 1) - 1);
			const e = end !== undefined ? Math.min(lines.length, end) : lines.length;
			text = lines.slice(s, e).join('\n');
		}
		if (text.length > 8000) { text = text.slice(0, 8000) + '\n... (truncated)'; }
		return text;
	}
};

export const findFiles: ZynkTool = {
	name: 'find_files',
	description: 'Glob search for files matching a pattern (e.g. "**/*.ts").',
	inputSchema: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern like "**/*.ts".' } }, required: ['pattern'] },
	invoke: async (args) => {
		const pattern = String(args.pattern);
		const files = await vscode.workspace.findFiles(pattern, `{${ignoredGlobs.join(',')}}`, 50);
		return files.map(f => vscode.workspace.asRelativePath(f)).join('\n') || 'No files found.';
	}
};

export const grepSearch: ZynkTool = {
	name: 'grep_search',
	description: 'Text search across files in the workspace.',
	inputSchema: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Search string or regex.' },
			file_pattern: { type: 'string', description: 'Optional glob pattern to limit search scope.' }
		},
		required: ['query']
	},
	invoke: async (args) => {
		const query = String(args.query);
		const pattern = args.file_pattern ? String(args.file_pattern) : '{**/*}';
		const collected: any[] = [];
		await vscode.workspace.findTextInFiles(
			{ pattern: query, isRegExp: false },
			{ include: pattern, exclude: ignoredGlobs.join(','), maxResults: 30 },
			(result) => { collected.push(result); }
		);
		return collected.map(r => `${vscode.workspace.asRelativePath(r.uri)}:${r.range.start.line + 1}: ${r.preview.text}`).join('\n') || 'No matches found.';
	}
};

const getWorkspaceRoot = (): vscode.Uri | undefined => {
	const folders = vscode.workspace.workspaceFolders;
	return folders && folders.length ? folders[0].uri : undefined;
};

const resolveUri = (rawPath: string): vscode.Uri => {
	const root = getWorkspaceRoot();
	if (rawPath.startsWith('file:')) { return vscode.Uri.parse(rawPath); }
	if (!root) { throw new Error('No workspace open.'); }
	return vscode.Uri.joinPath(root, rawPath);
};

const isInsideWorkspace = (uri: vscode.Uri): boolean => {
	const root = getWorkspaceRoot();
	if (!root) { return false; }
	return uri.fsPath.startsWith(root.fsPath);
};

export const createFile: ZynkTool = {
	name: 'create_file',
	description: 'Create a new file with the given content. Errors if the file already exists.',
	inputSchema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Relative path from workspace root.' },
			content: { type: 'string', description: 'Full file content to write.' }
		},
		required: ['path', 'content']
	},
	invoke: async (args) => {
		const uri = resolveUri(String(args.path));
		if (!isInsideWorkspace(uri)) { return 'Error: Cannot write outside the workspace.'; }
		try {
			await vscode.workspace.fs.stat(uri);
			return 'Error: File already exists.';
		} catch {
			// file doesn't exist, proceed
		}
		const parent = vscode.Uri.joinPath(uri, '..');
		await vscode.workspace.fs.createDirectory(parent);
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(String(args.content)));
		return `Created ${vscode.workspace.asRelativePath(uri)}`;
	}
};

export const editFile: ZynkTool = {
	name: 'edit_file',
	description: 'Apply an exact-string replacement in an existing file. The old_string must match exactly (including whitespace and newlines).',
	inputSchema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Relative path from workspace root.' },
			old_string: { type: 'string', description: 'Exact existing text to replace.' },
			new_string: { type: 'string', description: 'Replacement text.' }
		},
		required: ['path', 'old_string', 'new_string']
	},
	invoke: async (args) => {
		const uri = resolveUri(String(args.path));
		if (!isInsideWorkspace(uri)) { return 'Error: Cannot write outside the workspace.'; }
		const data = await vscode.workspace.fs.readFile(uri);
		let text = new TextDecoder().decode(data);
		const oldStr = String(args.old_string);
		const newStr = String(args.new_string);
		const idx = text.indexOf(oldStr);
		if (idx === -1) { return 'Error: old_string not found in file. Make sure it matches exactly (including whitespace).'; }
		if (text.indexOf(oldStr, idx + 1) !== -1) { return 'Error: old_string appears multiple times in the file. Provide more context so it is unique.'; }
		text = text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
		return `Edited ${vscode.workspace.asRelativePath(uri)}`;
	}
};

export const runCommand: ZynkTool = {
	name: 'run_command',
	description: 'Run a terminal command inside the workspace root. Requires zynk.agent.allowRunCommands to be enabled.',
	inputSchema: {
		type: 'object',
		properties: {
			command: { type: 'string', description: 'Shell command to run.' }
		},
		required: ['command']
	},
	invoke: async (args) => {
		const allowed = vscode.workspace.getConfiguration().get<boolean>('zynk.agent.allowRunCommands');
		if (!allowed) { return 'Error: Running commands is disabled. Enable zynk.agent.allowRunCommands in settings.'; }
		const root = getWorkspaceRoot();
		if (!root) { return 'Error: No workspace open.'; }
		const term = vscode.window.createTerminal({ cwd: root.fsPath, name: 'Zynk Agent' });
		term.sendText(String(args.command));
		term.show();
		return `Running command in terminal: ${String(args.command)}`;
	}
};

export const allTools: ZynkTool[] = [getProjectOverview, listDir, readFile, findFiles, grepSearch, createFile, editFile, runCommand];

export const getToolSchemas = (): vscode.LanguageModelChatTool[] => {
	return allTools.map(t => ({
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema as any,
	}));
};

export const invokeTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
	const tool = allTools.find(t => t.name === name);
	if (!tool) { return `Unknown tool: ${name}`; }
	try {
		logger.info(`[agent] invoking ${name}: ${JSON.stringify(args).slice(0, 200)}`);
		const result = await tool.invoke(args);
		logger.info(`[agent] ${name} done (${result.length} chars)`);
		return result;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error(`[agent] ${name} failed: ${msg}`);
		return `Error: ${msg}`;
	}
};
