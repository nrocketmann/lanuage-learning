# Language Learning Voice App

Local-first voice practice app for language learning. V1 focuses on Japanese vocab:

- Browser voice conversation with OpenAI Realtime.
- Local SQLite word-sense database.
- Recognition and production SRS tracks.
- Post-session vocab reconciliation from transcript/notes.
- Simple Talk, Words, and Settings screens.

## Local Setup

Create `vars.env` with your OpenAI API key:

```txt
OPENAI_KEY=sk-...
```

Install and run:

```bash
npm install
npm run build
npm start
```

Open:

```txt
http://127.0.0.1:8787/
```

For development with Vite hot reload:

```bash
npm run dev
```

Dev UI runs on `http://127.0.0.1:5173/` and the API runs on `http://127.0.0.1:8787/`.

## Notes

- The OpenAI key is read server-side from `vars.env`; it is not stored in browser local storage.
- Runtime data is stored in `data/app.db`.
- `vars.env`, `data/`, `node_modules/`, and `dist/` are ignored by git.
- No Tailscale, billing, accounts, or hosted mode are wired into this V1.
