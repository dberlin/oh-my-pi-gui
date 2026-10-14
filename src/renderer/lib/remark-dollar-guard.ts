import { markdownLineEnding, markdownLineEndingOrSpace } from "micromark-util-character";
import { codes } from "micromark-util-symbol";
import type { Construct, Effects, State, Token, Tokenizer } from "micromark-util-types";
import type { Processor } from "unified";

interface DollarGuardOptions {
	/** Allow `$…$` inline math (default true — matches remark-math). */
	singleDollarTextMath?: boolean;
}

/**
 * Currency-aware replacement for remark-math's inline `$…$` tokenizer.
 * Upstream has no price guard: `**$15 …**、$25` parses `$15 …$` as math and
 * swallows the closing `**` inside it. This construct registers AFTER
 * remark-math because micromark prepends each extension's constructs, which
 * makes it tried BEFORE mathText — and it always succeeds:
 *
 * - Pandoc-shaped math (`$x^2$`, `$$…$$`) → emits upstream's own
 *   mathText/mathTextSequence/mathTextData tokens, so the existing
 *   mdast-util-math → KaTeX pipeline renders it unchanged.
 * - Anything that fails the guard (prices like `$15 … $25`, lone `$`) → the
 *   attempt rewinds and the opening `$` is emitted as literal data, so
 *   following `**`/`_` still parse and the next `$` gets its own attempt.
 *
 * Guard rules: a single `$` needs non-space content on its right; the closing
 * run needs a non-space on its left and no digit on its right. A digit-led
 * span containing prose whitespace is money unless it also contains explicit
 * math syntax. This keeps `$5 and $10 and $x^2$` literal around the prices
 * without regressing existing numeric equations such as `$2^n$` or `$2 + 3$`.
 * `$$…$$` keeps upstream behavior, including numeric display math.
 */
export function remarkDollarGuard(this: Processor, options?: DollarGuardOptions): void {
	const single = options?.singleDollarTextMath !== false;
	const data = this.data();
	data.micromarkExtensions ??= [];
	data.micromarkExtensions.push({
		text: { [codes.dollarSign]: { tokenize: tokenizeGuardedMath(single), name: "mathText" } },
	});
}

function tokenizeGuardedMath(single: boolean): Tokenizer {
	return (effects, ok, _nok) => {
		// Emits upstream-identical tokens; interior whitespace folds into
		// mathTextData so no resolve pass is needed for mdast-util-math.
		const math: Construct = { tokenize: tokenizeMath, partial: true };

		function start(code: number | null): State | undefined {
			return effects.attempt(math, done, literal)(code);
		}

		// The math attempt already emitted the full token tree; redispatch the
		// unconsumed code through the continuation (states must consume or
		// synchronously redispatch — returning `ok` bare starves the machine).
		function done(code: number | null): State | undefined {
			return ok(code);
		}

		// Not math: the `$` is currency — emit it as literal text so inline
		// syntax after it (`**`, `_`, another `$`) still parses normally.
		function literal(code: number | null): State | undefined {
			effects.enter("data");
			effects.consume(code);
			effects.exit("data");
			return ok;
		}

		function tokenizeMath(effects: Effects, ok: State, nok: State): State {
			let sizeOpen = 0;
			let size = 0;
			let token: Token | undefined;
			let previous = -1;
			let numericStart = false;
			let numericWhitespace = false;
			let numericMathSyntax = false;
			return start;

			function start(code: number | null): State | undefined {
				effects.enter("mathText");
				effects.enter("mathTextSequence");
				return sequenceOpen(code);
			}

			function sequenceOpen(code: number | null): State | undefined {
				if (code === codes.dollarSign) {
					effects.consume(code);
					sizeOpen++;
					return sequenceOpen;
				}
				effects.exit("mathTextSequence");
				previous = codes.dollarSign;
				return first(code);
			}

			function first(code: number | null): State | undefined {
				if (sizeOpen === 1) {
					if (!single || code === null || markdownLineEndingOrSpace(code)) return nok(code);
					numericStart = code >= codes.digit0 && code <= codes.digit9;
				} else if (code === null) {
					return nok(code);
				}
				return between(code);
			}

			function between(code: number | null): State | undefined {
				if (code === null) return nok(code);
				if (markdownLineEnding(code)) {
					// Inline math cannot span a paragraph break (\r\n is one ending).
					if (markdownLineEnding(previous) && !(previous === 13 && code === 10)) return nok(code);
					if (numericStart) numericWhitespace = true;
					effects.enter("mathTextData");
					effects.consume(code);
					effects.exit("mathTextData");
					previous = code;
					return between;
				}
				if (code === codes.dollarSign) {
					token = effects.enter("mathTextSequence");
					size = 0;
					return sequenceClose(code);
				}
				effects.enter("mathTextData");
				return data(code);
			}

			function data(code: number | null): State | undefined {
				if (code === null || code === codes.dollarSign || markdownLineEnding(code)) {
					effects.exit("mathTextData");
					return between(code);
				}
				if (numericStart) {
					if (markdownLineEndingOrSpace(code)) numericWhitespace = true;
					else if (
						code === codes.backslash ||
						code === codes.caret ||
						code === codes.underscore ||
						code === codes.plusSign ||
						code === codes.dash ||
						code === codes.asterisk ||
						code === codes.slash ||
						code === codes.equalsTo ||
						code === codes.lessThan ||
						code === codes.greaterThan
					) {
						numericMathSyntax = true;
					}
				}
				previous = code;
				effects.consume(code);
				return data;
			}

			function sequenceClose(code: number | null): State | undefined {
				if (code === codes.dollarSign) {
					effects.consume(code);
					size++;
					return sequenceClose;
				}
				if (
					size === sizeOpen &&
					(sizeOpen !== 1 || !markdownLineEndingOrSpace(previous)) &&
					(!numericStart || !numericWhitespace || numericMathSyntax) &&
					(sizeOpen !== 1 || code === null || code < codes.digit0 || code > codes.digit9)
				) {
					effects.exit("mathTextSequence");
					effects.exit("mathText");
					return ok(code);
				}
				// A rejected digit-led span is a price, not the start of a later
				// equation. Rewind now so the next dollar gets its own attempt.
				if (numericStart && size === sizeOpen) return nok(code);
				// Rejected close — the `$` run is content, keep scanning.
				if (token) token.type = "mathTextData";
				previous = codes.dollarSign;
				return data(code);
			}
		}

		return start;
	};
}
