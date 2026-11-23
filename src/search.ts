export type LineMatcher = (line: string) => boolean;

export function createMatcher(query: string, regex: boolean): LineMatcher {
  if (regex) {
    const pattern = new RegExp(query, "i");
    return (line) => pattern.test(line);
  }
  const needle = query.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}

export function excerptMatches(content: string, matches: LineMatcher, contextLines: number): string {
  const lines = content.split("\n");
  const hitIndexes = lines.flatMap((line, index) => (matches(line) ? [index] : []));
  const hits = new Set(hitIndexes);

  const output: string[] = [];
  let lastPrinted = -1;
  for (const hit of hitIndexes) {
    const start = Math.max(hit - contextLines, lastPrinted + 1);
    const end = Math.min(hit + contextLines, lines.length - 1);
    if (lastPrinted >= 0 && start > lastPrinted + 1) output.push("--");
    for (let index = start; index <= end; index++) {
      output.push(`${index + 1}${hits.has(index) ? ":" : "-"}${lines[index]}`);
    }
    lastPrinted = Math.max(lastPrinted, end);
  }
  return output.join("\n");
}
