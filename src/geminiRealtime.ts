import type { TranscriptEntry } from "../shared/types";
import type { QuizReviewToolArgs } from "./realtime";

type GeminiRealtimeOptions = {
  onStatus: (status: string) => void;
  onTranscript: (entry: TranscriptEntry) => void;
  onEvent: (type: string, payload: unknown) => void;
  onQuizReview: (args: QuizReviewToolArgs) => Promise<unknown>;
};

type GeminiFunctionCall = {
  id: string;
  name: string;
  args: unknown;
};

function objectFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function base64ToInt16(base64: string) {
  const bytes = base64ToBytes(base64);
  return new Int16Array(bytes.buffer);
}

function downsampleTo16BitPcm(input: Float32Array, inputRate: number, outputRate = 16000) {
  if (inputRate === outputRate) return floatsTo16BitPcm(input);

  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new ArrayBuffer(outputLength * 2);
  const view = new DataView(output);

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(input.length, Math.floor((outputIndex + 1) * ratio));
    let sum = 0;
    let count = 0;

    for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
      sum += input[inputIndex];
      count += 1;
    }

    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, count)));
    view.setInt16(outputIndex * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return new Uint8Array(output);
}

function floatsTo16BitPcm(input: Float32Array) {
  const output = new ArrayBuffer(input.length * 2);
  const view = new DataView(output);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(output);
}

function inlineAudioChunks(event: Record<string, unknown>) {
  const chunks: Array<{ data: string; sampleRate: number }> = [];
  const serverContent = objectFrom(event.serverContent ?? event.server_content);
  const modelTurn = objectFrom(serverContent.modelTurn ?? serverContent.model_turn);
  const parts = Array.isArray(modelTurn.parts) ? modelTurn.parts : [];

  for (const part of parts) {
    const typed = objectFrom(part);
    const inlineData = objectFrom(typed.inlineData ?? typed.inline_data);
    const data = inlineData.data;
    if (typeof data !== "string") continue;
    const mimeType = String(inlineData.mimeType ?? inlineData.mime_type ?? "");
    const rateMatch = /rate=(\d+)/.exec(mimeType);
    chunks.push({
      data,
      sampleRate: rateMatch ? Number(rateMatch[1]) : 24000
    });
  }

  return chunks;
}

function transcriptionEntries(event: Record<string, unknown>): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const serverContent = objectFrom(event.serverContent ?? event.server_content);
  const inputTranscription = objectFrom(serverContent.inputTranscription ?? serverContent.input_transcription);
  const outputTranscription = objectFrom(serverContent.outputTranscription ?? serverContent.output_transcription);

  if (typeof inputTranscription.text === "string" && inputTranscription.text.trim()) {
    entries.push({ role: "user", text: inputTranscription.text.trim() });
  }

  if (typeof outputTranscription.text === "string" && outputTranscription.text.trim()) {
    entries.push({ role: "assistant", text: outputTranscription.text.trim() });
  }

  return entries;
}

function isInterrupted(event: Record<string, unknown>) {
  const serverContent = objectFrom(event.serverContent ?? event.server_content);
  return serverContent.interrupted === true;
}

function extractFunctionCalls(event: Record<string, unknown>): GeminiFunctionCall[] {
  const toolCall = objectFrom(event.toolCall ?? event.tool_call);
  const rawCalls = toolCall.functionCalls ?? toolCall.function_calls;
  if (!Array.isArray(rawCalls)) return [];

  return rawCalls.flatMap((rawCall, index) => {
    const call = objectFrom(rawCall);
    const name = call.name;
    if (typeof name !== "string") return [];
    const id = typeof call.id === "string" ? call.id : `${name}-${index}-${JSON.stringify(call.args ?? {})}`;
    return [{
      id,
      name,
      args: call.args ?? {}
    }];
  });
}

function parseQuizReviewArgs(args: unknown): QuizReviewToolArgs {
  const value = typeof args === "string" ? JSON.parse(args) as unknown : args;
  const object = objectFrom(value);
  return {
    wordSenseId: Number(object.wordSenseId),
    direction: object.direction === "production" ? "production" : "recognition",
    prompt: String(object.prompt ?? ""),
    expectedAnswer: object.expectedAnswer ?? {},
    userAnswer: String(object.userAnswer ?? ""),
    correct: object.correct === true,
    usedHint: object.usedHint === true
  };
}

function redactInlineAudio(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactInlineAudio);
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if ((key === "inlineData" || key === "inline_data") && child && typeof child === "object") {
      const inline = { ...(child as Record<string, unknown>) };
      if (typeof inline.data === "string") inline.data = `[audio omitted: ${inline.data.length} base64 chars]`;
      output[key] = inline;
    } else {
      output[key] = redactInlineAudio(child);
    }
  }
  return output;
}

function bridgeUrl() {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/api/gemini/live`;
}

export async function connectGeminiRealtime(options: GeminiRealtimeOptions) {
  options.onStatus("Opening Gemini bridge");

  const ws = new WebSocket(bridgeUrl());
  const handledToolCalls = new Set<string>();
  const outputContext = new AudioContext();
  const outputSources = new Set<AudioBufferSourceNode>();
  let inputContext: AudioContext | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let stream: MediaStream | null = null;
  let playhead = 0;
  let closed = false;
  let opened = false;

  const stopPlayback = () => {
    for (const source of outputSources) {
      try {
        source.stop();
      } catch {
        // The node may have already ended naturally.
      }
    }
    outputSources.clear();
    playhead = outputContext.currentTime;
  };

  const playPcm16 = (base64: string, sampleRate: number) => {
    const samples = base64ToInt16(base64);
    if (!samples.length) return;

    const buffer = outputContext.createBuffer(1, samples.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) {
      channel[index] = samples[index] / 0x8000;
    }

    const source = outputContext.createBufferSource();
    source.buffer = buffer;
    source.connect(outputContext.destination);
    source.onended = () => outputSources.delete(source);

    const startAt = Math.max(outputContext.currentTime + 0.02, playhead);
    source.start(startAt);
    playhead = startAt + buffer.duration;
    outputSources.add(source);
  };

  const sendToolResponse = (name: string, id: string, response: unknown) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: "tool_response",
      functionResponses: [{ name, id, response }]
    }));
  };

  const handleToolCalls = async (event: Record<string, unknown>) => {
    for (const call of extractFunctionCalls(event)) {
      if (call.name !== "record_quiz_review" || handledToolCalls.has(call.id)) continue;
      handledToolCalls.add(call.id);

      try {
        const args = parseQuizReviewArgs(call.args);
        const result = await options.onQuizReview(args);
        sendToolResponse(call.name, call.id, { ok: true, result });
      } catch (error) {
        sendToolResponse(call.name, call.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  const handleGeminiEvent = (event: Record<string, unknown>) => {
    options.onEvent("gemini_event", redactInlineAudio(event));

    if (isInterrupted(event)) stopPlayback();

    for (const chunk of inlineAudioChunks(event)) {
      playPcm16(chunk.data, chunk.sampleRate);
    }

    for (const entry of transcriptionEntries(event)) {
      options.onTranscript(entry);
    }

    void handleToolCalls(event);
  };

  const openPromise = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("Timed out opening Gemini bridge."));
    }, 15_000);

    ws.onopen = () => {
      opened = true;
      window.clearTimeout(timeout);
      resolve();
    };

    ws.onerror = () => {
      if (!opened) {
        window.clearTimeout(timeout);
        reject(new Error("Could not open Gemini bridge."));
      }
    };
  });

  ws.onmessage = (message) => {
    try {
      const payload = JSON.parse(String(message.data)) as Record<string, unknown>;
      if (payload.type === "status" && typeof payload.status === "string") {
        options.onStatus(payload.status);
        return;
      }
      if (payload.type === "error" && typeof payload.error === "string") {
        options.onStatus(`Gemini error: ${payload.error}`);
        return;
      }
      if (payload.type === "event") {
        handleGeminiEvent(objectFrom(payload.event));
      }
    } catch {
      options.onEvent("gemini_unparsed", message.data);
    }
  };

  ws.onclose = () => {
    if (!closed) options.onStatus("Gemini bridge closed");
  };

  try {
    await openPromise;
    await outputContext.resume();

    options.onStatus("Requesting microphone");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    inputContext = new AudioContext();
    await inputContext.resume();
    sourceNode = inputContext.createMediaStreamSource(stream);
    processor = inputContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      if (closed || ws.readyState !== WebSocket.OPEN || !inputContext) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm = downsampleTo16BitPcm(input, inputContext.sampleRate);
      ws.send(JSON.stringify({
        type: "audio",
        data: bytesToBase64(pcm)
      }));
    };

    sourceNode.connect(processor);
    processor.connect(inputContext.destination);
    options.onStatus("Connected");
  } catch (error) {
    closed = true;
    ws.close();
    await outputContext.close().catch(() => undefined);
    throw error;
  }

  return {
    close() {
      closed = true;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "audio_stream_end" }));
        ws.close();
      }
      processor?.disconnect();
      sourceNode?.disconnect();
      for (const track of stream?.getTracks() ?? []) track.stop();
      void inputContext?.close();
      stopPlayback();
      void outputContext.close();
      options.onStatus("Closed");
    }
  };
}
