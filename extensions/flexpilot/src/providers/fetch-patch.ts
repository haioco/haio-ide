/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Zynk. All rights reserved.
 *  Licensed under the GPL-3.0 License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Patches LLM responses where tool_calls have `"type": null` instead of the
 * expected `"type": "function"`. The ai-sdk Zod schema rejects null, causing
 * AI_TypeValidationError at runtime. This utility wraps fetch to fix the
 * response body before the SDK parses it.
 */

const NULL_TYPE_RE = /"type"\s*:\s*null/g;
const FUNCTION_TYPE_REPLACE = '"type":"function"';

const patchText = (text: string): string => text.replace(NULL_TYPE_RE, FUNCTION_TYPE_REPLACE);

/**
 * Transforms an SSE stream by patching each `data:` line's JSON payload.
 */
const patchSseStream = (stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
	const reader = stream.getReader();
	let buffer = '';

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					if (buffer) {
						controller.enqueue(new TextEncoder().encode(patchLine(buffer)));
						buffer = '';
					}
					controller.close();
					return;
				}
				buffer += new TextDecoder().decode(value);
				let nlIndex: number;
				while ((nlIndex = buffer.indexOf('\n')) !== -1) {
					const line = buffer.slice(0, nlIndex + 1);
					buffer = buffer.slice(nlIndex + 1);
					controller.enqueue(new TextEncoder().encode(patchLine(line)));
				}
			}
		},
		cancel() {
			reader.cancel();
		}
	});
};

/**
 * Patches a single SSE line. Only touches lines that start with `data: `.
 */
const patchLine = (line: string): string => {
	if (line.startsWith('data: ')) {
		return 'data: ' + patchText(line.slice(6));
	}
	return line;
};

/**
 * Returns a patched fetch function that normalizes tool_call type fields.
 */
export const createPatchedFetch = (originalFetch: typeof fetch): typeof fetch => {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const response = await originalFetch(input, init);
		const contentType = response.headers.get('content-type') || '';

		// SSE streaming responses
		if (contentType.includes('text/event-stream') && response.body) {
			return new Response(patchSseStream(response.body), {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers
			});
		}

		// Plain JSON responses (non-streaming)
		if (contentType.includes('application/json')) {
			const text = await response.clone().text();
			if (NULL_TYPE_RE.test(text)) {
				return new Response(patchText(text), {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers
				});
			}
		}

		return response;
	};
};
