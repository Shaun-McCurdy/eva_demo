/**
 * Display-only corrections applied to transcript text.
 *
 * The system prompt spells the company name phonetically so the model *says*
 * it correctly over voice. That spelling then leaks into the transcription,
 * where it is simply wrong: the visitor reads "Enj house" on screen. Fixing it
 * in the prompt would break the pronunciation, so it is fixed here instead,
 * after the model and before the page.
 *
 * This changes nothing about what is spoken, sent upstream, or stored -- only
 * what is rendered.
 */

/**
 * Matches the phonetic spellings the prompt can produce: "Enj house",
 * "Enj-house", "ENJ-HOUSE", "Enjhouse".
 *
 * No trailing word boundary on purpose, so compounds and plurals come out
 * right too: "EnjhouseAI" -> "EnghouseAI", "Enj houses" -> "Enghouses". The
 * leading \b is what keeps it from matching inside an unrelated word.
 *
 * Always replaced with the canonical capitalisation rather than preserving
 * whatever case arrived -- it is a proper noun with exactly one correct form.
 */
const MISSPELLINGS = [[/\bEnj[\s -]?house/gi, "Enghouse"]];

/**
 * Correct transcript text for display.
 *
 * Call this on the *accumulated* turn, never on a single streamed chunk:
 * transcription arrives a few fragments a second and a name routinely straddles
 * a boundary, so "...En" + "j house..." would slip past a per-chunk filter.
 */
export function correctTranscript(text) {
  if (!text) return text;
  let corrected = text;
  for (const [pattern, replacement] of MISSPELLINGS) {
    corrected = corrected.replace(pattern, replacement);
  }
  return corrected;
}
