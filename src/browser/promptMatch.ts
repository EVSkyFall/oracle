/**
 * Normalizes prompt and turn text to find a sent prompt on the page: lower case, Markdown fence
 * and inline-code markers removed (ChatGPT renders them differently), whitespace collapsed. The
 * commit check runs it in the page through toString(), so it stays free of imports and closures.
 */
export function normalizePromptText(value: unknown): string {
  let text = typeof value === "string" ? value.toLowerCase() : "";
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, " $1 ");
  text = text.replace(/```/g, " ");
  text = text.replace(/`([^`]*)`/g, "$1");
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Whether `text` shows the prompt, as the commit check decides it: the whole normalized prompt,
 * or its first 120 characters when those are more than 30 (ChatGPT can fold a long message).
 */
export function promptAppearsInText(prompt: string, text: unknown): boolean {
  const normalizedPrompt = normalizePromptText(prompt);
  if (!normalizedPrompt) return false;
  const normalizedText = normalizePromptText(text);
  const prefix = normalizedPrompt.slice(0, 120);
  return (
    normalizedText.includes(normalizedPrompt) ||
    (prefix.length > 30 && normalizedText.includes(prefix))
  );
}
