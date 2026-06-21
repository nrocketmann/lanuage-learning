import { recordUsageEvent } from "./db";

type UsageBreakdown = {
  inputTextTokens: number;
  cachedInputTextTokens: number;
  outputTextTokens: number;
  inputAudioTokens: number;
  cachedInputAudioTokens: number;
  outputAudioTokens: number;
};

type ModelPricing = {
  inputText: number;
  cachedInputText: number;
  outputText: number;
  inputAudio?: number;
  cachedInputAudio?: number;
  outputAudio?: number;
};

const pricingPerMillionTokens: Record<string, ModelPricing> = {
  "gpt-5.5": {
    inputText: 5,
    cachedInputText: 0.5,
    outputText: 30
  },
  "gpt-5.4": {
    inputText: 2.5,
    cachedInputText: 0.25,
    outputText: 15
  },
  "gpt-5.4-mini": {
    inputText: 0.75,
    cachedInputText: 0.075,
    outputText: 4.5
  },
  "gpt-realtime-2": {
    inputText: 4,
    cachedInputText: 0.4,
    outputText: 24,
    inputAudio: 32,
    cachedInputAudio: 0.4,
    outputAudio: 64
  },
  "gemini-live-2.5-flash-native-audio": {
    inputText: 0.5,
    cachedInputText: 0,
    outputText: 2,
    inputAudio: 3,
    cachedInputAudio: 0,
    outputAudio: 12
  },
  "gemini-2.5-flash-native-audio-preview-12-2025": {
    inputText: 0.5,
    cachedInputText: 0,
    outputText: 2,
    inputAudio: 3,
    cachedInputAudio: 0,
    outputAudio: 12
  }
};

const emptyUsage: UsageBreakdown = {
  inputTextTokens: 0,
  cachedInputTextTokens: 0,
  outputTextTokens: 0,
  inputAudioTokens: 0,
  cachedInputAudioTokens: 0,
  outputAudioTokens: 0
};

function numberFrom(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function objectFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function nestedNumber(source: Record<string, unknown>, path: string[]) {
  let current: unknown = source;
  for (const key of path) {
    current = objectFrom(current)[key];
  }
  return numberFrom(current);
}

function camelOrSnakeNumber(source: Record<string, unknown>, camelKey: string, snakeKey: string) {
  return numberFrom(source[camelKey]) || numberFrom(source[snakeKey]);
}

function detailsTokenCount(source: unknown, modality: string) {
  const details = Array.isArray(source) ? source : [];
  return details.reduce((sum, detail) => {
    const typed = objectFrom(detail);
    const detailModality = String(typed.modality ?? "").toLowerCase();
    if (detailModality !== modality) return sum;
    return sum + camelOrSnakeNumber(typed, "tokenCount", "token_count");
  }, 0);
}

function estimateCostUsd(model: string, usage: UsageBreakdown) {
  const pricing = pricingPerMillionTokens[model.toLowerCase()];
  if (!pricing) return 0;

  const billableInputText = Math.max(0, usage.inputTextTokens - usage.cachedInputTextTokens);
  const billableInputAudio = Math.max(0, usage.inputAudioTokens - usage.cachedInputAudioTokens);
  const total =
    billableInputText * pricing.inputText +
    usage.cachedInputTextTokens * pricing.cachedInputText +
    usage.outputTextTokens * pricing.outputText +
    billableInputAudio * (pricing.inputAudio ?? pricing.inputText) +
    usage.cachedInputAudioTokens * (pricing.cachedInputAudio ?? pricing.cachedInputText) +
    usage.outputAudioTokens * (pricing.outputAudio ?? pricing.outputText);

  return total / 1_000_000;
}

function idFromResponse(response: Record<string, unknown>) {
  const direct = response.id;
  if (typeof direct === "string") return direct;
  const nested = objectFrom(response.response).id;
  return typeof nested === "string" ? nested : null;
}

export function recordResponsesUsage({
  conversationId,
  operation,
  model,
  response
}: {
  conversationId?: number | null;
  operation: string;
  model: string;
  response: unknown;
}) {
  const typed = objectFrom(response);
  const usage = objectFrom(typed.usage);
  if (!Object.keys(usage).length) return;

  const details = objectFrom(usage.input_tokens_details);
  const breakdown = {
    ...emptyUsage,
    inputTextTokens: numberFrom(usage.input_tokens),
    cachedInputTextTokens: numberFrom(details.cached_tokens),
    outputTextTokens: numberFrom(usage.output_tokens)
  };

  recordUsageEvent({
    conversationId,
    operation,
    model,
    ...breakdown,
    estimatedCostUsd: estimateCostUsd(model, breakdown),
    rawUsage: usage,
    idempotencyKey: idFromResponse(typed) ? `responses:${operation}:${idFromResponse(typed)}` : null
  });
}

export function recordRealtimeUsageFromEvent({
  conversationId,
  model,
  payload
}: {
  conversationId: number;
  model: string;
  payload: unknown;
}) {
  const event = objectFrom(payload);
  const response = objectFrom(event.response);
  const usage = objectFrom(event.usage ?? response.usage);
  if (!Object.keys(usage).length) return;

  const inputDetails = objectFrom(usage.input_token_details ?? usage.input_tokens_details);
  const outputDetails = objectFrom(usage.output_token_details ?? usage.output_tokens_details);
  const cachedDetails = objectFrom(inputDetails.cached_tokens_details);
  const inputTokens = numberFrom(usage.input_tokens);
  const outputTokens = numberFrom(usage.output_tokens);
  const inputAudioTokens = numberFrom(inputDetails.audio_tokens);
  const outputAudioTokens = numberFrom(outputDetails.audio_tokens);
  const inputTextTokens = numberFrom(inputDetails.text_tokens) || Math.max(0, inputTokens - inputAudioTokens);
  const outputTextTokens = numberFrom(outputDetails.text_tokens) || Math.max(0, outputTokens - outputAudioTokens);

  const breakdown = {
    inputTextTokens,
    cachedInputTextTokens: numberFrom(inputDetails.cached_text_tokens) || nestedNumber(cachedDetails, ["text_tokens"]),
    outputTextTokens,
    inputAudioTokens,
    cachedInputAudioTokens: numberFrom(inputDetails.cached_audio_tokens) || nestedNumber(cachedDetails, ["audio_tokens"]),
    outputAudioTokens
  };

  const responseId = typeof response.id === "string" ? response.id : idFromResponse(event);
  recordUsageEvent({
    conversationId,
    operation: "realtime_response",
    model,
    ...breakdown,
    estimatedCostUsd: estimateCostUsd(model, breakdown),
    rawUsage: usage,
    idempotencyKey: responseId ? `realtime:${responseId}` : null
  });
}

export function recordGeminiLiveUsageFromEvent({
  conversationId,
  model,
  payload,
  sequence
}: {
  conversationId?: number | null;
  model: string;
  payload: unknown;
  sequence: number;
}) {
  const event = objectFrom(payload);
  const usage = objectFrom(event.usageMetadata ?? event.usage_metadata);
  if (!Object.keys(usage).length) return;

  const promptDetails = usage.promptTokensDetails ?? usage.prompt_tokens_details;
  const candidateDetails = usage.candidatesTokensDetails ?? usage.candidates_tokens_details;
  const promptTokenCount = camelOrSnakeNumber(usage, "promptTokenCount", "prompt_token_count");
  const candidateTokenCount = camelOrSnakeNumber(usage, "candidatesTokenCount", "candidates_token_count");
  const inputAudioTokens = detailsTokenCount(promptDetails, "audio");
  const outputAudioTokens = detailsTokenCount(candidateDetails, "audio");
  const inputTextTokens = detailsTokenCount(promptDetails, "text") || Math.max(0, promptTokenCount - inputAudioTokens);
  const outputTextTokens = detailsTokenCount(candidateDetails, "text") || Math.max(0, candidateTokenCount - outputAudioTokens);

  const breakdown = {
    inputTextTokens,
    cachedInputTextTokens: 0,
    outputTextTokens,
    inputAudioTokens,
    cachedInputAudioTokens: 0,
    outputAudioTokens
  };

  recordUsageEvent({
    conversationId,
    operation: "gemini_live_turn",
    model,
    ...breakdown,
    estimatedCostUsd: estimateCostUsd(model, breakdown),
    rawUsage: usage,
    idempotencyKey: conversationId ? `gemini-live:${conversationId}:${sequence}` : null
  });
}
