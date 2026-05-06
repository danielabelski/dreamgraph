export interface ClipLargeTextOutputOptions {
  maxChars?: number;
  previewHeadChars?: number;
  previewTailChars?: number;
  omissionMarkerPrefix?: string;
  notePrefix?: string;
  continuationGuidance?: string[];
}

const DEFAULT_MAX_OUTPUT_CHARS = 10000;
const DEFAULT_PREVIEW_HEAD_CHARS = 4500;
const DEFAULT_PREVIEW_TAIL_CHARS = 4500;

export function buildClippedOutputNotice(
  totalChars: number,
  displayedChars: number,
  options: ClipLargeTextOutputOptions = {}
): string {
  const notePrefix = options.notePrefix ?? "[DreamGraph note]";
  const continuationGuidance =
    options.continuationGuidance ?? [
      "Re-run with a narrower query, smaller range, or a more specific target.",
      "If supported, prefer entity-specific, filtered, or paged reads over full payloads.",
    ];

  return [
    "",
    `${notePrefix} Output clipped to ${displayedChars.toLocaleString()} of ${totalChars.toLocaleString()} chars to avoid transport truncation.`,
    ...continuationGuidance.map((line) => `${notePrefix} ${line}`),
  ].join("\n");
}

export function clipLargeTextOutput(
  content: string,
  options: ClipLargeTextOutputOptions = {}
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const previewHeadChars = options.previewHeadChars ?? DEFAULT_PREVIEW_HEAD_CHARS;
  const previewTailChars = options.previewTailChars ?? DEFAULT_PREVIEW_TAIL_CHARS;
  const omissionMarkerPrefix = options.omissionMarkerPrefix ?? "//";

  if (content.length <= maxChars) {
    return content;
  }

  const head = content.slice(0, previewHeadChars);
  const tail = content.slice(-previewTailChars);
  const omittedChars = content.length - (head.length + tail.length);
  const omissionMarker = [
    "",
    `${omissionMarkerPrefix} … ${omittedChars.toLocaleString()} chars omitted …`,
  ].join("\n");

  const clipped = `${head}${omissionMarker}\n${tail}`;
  return `${clipped}${buildClippedOutputNotice(content.length, clipped.length, options)}`;
}

export function formatJsonToolOutput(
  value: unknown,
  options: ClipLargeTextOutputOptions = {}
): string {
  return clipLargeTextOutput(JSON.stringify(value, null, 2), options);
}
