import type { Direction, TranscriptEntry } from "../shared/types";

type RealtimeClientOptions = {
  onStatus: (status: string) => void;
  onTranscript: (entry: TranscriptEntry) => void;
  onEvent: (type: string, payload: unknown) => void;
  onQuizReview: (args: QuizReviewToolArgs) => Promise<unknown>;
};

export type QuizReviewToolArgs = {
  wordSenseId: number;
  direction: Direction;
  prompt: string;
  expectedAnswer: unknown;
  userAnswer: string;
  correct: boolean;
  usedHint: boolean;
};

type RealtimeTokenResponse = {
  value?: string;
  client_secret?: {
    value?: string;
  };
};

function parseTextFromEvent(event: Record<string, unknown>) {
  const textKeys = ["transcript", "text", "delta"];
  for (const key of textKeys) {
    const value = event[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const item = event.item;
  if (item && typeof item === "object") {
    const content = (item as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const typed = part as { transcript?: unknown; text?: unknown };
          return typeof typed.transcript === "string" ? typed.transcript : typeof typed.text === "string" ? typed.text : "";
        })
        .filter(Boolean)
        .join(" ");
    }
  }
  return "";
}

export async function connectRealtime(options: RealtimeClientOptions) {
  options.onStatus("Requesting microphone");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
  const peer = new RTCPeerConnection();
  const audio = new Audio();
  audio.autoplay = true;
  const handledToolCalls = new Set<string>();

  peer.ontrack = (event) => {
    audio.srcObject = event.streams[0];
  };

  for (const track of stream.getTracks()) {
    peer.addTrack(track, stream);
  }

  const dataChannel = peer.createDataChannel("oai-events");
  dataChannel.onopen = () => {
    options.onStatus("Connected");
    dataChannel.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: "Start the session now. Follow the STARTUP FLOW from your session instructions. Speak one short opening turn, then wait."
      }
    }));
  };

  const sendToolOutput = (callId: string, output: unknown) => {
    dataChannel.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output)
      }
    }));
    dataChannel.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: "Continue from the quiz tool result. Do not repeat completed quiz items."
      }
    }));
  };

  const maybeHandleToolCall = async (event: Record<string, unknown>) => {
    const candidate = extractToolCall(event);
    if (!candidate || candidate.name !== "record_quiz_review") return;
    if (handledToolCalls.has(candidate.callId)) return;
    handledToolCalls.add(candidate.callId);

    try {
      const parsed = JSON.parse(candidate.arguments) as QuizReviewToolArgs;
      const result = await options.onQuizReview(parsed);
      sendToolOutput(candidate.callId, { ok: true, result });
    } catch (error) {
      sendToolOutput(candidate.callId, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  dataChannel.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as Record<string, unknown>;
      const type = typeof event.type === "string" ? event.type : "event";
      options.onEvent(type, event);
      void maybeHandleToolCall(event);

      if (type.includes("input_audio_transcription") && type.endsWith("completed")) {
        const text = parseTextFromEvent(event);
        if (text) options.onTranscript({ role: "user", text });
      }

      if ((type.includes("audio_transcript") || type.includes("output_text")) && (type.endsWith("done") || type.endsWith("completed"))) {
        const text = parseTextFromEvent(event);
        if (text) options.onTranscript({ role: "assistant", text });
      }

      const error = event.error;
      if (error) options.onStatus(`Realtime error: ${JSON.stringify(error)}`);
    } catch (error) {
      options.onEvent("unparsed", message.data);
    }
  };

  options.onStatus("Minting session");
  const tokenResponse = await fetch("/api/realtime/session", {
    method: "POST"
  });
  if (!tokenResponse.ok) {
    throw new Error(await tokenResponse.text());
  }
  const tokenData = (await tokenResponse.json()) as RealtimeTokenResponse;
  const ephemeralKey = tokenData.value ?? tokenData.client_secret?.value;
  if (!ephemeralKey) {
    throw new Error("Realtime session response did not include an ephemeral token.");
  }

  options.onStatus("Creating offer");
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);

  options.onStatus("Connecting to OpenAI");
  const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${ephemeralKey}`,
      "Content-Type": "application/sdp"
    }
  });

  if (!sdpResponse.ok) {
    throw new Error(await sdpResponse.text());
  }

  const answerSdp = await sdpResponse.text();
  await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });

  return {
    close() {
      dataChannel.close();
      peer.close();
      for (const track of stream.getTracks()) track.stop();
      audio.pause();
      options.onStatus("Closed");
    }
  };
}

function extractToolCall(event: Record<string, unknown>) {
  const directName = typeof event.name === "string" ? event.name : null;
  const directCallId = typeof event.call_id === "string" ? event.call_id : null;
  const directArgs = typeof event.arguments === "string" ? event.arguments : null;

  if (directName && directCallId && directArgs && String(event.type).includes("function_call_arguments")) {
    return {
      name: directName,
      callId: directCallId,
      arguments: directArgs
    };
  }

  const item = event.item;
  if (item && typeof item === "object") {
    const typed = item as Record<string, unknown>;
    const itemType = typeof typed.type === "string" ? typed.type : "";
    const name = typeof typed.name === "string" ? typed.name : null;
    const callId = typeof typed.call_id === "string" ? typed.call_id : null;
    const args = typeof typed.arguments === "string" ? typed.arguments : null;
    if (itemType === "function_call" && name && callId && args) {
      return {
        name,
        callId,
        arguments: args
      };
    }
  }

  return null;
}
