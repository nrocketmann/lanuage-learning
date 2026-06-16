# Language Learning Voice App Plan

## Product Shape

Build a local-first, open-source web app for language practice over voice. The first target language is Japanese, but the data model and prompts should support other languages.

The core loop is:

1. The user starts a voice session.
2. The app runs a short vocab quiz before open conversation.
3. The user has a natural spoken conversation with an LLM conversation partner.
4. The voice agent marks interesting vocab events during the conversation.
5. After the conversation ends, an offline LLM job reconciles those events with the transcript and updates the local word-sense database.
6. Future quizzes are generated from that evolving word-sense database.

V1 is intentionally vocab-only. Grammar concepts, grammar production drills, and automatic grammar gap analysis are deferred to V2.

## Product Principles

- Conversation first, studying second. The app should feel like a speaking partner that happens to remember what the learner needs.
- Local-first by default. Conversation history, transcripts, word senses, and SRS state live on the user's machine.
- Mobile-friendly. The user can practice from a phone while commuting by connecting to their own always-on backend through Tailscale.
- Bring your own OpenAI API key. The project should be useful without creating a hosted paid service.
- Friendly SRS. Words retire after enough positive evidence, and misses pull them back into practice without feeling punitive.
- Context-rich vocab. Store word senses, not bare words. Never quiz ambiguous prompts like "What does kakeru mean?" without context.

## Billing Reality

Using an OpenAI API key means usage is charged through the OpenAI API platform, not through a ChatGPT consumer subscription. ChatGPT Plus/Pro/etc. does not include API usage. As of June 16, 2026, there is no supported way for a standalone app like this to "route through" a user's ChatGPT subscription.

There are two adjacent options, but neither gives us the full product:

- Build something inside ChatGPT, such as a ChatGPT App/GPT-style experience. This might benefit from the ChatGPT surface, but it would not be our standalone mobile voice app with our own local database, Tailscale deployment, custom SRS screens, transcripts, and product control.
- Keep using ChatGPT manually. This preserves subscription economics, but loses the automatic word-sense database, offline reconciliation, custom SRS, and controlled conversation-partner UX.

This matters because realtime voice can become expensive compared to a fixed ChatGPT subscription. If the realtime API cost is high in real use, a hosted product with billing may become more sensible than a purely BYO-key tool. Hosted billing does not reduce model costs, but it lets the app charge enough to cover them and offer a simpler setup.

Cost control is therefore a first-class product requirement:

- Show estimated session duration and usage after each conversation.
- Add configurable session time limits.
- Add a monthly soft budget setting inside the app.
- Maintain a first-class usage ledger from V1 so real cost per commute/session is measurable.
- Use cheaper text models for offline post-conversation vocab reconciliation when possible.
- Keep offline jobs concise and structured.
- Avoid sending full lifetime history into each live voice session.
- Summarize older conversation history into compact memory notes.
- Consider a future "cheap mode" with speech-to-text, text model, and text-to-speech instead of realtime speech-to-speech.

The product should therefore be built with two modes in mind:

- Local/BYO-key mode: open-source, self-hosted, user supplies their own OpenAI API key.
- Hosted mode: managed accounts, app-owned OpenAI usage, Stripe billing, usage quotas, and included voice minutes.

V1 can ship only local/BYO-key mode, but the schema and backend boundaries should not make hosted billing painful later.

## Deployment Model

### Local/BYO-Key Mode

The recommended self-hosted setup is:

```txt
old laptop or small always-on machine
  docker compose up
  app listens on localhost
  tailscale serve exposes app privately to tailnet over HTTPS

phone
  Tailscale app connected
  opens https://language-learning.<tailnet>.ts.net
```

Tailscale provides private network access from the phone while away from home. It does not host the app. The old laptop must be awake, online, and running the backend.

Use Tailscale Serve for the default deployment because browser microphone and WebRTC flows need a secure context and because tailnet-only access is private. Tailscale Funnel can be documented later as an optional public exposure mode, but it should not be the default.

### Hosted Mode

Hosted mode is a possible later product shape, not required for V1.

Hosted mode would add:

- Managed cloud backend and database.
- User accounts and authentication.
- Stripe subscriptions or prepaid credits.
- Usage quotas based on voice minutes, model spend, or both.
- App-owned OpenAI API keys and centralized usage monitoring.
- Abuse prevention, rate limits, support tooling, privacy policy, and data deletion flows.

The hosted version should preserve exportability so local-first users can move data in either direction.

## Proposed Tech Stack

Use one TypeScript codebase for frontend, backend, and LLM orchestration.

- Frontend: React + Vite + TypeScript.
- PWA: Vite PWA plugin for installable mobile UX.
- Backend: Fastify + TypeScript.
- Database: SQLite for V1.
- ORM/migrations: Drizzle ORM.
- Background jobs: a simple SQLite-backed jobs table in V1.
- OpenAI:
  - Realtime voice for the live conversation.
  - Server-minted ephemeral client secrets for browser sessions.
  - Server-side tool handling or sideband controls for private business logic.
  - Structured text-model calls for offline vocab reconciliation.
- Packaging: Docker Compose with persistent volume for SQLite and transcripts.

This avoids a heavier multi-service setup while leaving a path to Postgres or a hosted mode later.

Hosted mode migration path:

- Keep business logic in the backend, not the frontend.
- Keep OpenAI key handling server-side in all modes.
- Use a `users` table from the beginning, even if V1 only has one local user.
- Store usage events in a provider-neutral ledger.
- Isolate billing/quota checks behind a service boundary that can be a no-op in local mode.
- Avoid assuming SQLite-only behavior in shared domain logic.

## Frontend

### Navigation

Use three main tabs:

- Talk
- Words
- Settings

History can start as a secondary view under Talk or Words. If transcripts become important quickly, promote History to a fourth tab.

### Talk Screen

Primary controls:

- Big mic/start button.
- Current target language and conversation partner style.
- Session status: idle, quiz, connecting, live, ending, processing.
- End conversation button.
- Small usage/session timer.

Flow:

1. User taps Start.
2. App fetches due quiz items.
3. App runs recognition and production quiz prompts.
4. App starts Realtime voice session.
5. App shows minimal live status, not a chat-heavy UI.
6. User taps End.
7. App shows "processing vocab" while offline reconciliation runs.

Live transcript display should be optional or collapsible. The main experience is audio.

### Words Screen

List word senses, not just surface forms.

Each row/card should show:

- Japanese surface form.
- Reading.
- Short English meaning in context.
- Recognition score and next due date.
- Production score and next due date.
- Active or retired state.

Detail view should show:

- First-seen sentence.
- English translation of that sentence.
- Notes about nuance/register.
- Transcript source and timestamp.
- Review history.
- Buttons: retire, unretire, edit, delete, merge.

Filters:

- Due now.
- Learning.
- Retired.
- Recently added.
- Search by Japanese, reading, or English.

### Settings Screen

Settings should include:

- OpenAI API configuration status.
- Realtime model.
- Offline vocab model.
- Native language.
- Target language.
- Conversation partner style.
- Max quiz length.
- Recognition retirement target, default 3 net successes.
- Production retirement target, default 2 net successes.
- Production unlock threshold, default 1 recognition success.
- Max session minutes.
- Monthly soft budget.
- Data export/import.

The API key itself should live in server environment variables or a local server-side config file, not browser local storage.

## Backend

### Responsibilities

The backend owns:

- OpenAI API key.
- Minting Realtime ephemeral client secrets.
- Session creation and ending.
- Transcript persistence.
- Tool/event persistence.
- Quiz item selection.
- Review result updates.
- Offline vocab reconciliation jobs.
- Data export.
- Usage tracking and quota checks.

### Suggested API Endpoints

Authentication can be omitted in personal local mode, but add an optional local app password before making Tailscale/Funnel docs prominent.

```txt
GET  /api/health
GET  /api/settings
PUT  /api/settings

POST /api/realtime/session
POST /api/conversations
GET  /api/conversations
GET  /api/conversations/:id
POST /api/conversations/:id/end

GET  /api/quiz/due
POST /api/reviews

GET  /api/word-senses
POST /api/word-senses
GET  /api/word-senses/:id
PATCH /api/word-senses/:id
POST /api/word-senses/:id/merge
DELETE /api/word-senses/:id

GET  /api/jobs
POST /api/jobs/:id/retry

GET  /api/usage

GET  /api/export
POST /api/import
```

### Background Jobs

V1 jobs:

- `reconcile_vocab_after_conversation`
- `summarize_conversation_memory`
- `estimate_usage`

Each job should have:

- id
- type
- status
- attempts
- input JSON
- output JSON
- error text
- created_at
- started_at
- finished_at

Run jobs in-process for V1. A separate worker process can come later.

## Database Model

### users

Even local-first can start with one user row so the schema can grow.

- id
- native_language
- target_language
- created_at

### conversations

- id
- user_id
- started_at
- ended_at
- target_language
- native_language
- partner_style
- status
- transcript_text
- transcript_json
- summary
- user_interest_notes
- estimated_input_tokens
- estimated_output_tokens
- estimated_audio_seconds

### usage_events

This table is required even in local mode so we can understand real costs before deciding whether hosted billing is worth it.

- id
- user_id
- conversation_id
- provider: openai
- model
- operation: realtime_response, transcription, offline_vocab_reconcile, summary, grading
- input_text_tokens
- output_text_tokens
- input_audio_tokens
- output_audio_tokens
- audio_seconds
- cached_tokens
- estimated_cost_usd
- raw_usage_json
- created_at

### quotas

Local mode can use this for soft warnings. Hosted mode can enforce it.

- id
- user_id
- period_start
- period_end
- monthly_budget_usd
- max_session_minutes
- max_monthly_voice_minutes
- hard_limit_enabled
- created_at
- updated_at

### conversation_events

Events are raw evidence from the live session.

- id
- conversation_id
- timestamp_ms
- type
- payload_json
- created_at

Important event types:

- `vocab_question`
- `assistant_vocab_explanation`
- `candidate_word_sense`
- `correction`
- `topic_interest`

### word_senses

This is the central V1 table.

- id
- target_language
- surface_form
- lemma
- reading
- part_of_speech
- meaning
- meaning_disambiguator
- nuance
- register
- first_seen_conversation_id
- first_seen_event_id
- first_seen_sentence
- first_seen_sentence_translation
- status: active, retired, ignored
- created_at
- updated_at

`meaning_disambiguator` should make quiz prompts unambiguous, such as "to hang/place something on something" rather than "to put".

### word_sense_examples

- id
- word_sense_id
- conversation_id
- sentence
- sentence_translation
- source: first_seen, later_seen, generated
- created_at

### srs_tracks

One word sense has separate recognition and production tracks.

- id
- word_sense_id
- direction: recognition, production
- unlocked
- net_score
- successes
- misses
- due_at
- last_reviewed_at
- interval_days
- ease
- retired_at

V1 scoring:

- Correct answer: successes + 1, net_score + 1.
- Wrong answer: misses + 1, net_score - 1.
- Correct only after sentence hint: count as wrong.
- Recognition retires when net_score >= 3.
- Production unlocks after at least 1 recognition success.
- Production retires when net_score >= 2.
- Word sense leaves active quiz rotation only when both tracks are retired.

### reviews

- id
- word_sense_id
- direction
- prompt
- expected_answer_json
- user_answer
- result: correct, incorrect, hint_used, skipped
- used_hint
- created_at

## Quiz Design

### Recognition: Japanese to English

Recognition prompts should include enough context to identify the sense.

Example prompt shape:

```txt
In this sentence, what does "<surface_form>" mean?

<first_seen_sentence>
```

If the learner struggles, the app can reveal the original sentence as a hint when the first prompt was less contextual. However, any answer requiring the hint counts as a miss.

### Production: English to Japanese

Production unlocks after one successful recognition review.

Production prompts should be disambiguated and production-friendly.

Example prompt shape:

```txt
How would you say the word/phrase for "<meaning_disambiguator>" in Japanese?

Context: <short English context or translated first-seen sentence>
```

The grader should accept:

- correct surface form
- correct lemma when inflection is irrelevant
- kana/kanji variants when appropriate
- close synonyms only when they really express the same saved sense

The grader should reject:

- a different sense of the same surface form
- a hyper-general synonym that dodges the target word
- answers that only work in a different register or context, unless marked acceptable

## LLM System

### Live Conversation Agent

Use a Realtime voice agent for natural turn-taking, interruptions, and low latency.

The agent should behave like a conversation partner, not an assistant:

- Keep the conversation mostly in the target language.
- Adjust difficulty to the learner.
- Ask real follow-up questions.
- Have light preferences and opinions.
- Avoid constantly explaining unless asked.
- When the user asks what a word means, answer briefly and naturally.
- Mark vocab events with tool calls instead of doing heavy database work live.

### Live Tool/Event Calls

The live agent can call tools like:

```txt
mark_vocab_question({
  surface_form,
  sentence,
  timestamp_ms,
  short_explanation
})

mark_candidate_word({
  surface_form,
  reading,
  sentence,
  reason
})

mark_topic_interest({
  topic,
  evidence
})
```

These calls should persist raw evidence only. Do not try to finalize word senses during live conversation.

### Offline Vocab Reconciliation

After each conversation, run one structured LLM pass with:

- transcript
- vocab/tool events
- existing possibly-related word senses
- current learner language settings

The output should be structured JSON:

```txt
{
  "new_word_senses": [],
  "updates": [],
  "merges": [],
  "ignored_events": [],
  "notes": []
}
```

The job should:

- Add new word senses.
- Merge duplicate senses.
- Keep distinct senses separate.
- Add examples to existing senses.
- Improve readings or glosses when evidence supports it.
- Avoid adding obvious noise, names, or already-known trivial items.

For Japanese, the prompt should explicitly handle:

- inflected forms vs lemmas
- kanji/kana variants
- readings
- particles and attached grammar
- multiword expressions
- distinct senses of the same surface form

## History and Memory

Store full transcripts locally. Generate compact conversation summaries for future context:

- recurring topics
- user interests
- comfort level
- repeated mistakes or hesitations
- recently introduced words

The live session should receive only concise memory, recent active vocab, and current quiz state. Do not stream the full historical transcript into every session.

## Security and Privacy

- Keep the OpenAI API key server-side.
- Use ephemeral client secrets for browser voice sessions.
- Bind the app to localhost by default.
- Expose over Tailscale Serve for phone use.
- Add an optional app password before documenting public exposure.
- Store all learner data locally.
- Provide export and delete-all-data controls.
- Do not log raw API keys.

## Cost Controls

V1 should include:

- Per-session timer.
- Configurable max session length.
- Max quiz items per session.
- Offline job model setting.
- Monthly soft budget.
- Usage ledger with estimated costs by operation and model.
- Usage summary page or settings panel.
- Warning when realtime voice is enabled.

V2 cost options:

- Chained voice mode: speech-to-text, cheap text model, text-to-speech.
- Batch processing for non-urgent offline jobs.
- Local dictionary/morphological pre-pass before LLM reconciliation.
- Local-only transcript search and candidate retrieval.
- Hosted billing with monthly included minutes and overage/prepaid controls.

Hosted billing requirements:

- Stripe customer and subscription records.
- Monthly usage aggregation.
- Quota enforcement before starting a realtime session.
- Graceful cutoff when a session hits max duration.
- Admin view for cost outliers.
- Explicit user-facing language that voice minutes are approximate because provider billing is token-based.

## Testing Plan

Backend:

- Unit tests for SRS scoring and retirement.
- Unit tests for production unlock behavior.
- Unit tests for quiz selection.
- Unit tests for word-sense merge/update logic around structured job outputs.
- Unit tests for usage ledger aggregation and quota checks.
- API tests for conversations, word senses, reviews, and settings.

Frontend:

- Component tests for Talk, Words, and Settings.
- Mobile viewport checks for the Talk screen.
- PWA installability smoke test.

LLM workflow:

- Fixture transcripts for Japanese vocab extraction.
- Fixture cases for same surface form with different senses.
- Fixture cases for hint-used review scoring.
- Schema validation for offline reconciliation output.

Manual verification:

- Start app locally.
- Connect from desktop browser.
- Connect from phone over Tailscale Serve.
- Complete a quiz.
- Complete a short voice session.
- Confirm vocab events become word senses after the offline job.

## Build Phases

### Phase 0: Project Skeleton

- Set up TypeScript monorepo.
- Add frontend, backend, shared package.
- Add Docker Compose.
- Add SQLite migrations.
- Add basic settings storage.
- Add single-user model, usage ledger, and quota tables even if quota enforcement starts as soft warnings.

### Phase 1: Vocab and SRS Core

- Implement word-sense tables.
- Implement recognition/production tracks.
- Implement review scoring.
- Implement quiz selection.
- Build Words and Settings screens.

### Phase 2: Conversation Records

- Add conversation creation/end flow.
- Store transcripts and events.
- Add basic History view or transcript detail.
- Add export.

### Phase 3: Realtime Voice

- Add server endpoint for Realtime session creation.
- Add browser WebRTC voice connection.
- Add Talk screen live state.
- Add live event/tool capture.
- Add end-session cleanup.

### Phase 4: Offline Vocab Reconciliation

- Add background job table and runner.
- Add structured LLM reconciliation prompt.
- Validate output schema.
- Apply new senses, updates, examples, and merges.
- Add job status UI.

### Phase 5: Mobile/Tailscale Polish

- Add PWA manifest and mobile layout refinements.
- Document Tailscale Serve setup.
- Verify microphone and WebRTC on phone.
- Add optional app password.

### Phase 6: Cost and Quality Controls

- Add usage tracking and session limits.
- Add model settings.
- Add transcript summarization memory.
- Add fixtures/evals for extraction quality.

### Phase 7: Hosted Readiness

- Add real authentication.
- Add Postgres option.
- Add billing/quota service boundary.
- Add Stripe integration.
- Add hosted deployment configuration.
- Add admin usage/cost dashboard.
- Add data export/delete account flows.

## V2 Ideas

- Grammar concept tracking.
- Grammar production drills.
- Offline analysis of grammar the learner avoids.
- Automatic new vocab suggestions not directly asked about.
- Native mobile wrapper.
- Multi-user profiles.
- Hosted managed version.
- Optional public sync.
- Import/export with Anki.
- Dictionary integration.
- Local Japanese morphological analysis.

## Open Questions

- Should the first implementation use the OpenAI Agents SDK Realtime helpers or direct WebRTC calls?
- How much live transcript should be visible during conversation?
- Should the app ask before adding automatically detected vocab, or silently add with an "auto-added" label?
- Should retirement hide words completely or keep a tiny long-term review probability?
- What is the best default conversation partner persona for Japanese practice?
- After several real sessions, what is the actual average cost per minute and per commute?
- If hosted, should pricing be subscription-only, prepaid credits, or subscription plus included minutes?

## Reference Links

- OpenAI API billing is separate from ChatGPT subscriptions: https://help.openai.com/en/articles/8156019-how-can-i-move-my-chatgpt-subscription-to-the-api
- OpenAI API pricing: https://openai.com/api/pricing/
- OpenAI voice agents: https://developers.openai.com/api/docs/guides/voice-agents
- OpenAI Realtime WebRTC: https://developers.openai.com/api/docs/guides/realtime-webrtc
- OpenAI Realtime server-side controls: https://developers.openai.com/api/docs/guides/realtime-server-controls
- Tailscale Serve: https://tailscale.com/docs/features/tailscale-serve
- Tailscale MagicDNS: https://tailscale.com/docs/features/magicdns
