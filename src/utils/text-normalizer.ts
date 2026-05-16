export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .split("")
    .map((char) => {
      const code = char.charCodeAt(0);
      if (
        (code >= 0 && code <= 8) ||
        code === 11 ||
        code === 12 ||
        (code >= 14 && code <= 31) ||
        code === 127
      ) {
        return " ";
      }
      return char;
    })
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
