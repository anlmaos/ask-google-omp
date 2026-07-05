export const ENGLISH_ANSWER_INSTRUCTION =
  "Please answer in English. Do not use the browser UI language or account locale for the answer.";

const ENGLISH_REQUEST_PATTERN =
  /\b(?:answer|respond|reply|write|use)\s+(?:only\s+)?in\s+english\b|\bin\s+english\b/i;

export function toGoogleAiModeQuery(query: string): string {
  const trimmed = query.trim();
  if (ENGLISH_REQUEST_PATTERN.test(trimmed)) return trimmed;
  return `${trimmed}\n\n${ENGLISH_ANSWER_INSTRUCTION}`;
}
