import { BookOpen, Check, Circle, Mic, Plus, Settings, Sparkles, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, Conversation, HealthResponse, QuizItem, TranscriptEntry, UsageSummary, WordSense } from "../shared/types";
import { api } from "./api";
import { connectGeminiRealtime } from "./geminiRealtime";
import { connectRealtime } from "./realtime";

type Tab = "talk" | "words" | "settings";

const emptyWord = {
  surfaceForm: "",
  reading: "",
  meaning: "",
  meaningDisambiguator: "",
  firstSeenSentence: "",
  firstSeenSentenceTranslation: ""
};

const languageOptions = ["English", "Japanese", "Spanish", "French", "Korean", "Mandarin Chinese"];
const targetLanguageOptions = ["Japanese", "Spanish", "French", "Korean", "Mandarin Chinese", "English"];
const openAIRealtimeModelOptions = ["gpt-realtime-2"];
const geminiRealtimeModelOptions = ["gemini-live-2.5-flash-native-audio", "gemini-2.5-flash-native-audio-preview-12-2025"];
const offlineModelOptions = ["gpt-5.4-mini", "gpt-5.4", "gpt-5.5"];
const openAIVoiceOptions = ["marin", "cedar", "alloy", "verse", "shimmer"];
const geminiVoiceOptions = ["Puck", "Charon", "Kore", "Fenrir", "Aoede"];
const partnerStyleOptions = [
  "patient conversation partner",
  "friendly commute companion",
  "mostly Japanese tutor",
  "casual language exchange partner"
];
const quizItemOptions = [5, 10, 15, 20];
const reviewTargetOptions = [1, 2, 3, 4, 5];
const sessionMinuteOptions = [10, 15, 20, 30, 45, 60];

function scoreText(word: WordSense) {
  return `R ${word.tracks.recognition.netScore} / P ${word.tracks.production.netScore}`;
}

function formatUsd(value?: number) {
  const amount = value ?? 0;
  if (amount > 0 && amount < 0.01) return "<$0.01";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

function formatUsageDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "No usage yet";
}

function optionValues<T extends string | number>(options: T[], current: T) {
  return options.includes(current) ? options : [current, ...options];
}

function realtimeModelOptionsFor(provider: AppSettings["realtimeProvider"]) {
  return provider === "gemini" ? geminiRealtimeModelOptions : openAIRealtimeModelOptions;
}

function voiceOptionsFor(provider: AppSettings["realtimeProvider"]) {
  return provider === "gemini" ? geminiVoiceOptions : openAIVoiceOptions;
}

function providerLabel(provider: AppSettings["realtimeProvider"] | undefined) {
  return provider === "gemini" ? "Gemini Live" : "OpenAI Realtime";
}

function quizPrompt(item: QuizItem) {
  const word = item.wordSense;
  if (item.track.direction === "recognition") {
    return word.firstSeenSentence
      ? `In this sentence, what does "${word.surfaceForm}" mean? ${word.firstSeenSentence}`
      : `What does "${word.surfaceForm}" mean in the sense "${word.meaningDisambiguator || word.meaning}"?`;
  }
  return `How would you say "${word.meaningDisambiguator || word.meaning}" in ${word.surfaceForm ? "Japanese" : "the target language"}?`;
}

export function App() {
  const [tab, setTab] = useState<Tab>("talk");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [words, setWords] = useState<WordSense[]>([]);
  const [quiz, setQuiz] = useState<QuizItem[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [nextHealth, nextUsage, nextSettings, nextWords, nextQuiz, nextConversations] = await Promise.all([
      api.health(),
      api.usage(),
      api.getSettings(),
      api.listWords(),
      api.dueQuiz(),
      api.listConversations()
    ]);
    setHealth(nextHealth);
    setUsage(nextUsage);
    setSettings(nextSettings);
    setWords(nextWords);
    setQuiz(nextQuiz);
    setConversations(nextConversations);
  }, []);

  useEffect(() => {
    refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [refresh]);

  const saveSettings = async (next: AppSettings) => {
    setBusy(true);
    setError(null);
    try {
      setSettings(await api.updateSettings(next));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Sparkles size={22} /></span>
          <div>
            <strong>Voice SRS</strong>
            <span>{settings?.targetLanguage ?? "Language"} practice</span>
          </div>
        </div>
        <nav className="nav">
          <button className={tab === "talk" ? "active" : ""} onClick={() => setTab("talk")}><Mic size={18} />Talk</button>
          <button className={tab === "words" ? "active" : ""} onClick={() => setTab("words")}><BookOpen size={18} />Words</button>
          <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}><Settings size={18} />Settings</button>
        </nav>
        <div className="stat-stack">
          <span><strong>{health?.counts.wordSenses ?? 0}</strong> word senses</span>
          <span><strong>{health?.counts.dueReviews ?? 0}</strong> due reviews</span>
          <span><strong>{formatUsd(usage?.currentMonth.estimatedCostUsd)}</strong> this month</span>
          <span className={health?.hasOpenAIKey ? "ok" : "bad"}>{health?.hasOpenAIKey ? "OpenAI key loaded" : "Missing OpenAI key"}</span>
          <span className={health?.hasGeminiApiKey || health?.hasVertexAccessToken || health?.vertexUseGcloudAuth || health?.vertexUseGcloudADC ? "ok" : "bad"}>
            {health?.hasGeminiApiKey ? "Gemini API key loaded" : health?.hasVertexAccessToken ? "Vertex access token loaded" : health?.vertexUseGcloudAuth ? "gcloud auth enabled" : health?.vertexUseGcloudADC ? "gcloud ADC enabled" : "Missing Gemini Live auth"}
          </span>
          <span className={health?.hasVertexKey ? "ok" : "bad"}>{health?.hasVertexKey ? "Vertex REST key loaded" : "Missing Vertex REST key"}</span>
        </div>
      </aside>

      <main className="main">
        {error && <div className="error"><X size={16} />{error}</div>}
        {tab === "talk" && (
          <TalkScreen
            quiz={quiz}
            refresh={refresh}
            conversations={conversations}
            usage={usage}
            settings={settings}
            setError={setError}
          />
        )}
        {tab === "words" && (
          <WordsScreen words={words} refresh={refresh} setError={setError} />
        )}
        {tab === "settings" && settings && (
          <SettingsScreen settings={settings} saveSettings={saveSettings} busy={busy} />
        )}
      </main>
    </div>
  );
}

function TalkScreen({
  quiz,
  refresh,
  conversations,
  usage,
  settings,
  setError
}: {
  quiz: QuizItem[];
  refresh: () => Promise<void>;
  conversations: Conversation[];
  usage: UsageSummary | null;
  settings: AppSettings | null;
  setError: (error: string | null) => void;
}) {
  const [status, setStatus] = useState("Idle");
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [notes, setNotes] = useState("");
  const [reviewIndex, setReviewIndex] = useState(0);
  const [hintVisible, setHintVisible] = useState(false);
  const [processing, setProcessing] = useState(false);
  const connectionRef = useRef<{ close: () => void } | null>(null);
  const transcriptRef = useRef<TranscriptEntry[]>([]);

  const currentQuiz = quiz[reviewIndex];
  const live = Boolean(connectionRef.current);

  const recordReview = async (correct: boolean) => {
    if (!currentQuiz) return;
    await api.review({
      wordSenseId: currentQuiz.wordSense.id,
      direction: currentQuiz.track.direction,
      prompt: quizPrompt(currentQuiz),
      expectedAnswer: {
        surfaceForm: currentQuiz.wordSense.surfaceForm,
        meaning: currentQuiz.wordSense.meaning,
        meaningDisambiguator: currentQuiz.wordSense.meaningDisambiguator
      },
      correct,
      usedHint: hintVisible
    });
    setHintVisible(false);
    await refresh();
    setReviewIndex(0);
  };

  const start = async () => {
    setError(null);
    setProcessing(true);
    try {
      const nextConversation = await api.createConversation();
      setConversation(nextConversation);
      transcriptRef.current = [];
      setTranscript([]);
      const realtimeOptions: Parameters<typeof connectRealtime>[0] = {
        onStatus: setStatus,
        onTranscript: (entry) => {
          transcriptRef.current = [...transcriptRef.current, entry];
          setTranscript(transcriptRef.current);
        },
        onEvent: (type, payload) => {
          api.addEvent(nextConversation.id, { type, payload }).catch(() => undefined);
        },
        onQuizReview: async (args) => {
          const result = await api.review(args);
          await api.addEvent(nextConversation.id, {
            type: "quiz_review_recorded",
            payload: args
          });
          await refresh();
          return result;
        }
      };
      const connection = settings?.realtimeProvider === "gemini"
        ? await connectGeminiRealtime({ ...realtimeOptions, conversationId: nextConversation.id })
        : await connectRealtime(realtimeOptions);
      connectionRef.current = connection;
      setStatus("Live");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("Error");
    } finally {
      setProcessing(false);
    }
  };

  const end = async () => {
    if (!conversation) return;
    setProcessing(true);
    setError(null);
    try {
      connectionRef.current?.close();
      connectionRef.current = null;
      setStatus("Reconciling vocab");
      const ended = await api.endConversation(conversation.id, transcriptRef.current, notes);
      setConversation(ended);
      setNotes("");
      await refresh();
      setStatus(ended.status === "error" ? "Reconciliation error" : "Complete");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("Error");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Talk</h1>
          <p>Review a few due words, then start a local browser voice session.</p>
        </div>
        <span className="status-pill"><Circle size={10} fill="currentColor" />{status}</span>
      </header>

      <div className="panel usage-strip">
        <div>
          <span>Estimated API spend</span>
          <strong>{formatUsd(usage?.total.estimatedCostUsd)}</strong>
        </div>
        <div>
          <span>This month</span>
          <strong>{formatUsd(usage?.currentMonth.estimatedCostUsd)}</strong>
        </div>
        <div>
          <span>Usage events</span>
          <strong>{usage?.total.eventCount ?? 0}</strong>
        </div>
        <div>
          <span>Last update</span>
          <strong>{formatUsageDate(usage?.total.lastEventAt)}</strong>
        </div>
      </div>

      <div className="talk-grid">
        <div className="panel call-panel">
          <button className={`mic-button ${live ? "live" : ""}`} onClick={live ? end : start} disabled={processing}>
            {live ? <Square size={38} /> : <Mic size={42} />}
          </button>
          <h2>{live ? "Voice session running" : "Ready when you are"}</h2>
          <p>{live ? "End the session to save the transcript and run vocab reconciliation." : `${providerLabel(settings?.realtimeProvider)} is selected. Provider credentials stay on the localhost server.`}</p>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Optional fallback notes or words to save from this session"
          />
        </div>

        <div className="panel quiz-panel">
          <div className="panel-title">
            <h2>Voice Quiz Preview</h2>
            <span>{quiz.length ? Math.min(reviewIndex + 1, quiz.length) : 0} / {quiz.length}</span>
          </div>
          {currentQuiz ? (
            <div className="quiz-card">
              <span className="direction">{currentQuiz.track.direction}</span>
              <h3>{currentQuiz.wordSense.surfaceForm}</h3>
              {currentQuiz.wordSense.reading && <p className="muted">{currentQuiz.wordSense.reading}</p>}
              <p>{quizPrompt(currentQuiz)}</p>
              {hintVisible && (
                <div className="hint">
                  {currentQuiz.wordSense.firstSeenSentence || currentQuiz.wordSense.meaningDisambiguator || currentQuiz.wordSense.meaning}
                </div>
              )}
              <div className="button-row">
                <button onClick={() => setHintVisible(true)}>Hint</button>
                <button className="bad-button" onClick={() => recordReview(false)}><X size={16} />Missed</button>
                <button className="good-button" onClick={() => recordReview(true)}><Check size={16} />Got it</button>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <Check size={24} />
              <p>No reviews due.</p>
            </div>
          )}
          {currentQuiz && <p className="muted">The agent will ask whether you want to do these verbally when the call starts.</p>}
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <h2>Live Transcript</h2>
          <span>{transcript.length} entries</span>
        </div>
        <div className="transcript">
          {transcript.length ? transcript.map((entry, index) => (
            <p key={`${entry.role}-${index}`}><strong>{entry.role}</strong>{entry.text}</p>
          )) : <p className="muted">Transcript events will appear here when the Realtime session emits them.</p>}
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <h2>Recent Sessions</h2>
          <span>{conversations.length}</span>
        </div>
        <div className="session-list">
          {conversations.slice(0, 5).map((item) => (
            <div key={item.id} className="session-row">
              <span>#{item.id}</span>
              <strong>{item.status}</strong>
              <span>{new Date(item.startedAt).toLocaleString()}</span>
              <p>{item.summary || item.error || "No summary yet"}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function WordsScreen({
  words,
  refresh,
  setError
}: {
  words: WordSense[];
  refresh: () => Promise<void>;
  setError: (error: string | null) => void;
}) {
  const [draft, setDraft] = useState(emptyWord);
  const activeWords = useMemo(() => words.filter((word) => word.status === "active"), [words]);

  const addWord = async () => {
    setError(null);
    try {
      await api.createWord(draft);
      setDraft(emptyWord);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeWord = async (id: number) => {
    await api.deleteWord(id);
    await refresh();
  };

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Words</h1>
          <p>Word senses, review scores, and the sentence that made each one useful.</p>
        </div>
        <span className="status-pill">{activeWords.length} active</span>
      </header>

      <div className="panel add-word">
        <div className="field-grid">
          <label>Word<input value={draft.surfaceForm} onChange={(event) => setDraft({ ...draft, surfaceForm: event.target.value })} /></label>
          <label>Reading<input value={draft.reading} onChange={(event) => setDraft({ ...draft, reading: event.target.value })} /></label>
          <label>Meaning<input value={draft.meaning} onChange={(event) => setDraft({ ...draft, meaning: event.target.value })} /></label>
          <label>Sense<input value={draft.meaningDisambiguator} onChange={(event) => setDraft({ ...draft, meaningDisambiguator: event.target.value })} /></label>
        </div>
        <label>First sentence<textarea value={draft.firstSeenSentence} onChange={(event) => setDraft({ ...draft, firstSeenSentence: event.target.value })} /></label>
        <button className="primary" onClick={addWord} disabled={!draft.surfaceForm || !draft.meaning}><Plus size={16} />Add word sense</button>
      </div>

      <div className="word-list">
        {activeWords.map((word) => (
          <article className="word-card" key={word.id}>
            <div className="word-topline">
              <div>
                <h2>{word.surfaceForm}</h2>
                <span>{word.reading || word.lemma || "No reading yet"}</span>
              </div>
              <button className="icon-button" onClick={() => removeWord(word.id)} aria-label="Delete word"><Trash2 size={17} /></button>
            </div>
            <p>{word.meaningDisambiguator || word.meaning}</p>
            {word.firstSeenSentence && <blockquote>{word.firstSeenSentence}</blockquote>}
            <div className="track-row">
              <span>{scoreText(word)}</span>
              <span>{word.status}</span>
            </div>
          </article>
        ))}
        {!activeWords.length && (
          <div className="panel empty-state">
            <Check size={24} />
            <p>No active word senses yet.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {optionValues(options, value).map((option) => (
          <option value={option} key={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function NumberSelectField({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: number;
  options: number[];
  onChange: (value: number) => void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {optionValues(options, value).map((option) => (
          <option value={option} key={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function ProviderSelectField({
  value,
  onChange
}: {
  value: AppSettings["realtimeProvider"];
  onChange: (value: AppSettings["realtimeProvider"]) => void;
}) {
  return (
    <label>
      Realtime provider
      <select value={value} onChange={(event) => onChange(event.target.value as AppSettings["realtimeProvider"])}>
        <option value="openai">OpenAI Realtime</option>
        <option value="gemini">Gemini Live (Vertex)</option>
      </select>
    </label>
  );
}

function SettingsScreen({
  settings,
  saveSettings,
  busy
}: {
  settings: AppSettings;
  saveSettings: (settings: AppSettings) => Promise<void>;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(settings);

  useEffect(() => setDraft(settings), [settings]);

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setDraft((existing) => ({ ...existing, [key]: value }));
  };

  const updateProvider = (provider: AppSettings["realtimeProvider"]) => {
    const models = realtimeModelOptionsFor(provider);
    const voices = voiceOptionsFor(provider);
    setDraft((existing) => ({
      ...existing,
      realtimeProvider: provider,
      realtimeModel: models.includes(existing.realtimeModel) ? existing.realtimeModel : models[0],
      voice: voices.includes(existing.voice) ? existing.voice : voices[0]
    }));
  };

  const realtimeModelOptions = realtimeModelOptionsFor(draft.realtimeProvider);
  const voiceOptions = voiceOptionsFor(draft.realtimeProvider);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Local-only settings for this browser and backend.</p>
        </div>
        <button className="primary" onClick={() => saveSettings(draft)} disabled={busy}>Save</button>
      </header>

      <div className="panel settings-panel">
        <div className="field-grid">
          <SelectField label="Native language" value={draft.nativeLanguage} options={languageOptions} onChange={(value) => update("nativeLanguage", value)} />
          <SelectField label="Target language" value={draft.targetLanguage} options={targetLanguageOptions} onChange={(value) => update("targetLanguage", value)} />
          <ProviderSelectField value={draft.realtimeProvider} onChange={updateProvider} />
          <SelectField label="Realtime model" value={draft.realtimeModel} options={realtimeModelOptions} onChange={(value) => update("realtimeModel", value)} />
          <SelectField label="Offline model" value={draft.offlineModel} options={offlineModelOptions} onChange={(value) => update("offlineModel", value)} />
          <SelectField label="Voice" value={draft.voice} options={voiceOptions} onChange={(value) => update("voice", value)} />
          <NumberSelectField label="Max quiz items" value={draft.maxQuizItems} options={quizItemOptions} onChange={(value) => update("maxQuizItems", value)} />
          <NumberSelectField label="Recognition target" value={draft.recognitionTarget} options={reviewTargetOptions} onChange={(value) => update("recognitionTarget", value)} />
          <NumberSelectField label="Production target" value={draft.productionTarget} options={reviewTargetOptions} onChange={(value) => update("productionTarget", value)} />
          <NumberSelectField label="Production unlock" value={draft.productionUnlockSuccesses} options={reviewTargetOptions} onChange={(value) => update("productionUnlockSuccesses", value)} />
          <NumberSelectField label="Max session minutes" value={draft.maxSessionMinutes} options={sessionMinuteOptions} onChange={(value) => update("maxSessionMinutes", value)} />
        </div>
        <SelectField label="Partner style" value={draft.partnerStyle} options={partnerStyleOptions} onChange={(value) => update("partnerStyle", value)} />
      </div>
    </section>
  );
}
