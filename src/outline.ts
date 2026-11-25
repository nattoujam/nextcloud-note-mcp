export interface Heading {
  line: number;
  text: string;
}

const atxHeading = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const fenceOpening = /^ {0,3}(`{3,}|~{3,})/;

export function listHeadings(content: string): Heading[] {
  const headings: Heading[] = [];
  let fence: string | undefined;
  content.split("\n").forEach((text, index) => {
    const marker = fenceOpening.exec(text)?.[1];
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && text.trim() === marker) {
        fence = undefined;
      }
      return;
    }
    if (marker !== undefined) {
      fence = marker;
      return;
    }
    if (atxHeading.test(text)) headings.push({ line: index + 1, text: text.trim() });
  });
  return headings;
}
