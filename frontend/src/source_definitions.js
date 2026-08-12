import { DATA_EDITORIAL } from "./data_editorial";

// Reverse index: source_key -> a short, popover-sized "what is this data"
// string, derived from data_editorial.json's per-card `origin` field. Built
// once at module load (DATA_EDITORIAL is static), not per-render.
//
// `origin` itself is written for the Data tab's full-width SourceCard and
// often runs several hundred characters — too long for a compact hover
// popover (chart_staleness.jsx's ChartStaleness). Rather than maintain a
// second, separately-authored short-description field that could drift
// from `origin`, this takes origin's own first sentence (every entry
// checked opens with a clear "here's the real source" statement before
// elaborating) and hard-caps it as a safety net for the handful of entries
// whose first sentence still runs long.
const MAX_DEFINITION_LEN = 140;

function shortDefinition(origin) {
  if (!origin) return null;
  const firstSentence = origin.split(/(?<=\.)\s/)[0];
  if (firstSentence.length <= MAX_DEFINITION_LEN) return firstSentence;
  return firstSentence.slice(0, MAX_DEFINITION_LEN - 1).trimEnd() + "…";
}

export const SOURCE_DEFINITIONS = {};
for (const card of DATA_EDITORIAL) {
  const def = shortDefinition(card.origin);
  for (const key of card.sourceKeys ?? []) {
    SOURCE_DEFINITIONS[key] = { label: card.label, definition: def };
  }
}
