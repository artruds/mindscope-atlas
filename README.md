# Mindscope Atlas (Share Package)

This repository contains the Mindscope Atlas frontend + backend app.

## Quick start

### 1) Install requirements

- Node.js 18+ and `npm`
- Python 3.10+ with `python3 -m venv`
- USB meter drivers for your platform (if connecting hardware)

### 2) Clone and install

```bash
git clone <your-repo-url> mindscope-atlas
cd mindscope-atlas
npm install

cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd ..
```

### 3) Configure API keys

Copy the environment example and add your own keys:

```bash
cp .env.example .env
```

Then edit `.env`:

- `OPENAI_API_KEY` → Whisper transcription key (if you want microphone transcription)
- `ANTHROPIC_API_KEY` → Auditor model key

You can also place the same two variables in `backend/.env` instead.

### 4) Run in browser (recommended for development)

```bash
npm run dev:browser
```

This starts:

- Vite frontend at `http://127.0.0.1:5173`
- Python backend WebSocket server at `127.0.0.1:8765`

Open the app in your browser and test.

### 5) Run as Electron desktop app

```bash
npm run dev
```

This launches the desktop app and auto-starts the backend with the same virtualenv.

## Packaging for someone else (one bundle)

Create a clean distributable zip with tracked source files only (no secrets, no dependencies):

```bash
./scripts/package-share.sh
```

This creates `mindscope-atlas-share.zip` in the repository root.

## Notes

- `.env` and `backend/.env` are not committed.
- API keys are never stored in version control by this repo setup.
- For USB meter use, make sure the meter bridge is connected before starting a session and that your Python venv can access `hid`.
