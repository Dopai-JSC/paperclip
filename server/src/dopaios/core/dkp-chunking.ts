export type MarkdownChunk = {
  ordinal: number;
  charStart: number;
  charEnd: number;
  content: string;
};

export const KC08_STRUCTURED_MARKDOWN_INDEX_VERSION = "kc08-structured-markdown-v1";

export function structuredMarkdownChunks(content: string): MarkdownChunk[] {
  const headingStarts = [...content.matchAll(/^#{1,6}[ \t]+\S.*$/gmu)].map(
    (match) => match.index ?? 0,
  );
  const starts = headingStarts[0] === 0 ? headingStarts : [0, ...headingStarts];
  if (starts.length === 0) starts.push(0);
  const chunks: MarkdownChunk[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const sectionStart = starts[index] ?? 0;
    const sectionEnd = starts[index + 1] ?? content.length;
    const raw = content.slice(sectionStart, sectionEnd);
    const leadingWhitespace = raw.search(/\S/u);
    if (leadingWhitespace < 0) continue;
    const trimmedEnd = raw.trimEnd().length;
    const charStart = sectionStart + leadingWhitespace;
    const charEnd = sectionStart + trimmedEnd;
    chunks.push({
      ordinal: chunks.length,
      charStart,
      charEnd,
      content: content.slice(charStart, charEnd),
    });
  }
  return chunks;
}
