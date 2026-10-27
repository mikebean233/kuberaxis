import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** A single run of text on a page, positioned in PDF user-space units (origin bottom-left). */
export interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
}

/** Text items that share a baseline, sorted left to right. */
export interface TextLine {
  /** 1-based physical page number. */
  page: number;
  y: number;
  items: TextItem[];
}

export interface PdfPage {
  page: number;
  lines: TextLine[];
}

/** Items whose baselines are within this many units are treated as the same line. */
const LINE_TOLERANCE = 2;

export async function extractPages(data: Uint8Array): Promise<PdfPage[]> {
  // pdf.js takes ownership of (and detaches) the buffer it is given, so pass a copy.
  const loadingTask = getDocument({ data: new Uint8Array(data), useSystemFonts: true });
  const doc = await loadingTask.promise;

  try {
    const pages: PdfPage[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const items: TextItem[] = [];
      for (const raw of content.items) {
        if (!("str" in raw)) continue;
        const str = raw.str.trim();
        if (!str) continue;
        items.push({ str, x: raw.transform[4], y: raw.transform[5], width: raw.width });
      }
      pages.push({ page: pageNumber, lines: groupIntoLines(pageNumber, items) });
    }
    return pages;
  } finally {
    await loadingTask.destroy();
  }
}

function groupIntoLines(page: number, items: TextItem[]): TextLine[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: TextLine[] = [];
  for (const item of sorted) {
    const current = lines[lines.length - 1];
    if (current && Math.abs(current.y - item.y) <= LINE_TOLERANCE) {
      current.items.push(item);
    } else {
      lines.push({ page, y: item.y, items: [item] });
    }
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

export function lineText(line: TextLine): string {
  return line.items.map((i) => i.str).join(" ");
}
