// The `hyphen` package ships no typings. Only the synchronous English entry
// is used (justify.ts): it returns the word with U+00AD at each break point.
declare module "hyphen/en-us" {
	export function hyphenateSync(text: string, options?: { minWordLength?: number }): string;
}
