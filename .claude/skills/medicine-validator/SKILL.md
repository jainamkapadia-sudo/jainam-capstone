---
name: medicine-validator
description: Validates a scanned medicine/prescription JSON (Aegis's Gemini extraction schema — medications[] with name/dosage/frequency/duration/withFood) against a bundled reference drug dataset, flagging unknown medicines, out-of-range dosages, and unsafe frequencies with a severity level. Use before a scanned prescription is shown to the user or turned into a schedule.
---

# Medicine Validator

Validates a single scanned medicine/prescription payload against `reference-drugs.json`,
bundled in this skill's folder, before Aegis shows it to a user or turns it into a
medication schedule.

## Input shape

A JSON object matching Aegis's prescription-scan output (see `processPrescription()`
in `aegis-preview.html`):

```json
{
  "medications": [
    {
      "name": "Metformin",
      "type": "tablet",
      "category": "antidiabetic",
      "purpose": "Blood sugar control",
      "dosage": "500mg",
      "frequency": "1-0-1",
      "duration": "30 days",
      "withFood": true,
      "instructions": "Take with breakfast and dinner",
      "sideEffects": ["Nausea", "Diarrhea"]
    }
  ],
  "alerts": [],
  "rawText": "...",
  "doctorName": "...",
  "patientName": "..."
}
```

`frequency` uses Aegis's slot notation: each `1` is one dose in that daily slot
(morning-afternoon-evening[-night]), so `1-0-1` = 2 doses/day, `1-1-1-1` = 4 doses/day.

## Steps

1. Load `reference-drugs.json` (in this same skill folder) — a list of known medicines,
   each with `name`, `class`, `dosageRangeMg` (`{min, max}` per dose), and
   `maxFrequencyPerDay`.
2. For every entry in `medications[]`:
   - **Unknown medicine** — if the name doesn't match any reference entry
     (case-insensitive; treat obvious brand/generic spelling variants as a match, but
     do not guess wildly), flag `severity: "medium"`, `type: "unknown_medicine"`.
   - **Dosage out of range** — parse the numeric mg value out of `dosage`. If it falls
     outside that medicine's `dosageRangeMg`, flag `severity: "high"`,
     `type: "dosage_out_of_range"`.
   - **Frequency exceeded** — parse the number of daily doses out of `frequency`
     (count the `1`s in the slot notation). If it exceeds `maxFrequencyPerDay`, flag
     `severity: "high"`, `type: "frequency_exceeded"`.
   - A medicine with none of the above is clean — do not add a flag for it.
3. Compute `overallSeverity`: `"high"` if any flag is high, else `"medium"` if any flag
   is medium, else `"none"`.
4. Return exactly one JSON object (no markdown fences, no commentary outside it):

```json
{
  "flags": [
    { "medicine": "Amoxicillin", "type": "dosage_out_of_range", "severity": "high",
      "detail": "3000mg is far above the typical 250-1000mg range" }
  ],
  "overallSeverity": "high",
  "summary": "One or two plain-English sentences describing the most important issue(s)."
}
```

## Rules

- Only flag genuine mismatches against the reference data — not stylistic naming
  differences, capitalization, or brand-vs-generic naming when the match is clear.
- If `medications` is empty or missing, return
  `{"flags": [], "overallSeverity": "none", "summary": "No medications to validate."}`.
- Never invent a reference entry that isn't in `reference-drugs.json` — an unmatched
  medicine is always `unknown_medicine`, not a guessed dosage range.
