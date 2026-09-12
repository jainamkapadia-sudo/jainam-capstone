# jainam-capstone

**Author:** Jainam

## What Aegis Is

Aegis is a mobile-style health companion app for scanning, understanding, and managing medications. A user points their phone camera at a medicine strip or a prescription; the app auto-detects when it's properly framed, captures it, and sends it to Google's Gemini vision model to extract structured data — medicine name, dosage, form, manufacturer, category, purpose, frequency, duration, food timing, side effects, and medicine-specific disclaimers. The user reviews and corrects the extracted data before confirming it. From there, Aegis can cross-check scanned strips against a prescription, build a daily medication schedule, send WhatsApp reminders, and let the user consult an AI health assistant for medication and general health questions.

## MVP Scope

Features already implemented and working:

- **Camera auto-scan (medicine strip)** — detects when a strip is aligned and held steady in frame, then auto-captures and sends it to Gemini for identification.
- **Camera auto-scan (prescription)** — same auto-detect mechanism; extracts every medicine with frequency (e.g. `1-0-1`), duration, food timing, and instructions from handwritten or printed prescriptions.
- **Manual capture + gallery upload** as a fallback for both scan modes.
- **Review & edit screen** before confirming extracted data — editable core fields, a read-only info summary (category, purpose, side effects), and an AI-generated disclaimers card.
- **Strip-to-prescription matching** — flags medicines that are missing, extra, or mismatched.
- **AI-generated daily medication schedule** builder.
- **WhatsApp medication reminders** via Twilio + `node-cron`, served by a small Node.js backend (`server.js`).
- **AI health consult chat** (Gemini-powered) for medication and health questions, with safety framing (defers to real doctors, escalates emergencies).
- A local Node server serving the static app plus a small REST API for scheduling.

## Final Goals

Broader vision beyond the current prototype:

- Multi-user/family profile support (the chat screen already stubs a "Me / Mom / Dad / Max" profile switcher) with per-person medication history.
- Persistent, structured medication history and adherence tracking — today reminders are just a flat JSON file with no real database or authentication.
- Real drug-interaction and allergy-checking against a verified medical database, rather than relying solely on the LLM's general medical knowledge.
- Sharing scan/schedule data directly with a doctor or pharmacist.
- A native mobile build (Expo is already a listed dependency) instead of today's single-page browser prototype, with push notifications.
- Multi-language OCR/support for non-English prescriptions and strips.

## Target AI-Involvement Level

**Level: High — AI is core to the product, not a bolt-on feature.**

Reasoning:
- The entire value proposition of Aegis — turning a photo of a prescription or medicine strip into structured, actionable data — only works because a multimodal LLM (Gemini) is doing the vision-based extraction. There is no rule-based OCR fallback; without the model, the core feature doesn't exist.
- Of the app's main features (strip scan, prescription scan, strip/prescription matching, schedule generation, health chat), all but the reminder-delivery plumbing (cron scheduling + WhatsApp send) are directly powered by LLM calls.
- The intent of this project is to practice building a real product *around* an LLM's capabilities — prompt design for structured JSON extraction, multimodal image input, and safety framing for a health-adjacent chat assistant — rather than adding AI as a peripheral feature to an otherwise conventional app.
