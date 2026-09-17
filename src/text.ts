import { isVisible } from './css.js'
import { svgNamespace } from './dom.js'
import { TraversalContext } from './traversal.js'
import { doRectanglesIntersect, assert } from './util.js'

export function handleTextNode(textNode: Text, context: TraversalContext): void {
	if (!textNode.ownerDocument.defaultView) {
		throw new Error("Element's ownerDocument has no defaultView")
	}
	const window = textNode.ownerDocument.defaultView
	const parentElement = textNode.parentElement!
	const styles = window.getComputedStyle(parentElement)
	if (!isVisible(styles)) {
		return
	}

	const selection = window.getSelection()
	assert(
		selection,
		'Could not obtain selection from window. Selection is needed for detecting whitespace collapsing in text.'
	)

	const svgTextElement = context.svgDocument.createElementNS(svgNamespace, 'text')

	// Copy text styles
	// https://css-tricks.com/svg-properties-and-css
	copyTextStyles(styles, svgTextElement)

	const writingMode = styles.getPropertyValue('writing-mode')
	const isLTR = writingMode === 'vertical-lr'
	const isVertical =
		isLTR || writingMode === 'vertical-rl' || writingMode === 'sideways-rl' || writingMode === 'sideways-lr'
	// Degrees to manually rotate each glyph by when falling back to per-character positioning for
	// vertical text (see below) - that fallback stops relying on the writing-mode attribute, which
	// would otherwise apply this rotation automatically.
	const verticalGlyphRotationDegrees =
		styles.getPropertyValue('text-orientation') === 'upright'
			? 0
			: writingMode === 'sideways-lr'
			? -90
			: writingMode === 'sideways-rl'
			? 90
			: 90 // vertical-rl/vertical-lr default ("mixed") orientation rotates glyphs 90deg clockwise

	const tabSize = parseInt(styles.tabSize, 10)

	// Make sure the y attribute is the bottom of the box, not the baseline
	svgTextElement.setAttribute('dominant-baseline', 'text-after-edge')

	const lineRange = textNode.ownerDocument.createRange()
	lineRange.setStart(textNode, 0)
	lineRange.setEnd(textNode, 0)
	const characterRange = textNode.ownerDocument.createRange()
	while (true) {
		const addTextSpanForLineRange = (): void => {
			if (lineRange.collapsed) {
				return
			}
			const lineRectangle = lineRange.getClientRects()[0]!
			if (!doRectanglesIntersect(lineRectangle, context.options.captureArea)) {
				return
			}
			const textSpan = context.svgDocument.createElementNS(svgNamespace, 'tspan')
			textSpan.setAttribute('xml:space', 'preserve')

			// lineRange.toString() returns the text including whitespace.
			// by adding the range to a Selection, then getting the text from that selection,
			// we can let the DOM handle whitespace collapsing the same way as innerText (but for a Range).
			// For this to work, the parent element must not forbid user selection.
			const previousUserSelect = parentElement.style.userSelect
			parentElement.style.userSelect = 'all'
			let collapsedText: string
			try {
				selection.removeAllRanges()
				selection.addRange(lineRange)
				collapsedText = selection.toString()
			} finally {
				parentElement.style.userSelect = previousUserSelect
				selection.removeAllRanges()
			}
			// SVG does not support tabs in text. Tabs get rendered as one space character. Convert the
			// tabs to spaces according to tab-size instead.
			// Ideally we would keep the tab and create offset tspans.
			textSpan.textContent = collapsedText.replace(/\t/g, ' '.repeat(tabSize))

			const useMirroredTransform = styles.getPropertyValue('transform') === 'matrix(-1, 0, 0, -1, 0, 0)' && isLTR
			// Per-character positions (x for horizontal text, y for vertical text) make the rendered text
			// robust against consumers (e.g. Inkscape's EMF export) that don't support
			// textLength/lengthAdjust="spacingAndGlyphs" or the SVG writing-mode attribute, and would
			// otherwise draw every character on top of the others or at the substituted font's natural
			// width/height.
			const characterRects = !useMirroredTransform
				? getCharacterRects(characterRange, textNode, lineRange, collapsedText, tabSize)
				: undefined
			const hasCharacterRects = !!characterRects && characterRects.length > 0
			if (useMirroredTransform) {
				textSpan.setAttribute('x', (-1 * (lineRectangle.x + lineRectangle.width)).toString())
				textSpan.setAttribute('y', (-1 * (lineRectangle.top + lineRectangle.height)).toString())
			} else if (isVertical) {
				// Rotating a glyph via the SVG `rotate` attribute pivots it around its given (x, y) point
				// rather than re-centering it, so a counter-clockwise rotation (negative degrees) swings the
				// glyph's body out to the left of that point instead of to the right. Anchor to the far
				// (right) edge of the line in that case so the rotated glyph body lands back inside the
				// original line's bounds instead of poking out past its left edge.
				const verticalPivotX =
					verticalGlyphRotationDegrees < 0 ? lineRectangle.x + lineRectangle.width : lineRectangle.x
				// Repeat the (fixed) column x for every character so the x/y lists are the same length -
				// some SVG consumers mishandle a shorter x list by falling back to auto-advance for the
				// remaining characters instead of per the spec (reusing the last explicit value).
				textSpan.setAttribute(
					'x',
					hasCharacterRects ? characterRects!.map(() => verticalPivotX).join(' ') : lineRectangle.x.toString()
				)
				textSpan.setAttribute(
					'y',
					hasCharacterRects
						? characterRects!.map(rectangle => rectangle.bottom).join(' ')
						: (isLTR ? lineRectangle.top : lineRectangle.bottom).toString() // intentionally bottom because of dominant-baseline setting
				)
				if (hasCharacterRects) {
					// Placing each glyph at an explicit (x, y) takes over layout from the writing-mode
					// attribute entirely for consumers that don't auto-rotate glyphs once per-character
					// positions are given (e.g. Inkscape's EMF export leaves them upright) - so the rotation
					// writing-mode would normally apply automatically has to be done manually here instead.
					svgTextElement.setAttribute('writing-mode', 'horizontal-tb')
					textSpan.setAttribute(
						'rotate',
						characterRects!.map(() => verticalGlyphRotationDegrees.toString()).join(' ')
					)
				}
			} else {
				textSpan.setAttribute(
					'x',
					hasCharacterRects
						? characterRects!.map(rectangle => rectangle.x).join(' ')
						: lineRectangle.x.toString()
				)
				textSpan.setAttribute('y', lineRectangle.bottom.toString()) // intentionally bottom because of dominant-baseline setting
			}
			// textLength/lengthAdjust="spacingAndGlyphs" is only needed as a fallback for consumers that
			// don't support per-character positions. Setting both at once causes some renderers (e.g.
			// Chromium) to double-apply glyph scaling, squishing the text into an illegible blob.
			if (!hasCharacterRects) {
				textSpan.setAttribute(
					'textLength',
					isVertical ? lineRectangle.height.toString() : lineRectangle.width.toString()
				)
				textSpan.setAttribute('lengthAdjust', 'spacingAndGlyphs')
			}
			svgTextElement.append(textSpan)
		}
		try {
			lineRange.setEnd(textNode, lineRange.endOffset + 1)
		} catch (error) {
			if (error instanceof DOMException && error.code === DOMException.INDEX_SIZE_ERR) {
				// Reached the end
				addTextSpanForLineRange()
				break
			}
			if (!(error instanceof Error)) {
				throw new TypeError(String(error))
			}
			throw error
		}
		// getClientRects() returns one rectangle for each line of a text node.
		const lineRectangles = lineRange.getClientRects()
		// If no lines
		if (!lineRectangles[0]) {
			// Pure whitespace text nodes are collapsed and not rendered.
			return
		}
		// If two (unique) lines
		// For some reason, Chrome returns 2 identical DOMRects for text with text-overflow: ellipsis.
		if (lineRectangles[1] && lineRectangles[0].top !== lineRectangles[1].top) {
			// Crossed a line break.
			// Go back one character to select exactly the previous line.
			lineRange.setEnd(textNode, lineRange.endOffset - 1)
			// Add <tspan> for exactly that line
			addTextSpanForLineRange()
			// Start on the next line.
			lineRange.setStart(textNode, lineRange.endOffset)
		}
	}

	context.currentSvgParent.append(svgTextElement)
}

/**
 * Computes the client rectangle of each character of `collapsedText` (the whitespace-collapsed
 * text that will actually be rendered), by aligning it against the raw (uncollapsed) text of
 * `lineRange` and measuring each aligned character's position individually.
 * Returns `undefined` if the alignment is not reliable (falls back to a single position for the line).
 */
function getCharacterRects(
	characterRange: Range,
	textNode: Text,
	lineRange: Range,
	collapsedText: string,
	tabSize: number
): DOMRect[] | undefined {
	const rawText = textNode.data.slice(lineRange.startOffset, lineRange.endOffset)

	// Align each character of collapsedText to the index of the same character in rawText.
	// Whitespace collapsing only ever removes characters, it never reorders or replaces them,
	// so a simple greedy left-to-right scan is sufficient.
	const rawIndices: number[] = []
	let rawIndex = 0
	for (const character of collapsedText) {
		while (rawIndex < rawText.length && rawText[rawIndex] !== character) {
			rawIndex++
		}
		if (rawIndex >= rawText.length) {
			// Alignment failed, e.g. because of a character substitution we didn't anticipate.
			return undefined
		}
		rawIndices.push(rawIndex)
		rawIndex++
	}

	const rectangles: DOMRect[] = []
	for (const index of rawIndices) {
		characterRange.setStart(textNode, lineRange.startOffset + index)
		characterRange.setEnd(textNode, lineRange.startOffset + index + 1)
		const rectangle = characterRange.getClientRects()[0]
		if (!rectangle) {
			return undefined
		}
		if (rawText[index] === '\t') {
			// Tabs are expanded into `tabSize` spaces in the output text, all placed at the tab's position.
			for (let tabStop = 0; tabStop < tabSize; tabStop++) {
				rectangles.push(rectangle)
			}
		} else {
			rectangles.push(rectangle)
		}
	}
	return rectangles
}

export const textAttributes = new Set([
	'color',
	'dominant-baseline',
	'font-family',
	'font-size',
	'font-size-adjust',
	'font-stretch',
	'font-style',
	'font-variant',
	'font-weight',
	'direction',
	'letter-spacing',
	'text-decoration',
	'text-anchor',
	'text-decoration',
	'text-rendering',
	'unicode-bidi',
	'word-spacing',
	'writing-mode',
	'user-select',
] as const)
export function copyTextStyles(styles: CSSStyleDeclaration, svgElement: SVGElement): void {
	for (const textProperty of textAttributes) {
		const value = styles.getPropertyValue(textProperty)
		if (value) {
			svgElement.setAttribute(textProperty, value)
		}
	}
	// tspan uses fill, CSS uses color
	svgElement.setAttribute('fill', styles.color)
}
