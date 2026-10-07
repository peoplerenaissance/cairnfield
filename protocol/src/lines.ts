// How a file's bytes divide into lines. Validation and the diff share this, so a
// finding's line numbers and a patch's changed lines mean the same thing.
//
// A line runs through its line feed. A last line with no line feed is still a line.
// Every byte is then in exactly one line, and a carriage return is ordinary content.

const LINE_FEED = 10;

/** The offset at which each line starts. */
export function lineStarts(content: Uint8Array): number[] {
  const starts: number[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === LINE_FEED) {
      starts.push(start);
      start = i + 1;
    }
  }
  if (start < content.length) starts.push(start);
  return starts;
}

export function countLines(content: Uint8Array): number {
  return lineStarts(content).length;
}

/** Each line as a view into the content. */
export function splitLines(content: Uint8Array): Uint8Array[] {
  const starts = lineStarts(content);
  return starts.map((start, i) => content.subarray(start, starts[i + 1] ?? content.length));
}

/**
 * The bytes of lines `start` to `end`. Lines count from 1 and the range includes both ends.
 * Returns nothing when the range is not within the file.
 */
export function linesOf(content: Uint8Array, start: number, end: number): Uint8Array | undefined {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return undefined;
  const starts = lineStarts(content);
  if (end > starts.length) return undefined;
  return content.subarray(starts[start - 1], starts[end] ?? content.length);
}
