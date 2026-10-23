import { hyphenateSync } from "hyphen/en-us";

/**
 * Knuth-Plass paragraph justification for the reading column.
 *
 * A port of the "optimal" column in pretext's justification comparison demo
 * (node_modules/@chenglou/pretext/pages/demos/justification-comparison.model.ts):
 * the same badness model (cubic deviation from the natural space, river and
 * tightness penalties, a small cost per hyphen) minimised over the whole
 * paragraph instead of greedily per line, with TeX hyphenation patterns in
 * place of the demo's prefix/suffix list.
 *
 * The result is written back into the live paragraph without touching its
 * text: line ends become `.tmr-kp-br` spans whose `::before` carries the
 * break (and the hyphen, for `.tmr-kp-hy`) as generated content, and the
 * spaces of each justified line are wrapped in `.tmr-kp-gap` spans carrying
 * that line's word-spacing. `textContent` is byte-for-byte unchanged, so
 * pretext cursors, highlights and search offsets all keep working, and
 * generated content stays out of copied text.
 *
 * Breaks depend on the column width, so a paragraph remembers the geometry
 * it was set at (`data-kp-key`) and is reset and re-set when that moves.
 */

const SHORT_LINE_RATIO = 0.6;
const RIVER_THRESHOLD = 1.5;
/** How far a space may shrink, tried in order: 0.6 first (TeX allows about two-thirds),
 *  then the demo's 0.4 for paragraphs that can't be set otherwise. The demo's
 *  limit alone let ordinary paragraphs squeeze spaces to 40%, which reads
 *  cramped in a real book at body size. */
const SHRINK_LIMITS = [0.6, 0.4];
const OVERFLOW_SPACE_RATIO = 0.2;
const TIGHT_SPACE_RATIO = 0.75;
const HYPHEN_PENALTY = 50;
/** TeX's \doublehyphendemerits: a ladder of hyphens down the right edge. */
const CONSECUTIVE_HYPHEN_PENALTY = 3000;
/** Hyphenate only words with at least this many letters, keeping at least
 *  this many on each side of the break. */
const HYPHEN_MIN_WORD = 6;
const HYPHEN_MIN_LEFT = 2;
const HYPHEN_MIN_RIGHT = 3;

export const KP_PARA_CLASS = "tmr-kp";
const BREAK_CLASS = "tmr-kp-br";
const HYPHEN_CLASS = "tmr-kp-hy";
const GAP_CLASS = "tmr-kp-gap";

const SOFT_HYPHEN = "­";
/** Collapsible white space in `white-space: normal` — deliberately not \s,
 *  which would also swallow no-break spaces. */
const COLLAPSIBLE_WS = /[ \t\n\r\f]+/g;
const DASHES = new Set(["-", "‐", "–", "—"]);
const UNSUPPORTED_TAGS = new Set([
	"IMG", "SVG", "MATH", "BR", "WBR", "RUBY", "TABLE", "IFRAME", "VIDEO", "AUDIO",
	"CANVAS", "OBJECT", "EMBED", "INPUT", "BUTTON", "SELECT", "TEXTAREA",
]);

export interface JustifyOptions {
	/** Insert discretionary hyphens from the English patterns. Off for books
	 *  in other languages, whose words the patterns would mangle. */
	hyphenate: boolean;
}

// ─── Measurement ─────────────────────────────────────────────────────────────

interface RunStyle {
	font: string;
	letterSpacing: number;
	wordSpacing: number;
	transform: string;
}

let measureCtx: CanvasRenderingContext2D | null = null;
const widthCache = new Map<string, number>();

function measure(text: string, style: RunStyle): number {
	if (!text) return 0;
	const shown = applyTransform(text, style.transform);
	const key = `${style.font}\u0000${shown}`;
	let width = widthCache.get(key);
	if (width === undefined) {
		if (!measureCtx) measureCtx = createEl("canvas").getContext("2d");
		if (!measureCtx) return 0;
		measureCtx.font = style.font;
		width = measureCtx.measureText(shown).width;
		if (widthCache.size > 50000) widthCache.clear();
		widthCache.set(key, width);
	}
	// Letter-spacing lands after every grapheme, so it is added here rather
	// than through the canvas, keeping the cache font-only.
	return style.letterSpacing ? width + style.letterSpacing * Array.from(shown).length : width;
}

function applyTransform(text: string, transform: string): string {
	if (transform === "uppercase") return text.toUpperCase();
	if (transform === "lowercase") return text.toLowerCase();
	return text;
}

function px(value: string): number {
	const n = parseFloat(value);
	return Number.isFinite(n) ? n : 0;
}

function runStyleOf(el: Element, cache: Map<Element, RunStyle>): RunStyle {
	let style = cache.get(el);
	if (style) return style;
	const cs = getComputedStyle(el);
	const caps = cs.fontVariantCaps === "small-caps" ? "small-caps " : "";
	style = {
		font: `${cs.fontStyle} ${caps}${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
		letterSpacing: px(cs.letterSpacing),
		wordSpacing: px(cs.wordSpacing),
		transform: cs.textTransform,
	};
	cache.set(el, style);
	return style;
}

// ─── Paragraph model ─────────────────────────────────────────────────────────

interface Piece { node: Text; start: number; end: number; style: RunStyle }
interface Gap { node: Text; start: number; end: number; width: number; baseSpacing: number }
interface WordBreak {
	/** Text-node position the break goes at — right after the hyphen point. */
	node: Text;
	offset: number;
	widthBefore: number;
	/** Width of the hyphen drawn at the line end; 0 after a hard dash. */
	hyphenWidth: number;
}
interface Word { pieces: Piece[]; width: number; breaks: WordBreak[] }

type CandidateKind = "start" | "space" | "hyphen" | "end";
interface Candidate {
	kind: CandidateKind;
	/** Word this break sits in (hyphen) or follows (space). */
	word: number;
	wordWidthBefore: number;
	gapWidthBefore: number;
	gapsBefore: number;
	/** Space breaks: the gap swallowed at the line end. Hyphen breaks: the
	 *  break point inside the word. */
	gap?: Gap;
	wordBreak?: WordBreak;
}

interface Paragraph {
	el: HTMLElement;
	width: number;
	indent: number;
	spaceWidth: number;
	words: Word[];
	gaps: Gap[];
}

/** Walk the paragraph's text into words and the gaps between them. Returns
 *  null for anything this can't set faithfully — images, floats, inline
 *  blocks, forced breaks — which then keeps the browser's own layout. */
function readParagraph(
	el: HTMLElement,
	width: number,
	indent: number,
	styles: Map<Element, RunStyle>,
	opts: JustifyOptions,
): Paragraph | null {
	const words: Word[] = [];
	const gaps: Gap[] = [];
	let word: Piece[] = [];
	let pendingGap: Gap | null = null;

	const flushWord = (): void => {
		if (!word.length) return;
		if (pendingGap && words.length) gaps.push(pendingGap);
		pendingGap = null;
		words.push(buildWord(word, opts));
		word = [];
	};

	const walk = (parent: Element): boolean => {
		for (let child = parent.firstChild; child; child = child.nextSibling) {
			if (child.nodeType === Node.TEXT_NODE) {
				const text = child as Text;
				const style = runStyleOf(parent, styles);
				const data = text.data;
				let pos = 0;
				COLLAPSIBLE_WS.lastIndex = 0;
				let m: RegExpExecArray | null;
				while ((m = COLLAPSIBLE_WS.exec(data))) {
					if (m.index > pos) word.push({ node: text, start: pos, end: m.index, style });
					flushWord();
					// The first space of a run is the one the browser keeps.
					if (!pendingGap) {
						pendingGap = {
							node: text,
							start: m.index,
							end: m.index + m[0].length,
							width: measure(" ", style) + style.wordSpacing,
							baseSpacing: style.wordSpacing,
						};
					}
					pos = m.index + m[0].length;
				}
				if (pos < data.length) {
					word.push({ node: text, start: pos, end: data.length, style });
				}
			} else if (child.nodeType === Node.ELEMENT_NODE) {
				const childEl = child as HTMLElement;
				if (UNSUPPORTED_TAGS.has(childEl.tagName.toUpperCase())) return false;
				const cs = getComputedStyle(childEl);
				if (cs.display === "none") continue;
				if (cs.display !== "inline" && cs.display !== "contents") return false;
				if (cs.float !== "none" || cs.position === "absolute" || cs.position === "fixed") return false;
				// Inline boxes with horizontal padding/borders/margins would need
				// their edges measured too; rare enough in books to leave alone.
				const edges =
					px(cs.marginLeft) + px(cs.marginRight) +
					px(cs.paddingLeft) + px(cs.paddingRight) +
					px(cs.borderLeftWidth) + px(cs.borderRightWidth);
				if (Math.abs(edges) > 0.5) return false;
				if (!walk(childEl)) return false;
			}
		}
		return true;
	};

	if (!walk(el)) return null;
	flushWord();
	if (words.length < 2) return null;
	for (const w of words) if (w.width > width) return null;

	const pStyle = runStyleOf(el, styles);
	return { el, width, indent, spaceWidth: measure(" ", pStyle) + pStyle.wordSpacing, words, gaps };
}

function buildWord(pieces: Piece[], opts: JustifyOptions): Word {
	let width = 0;
	const offsets: number[] = [];
	let text = "";
	for (const p of pieces) {
		offsets.push(text.length);
		text += p.node.data.slice(p.start, p.end);
		width += measure(p.node.data.slice(p.start, p.end), p.style);
	}

	// Break positions as character offsets into `text`, each with the hyphen
	// it shows (or none, after a dash the word already has).
	const points: Array<{ at: number; hyphen: boolean }> = [];
	if (text.includes(SOFT_HYPHEN)) {
		for (let i = 0; i < text.length; i++) if (text[i] === SOFT_HYPHEN) points.push({ at: i + 1, hyphen: true });
	} else {
		for (let i = HYPHEN_MIN_LEFT; i < text.length - HYPHEN_MIN_LEFT; i++) {
			if (DASHES.has(text[i]) && /\p{L}/u.test(text[i + 1] ?? "")) points.push({ at: i + 1, hyphen: false });
		}
		if (opts.hyphenate && !points.length) {
			const m = /^([^\p{L}]*)(\p{L}+)([^\p{L}]*)$/u.exec(text);
			// Mixed-case cores are acronyms or names-with-capitals: leave them be.
			if (m && m[2].length >= HYPHEN_MIN_WORD && !/\p{Lu}/u.test(m[2].slice(1))) {
				const core = m[2];
				const lead = m[1].length;
				const marked = hyphenateSync(core.toLowerCase());
				let idx = 0;
				for (const ch of marked) {
					if (ch === SOFT_HYPHEN) {
						if (idx >= HYPHEN_MIN_LEFT && core.length - idx >= HYPHEN_MIN_RIGHT) {
							points.push({ at: lead + idx, hyphen: true });
						}
					} else {
						idx++;
					}
				}
			}
		}
	}

	const breaks: WordBreak[] = [];
	for (const point of points) {
		let k = pieces.length - 1;
		while (k > 0 && offsets[k] > point.at) k--;
		// A break exactly on a piece boundary belongs to the earlier piece, so
		// the hyphen is drawn in its font.
		if (k > 0 && offsets[k] === point.at) k--;
		const piece = pieces[k];
		const offset = piece.start + (point.at - offsets[k]);
		let widthBefore = 0;
		for (let j = 0; j < k; j++) widthBefore += measure(pieces[j].node.data.slice(pieces[j].start, pieces[j].end), pieces[j].style);
		widthBefore += measure(piece.node.data.slice(piece.start, offset), piece.style);
		breaks.push({
			node: piece.node,
			offset,
			widthBefore,
			hyphenWidth: point.hyphen ? measure("-", piece.style) : 0,
		});
	}
	return { pieces, width, breaks };
}

// ─── Line breaking ───────────────────────────────────────────────────────────

function buildCandidates(para: Paragraph): Candidate[] {
	const out: Candidate[] = [{ kind: "start", word: 0, wordWidthBefore: 0, gapWidthBefore: 0, gapsBefore: 0 }];
	let wordWidth = 0;
	let gapWidth = 0;
	for (let i = 0; i < para.words.length; i++) {
		const w = para.words[i];
		for (const b of w.breaks) {
			out.push({
				kind: "hyphen", word: i,
				wordWidthBefore: wordWidth + b.widthBefore,
				gapWidthBefore: gapWidth, gapsBefore: i,
				wordBreak: b,
			});
		}
		wordWidth += w.width;
		if (i < para.gaps.length) {
			const gap = para.gaps[i];
			gapWidth += gap.width;
			out.push({ kind: "space", word: i, wordWidthBefore: wordWidth, gapWidthBefore: gapWidth, gapsBefore: i + 1, gap });
		}
	}
	out.push({ kind: "end", word: para.words.length - 1, wordWidthBefore: wordWidth, gapWidthBefore: gapWidth, gapsBefore: para.gaps.length });
	return out;
}

interface LineStats {
	wordWidth: number;
	gapWidth: number;
	gaps: number;
	natural: number;
	maxWidth: number;
	isLast: boolean;
	hyphenated: boolean;
}

function lineStats(para: Paragraph, cands: Candidate[], from: number, to: number): LineStats {
	const a = cands[from];
	const b = cands[to];
	const trailingGap = b.kind === "space" ? b.gap!.width : 0;
	const hyphenWidth = b.kind === "hyphen" ? b.wordBreak!.hyphenWidth : 0;
	const wordWidth = b.wordWidthBefore - a.wordWidthBefore + hyphenWidth;
	const gapWidth = b.gapWidthBefore - a.gapWidthBefore - trailingGap;
	const gaps = b.gapsBefore - a.gapsBefore - (b.kind === "space" ? 1 : 0);
	return {
		wordWidth, gapWidth, gaps,
		natural: wordWidth + gapWidth,
		maxWidth: from === 0 ? para.width - para.indent : para.width,
		isLast: b.kind === "end",
		hyphenated: b.kind === "hyphen" && hyphenWidth > 0,
	};
}

type Spacing = { kind: "ragged" } | { kind: "overflow" } | { kind: "justified"; space: number };

function displaySpacing(line: LineStats, spaceWidth: number): Spacing {
	if (line.isLast || line.gaps <= 0 || line.natural < line.maxWidth * SHORT_LINE_RATIO) {
		return line.natural <= line.maxWidth ? { kind: "ragged" } : { kind: "overflow" };
	}
	const space = (line.maxWidth - line.wordWidth) / line.gaps;
	if (space < spaceWidth * OVERFLOW_SPACE_RATIO) return { kind: "overflow" };
	return { kind: "justified", space };
}

function lineBadness(line: LineStats, spaceWidth: number, shrinkLimit: number): number {
	const spacing = displaySpacing(line, spaceWidth);
	if (spacing.kind === "overflow") return Infinity;
	if (spacing.kind === "ragged") {
		if (line.isLast) return 0;
		const slack = line.maxWidth - line.natural;
		return slack * slack * 10;
	}
	const space = spacing.space;
	if (space < spaceWidth * shrinkLimit) return Infinity;
	const ratio = Math.abs(space - spaceWidth) / spaceWidth;
	let badness = ratio * ratio * ratio * 1000;
	const riverExcess = space / spaceWidth - RIVER_THRESHOLD;
	if (riverExcess > 0) badness += 5000 + riverExcess * riverExcess * 10000;
	const tight = spaceWidth * TIGHT_SPACE_RATIO;
	if (space < tight) badness += 3000 + (tight - space) * (tight - space) * 10000;
	if (line.hyphenated) badness += HYPHEN_PENALTY;
	return badness;
}

/** Minimum-total-badness break sequence, as candidate indices (excluding the
 *  start). Null when no sequence fits. */
function optimalBreaks(para: Paragraph, cands: Candidate[], shrinkLimit: number): number[] | null {
	const n = cands.length;
	// The widest any line can be: the first line's width differs by the indent.
	const widest = Math.max(para.width, para.width - para.indent);
	const cost = new Array<number>(n).fill(Infinity);
	const prev = new Array<number>(n).fill(-1);
	cost[0] = 0;
	for (let to = 1; to < n; to++) {
		const isLast = cands[to].kind === "end";
		for (let from = to - 1; from >= 0; from--) {
			// Only wider from here on: once even fully squeezed spaces can't fit,
			// no earlier start can either.
			const line = lineStats(para, cands, from, to);
			const minSpace = para.spaceWidth * (isLast ? 1 : shrinkLimit);
			if (line.wordWidth + line.gaps * minSpace > widest) break;
			if (cost[from] === Infinity) continue;
			let total = cost[from] + lineBadness(line, para.spaceWidth, shrinkLimit);
			// A line starting at a hyphen break means the one above ended in one.
			if (line.hyphenated && cands[from].kind === "hyphen") total += CONSECUTIVE_HYPHEN_PENALTY;
			if (total < cost[to]) {
				cost[to] = total;
				prev[to] = from;
			}
		}
	}
	if (cost[n - 1] === Infinity) return null;
	const breaks: number[] = [];
	for (let at = n - 1; at > 0; at = prev[at]) {
		if (prev[at] === -1) return null;
		breaks.push(at);
	}
	return breaks.reverse();
}

// ─── DOM write ───────────────────────────────────────────────────────────────

type Op =
	| { kind: "break"; node: Text; offset: number; hyphen: boolean }
	| { kind: "gap"; node: Text; start: number; end: number; spacing: number };

function opPos(op: Op): number {
	return op.kind === "break" ? op.offset : op.start;
}

function applyParagraph(para: Paragraph, cands: Candidate[], breaks: number[], nodeOrder: Map<Text, number>): void {
	const ops: Op[] = [];
	let from = 0;
	for (const to of breaks) {
		const line = lineStats(para, cands, from, to);
		const spacing = displaySpacing(line, para.spaceWidth);
		const a = cands[from];
		const b = cands[to];
		if (spacing.kind === "justified" && line.gaps > 0) {
			const extra = (line.maxWidth - line.natural) / line.gaps;
			const firstGap = a.kind === "space" ? a.word + 1 : a.word;
			for (let g = firstGap; g < firstGap + line.gaps; g++) {
				const gap = para.gaps[g];
				ops.push({ kind: "gap", node: gap.node, start: gap.start, end: gap.end, spacing: gap.baseSpacing + extra });
			}
		}
		if (b.kind === "space") {
			ops.push({ kind: "break", node: b.gap!.node, offset: b.gap!.end, hyphen: false });
		} else if (b.kind === "hyphen") {
			const wb = b.wordBreak!;
			ops.push({ kind: "break", node: wb.node, offset: wb.offset, hyphen: wb.hyphenWidth > 0 });
		}
		from = to;
	}

	// Back to front, so splitting a text node never invalidates an offset
	// still waiting to be applied.
	ops.sort((x, y) => (nodeOrder.get(y.node)! - nodeOrder.get(x.node)!) || (opPos(y) - opPos(x)));
	for (const op of ops) {
		if (op.kind === "break") {
			const span = createSpan({ cls: op.hyphen ? [BREAK_CLASS, HYPHEN_CLASS] : BREAK_CLASS });
			if (op.offset >= op.node.length) op.node.after(span);
			else if (op.offset <= 0) op.node.before(span);
			else {
				op.node.splitText(op.offset);
				op.node.after(span);
			}
		} else {
			if (op.end < op.node.length) op.node.splitText(op.end);
			const mid = op.start > 0 ? op.node.splitText(op.start) : op.node;
			const span = createSpan({ cls: GAP_CLASS });
			span.style.wordSpacing = `${op.spacing.toFixed(3)}px`;
			mid.replaceWith(span);
			span.appendChild(mid);
		}
	}
	para.el.classList.add(KP_PARA_CLASS);
}

function resetParagraph(p: HTMLElement): void {
	p.querySelectorAll(`.${BREAK_CLASS}`).forEach((el) => el.remove());
	p.querySelectorAll<HTMLElement>(`.${GAP_CLASS}`).forEach((el) => el.replaceWith(...Array.from(el.childNodes)));
	p.normalize();
	p.classList.remove(KP_PARA_CLASS);
	delete p.dataset.kpKey;
}

// ─── Entry points ────────────────────────────────────────────────────────────

/** Justify every eligible paragraph under `root` to its current width. Cheap
 *  to call again: paragraphs already set at the same geometry are skipped.
 *  Reads all geometry before writing anything, so a chapter costs one layout
 *  rather than one per paragraph. */
export function justifyParagraphs(root: HTMLElement, opts: JustifyOptions): void {
	const all = Array.from(root.querySelectorAll<HTMLElement>(".tmr-spine-item p"));
	const jobs: Array<{ el: HTMLElement; width: number; indent: number; key: string }> = [];
	for (const el of all) {
		if (el.classList.contains("tmr-drop-cap")) continue;
		const cs = getComputedStyle(el);
		const align = cs.textAlign;
		if (align !== "start" && align !== "left" && align !== "justify") continue;
		if (cs.direction !== "ltr" || (cs.whiteSpace !== "normal" && cs.whiteSpace !== "nowrap")) continue;
		const width = el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);
		if (width <= 0) continue;
		const indent = cs.textIndent.endsWith("%") ? width * px(cs.textIndent) / 100 : px(cs.textIndent);
		const key = [
			width.toFixed(2), indent.toFixed(2),
			cs.fontStyle, cs.fontWeight, cs.fontSize, cs.fontFamily, cs.letterSpacing, cs.wordSpacing,
			opts.hyphenate ? "h" : "",
		].join("|");
		if (el.dataset.kpKey === key) continue;
		jobs.push({ el, width, indent, key });
	}
	if (!jobs.length) return;

	for (const job of jobs) if (job.el.classList.contains(KP_PARA_CLASS)) resetParagraph(job.el);

	const styles = new Map<Element, RunStyle>();
	const planned: Array<{ para: Paragraph; cands: Candidate[]; breaks: number[]; key: string }> = [];
	for (const job of jobs) {
		// Remember the attempt either way, so a paragraph that can't be set
		// isn't re-walked on every mount at the same width.
		job.el.dataset.kpKey = job.key;
		const para = readParagraph(job.el, job.width, job.indent, styles, opts);
		if (!para) continue;
		const cands = buildCandidates(para);
		let breaks: number[] | null = null;
		for (const limit of SHRINK_LIMITS) {
			breaks = optimalBreaks(para, cands, limit);
			if (breaks) break;
		}
		if (!breaks || breaks.length < 2) continue;
		planned.push({ para, cands, breaks, key: job.key });
	}

	for (const { para, cands, breaks } of planned) {
		const nodeOrder = new Map<Text, number>();
		const walker = document.createTreeWalker(para.el, NodeFilter.SHOW_TEXT);
		for (let i = 0, n = walker.nextNode(); n; n = walker.nextNode(), i++) nodeOrder.set(n as Text, i);
		applyParagraph(para, cands, breaks, nodeOrder);
	}
}

/** Undo `justifyParagraphs` under `root`, restoring the original text nodes'
 *  content (adjacent text nodes come back merged). */
export function clearJustification(root: HTMLElement): void {
	root.querySelectorAll<HTMLElement>("[data-kp-key]").forEach(resetParagraph);
}
