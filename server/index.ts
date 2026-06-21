import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import path from "node:path";
import { z } from "zod";
import type { TranscriptEntry } from "../shared/types";
import { serverConfig } from "./config";
import {
  addConversationEvent,
  completeConversation,
  createConversation,
  createWordSense,
  deleteWordSense,
  endConversation,
  failConversation,
  getConversation,
  getCounts,
  getDueQuizItems,
  getSettings,
  getUsageSummary,
  listConversations,
  listWordSenses,
  recordReview,
  updateSettings,
  updateWordSense
} from "./db";
import { handleGeminiLiveSocket, smokeGeminiLive } from "./gemini";
import { createRealtimeSession, reconcileVocab } from "./openai";
import { recordRealtimeUsageFromEvent } from "./usage";

const app = Fastify({ logger: true });

app.addContentTypeParser("application/sdp", { parseAs: "string" }, (_request, body, done) => {
  done(null, body);
});

await app.register(cors, {
  origin: ["http://127.0.0.1:5173", "http://localhost:5173"]
});

await app.register(fastifyWebsocket, {
  options: {
    maxPayload: 2 * 1024 * 1024
  }
});

const settingsSchema = z.object({
  nativeLanguage: z.string().min(1),
  targetLanguage: z.string().min(1),
  partnerStyle: z.string().min(1),
  realtimeProvider: z.enum(["openai", "gemini"]).default("openai"),
  realtimeModel: z.string().min(1),
  offlineModel: z.string().min(1),
  voice: z.string().min(1),
  maxQuizItems: z.coerce.number().int().min(1).max(20),
  recognitionTarget: z.coerce.number().int().min(1).max(20),
  productionTarget: z.coerce.number().int().min(1).max(20),
  productionUnlockSuccesses: z.coerce.number().int().min(1).max(20),
  maxSessionMinutes: z.coerce.number().int().min(1).max(120)
});

const wordSenseSchema = z.object({
  surfaceForm: z.string().min(1),
  lemma: z.string().optional().nullable(),
  reading: z.string().optional().nullable(),
  partOfSpeech: z.string().optional().nullable(),
  meaning: z.string().min(1),
  meaningDisambiguator: z.string().optional().nullable(),
  nuance: z.string().optional().nullable(),
  register: z.string().optional().nullable(),
  firstSeenSentence: z.string().optional().nullable(),
  firstSeenSentenceTranslation: z.string().optional().nullable()
});

app.get("/api/health", async () => ({
  ok: true,
  hasOpenAIKey: Boolean(serverConfig.openAIKey),
  hasGeminiApiKey: Boolean(serverConfig.geminiApiKey),
  hasVertexKey: Boolean(serverConfig.vertexKey),
  hasVertexAccessToken: Boolean(serverConfig.vertexAccessToken),
  hasVertexProjectId: Boolean(serverConfig.vertexProjectId),
  vertexUseGcloudAuth: serverConfig.vertexUseGcloudAuth,
  vertexUseGcloudADC: serverConfig.vertexUseGcloudADC,
  counts: getCounts()
}));

app.get("/api/settings", async () => getSettings());

app.put("/api/settings", async (request) => updateSettings(settingsSchema.parse(request.body)));

app.get("/api/usage", async () => getUsageSummary());

app.post("/api/gemini/smoke", async () => smokeGeminiLive(getSettings()));

app.get("/api/gemini/live", { websocket: true }, (socket, request) => {
  const settings = getSettings();
  const dueItems = getDueQuizItems(settings.maxQuizItems);
  const query = z.object({
    conversationId: z.coerce.number().int().optional()
  }).parse(request.query);
  void handleGeminiLiveSocket({
    socket,
    settings,
    dueItems,
    conversationId: query.conversationId ?? null,
    log: app.log
  });
});

app.get("/api/word-senses", async () => listWordSenses());

app.post("/api/word-senses", async (request, reply) => {
  const input = wordSenseSchema.parse(request.body);
  const wordSense = createWordSense(input);
  reply.code(201);
  return wordSense;
});

app.patch("/api/word-senses/:id", async (request, reply) => {
  const params = z.object({ id: z.coerce.number().int() }).parse(request.params);
  const body = wordSenseSchema.partial().extend({
    status: z.enum(["active", "retired", "ignored"]).optional()
  }).parse(request.body);
  const updated = updateWordSense(params.id, body);
  if (!updated) return reply.code(404).send({ error: "Not found" });
  return updated;
});

app.delete("/api/word-senses/:id", async (request, reply) => {
  const params = z.object({ id: z.coerce.number().int() }).parse(request.params);
  deleteWordSense(params.id);
  reply.code(204);
});

app.get("/api/quiz/due", async () => {
  const settings = getSettings();
  return getDueQuizItems(settings.maxQuizItems);
});

app.post("/api/reviews", async (request) => {
  const body = z.object({
    wordSenseId: z.number().int(),
    direction: z.enum(["recognition", "production"]),
    prompt: z.string(),
    expectedAnswer: z.unknown(),
    userAnswer: z.string().optional().nullable(),
    correct: z.boolean(),
    usedHint: z.boolean().default(false)
  }).parse(request.body);
  return recordReview(body);
});

app.get("/api/conversations", async () => listConversations());

app.post("/api/conversations", async (_request, reply) => {
  const conversation = createConversation();
  reply.code(201);
  return conversation;
});

app.get("/api/conversations/:id", async (request, reply) => {
  const params = z.object({ id: z.coerce.number().int() }).parse(request.params);
  const conversation = getConversation(params.id);
  if (!conversation) return reply.code(404).send({ error: "Not found" });
  return conversation;
});

app.post("/api/conversations/:id/events", async (request, reply) => {
  const params = z.object({ id: z.coerce.number().int() }).parse(request.params);
  const body = z.object({
    type: z.string().min(1),
    payload: z.unknown(),
    timestampMs: z.number().optional()
  }).parse(request.body);
  if (!getConversation(params.id)) return reply.code(404).send({ error: "Not found" });
  addConversationEvent(params.id, body.type, body.payload, body.timestampMs);
  recordRealtimeUsageFromEvent({
    conversationId: params.id,
    model: getSettings().realtimeModel,
    payload: body.payload
  });
  reply.code(201);
  return { ok: true };
});

app.post("/api/conversations/:id/end", async (request, reply) => {
  const params = z.object({ id: z.coerce.number().int() }).parse(request.params);
  const body = z.object({
    transcript: z.array(z.object({
      role: z.enum(["user", "assistant", "system"]),
      text: z.string(),
      timestampMs: z.number().optional()
    })).default([]),
    fallbackNotes: z.string().optional()
  }).parse(request.body);

  if (!getConversation(params.id)) return reply.code(404).send({ error: "Not found" });
  const transcriptEntries: TranscriptEntry[] = [...body.transcript];
  if (body.fallbackNotes?.trim()) {
    transcriptEntries.push({ role: "system", text: `User-provided notes: ${body.fallbackNotes.trim()}` });
  }
  const transcriptText = transcriptEntries.map((entry) => `${entry.role}: ${entry.text}`).join("\n");
  endConversation(params.id, transcriptText, transcriptEntries);

  try {
    if (transcriptText.trim()) {
      const result = await reconcileVocab({
        settings: getSettings(),
        transcript: transcriptEntries,
        existingWordSenses: listWordSenses(),
        conversationId: params.id
      });
      for (const word of result.new_word_senses ?? []) {
        if (!word.surface_form?.trim() || !word.meaning?.trim()) continue;
        createWordSense({
          surfaceForm: word.surface_form,
          lemma: word.lemma,
          reading: word.reading,
          partOfSpeech: word.part_of_speech,
          meaning: word.meaning,
          meaningDisambiguator: word.meaning_disambiguator,
          nuance: word.nuance,
          register: word.register,
          firstSeenSentence: word.first_seen_sentence,
          firstSeenSentenceTranslation: word.first_seen_sentence_translation,
          sourceConversationId: params.id
        });
      }
      return completeConversation(params.id, result.summary ?? null);
    }
    return completeConversation(params.id, null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failConversation(params.id, message);
  }
});

app.post("/api/realtime/session", async () => {
  const settings = getSettings();
  if (settings.realtimeProvider !== "openai") {
    throw new Error("The OpenAI session endpoint only supports OpenAI Realtime. Use /api/gemini/live for Gemini Live WebSocket sessions.");
  }
  const dueItems = getDueQuizItems(settings.maxQuizItems);
  return createRealtimeSession({
    settings,
    dueItems
  });
});

if (process.env.NODE_ENV === "production") {
  await app.register(fastifyStatic, {
    root: path.resolve(process.cwd(), "dist"),
    prefix: "/"
  });
}

await app.listen({ host: serverConfig.host, port: serverConfig.port });
