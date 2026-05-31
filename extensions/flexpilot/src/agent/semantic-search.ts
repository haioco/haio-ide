import * as vscode from 'vscode';
import { logger } from '../logger';

interface SearchResult {
	uri: vscode.Uri;
	score: number;
	preview: string;
}

const sourceGlobs = [
	'**/*.{ts,tsx,js,jsx}',
	'**/*.{py,ipynb}',
	'**/*.{go,rs,c,cpp,h,hpp}',
	'**/*.{java,kt,scala}',
	'**/*.{rb,php}',
	'**/*.{swift,m}',
];

const ignored = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.build/**,**/vendor/**}';

const extractKeywords = (query: string): string[] => {
	return query
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter(w => w.length > 2 && !stopWords.has(w));
};

const stopWords = new Set([
	'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out',
	'day', 'get', 'has', 'him', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way', 'who',
	'with', 'have', 'this', 'will', 'your', 'from', 'they', 'know', 'want', 'been', 'good', 'much', 'some',
	'time', 'very', 'when', 'come', 'here', 'just', 'like', 'long', 'make', 'many', 'over', 'such', 'take',
	'than', 'them', 'well', 'were', 'find', 'what','use', 'using', 'used',
]);

const scoreFile = (text: string, keywords: string[]): number => {
	const lower = text.toLowerCase();
	let score = 0;

	// Keyword presence scoring
	for (const kw of keywords) {
		const idx = lower.indexOf(kw);
		if (idx !== -1) {
			score += 1;
			// Boost if keyword appears in a definition-like line
			const lineStart = lower.lastIndexOf('\n', idx) + 1;
			const line = lower.slice(lineStart, lower.indexOf('\n', idx));
			if (/\b(function|def|class|interface|type|struct|enum|const|let|var|export|import|module)\b/.test(line)) {
				score += 3;
			}
			// Boost if keyword is part of a camelCase/PascalCase identifier
			const before = text.charAt(idx - 1);
			const after = text.charAt(idx + kw.length);
			if ((before === '' || /[^a-zA-Z0-9]/.test(before)) && /[A-Z]/.test(after || '')) {
				score += 2;
			}
		}
	}

	// Boost for files with more structural elements (likely implementation files)
	const structureMatches = text.match(/\b(function|def|class|interface|struct|enum)\b/g);
	if (structureMatches) {
		score += Math.min(structureMatches.length, 5);
	}

	return score;
};

export const semanticSearch = async (query: string, limit: number = 10): Promise<string> => {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || !folders.length) { return 'No workspace open.'; }

	const keywords = extractKeywords(query);
	if (!keywords.length) { return 'Query too vague; please provide more specific terms.'; }

	logger.debug(`[semantic-search] keywords: ${keywords.join(', ')}`);

	// Collect candidate files from all source globs
	const allFiles: vscode.Uri[] = [];
	for (const glob of sourceGlobs) {
		const files = await vscode.workspace.findFiles(glob, ignored, 300);
		allFiles.push(...files);
	}
	// Deduplicate
	const seen = new Set<string>();
	const uniqueFiles = allFiles.filter(f => {
		const s = f.toString();
		if (seen.has(s)) { return false; }
		seen.add(s);
		return true;
	});

	const results: SearchResult[] = [];

	for (const file of uniqueFiles) {
		try {
			const data = await vscode.workspace.fs.readFile(file);
			const text = new TextDecoder().decode(data);
			const score = scoreFile(text, keywords);
			if (score > 0) {
				const lines = text.split('\n');
				// Build preview from top of file + lines around first keyword hit
				let previewLines: string[] = [];
				const headerEnd = Math.min(lines.length, 15);
				previewLines.push(...lines.slice(0, headerEnd));

				// Find line around first keyword hit
				for (let i = 0; i < lines.length; i++) {
					if (keywords.some(kw => lines[i].toLowerCase().includes(kw))) {
						const start = Math.max(0, i - 2);
						const end = Math.min(lines.length, i + 3);
						previewLines.push('...');
						previewLines.push(...lines.slice(start, end));
						break;
					}
				}

				const preview = previewLines.join('\n').slice(0, 600);
				results.push({ uri: file, score, preview });
			}
		} catch { /* ignore unreadable */ }
	}

	results.sort((a, b) => b.score - a.score);
	const top = results.slice(0, limit);

	if (!top.length) {
		return `No semantically relevant files found for: "${query}". Try using grep_search for exact text matching.`;
	}

	return top.map((r, i) =>
		`${i + 1}. ${vscode.workspace.asRelativePath(r.uri)} (score: ${r.score})\n${r.preview}\n---`
	).join('\n');
};
