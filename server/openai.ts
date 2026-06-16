import type { AppSettings, QuizItem, TranscriptEntry, WordSense } from "../shared/types";
import { requireOpenAIKey } from "./config";

type ReconcileResult = {
  summary?: string;
  new_word_senses?: Array<{
    surface_form: string;
    lemma?: string | null;
    reading?: string | null;
    part_of_speech?: string | null;
    meaning: string;
    meaning_disambiguator?: string | null;
    nuance?: string | null;
    register?: string | null;
    first_seen_sentence?: string | null;
    first_seen_sentence_translation?: string | null;
  }>;
  ignored_events?: Array<{ reason: string; evidence?: string }>;
};

function buildQuizPrompt(item: QuizItem) {
  const word = item.wordSense;
  if (item.track.direction === "recognition") {
    return word.firstSeenSentence
      ? `In this sentence, what does "${word.surfaceForm}" mean? ${word.firstSeenSentence}`
      : `What does "${word.surfaceForm}" mean in the sense "${word.meaningDisambiguator || word.meaning}"?`;
  }
  return `How would you say "${word.meaningDisambiguator || word.meaning}" in ${word.surfaceForm ? "Japanese" : "the target language"}?`;
}

function buildQuizItems(dueItems: QuizItem[]) {
  return dueItems.slice(0, 8).map((item, index) => {
    const word = item.wordSense;
    return {
      quiz_number: index + 1,
      word_sense_id: word.id,
      direction: item.track.direction,
      prompt: buildQuizPrompt(item),
      expected_answer: {
        surface_form: word.surfaceForm,
        reading: word.reading,
        meaning: word.meaning,
        meaning_disambiguator: word.meaningDisambiguator,
        first_seen_sentence: word.firstSeenSentence
      },
      hint: word.firstSeenSentence || word.meaningDisambiguator || word.meaning
    };
  });
}

function buildReviewTool() {
  return {
    type: "function",
    name: "record_quiz_review",
    description: "Record the result of one verbally administered vocabulary quiz item.",
    parameters: {
      type: "object",
      properties: {
        wordSenseId: {
          type: "number",
          description: "The word_sense_id from the quiz item."
        },
        direction: {
          type: "string",
          enum: ["recognition", "production"]
        },
        prompt: {
          type: "string",
          description: "The exact quiz prompt asked verbally."
        },
        expectedAnswer: {
          type: "object",
          description: "The expected answer or answer metadata from the quiz item.",
          additionalProperties: true
        },
        userAnswer: {
          type: "string",
          description: "What the learner answered, as best as you heard it."
        },
        correct: {
          type: "boolean",
          description: "True only if the learner answered correctly without needing a hint."
        },
        usedHint: {
          type: "boolean",
          description: "True if the learner asked for or needed a hint. Hint usage counts as a miss."
        }
      },
      required: ["wordSenseId", "direction", "prompt", "expectedAnswer", "userAnswer", "correct", "usedHint"],
      additionalProperties: false
    }
  };
}

export function buildRealtimeInstructions(settings: AppSettings, dueItems: QuizItem[]) {
  const quizItems = buildQuizItems(dueItems);
  const quizBlock = quizItems.length
    ? JSON.stringify(quizItems, null, 2)
    : "[]";

  return [
    `You are a ${settings.partnerStyle} helping the user practice ${settings.targetLanguage}.`,
    `The user's native language is ${settings.nativeLanguage}.`,
    "Act like a real conversation partner, not a generic assistant.",
    "Keep most of the conversation in the target language, but explain briefly in the user's native language when asked.",
    "Ask natural follow-up questions and keep the pace friendly.",
    "If the user asks what a word means, explain the meaning in context and reuse the word in a simple sentence.",
    "Avoid quizzing grammar in this version.",
    [
      "STARTUP FLOW",
      quizItems.length
        ? `Your first spoken turn must be short: greet the learner once, say there are ${quizItems.length} vocabulary quiz item(s) due, and ask whether they want to do the latest quiz before conversation. Then stop and wait for the learner.`
        : "Your first spoken turn must be short: greet the learner once, say there are no vocabulary reviews due, and ask what they want to talk about. Then stop and wait for the learner.",
      "Do not start any second greeting or alternate opening dialogue.",
      "Do not begin the quiz until the learner says yes or otherwise agrees."
    ].join("\n"),
    [
      "VERBAL QUIZ FLOW",
      "If the learner agrees to quiz, administer the items below one at a time in order.",
      "Ask the prompt verbally, wait for the learner's answer, judge it generously but honestly for the listed sense, and then call record_quiz_review exactly once for that item.",
      "If the learner asks for a hint or needs the sentence/extra help before answering, set usedHint=true and correct=false even if they answer after the hint.",
      "For production items, accept kana/kanji variants and close equivalents only when they express the same saved sense.",
      "After the tool result comes back, briefly say whether they got it and continue to the next item.",
      "After the final quiz item, transition naturally into conversation."
    ].join("\n"),
    `VERBAL QUIZ ITEMS\n${quizBlock}`
  ].join("\n\n");
}

export async function createRealtimeSession({
  settings,
  dueItems
}: {
  settings: AppSettings;
  dueItems: QuizItem[];
}) {
  const apiKey = requireOpenAIKey();
  const instructions = buildRealtimeInstructions(settings, dueItems);
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": "local-user"
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: settings.realtimeModel,
        instructions,
        tools: [buildReviewTool()],
        tool_choice: "auto",
        audio: {
          input: {
            turn_detection: {
              type: "semantic_vad",
              eagerness: "low",
              create_response: true,
              interrupt_response: false
            }
          },
          output: {
            voice: settings.voice
          }
        }
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Realtime session failed: ${response.status} ${error}`);
  }

  return response.json();
}

function extractOutputText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const maybe = response as { output_text?: unknown; output?: unknown };
  if (typeof maybe.output_text === "string") return maybe.output_text;
  if (!Array.isArray(maybe.output)) return "";

  const parts: string[] = [];
  for (const item of maybe.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

export async function reconcileVocab({
  settings,
  transcript,
  existingWordSenses
}: {
  settings: AppSettings;
  transcript: TranscriptEntry[];
  existingWordSenses: WordSense[];
}): Promise<ReconcileResult> {
  const apiKey = requireOpenAIKey();
  const compactExisting = existingWordSenses.slice(0, 200).map((word) => ({
    id: word.id,
    surface_form: word.surfaceForm,
    lemma: word.lemma,
    reading: word.reading,
    meaning: word.meaning,
    meaning_disambiguator: word.meaningDisambiguator,
    sentence: word.firstSeenSentence
  }));

  const prompt = {
    task: "Update a local vocabulary list for a language learner after a voice conversation.",
    target_language: settings.targetLanguage,
    native_language: settings.nativeLanguage,
    rules: [
      "Return JSON only.",
      "Add word senses, not bare words.",
      "Prefer words the user explicitly asked about, words the assistant explained, or salient useful words from the conversation.",
      "Do not add names, filler, trivial particles, or noise.",
      "For Japanese, separate different senses of the same surface form.",
      "For Japanese, provide reading when inferable.",
      "Every new item must include an unambiguous English meaning in context.",
      "Keep the list small: at most 8 new word senses."
    ],
    output_shape: {
      summary: "short conversation summary",
      new_word_senses: [
        {
          surface_form: "target-language surface form",
          lemma: "dictionary form if useful",
          reading: "reading if applicable",
          part_of_speech: "optional",
          meaning: "short English gloss",
          meaning_disambiguator: "unambiguous sense description",
          nuance: "optional nuance",
          register: "optional register",
          first_seen_sentence: "sentence where the sense appeared",
          first_seen_sentence_translation: "English translation of that sentence"
        }
      ],
      ignored_events: [{ reason: "why no word was added", evidence: "optional" }]
    },
    existing_word_senses: compactExisting,
    transcript
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.offlineModel,
      input: [
        {
          role: "system",
          content: "You are a careful bilingual vocabulary curator. You return compact, valid JSON and nothing else."
        },
        {
          role: "user",
          content: JSON.stringify(prompt)
        }
      ],
      max_output_tokens: 1800
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Vocab reconciliation failed: ${response.status} ${error}`);
  }

  const data = await response.json();
  const text = extractOutputText(data);
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  return JSON.parse(cleaned) as ReconcileResult;
}
