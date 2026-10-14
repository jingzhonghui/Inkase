function slugifyHeading(text: string): string {
  return text
    .replace(/^\s*#{1,6}\s+/, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/[\s-]+/g, '-')
}

function decodeAnchor(anchor: string): string {
  try {
    return decodeURIComponent(anchor.replace(/^#/, ''))
  } catch {
    return anchor.replace(/^#/, '')
  }
}

export function findHeadingForAnchor(headings: HTMLElement[], anchor: string): HTMLElement | undefined {
  const target = decodeAnchor(anchor).toLowerCase()
  return headings.find((heading) => {
    const id = heading.id.toLowerCase()
    const slug = slugifyHeading(heading.textContent || '')
    return id === target || slug === target
  })
}
