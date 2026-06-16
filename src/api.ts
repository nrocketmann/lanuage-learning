import type { AppSettings, Conversation, HealthResponse, QuizItem, TranscriptEntry, WordSense } from "../shared/types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    headers
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<HealthResponse>("/api/health"),
  getSettings: () => request<AppSettings>("/api/settings"),
  updateSettings: (settings: AppSettings) => request<AppSettings>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings)
  }),
  listWords: () => request<WordSense[]>("/api/word-senses"),
  createWord: (word: Partial<WordSense> & { surfaceForm: string; meaning: string }) => request<WordSense>("/api/word-senses", {
    method: "POST",
    body: JSON.stringify(word)
  }),
  updateWord: (id: number, word: Partial<WordSense>) => request<WordSense>(`/api/word-senses/${id}`, {
    method: "PATCH",
    body: JSON.stringify(word)
  }),
  deleteWord: (id: number) => request<void>(`/api/word-senses/${id}`, { method: "DELETE" }),
  dueQuiz: () => request<QuizItem[]>("/api/quiz/due"),
  review: (payload: {
    wordSenseId: number;
    direction: "recognition" | "production";
    prompt: string;
    expectedAnswer: unknown;
    userAnswer?: string;
    correct: boolean;
    usedHint: boolean;
  }) => request<WordSense>("/api/reviews", {
    method: "POST",
    body: JSON.stringify(payload)
  }),
  createConversation: () => request<Conversation>("/api/conversations", { method: "POST", body: "{}" }),
  listConversations: () => request<Conversation[]>("/api/conversations"),
  addEvent: (conversationId: number, payload: { type: string; payload: unknown; timestampMs?: number }) =>
    request<{ ok: true }>(`/api/conversations/${conversationId}/events`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  endConversation: (conversationId: number, transcript: TranscriptEntry[], fallbackNotes: string) =>
    request<Conversation>(`/api/conversations/${conversationId}/end`, {
      method: "POST",
      body: JSON.stringify({ transcript, fallbackNotes })
    })
};
