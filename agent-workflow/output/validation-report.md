# Medicine Validation Report

**Overall Severity:** HIGH

## Summary

Amoxicillin is dosed at 3000mg, far exceeding its safe 250-1000mg range, and Ibuprofen is scheduled for 5 doses/day versus a max of 4; Zorbitol X is also an unrecognized medicine that could not be validated.

## Flags

- **Amoxicillin** — Type: `dosage_out_of_range` — Severity: **high**
  Detail: 3000mg per dose is far above the typical 250-1000mg range for Amoxicillin

- **Zorbitol X** — Type: `unknown_medicine` — Severity: **medium**
  Detail: Zorbitol X does not match any entry in the reference drug data

- **Ibuprofen** — Type: `frequency_exceeded` — Severity: **high**
  Detail: Frequency 1-1-1-1-1 equals 5 doses/day, exceeding the maximum of 4 per day for Ibuprofen
