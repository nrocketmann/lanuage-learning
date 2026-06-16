import { BookOpen, Check, Circle, Mic, Plus, Settings, Sparkles, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, Conversation, HealthResponse, QuizItem, TranscriptEntry, WordSense } from "../shared/types";
import { api } from "./api";
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

function scoreText(word: WordSense) {
  return `R ${word.tracks.recognition.netScore} / P ${word.tracks.production.netScore}`;
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [nextHealth, nextSettings, nextWords, nextQuiz, nextConversations] = await Promise.all([
      api.health(),
      api.getSettings(),
      api.listWords(),
      api.dueQuiz(),
      api.listConversations()
    ]);
    setHealth(nextHealth);
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
          <span className={health?.hasOpenAIKey ? "ok" : "bad"}>{health?.hasOpenAIKey ? "OpenAI key loaded" : "Missing OpenAI key"}</span>
        </div>
      </aside>

      <main className="main">
        {error && <div className="error"><X size={16} />{error}</div>}
        {tab === "talk" && (
          <TalkScreen
            quiz={quiz}
            refresh={refresh}
            conversations={conversations}
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
  setError
}: {
  quiz: QuizItem[];
  refresh: () => Promise<void>;
  conversations: Conversation[];
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
      setTranscript([]);
      const connection = await connectRealtime({
        onStatus: setStatus,
        onTranscript: (entry) => {
          setTranscript((existing) => [...existing, entry]);
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
      });
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
      const ended = await api.endConversation(conversation.id, transcript, notes);
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

      <div className="talk-grid">
        <div className="panel call-panel">
          <button className={`mic-button ${live ? "live" : ""}`} onClick={live ? end : start} disabled={processing}>
            {live ? <Square size={38} /> : <Mic size={42} />}
          </button>
          <h2>{live ? "Voice session running" : "Ready when you are"}</h2>
          <p>{live ? "End the session to save the transcript and run vocab reconciliation." : "Your OpenAI key stays on the localhost server."}</p>
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
        {words.map((word) => (
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
      </div>
    </section>
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
          <label>Native language<input value={draft.nativeLanguage} onChange={(event) => update("nativeLanguage", event.target.value)} /></label>
          <label>Target language<input value={draft.targetLanguage} onChange={(event) => update("targetLanguage", event.target.value)} /></label>
          <label>Realtime model<input value={draft.realtimeModel} onChange={(event) => update("realtimeModel", event.target.value)} /></label>
          <label>Offline model<input value={draft.offlineModel} onChange={(event) => update("offlineModel", event.target.value)} /></label>
          <label>Voice<input value={draft.voice} onChange={(event) => update("voice", event.target.value)} /></label>
          <label>Max quiz items<input type="number" value={draft.maxQuizItems} onChange={(event) => update("maxQuizItems", Number(event.target.value))} /></label>
          <label>Recognition target<input type="number" value={draft.recognitionTarget} onChange={(event) => update("recognitionTarget", Number(event.target.value))} /></label>
          <label>Production target<input type="number" value={draft.productionTarget} onChange={(event) => update("productionTarget", Number(event.target.value))} /></label>
          <label>Production unlock<input type="number" value={draft.productionUnlockSuccesses} onChange={(event) => update("productionUnlockSuccesses", Number(event.target.value))} /></label>
          <label>Max session minutes<input type="number" value={draft.maxSessionMinutes} onChange={(event) => update("maxSessionMinutes", Number(event.target.value))} /></label>
        </div>
        <label>Partner style<textarea value={draft.partnerStyle} onChange={(event) => update("partnerStyle", event.target.value)} /></label>
      </div>
    </section>
  );
}
