import type { CSSProperties } from 'react'

const DARK = '#0e1116'
const LIGHT = '#ffffff'

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

export function contrastRatio(first: string, second: string): number {
  const light = Math.max(luminance(first), luminance(second))
  const dark = Math.min(luminance(first), luminance(second))
  return (light + 0.05) / (dark + 0.05)
}

export function hookScoreStyle(score: number): CSSProperties {
  // Retain the existing score bands and backgrounds; choose the more legible text color.
  const backgroundColor = score >= 85 ? '#146c43' : score >= 70 ? '#80cf6f' :
    score >= 55 ? '#8a5b00' : '#b42318'
  const color = contrastRatio(backgroundColor, LIGHT) >= contrastRatio(backgroundColor, DARK)
    ? LIGHT : DARK
  return { backgroundColor, color }
}
