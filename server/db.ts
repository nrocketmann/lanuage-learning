import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { AppSettings, Conversation, Direction, QuizItem, SrsTrack, WordSense } from "../shared/types";
import { serverConfig } from "./config";

fs.mkdirSync(path.dirname(serverConfig.databasePath), { recursive: true });

export const db = new Database(serverConfig.databasePath);
db.pragma("journal_mode = WAL");

const isoNow = () => new Date().toISOString();

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  native_language TEXT NOT NULL,
  target_language TEXT NOT NULL,
  partner_style TEXT NOT NULL,
  realtime_model TEXT NOT NULL,
  offline_model TEXT NOT NULL,
  voice TEXT NOT NULL,
  max_quiz_items INTEGER NOT NULL,
  recognition_target INTEGER NOT NULL,
  production_target INTEGER NOT NULL,
  production_unlock_successes INTEGER NOT NULL,
  max_session_minutes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  target_language TEXT NOT NULL,
  native_language TEXT NOT NULL,
  partner_style TEXT NOT NULL,
  transcript_text TEXT,
  transcript_json TEXT,
  summary TEXT,
  model TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS conversation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  timestamp_ms INTEGER,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS word_senses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  surface_form TEXT NOT NULL,
  lemma TEXT,
  reading TEXT,
  part_of_speech TEXT,
  meaning TEXT NOT NULL,
  meaning_disambiguator TEXT,
  nuance TEXT,
  register TEXT,
  first_seen_sentence TEXT,
  first_seen_sentence_translation TEXT,
  source_conversation_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS srs_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_sense_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  unlocked INTEGER NOT NULL,
  net_score INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  misses INTEGER NOT NULL DEFAULT 0,
  due_at TEXT NOT NULL,
  last_reviewed_at TEXT,
  interval_days REAL NOT NULL DEFAULT 0,
  retired_at TEXT,
  FOREIGN KEY (word_sense_id) REFERENCES word_senses(id) ON DELETE CASCADE,
  UNIQUE(word_sense_id, direction)
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_sense_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  prompt TEXT NOT NULL,
  expected_answer_json TEXT NOT NULL,
  user_answer TEXT,
  result TEXT NOT NULL,
  used_hint INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (word_sense_id) REFERENCES word_senses(id) ON DELETE CASCADE
);
`);

const defaultSettings: AppSettings = {
  nativeLanguage: "English",
  targetLanguage: "Japanese",
  partnerStyle: "patient conversation partner",
  realtimeModel: "gpt-realtime-2",
  offlineModel: "gpt-5.4-mini",
  voice: "marin",
  maxQuizItems: 5,
  recognitionTarget: 3,
  productionTarget: 2,
  productionUnlockSuccesses: 1,
  maxSessionMinutes: 20
};

db.prepare(`
INSERT OR IGNORE INTO settings (
  id, native_language, target_language, partner_style, realtime_model, offline_model, voice,
  max_quiz_items, recognition_target, production_target, production_unlock_successes, max_session_minutes
) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  defaultSettings.nativeLanguage,
  defaultSettings.targetLanguage,
  defaultSettings.partnerStyle,
  defaultSettings.realtimeModel,
  defaultSettings.offlineModel,
  defaultSettings.voice,
  defaultSettings.maxQuizItems,
  defaultSettings.recognitionTarget,
  defaultSettings.productionTarget,
  defaultSettings.productionUnlockSuccesses,
  defaultSettings.maxSessionMinutes
);

function mapSettings(row: Record<string, unknown>): AppSettings {
  return {
    nativeLanguage: String(row.native_language),
    targetLanguage: String(row.target_language),
    partnerStyle: String(row.partner_style),
    realtimeModel: String(row.realtime_model),
    offlineModel: String(row.offline_model),
    voice: String(row.voice),
    maxQuizItems: Number(row.max_quiz_items),
    recognitionTarget: Number(row.recognition_target),
    productionTarget: Number(row.production_target),
    productionUnlockSuccesses: Number(row.production_unlock_successes),
    maxSessionMinutes: Number(row.max_session_minutes)
  };
}

export function getSettings(): AppSettings {
  return mapSettings(db.prepare("SELECT * FROM settings WHERE id = 1").get() as Record<string, unknown>);
}

export function updateSettings(settings: AppSettings): AppSettings {
  db.prepare(`
    UPDATE settings SET
      native_language = ?,
      target_language = ?,
      partner_style = ?,
      realtime_model = ?,
      offline_model = ?,
      voice = ?,
      max_quiz_items = ?,
      recognition_target = ?,
      production_target = ?,
      production_unlock_successes = ?,
      max_session_minutes = ?
    WHERE id = 1
  `).run(
    settings.nativeLanguage,
    settings.targetLanguage,
    settings.partnerStyle,
    settings.realtimeModel,
    settings.offlineModel,
    settings.voice,
    settings.maxQuizItems,
    settings.recognitionTarget,
    settings.productionTarget,
    settings.productionUnlockSuccesses,
    settings.maxSessionMinutes
  );
  return getSettings();
}

function mapTrack(row: Record<string, unknown>): SrsTrack {
  return {
    id: Number(row.id),
    wordSenseId: Number(row.word_sense_id),
    direction: String(row.direction) as Direction,
    unlocked: Number(row.unlocked) === 1,
    netScore: Number(row.net_score),
    successes: Number(row.successes),
    misses: Number(row.misses),
    dueAt: String(row.due_at),
    lastReviewedAt: row.last_reviewed_at ? String(row.last_reviewed_at) : null,
    intervalDays: Number(row.interval_days),
    retiredAt: row.retired_at ? String(row.retired_at) : null
  };
}

function mapWordSense(row: Record<string, unknown>, tracks: SrsTrack[]): WordSense {
  return {
    id: Number(row.id),
    surfaceForm: String(row.surface_form),
    lemma: row.lemma ? String(row.lemma) : null,
    reading: row.reading ? String(row.reading) : null,
    partOfSpeech: row.part_of_speech ? String(row.part_of_speech) : null,
    meaning: String(row.meaning),
    meaningDisambiguator: row.meaning_disambiguator ? String(row.meaning_disambiguator) : null,
    nuance: row.nuance ? String(row.nuance) : null,
    register: row.register ? String(row.register) : null,
    firstSeenSentence: row.first_seen_sentence ? String(row.first_seen_sentence) : null,
    firstSeenSentenceTranslation: row.first_seen_sentence_translation ? String(row.first_seen_sentence_translation) : null,
    status: String(row.status) as WordSense["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    tracks: {
      recognition: tracks.find((track) => track.direction === "recognition")!,
      production: tracks.find((track) => track.direction === "production")!
    }
  };
}

export function ensureTracks(wordSenseId: number) {
  const now = isoNow();
  db.prepare(`
    INSERT OR IGNORE INTO srs_tracks (word_sense_id, direction, unlocked, due_at)
    VALUES (?, 'recognition', 1, ?)
  `).run(wordSenseId, now);
  db.prepare(`
    INSERT OR IGNORE INTO srs_tracks (word_sense_id, direction, unlocked, due_at)
    VALUES (?, 'production', 0, ?)
  `).run(wordSenseId, now);
}

export type WordSenseInput = {
  surfaceForm: string;
  lemma?: string | null;
  reading?: string | null;
  partOfSpeech?: string | null;
  meaning: string;
  meaningDisambiguator?: string | null;
  nuance?: string | null;
  register?: string | null;
  firstSeenSentence?: string | null;
  firstSeenSentenceTranslation?: string | null;
  sourceConversationId?: number | null;
};

export function createWordSense(input: WordSenseInput): WordSense {
  const now = isoNow();
  const result = db.prepare(`
    INSERT INTO word_senses (
      surface_form, lemma, reading, part_of_speech, meaning, meaning_disambiguator, nuance,
      register, first_seen_sentence, first_seen_sentence_translation, source_conversation_id,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(
    input.surfaceForm.trim(),
    input.lemma?.trim() || null,
    input.reading?.trim() || null,
    input.partOfSpeech?.trim() || null,
    input.meaning.trim(),
    input.meaningDisambiguator?.trim() || null,
    input.nuance?.trim() || null,
    input.register?.trim() || null,
    input.firstSeenSentence?.trim() || null,
    input.firstSeenSentenceTranslation?.trim() || null,
    input.sourceConversationId ?? null,
    now,
    now
  );
  ensureTracks(Number(result.lastInsertRowid));
  return getWordSense(Number(result.lastInsertRowid))!;
}

export function getWordSense(id: number): WordSense | null {
  const row = db.prepare("SELECT * FROM word_senses WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const tracks = (db.prepare("SELECT * FROM srs_tracks WHERE word_sense_id = ?").all(id) as Record<string, unknown>[]).map(mapTrack);
  return mapWordSense(row, tracks);
}

export function listWordSenses(): WordSense[] {
  const rows = db.prepare("SELECT * FROM word_senses ORDER BY updated_at DESC, id DESC").all() as Record<string, unknown>[];
  const trackRows = db.prepare("SELECT * FROM srs_tracks").all() as Record<string, unknown>[];
  const tracksByWord = new Map<number, SrsTrack[]>();
  for (const row of trackRows) {
    const track = mapTrack(row);
    const existing = tracksByWord.get(track.wordSenseId) ?? [];
    existing.push(track);
    tracksByWord.set(track.wordSenseId, existing);
  }
  return rows.map((row) => mapWordSense(row, tracksByWord.get(Number(row.id)) ?? []));
}

export function updateWordSense(id: number, input: Partial<WordSenseInput> & { status?: WordSense["status"] }): WordSense | null {
  const existing = getWordSense(id);
  if (!existing) return null;
  db.prepare(`
    UPDATE word_senses SET
      surface_form = ?,
      lemma = ?,
      reading = ?,
      part_of_speech = ?,
      meaning = ?,
      meaning_disambiguator = ?,
      nuance = ?,
      register = ?,
      first_seen_sentence = ?,
      first_seen_sentence_translation = ?,
      status = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    input.surfaceForm ?? existing.surfaceForm,
    input.lemma ?? existing.lemma,
    input.reading ?? existing.reading,
    input.partOfSpeech ?? existing.partOfSpeech,
    input.meaning ?? existing.meaning,
    input.meaningDisambiguator ?? existing.meaningDisambiguator,
    input.nuance ?? existing.nuance,
    input.register ?? existing.register,
    input.firstSeenSentence ?? existing.firstSeenSentence,
    input.firstSeenSentenceTranslation ?? existing.firstSeenSentenceTranslation,
    input.status ?? existing.status,
    isoNow(),
    id
  );
  return getWordSense(id);
}

export function deleteWordSense(id: number) {
  db.prepare("DELETE FROM word_senses WHERE id = ?").run(id);
}

export function getDueQuizItems(limit: number): QuizItem[] {
  const now = isoNow();
  const rows = db.prepare(`
    SELECT
      srs_tracks.id AS track_id,
      srs_tracks.word_sense_id,
      srs_tracks.direction,
      srs_tracks.unlocked,
      srs_tracks.net_score,
      srs_tracks.successes,
      srs_tracks.misses,
      srs_tracks.due_at,
      srs_tracks.last_reviewed_at,
      srs_tracks.interval_days,
      srs_tracks.retired_at
    FROM srs_tracks
    JOIN word_senses ON word_senses.id = srs_tracks.word_sense_id
    WHERE srs_tracks.unlocked = 1
      AND srs_tracks.retired_at IS NULL
      AND srs_tracks.due_at <= ?
      AND word_senses.status = 'active'
    ORDER BY srs_tracks.due_at ASC, srs_tracks.id ASC
    LIMIT ?
  `).all(now, limit) as Record<string, unknown>[];

  return rows
    .map((row) => getWordSense(Number(row.word_sense_id)))
    .filter((wordSense): wordSense is WordSense => Boolean(wordSense))
    .flatMap((wordSense) => {
      const dueTracks = Object.values(wordSense.tracks)
        .filter((track) => track.unlocked && !track.retiredAt && track.dueAt <= now)
        .slice(0, 1);
      return dueTracks.map((track) => ({ track, wordSense }));
    })
    .slice(0, limit);
}

function nextDueDate(success: boolean, intervalDays: number) {
  const days = success ? Math.max(1, Math.min(30, intervalDays > 0 ? intervalDays * 2 : 1)) : 0;
  const due = new Date();
  due.setTime(due.getTime() + days * 24 * 60 * 60 * 1000);
  return { dueAt: due.toISOString(), intervalDays: days };
}

export function recordReview(input: {
  wordSenseId: number;
  direction: Direction;
  prompt: string;
  expectedAnswer: unknown;
  userAnswer?: string | null;
  correct: boolean;
  usedHint: boolean;
}) {
  const settings = getSettings();
  const track = db.prepare("SELECT * FROM srs_tracks WHERE word_sense_id = ? AND direction = ?")
    .get(input.wordSenseId, input.direction) as Record<string, unknown> | undefined;
  if (!track) throw new Error("Review track not found");

  const countsAsSuccess = input.correct && !input.usedHint;
  const mapped = mapTrack(track);
  const netScore = mapped.netScore + (countsAsSuccess ? 1 : -1);
  const successes = mapped.successes + (countsAsSuccess ? 1 : 0);
  const misses = mapped.misses + (countsAsSuccess ? 0 : 1);
  const threshold = input.direction === "recognition" ? settings.recognitionTarget : settings.productionTarget;
  const retiredAt = netScore >= threshold ? isoNow() : null;
  const next = nextDueDate(countsAsSuccess, mapped.intervalDays);

  db.prepare(`
    UPDATE srs_tracks SET
      net_score = ?,
      successes = ?,
      misses = ?,
      due_at = ?,
      last_reviewed_at = ?,
      interval_days = ?,
      retired_at = COALESCE(?, retired_at)
    WHERE id = ?
  `).run(netScore, successes, misses, next.dueAt, isoNow(), next.intervalDays, retiredAt, mapped.id);

  db.prepare(`
    INSERT INTO reviews (word_sense_id, direction, prompt, expected_answer_json, user_answer, result, used_hint, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.wordSenseId,
    input.direction,
    input.prompt,
    JSON.stringify(input.expectedAnswer),
    input.userAnswer ?? null,
    countsAsSuccess ? "correct" : input.usedHint ? "hint_used" : "incorrect",
    input.usedHint ? 1 : 0,
    isoNow()
  );

  if (input.direction === "recognition" && successes >= settings.productionUnlockSuccesses) {
    db.prepare("UPDATE srs_tracks SET unlocked = 1, due_at = ? WHERE word_sense_id = ? AND direction = 'production'")
      .run(isoNow(), input.wordSenseId);
  }

  const updated = getWordSense(input.wordSenseId);
  if (updated?.tracks.recognition.retiredAt && updated.tracks.production.retiredAt) {
    updateWordSense(input.wordSenseId, { status: "retired" });
  }

  return getWordSense(input.wordSenseId);
}

function mapConversation(row: Record<string, unknown>): Conversation {
  return {
    id: Number(row.id),
    status: String(row.status) as Conversation["status"],
    startedAt: String(row.started_at),
    endedAt: row.ended_at ? String(row.ended_at) : null,
    targetLanguage: String(row.target_language),
    nativeLanguage: String(row.native_language),
    partnerStyle: String(row.partner_style),
    transcriptText: row.transcript_text ? String(row.transcript_text) : null,
    summary: row.summary ? String(row.summary) : null,
    model: String(row.model),
    error: row.error ? String(row.error) : null
  };
}

export function createConversation(): Conversation {
  const settings = getSettings();
  const result = db.prepare(`
    INSERT INTO conversations (status, started_at, target_language, native_language, partner_style, model)
    VALUES ('active', ?, ?, ?, ?, ?)
  `).run(isoNow(), settings.targetLanguage, settings.nativeLanguage, settings.partnerStyle, settings.realtimeModel);
  return getConversation(Number(result.lastInsertRowid))!;
}

export function getConversation(id: number): Conversation | null {
  const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapConversation(row) : null;
}

export function listConversations(): Conversation[] {
  return (db.prepare("SELECT * FROM conversations ORDER BY started_at DESC LIMIT 50").all() as Record<string, unknown>[]).map(mapConversation);
}

export function addConversationEvent(conversationId: number, type: string, payload: unknown, timestampMs?: number) {
  db.prepare(`
    INSERT INTO conversation_events (conversation_id, timestamp_ms, type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(conversationId, timestampMs ?? null, type, JSON.stringify(payload), isoNow());
}

export function getConversationEvents(conversationId: number) {
  return db.prepare("SELECT * FROM conversation_events WHERE conversation_id = ? ORDER BY id ASC").all(conversationId) as Record<string, unknown>[];
}

export function endConversation(conversationId: number, transcriptText: string, transcriptJson: unknown) {
  db.prepare(`
    UPDATE conversations SET status = 'processing', ended_at = ?, transcript_text = ?, transcript_json = ?
    WHERE id = ?
  `).run(isoNow(), transcriptText, JSON.stringify(transcriptJson), conversationId);
  return getConversation(conversationId)!;
}

export function completeConversation(conversationId: number, summary: string | null) {
  db.prepare("UPDATE conversations SET status = 'complete', summary = ?, error = NULL WHERE id = ?").run(summary, conversationId);
  return getConversation(conversationId)!;
}

export function failConversation(conversationId: number, error: string) {
  db.prepare("UPDATE conversations SET status = 'error', error = ? WHERE id = ?").run(error, conversationId);
  return getConversation(conversationId)!;
}

export function getCounts() {
  const wordSenses = Number((db.prepare("SELECT COUNT(*) AS count FROM word_senses").get() as { count: number }).count);
  const conversations = Number((db.prepare("SELECT COUNT(*) AS count FROM conversations").get() as { count: number }).count);
  const dueReviews = Number((db.prepare(`
    SELECT COUNT(*) AS count FROM srs_tracks
    JOIN word_senses ON word_senses.id = srs_tracks.word_sense_id
    WHERE srs_tracks.unlocked = 1
      AND srs_tracks.retired_at IS NULL
      AND srs_tracks.due_at <= ?
      AND word_senses.status = 'active'
  `).get(isoNow()) as { count: number }).count);
  return { wordSenses, conversations, dueReviews };
}
