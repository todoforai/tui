/**
 * Decode one input sequence into an approval answer, or null to keep waiting.
 *
 * Enter is the prompt's [Y] default, so it maps to "". Nothing else may:
 * callers read "" as approval, so mapping Ctrl+C/Ctrl+D/ESC there would make
 * an interrupt silently allow whatever was being asked about. They come back
 * as their raw char, which matches no choice and therefore denies.
 */
export function decodeSingleChar(seq: string): string | null {
  // Multi-char escapes (arrows, F-keys) are not answers.
  if (seq.length > 1 && seq.startsWith("\x1b")) return null;
  if (seq === "\r" || seq === "\n") return "";
  return seq[0].toLowerCase();
}
