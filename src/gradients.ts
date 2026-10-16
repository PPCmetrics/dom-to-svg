/* eslint-disable id-length */
import * as gradientParser from 'gradient-parser'

import { svgNamespace } from './dom.js'
import { TraversalContext } from './traversal.js'

type Size = Pick<DOMRectReadOnly, 'width' | 'height'>

const degreesPerUnit: Record<gradientParser.AngleUnit, number> = {
	deg: 1,
	rad: 180 / Math.PI,
	grad: 0.9,
	turn: 360,
}

const positionsForOrientation = (
	orientation: gradientParser.LinearOrientation | undefined
): Record<'x1' | 'x2' | 'y1' | 'y2', string> => {
	const positions = {
		x1: '0%',
		x2: '0%',
		y1: '0%',
		y2: '0%',
	}

	if (orientation?.type === 'angular') {
		const anglePI = Number(orientation.value) * degreesPerUnit[orientation.unit] * (Math.PI / 180)
		positions.x1 = `${Math.round(50 + Math.sin(anglePI + Math.PI) * 50)}%`
		positions.y1 = `${Math.round(50 + Math.cos(anglePI) * 50)}%`
		positions.x2 = `${Math.round(50 + Math.sin(anglePI) * 50)}%`
		positions.y2 = `${Math.round(50 + Math.cos(anglePI + Math.PI) * 50)}%`
	} else if (orientation?.type === 'directional') {
		switch (orientation.value) {
			case 'left':
				positions.x1 = '100%'
				break

			case 'top':
				positions.y1 = '100%'
				break

			case 'right':
				positions.x2 = '100%'
				break

			case 'bottom':
				positions.y2 = '100%'
				break
		}
	}

	return positions
}

/** Length of the CSS gradient line, which is what stop percentages and px values are relative to. */
function getGradientLineLength(
	orientation: gradientParser.LinearOrientation | undefined,
	{ width, height }: Size
): number {
	if (orientation?.type === 'angular') {
		const anglePI = Number(orientation.value) * degreesPerUnit[orientation.unit] * (Math.PI / 180)
		return Math.abs(width * Math.sin(anglePI)) + Math.abs(height * Math.cos(anglePI))
	}
	if (orientation?.type === 'directional') {
		const sides = orientation.value.split(' ')
		if (sides.length === 2) {
			// Corner: the gradient line is perpendicular to the diagonal through the two other corners
			return (2 * width * height) / Math.hypot(width, height)
		}
		if (sides[0] === 'left' || sides[0] === 'right') {
			return width
		}
	}
	return height
}

const calcTerm = String.raw`(?:\d*\.\d+|\d+\.?)(?:%|px)`
const calcSum = new RegExp(String.raw`^\s*[+-]?\s*${calcTerm}(?:\s*[+-]\s*${calcTerm})*\s*$`)

/** Resolves a sum of `%` and `px` terms (e.g. `56.42% - 0.5px`) to px, or undefined for anything else. */
function evaluateCalc(expression: string, lineLength: number): number | undefined {
	if (!calcSum.test(expression)) {
		return undefined
	}
	let total = 0
	const termPattern = /([+-]?)\s*(\d*\.\d+|\d+\.?)(%|px)/g
	let term: RegExpExecArray | null
	while ((term = termPattern.exec(expression))) {
		const [, sign, number, unit] = term
		const value = Number(number) * (unit === '%' ? lineLength / 100 : 1)
		total += sign === '-' ? -value : value
	}
	return total
}

/** Returns the SVG stop offset for a stop position, or undefined if it can't be resolved (e.g. `em`). */
function getStopOffset(length: gradientParser.LengthNode | undefined, lineLength: number): string | undefined {
	if (length?.type === '%') {
		return `${length.value}%`
	}
	if (lineLength <= 0) {
		return undefined
	}
	let pixels: number | undefined
	if (length?.type === 'px') {
		pixels = Number(length.value)
	} else if (length?.type === 'calc') {
		pixels = evaluateCalc(length.value, lineLength)
	}
	return pixels === undefined ? undefined : `${Number(((pixels / lineLength) * 100).toFixed(4))}%`
}

export function convertLinearGradient(
	css: string,
	{ svgDocument }: Pick<TraversalContext, 'svgDocument'>,
	size: Size
): SVGLinearGradientElement {
	const { orientation, colorStops } = gradientParser.parse(css)[0] as gradientParser.LinearGradientNode
	const { x1, x2, y1, y2 } = positionsForOrientation(orientation)
	const lineLength = getGradientLineLength(orientation, size)

	const getColorStops = (colorStop: gradientParser.ColorStop, index: number): SVGStopElement => {
		const offset = getStopOffset(colorStop.length, lineLength) ?? `${(index / (colorStops.length - 1)) * 100}%`
		let stopColor = 'rgb(0,0,0)'
		let stopOpacity = 1

		switch (colorStop.type) {
			case 'rgb': {
				stopColor = `rgb(${colorStop.value.join(',')})`
				break
			}

			case 'rgba': {
				stopColor = `rgb(${colorStop.value.slice(0, 3).join(',')})`
				stopOpacity = Number(colorStop.value[3])
				break
			}

			case 'hex': {
				stopColor = `#${colorStop.value}`
				break
			}

			case 'literal': {
				stopColor = colorStop.value
				break
			}
		}

		const stop = svgDocument.createElementNS(svgNamespace, 'stop')
		stop.setAttribute('offset', offset)
		stop.setAttribute('stop-color', stopColor)
		stop.setAttribute('stop-opacity', stopOpacity.toString())
		return stop
	}

	const linearGradient = svgDocument.createElementNS(svgNamespace, 'linearGradient')
	linearGradient.setAttribute('x1', x1)
	linearGradient.setAttribute('y1', y1)
	linearGradient.setAttribute('x2', x2)
	linearGradient.setAttribute('y2', y2)
	linearGradient.append(...colorStops.map(getColorStops))

	return linearGradient
}
