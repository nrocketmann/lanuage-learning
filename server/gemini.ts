import { execFileSync } from "node:child_process";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket as ServerWebSocket } from "ws";
import WebSocket from "ws";
import type { AppSettings, GeminiSmokeAttempt, GeminiSmokeResponse, QuizItem } from "../shared/types";
import { serverConfig } from "./config";
import { buildRealtimeInstructions, buildReviewTool } from "./openai";

const DEVELOPER_LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
const VERTEX_LIVE_MODEL = "gemini-live-2.5-flash-native-audio";
const SMOKE_PROMPT = "Say only: smoke ok.";
const PCM_16KHZ_MIME = "audio/pcm;rate=16000";

type GeminiWireFormat = "developer" | "vertex";
type LiveCredentialSource = Exclude<GeminiSmokeAttempt["credentialSource"], "missing" | "vertex-express-key">;

type LiveConfig = {
  endpoint: Extract<GeminiSmokeAttempt["endpoint"], "developer-api" | "vertex-live">;
  credentialSource: LiveCredentialSource;
  model: string;
  url: string;
  headers?: Record<string, string>;
  setup: unknown;
  startMessage: unknown;
  textMessage: unknown;
  wireFormat: GeminiWireFormat;
};

type LiveSocketInput = {
  type?: string;
  data?: unknown;
  text?: unknown;
  functionResponses?: unknown;
};

function objectFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readGcloudValue(args: string[]) {
  try {
    return execFileSync("gcloud", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000
    }).trim();
  } catch {
    return "";
  }
}

function resolveConfiguredVertexProjectId() {
  return serverConfig.vertexProjectId;
}

function resolveExplicitGcloudProjectId() {
  if (!serverConfig.vertexUseGcloudADC) return "";
  return serverConfig.vertexProjectId || readGcloudValue(["config", "get-value", "project"]);
}

function resolveExplicitGcloudAdcToken() {
  if (!serverConfig.vertexUseGcloudADC) return "";
  return readGcloudValue(["auth", "application-default", "print-access-token"]);
}

function isLikelyGeminiDeveloperApiKey(value: string) {
  return value.startsWith("AIza");
}

function truncateReason(value: unknown) {
  return String(value ?? "").slice(0, 500);
}

function stripModelPrefix(model: string) {
  return model.replace(/^models\//, "");
}

function developerModel(settings: AppSettings) {
  return stripModelPrefix(settings.realtimeModel || DEVELOPER_LIVE_MODEL);
}

function vertexModel(settings: AppSettings) {
  return settings.realtimeModel.startsWith("gemini-live-") ? settings.realtimeModel : VERTEX_LIVE_MODEL;
}

function buildGeminiReviewDeclaration() {
  const tool = buildReviewTool();
  return {
    name: tool.name,
    description: tool.description,
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
          properties: {
            surfaceForm: { type: "string" },
            reading: { type: "string" },
            meaning: { type: "string" },
            meaningDisambiguator: { type: "string" },
            firstSeenSentence: { type: "string" }
          }
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
      required: ["wordSenseId", "direction", "prompt", "expectedAnswer", "userAnswer", "correct", "usedHint"]
    }
  };
}

function buildDeveloperSetup({
  settings,
  dueItems,
  model
}: {
  settings: AppSettings;
  dueItems: QuizItem[];
  model: string;
}) {
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        temperature: 0.8,
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: settings.voice
            }
          }
        }
      },
      systemInstruction: {
        parts: [{ text: buildRealtimeInstructions(settings, dueItems) }]
      },
      tools: [{ functionDeclarations: [buildGeminiReviewDeclaration()] }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          silenceDurationMs: 1200
        },
        activityHandling: "START_OF_ACTIVITY_INTERRUPTS"
      }
    }
  };
}

function buildVertexSetup({
  settings,
  dueItems,
  projectId,
  model
}: {
  settings: AppSettings;
  dueItems: QuizItem[];
  projectId: string;
  model: string;
}) {
  const location = serverConfig.vertexLocation;
  return {
    setup: {
      model: `projects/${projectId}/locations/${location}/publishers/google/models/${model}`,
      generation_config: {
        response_modalities: ["audio"],
        temperature: 0.8,
        speech_config: {
          voice_config: {
            prebuilt_voice_config: {
              voice_name: settings.voice
            }
          }
        }
      },
      system_instruction: {
        parts: [{ text: buildRealtimeInstructions(settings, dueItems) }]
      },
      tools: [{ function_declarations: [buildGeminiReviewDeclaration()] }],
      input_audio_transcription: {},
      output_audio_transcription: {},
      realtime_input_config: {
        automatic_activity_detection: {
          disabled: false,
          silence_duration_ms: 1200
        },
        activity_handling: "START_OF_ACTIVITY_INTERRUPTS"
      }
    }
  };
}

function buildStartMessage(format: GeminiWireFormat) {
  const text = "Start the session now. Follow the STARTUP FLOW from your session instructions. Speak one short opening turn, then wait.";
  if (format === "vertex") {
    return {
      client_content: {
        turns: [{ role: "user", parts: [{ text }] }],
        turn_complete: true
      }
    };
  }
  return {
    clientContent: {
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true
    }
  };
}

function buildTextMessage(format: GeminiWireFormat, text: string) {
  if (format === "vertex") {
    return {
      client_content: {
        turns: [{ role: "user", parts: [{ text }] }],
        turn_complete: true
      }
    };
  }
  return {
    clientContent: {
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true
    }
  };
}

function buildAudioMessage(format: GeminiWireFormat, data: string) {
  if (format === "vertex") {
    return {
      realtime_input: {
        audio: {
          data,
          mime_type: PCM_16KHZ_MIME
        }
      }
    };
  }
  return {
    realtimeInput: {
      audio: {
        data,
        mimeType: PCM_16KHZ_MIME
      }
    }
  };
}

function buildAudioStreamEndMessage(format: GeminiWireFormat) {
  if (format === "vertex") {
    return {
      realtime_input: {
        audio_stream_end: true
      }
    };
  }
  return {
    realtimeInput: {
      audioStreamEnd: true
    }
  };
}

function buildToolResponseMessage(format: GeminiWireFormat, functionResponses: unknown) {
  const responses = Array.isArray(functionResponses) ? functionResponses : [];
  if (format === "vertex") {
    return {
      tool_response: {
        function_responses: responses.map((response) => {
          const typed = objectFrom(response);
          return {
            name: typed.name,
            id: typed.id,
            response: typed.response
          };
        })
      }
    };
  }
  return {
    toolResponse: {
      functionResponses: responses
    }
  };
}

function buildDeveloperConfig({
  apiKey,
  credentialSource,
  settings,
  dueItems
}: {
  apiKey: string;
  credentialSource: LiveCredentialSource;
  settings: AppSettings;
  dueItems: QuizItem[];
}): LiveConfig {
  const model = developerModel(settings);
  return {
    endpoint: "developer-api",
    credentialSource,
    model,
    url: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`,
    setup: buildDeveloperSetup({ settings, dueItems, model }),
    startMessage: buildStartMessage("developer"),
    textMessage: buildTextMessage("developer", SMOKE_PROMPT),
    wireFormat: "developer"
  };
}

function buildVertexConfig({
  bearerToken,
  credentialSource,
  projectId,
  settings,
  dueItems
}: {
  bearerToken: string;
  credentialSource: LiveCredentialSource;
  projectId: string;
  settings: AppSettings;
  dueItems: QuizItem[];
}): LiveConfig {
  const model = vertexModel(settings);
  const location = serverConfig.vertexLocation;
  return {
    endpoint: "vertex-live",
    credentialSource,
    model,
    url: `wss://${location}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`,
    headers: {
      Authorization: `Bearer ${bearerToken}`
    },
    setup: buildVertexSetup({ settings, dueItems, projectId, model }),
    startMessage: buildStartMessage("vertex"),
    textMessage: buildTextMessage("vertex", SMOKE_PROMPT),
    wireFormat: "vertex"
  };
}

function extractText(data: Record<string, unknown>) {
  const chunks: string[] = [];
  const serverContent = objectFrom(data.serverContent ?? data.server_content);
  const modelTurn = objectFrom(serverContent.modelTurn ?? serverContent.model_turn);
  const parts = Array.isArray(modelTurn.parts) ? modelTurn.parts : [];
  for (const part of parts) {
    const text = objectFrom(part).text;
    if (typeof text === "string") chunks.push(text);
  }

  const outputTranscription = objectFrom(serverContent.outputTranscription ?? serverContent.output_transcription);
  if (typeof outputTranscription.text === "string") chunks.push(outputTranscription.text);

  return chunks.join("");
}

function extractAudioBytes(data: Record<string, unknown>) {
  const serverContent = objectFrom(data.serverContent ?? data.server_content);
  const modelTurn = objectFrom(serverContent.modelTurn ?? serverContent.model_turn);
  const parts = Array.isArray(modelTurn.parts) ? modelTurn.parts : [];
  return parts.reduce((total, part) => {
    const inlineData = objectFrom(objectFrom(part).inlineData ?? objectFrom(part).inline_data);
    return typeof inlineData.data === "string" ? total + inlineData.data.length : total;
  }, 0);
}

function isTurnComplete(data: Record<string, unknown>) {
  const serverContent = objectFrom(data.serverContent ?? data.server_content);
  return serverContent.turnComplete === true || serverContent.turn_complete === true;
}

function isSetupComplete(data: Record<string, unknown>) {
  return Boolean(data.setupComplete || data.setup_complete);
}

function extractError(data: Record<string, unknown>) {
  const error = data.error;
  if (!error) return "";
  if (typeof error === "string") return error;
  const typed = objectFrom(error);
  return String(typed.message ?? JSON.stringify(error));
}

function runWebSocketSmoke(config: LiveConfig): Promise<GeminiSmokeAttempt> {
  return new Promise((resolve) => {
    let settled = false;
    let sentPrompt = false;
    let text = "";
    let audioBytes = 0;

    const ws = new WebSocket(config.url, {
      headers: config.headers
    });

    const finish = (attempt: Omit<GeminiSmokeAttempt, "endpoint" | "credentialSource" | "model">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      resolve({
        endpoint: config.endpoint,
        credentialSource: config.credentialSource,
        model: config.model,
        ...attempt
      });
    };

    const sendPrompt = () => {
      if (sentPrompt || ws.readyState !== WebSocket.OPEN) return;
      sentPrompt = true;
      ws.send(JSON.stringify(config.textMessage));
    };

    const timeout = setTimeout(() => {
      finish({
        ok: false,
        error: text || audioBytes ? "Timed out before the model completed a turn." : "Timed out before receiving a Gemini Live response."
      });
    }, 15_000);

    ws.on("open", () => {
      ws.send(JSON.stringify(config.setup));
    });

    ws.on("message", (raw) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }

      const error = extractError(data);
      if (error) {
        finish({ ok: false, error });
        return;
      }

      if (isSetupComplete(data)) sendPrompt();

      text += extractText(data);
      audioBytes += extractAudioBytes(data);

      if (audioBytes > 0) {
        finish({
          ok: true,
          text: text.trim() || `Received Gemini audio output (${audioBytes} base64 characters).`
        });
        return;
      }

      if (text.trim() && isTurnComplete(data)) {
        finish({ ok: true, text: text.trim() });
      }
    });

    ws.on("error", (error) => {
      finish({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

    ws.on("close", (code, reason) => {
      finish({
        ok: false,
        closeCode: code,
        closeReason: truncateReason(reason.toString()),
        error: text.trim() ? undefined : "WebSocket closed before a model response."
      });
    });
  });
}

async function runVertexExpressRestSmoke(apiKey: string): Promise<GeminiSmokeAttempt> {
  try {
    const response = await fetch(`https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{ text: SMOKE_PROMPT }]
        }]
      })
    });
    const body = await response.text();
    if (!response.ok) {
      return {
        endpoint: "vertex-express-rest",
        credentialSource: "vertex-express-key",
        model: "gemini-2.5-flash",
        ok: false,
        error: truncateReason(`${response.status} ${body}`)
      };
    }
    return {
      endpoint: "vertex-express-rest",
      credentialSource: "vertex-express-key",
      model: "gemini-2.5-flash",
      ok: true,
      text: truncateReason(body)
    };
  } catch (error) {
    return {
      endpoint: "vertex-express-rest",
      credentialSource: "vertex-express-key",
      model: "gemini-2.5-flash",
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function resolveLiveConfig(settings: AppSettings, dueItems: QuizItem[]): Promise<LiveConfig> {
  if (serverConfig.geminiApiKey) {
    return buildDeveloperConfig({
      apiKey: serverConfig.geminiApiKey,
      credentialSource: "gemini-api-key",
      settings,
      dueItems
    });
  }

  if (serverConfig.vertexKey && isLikelyGeminiDeveloperApiKey(serverConfig.vertexKey)) {
    return buildDeveloperConfig({
      apiKey: serverConfig.vertexKey,
      credentialSource: "vertex-key",
      settings,
      dueItems
    });
  }

  const configuredProjectId = resolveConfiguredVertexProjectId();
  if (serverConfig.vertexAccessToken && configuredProjectId) {
    return buildVertexConfig({
      bearerToken: serverConfig.vertexAccessToken,
      credentialSource: "vertex-access-token",
      projectId: configuredProjectId,
      settings,
      dueItems
    });
  }

  if (serverConfig.vertexUseGcloudADC) {
    const projectId = resolveExplicitGcloudProjectId();
    const token = resolveExplicitGcloudAdcToken();
    if (projectId && token) {
      return buildVertexConfig({
        bearerToken: token,
        credentialSource: "gcloud-adc",
        projectId,
        settings,
        dueItems
      });
    }
  }

  const projectHint = configuredProjectId ? "" : " Set VERTEX_PROJECT_ID for Vertex Live.";
  const gcloudHint = serverConfig.vertexUseGcloudADC ? " Explicit gcloud ADC was enabled but did not provide a project/token." : " Local gcloud ADC is disabled unless VERTEX_USE_GCLOUD_ADC=true.";
  const expressHint = serverConfig.vertexKey ? " VERTEX_KEY appears to be a Vertex/Agent Platform API key; it can be useful for REST Express calls, but this Live WebSocket needs a Gemini API key or Vertex OAuth credential." : "";
  throw new Error(`No usable Gemini Live WebSocket credential is configured. Set GEMINI_API_KEY/GOOGLE_API_KEY for the Gemini Developer Live API, or set VERTEX_PROJECT_ID plus VERTEX_ACCESS_TOKEN for Vertex Live.${projectHint}${gcloudHint}${expressHint}`);
}

function safeSend(socket: ServerWebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function safeUpstreamSend(upstream: WebSocket | null, payload: unknown) {
  if (upstream?.readyState === WebSocket.OPEN) {
    upstream.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

export async function handleGeminiLiveSocket({
  socket,
  settings,
  dueItems,
  log
}: {
  socket: ServerWebSocket;
  settings: AppSettings;
  dueItems: QuizItem[];
  log: FastifyBaseLogger;
}) {
  let upstream: WebSocket | null = null;
  let upstreamConfig: LiveConfig | null = null;
  let readyForInput = false;
  let startupPromptSent = false;
  const queuedInputs: unknown[] = [];

  const queueOrSend = (payload: unknown) => {
    if (readyForInput && safeUpstreamSend(upstream, payload)) return;
    queuedInputs.push(payload);
    if (queuedInputs.length > 300) queuedInputs.shift();
  };

  const flushQueuedInputs = () => {
    while (readyForInput && queuedInputs.length) {
      const payload = queuedInputs.shift();
      if (!safeUpstreamSend(upstream, payload)) {
        if (payload) queuedInputs.unshift(payload);
        return;
      }
    }
  };

  const closeUpstream = () => {
    if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
    safeUpstreamSend(upstream, buildAudioStreamEndMessage(upstreamConfig?.wireFormat ?? "developer"));
    upstream.close();
  };

  socket.on("message", (raw) => {
    let input: LiveSocketInput;
    try {
      input = JSON.parse(raw.toString()) as LiveSocketInput;
    } catch {
      safeSend(socket, { type: "error", error: "Could not parse browser WebSocket message." });
      return;
    }

    const format = upstreamConfig?.wireFormat ?? "developer";
    if (input.type === "audio" && typeof input.data === "string") {
      queueOrSend(buildAudioMessage(format, input.data));
      return;
    }
    if (input.type === "tool_response") {
      queueOrSend(buildToolResponseMessage(format, input.functionResponses));
      return;
    }
    if (input.type === "client_text" && typeof input.text === "string") {
      queueOrSend(buildTextMessage(format, input.text));
      return;
    }
    if (input.type === "audio_stream_end") {
      queueOrSend(buildAudioStreamEndMessage(format));
    }
  });

  socket.on("close", () => {
    closeUpstream();
  });

  try {
    safeSend(socket, { type: "status", status: "Resolving Gemini Live credentials" });
    upstreamConfig = await resolveLiveConfig(settings, dueItems);
    safeSend(socket, {
      type: "status",
      status: `Connecting to ${upstreamConfig.endpoint} with ${upstreamConfig.credentialSource}`
    });

    upstream = new WebSocket(upstreamConfig.url, {
      headers: upstreamConfig.headers
    });

    upstream.on("open", () => {
      if (!upstreamConfig) return;
      safeSend(socket, { type: "status", status: "Configuring Gemini Live session" });
      upstream?.send(JSON.stringify(upstreamConfig.setup));
    });

    upstream.on("message", (raw) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        safeSend(socket, { type: "event", event: { raw: raw.toString() } });
        return;
      }

      safeSend(socket, { type: "event", event });

      const error = extractError(event);
      if (error) {
        safeSend(socket, { type: "error", error });
      }

      if (isSetupComplete(event) && upstreamConfig && !startupPromptSent) {
        startupPromptSent = true;
        readyForInput = true;
        safeUpstreamSend(upstream, upstreamConfig.startMessage);
        flushQueuedInputs();
        safeSend(socket, { type: "status", status: "Connected" });
      }
    });

    upstream.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      log.warn({ err: error }, "Gemini Live upstream error");
      safeSend(socket, { type: "error", error: message });
    });

    upstream.on("close", (code, reason) => {
      const closeReason = truncateReason(reason.toString());
      readyForInput = false;
      safeSend(socket, {
        type: code === 1000 ? "status" : "error",
        status: code === 1000 ? "Gemini Live closed" : undefined,
        error: code === 1000 ? undefined : `Gemini Live closed (${code}) ${closeReason || "without a reason."}`
      });
      if (socket.readyState === WebSocket.OPEN) socket.close();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    safeSend(socket, { type: "error", error: message });
    if (socket.readyState === WebSocket.OPEN) socket.close(1011, "Gemini Live setup failed");
  }
}

export async function smokeGeminiLive(settings: AppSettings): Promise<GeminiSmokeResponse> {
  const attempts: GeminiSmokeAttempt[] = [];
  const emptyDueItems: QuizItem[] = [];

  if (serverConfig.geminiApiKey) {
    attempts.push(await runWebSocketSmoke(buildDeveloperConfig({
      apiKey: serverConfig.geminiApiKey,
      credentialSource: "gemini-api-key",
      settings,
      dueItems: emptyDueItems
    })));
  }

  if (!attempts.some((attempt) => attempt.ok) && serverConfig.vertexKey && isLikelyGeminiDeveloperApiKey(serverConfig.vertexKey)) {
    attempts.push(await runWebSocketSmoke(buildDeveloperConfig({
      apiKey: serverConfig.vertexKey,
      credentialSource: "vertex-key",
      settings,
      dueItems: emptyDueItems
    })));
  }

  const configuredProjectId = resolveConfiguredVertexProjectId();
  if (!attempts.some((attempt) => attempt.ok) && serverConfig.vertexAccessToken && configuredProjectId) {
    attempts.push(await runWebSocketSmoke(buildVertexConfig({
      bearerToken: serverConfig.vertexAccessToken,
      credentialSource: "vertex-access-token",
      projectId: configuredProjectId,
      settings,
      dueItems: emptyDueItems
    })));
  }

  if (!attempts.some((attempt) => attempt.ok) && serverConfig.vertexUseGcloudADC) {
    const projectId = resolveExplicitGcloudProjectId();
    const token = resolveExplicitGcloudAdcToken();
    if (projectId && token) {
      attempts.push(await runWebSocketSmoke(buildVertexConfig({
        bearerToken: token,
        credentialSource: "gcloud-adc",
        projectId,
        settings,
        dueItems: emptyDueItems
      })));
    } else {
      attempts.push({
        endpoint: "vertex-live",
        credentialSource: "gcloud-adc",
        model: vertexModel(settings),
        ok: false,
        error: "VERTEX_USE_GCLOUD_ADC=true, but gcloud did not return both a project and an ADC access token."
      });
    }
  }

  if (serverConfig.vertexKey) {
    attempts.push(await runVertexExpressRestSmoke(serverConfig.vertexKey));
  }

  if (!attempts.length) {
    attempts.push({
      endpoint: "developer-api",
      credentialSource: "missing",
      model: DEVELOPER_LIVE_MODEL,
      ok: false,
      error: "Missing GEMINI_API_KEY/GOOGLE_API_KEY for Gemini Developer Live, or VERTEX_PROJECT_ID plus VERTEX_ACCESS_TOKEN for Vertex Live."
    });
  }

  return {
    ok: attempts.some((attempt) => attempt.ok && attempt.endpoint !== "vertex-express-rest"),
    attempts
  };
}
