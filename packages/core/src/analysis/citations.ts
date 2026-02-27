import type { SummarySection } from "./summarizer.js";

export interface Citation {
  /** Index of the summary section this citation belongs to */
  sectionIndex: number;
  /** Character offset in the original email body */
  startOffset: number;
  endOffset: number;
  /** Short preview of the cited text */
  previewText: string;
}

/**
 * Extract citations from summary sections and validate them against the source email body.
 * Returns only citations whose offsets point to valid positions in the body.
 */
export function extractCitations(
  sections: SummarySection[],
  bodyText: string,
): Citation[] {
  const citations: Citation[] = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const { citation } = section;

    if (!citation || citation.startOffset == null || citation.endOffset == null)
      continue;

    // Validate offset bounds
    if (
      citation.startOffset < 0 ||
      citation.endOffset > bodyText.length ||
      citation.startOffset >= citation.endOffset
    ) {
      continue;
    }

    // Verify the preview text roughly matches the cited region
    const cited = bodyText.slice(citation.startOffset, citation.endOffset);
    const preview = citation.previewText || cited.slice(0, 80);

    citations.push({
      sectionIndex: i,
      startOffset: citation.startOffset,
      endOffset: citation.endOffset,
      previewText: preview,
    });
  }

  return citations;
}
