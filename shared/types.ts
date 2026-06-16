export type Direction = "recognition" | "production";

export type AppSettings = {
  nativeLanguage: string;
  targetLanguage: string;
  partnerStyle: string;
  realtimeModel: string;
  offlineModel: string;
  voice: string;
  maxQuizItems: number;
  recognitionTarget: number;
  productionTarget: number;
  productionUnlockSuccesses: number;
  maxSessionMinutes: number;
};

export type SrsTrack = {
  id: number;
  wordSenseId: number;
  direction: Direction;
  unlocked: boolean;
  netScore: number;
  successes: number;
  misses: number;
  dueAt: string;
  lastReviewedAt: string | null;
  intervalDays: number;
  retiredAt: string | null;
};

export type WordSense = {
  id: number;
  surfaceForm: string;
  lemma: string | null;
  reading: string | null;
  partOfSpeech: string | null;
  meaning: string;
  meaningDisambiguator: string | null;
  nuance: string | null;
  register: string | null;
  firstSeenSentence: string | null;
  firstSeenSentenceTranslation: string | null;
  status: "active" | "retired" | "ignored";
  createdAt: string;
  updatedAt: string;
  tracks: Record<Direction, SrsTrack>;
};

export type QuizItem = {
  track: SrsTrack;
  wordSense: WordSense;
};

export type Conversation = {
  id: number;
  status: "active" | "processing" | "complete" | "error";
  startedAt: string;
  endedAt: string | null;
  targetLanguage: string;
  nativeLanguage: string;
  partnerStyle: string;
  transcriptText: string | null;
  summary: string | null;
  model: string;
  error: string | null;
};

export type TranscriptEntry = {
  role: "user" | "assistant" | "system";
  text: string;
  timestampMs?: number;
};

export type HealthResponse = {
  ok: true;
  hasOpenAIKey: boolean;
  counts: {
    wordSenses: number;
    conversations: number;
    dueReviews: number;
  };
};
