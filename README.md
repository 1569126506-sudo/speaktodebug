# SpeakToDebug — Debug out loud

**A voice-first debugging partner.** Describe a bug out loud — SpeakToDebug searches your real code, reads the files, runs your tests, and speaks the root cause and fix back to you.

Built for the [AssemblyAI - Voice Agent Hackathon](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon) (Sep 2026).

## Why

Every developer knows the moment: you hit a bug while your hands are busy in the editor, or mid-code-review on a second screen. Chat assistants can *talk* about your code, but they have never seen it. SpeakToDebug is the colleague with hands on your keyboard:

- You **speak** the problem — no context-switching, no pasting snippets
- It **investigates for real**: searches your actual files, opens the suspicious lines, runs your actual test suite
- It **answers out loud** with the root cause, verified against your code

## How it works

```
 Browser (mic) ──wss──▶ AssemblyAI Voice Agent API
                          │  Universal-3.5 Pro STT
                          │  LLM reasoning + tool calling
                          │  voice output
                          ▼
                 tool.call (interactive) ──▶ localhost:3000/api/tools
                                              ├─ search_code  (recursive grep)
                                              ├─ read_file    (line-ranged read)
                                              ├─ run_tests    (npm test)
                                              └─ list_files   (tree)
        ◀── tool.result ── spoken answer grounded in real output ◀──
```

- **Voice Agent API path**: one WebSocket handles STT (Universal-3.5 Pro), LLM routing, TTS and turn-taking
- **Interactive tools**: the agent calls `search_code` / `read_file` / `run_tests` / `list_files`; the browser forwards each `tool.call` to the local server, which executes it **inside your real project** and returns the result as `tool.result`
- **Grounded answers**: everything the agent says is backed by actual tool output from your repository — never invented

## Setup

```sh
git clone https://github.com/1569126506-sudo/speaktodebug.git
cd speaktodebug
cp .env.example .env          # add your ASSEMBLYAI_API_KEY
npm run publish               # registers the SpeakToDebug agent
npm start                     # serves the app on http://localhost:3000
```

Point it at any project you want it to debug:

```sh
WORKDIR=C:\path\to\your-project npm start
```

## Tools

| Tool | What it does |
| --- | --- |
| `search_code` | Case-insensitive recursive search across the workspace (skips `node_modules`, `.git`, `dist`), capped at 50 hits |
| `read_file` | Reads a file with 1-based line numbers, optional line range |
| `run_tests` | Runs `npm test` (or a specific test path) in the workspace, 110 s timeout, output truncated to 4 KB |
| `list_files` | Lists a directory's entries with file/dir types |

All paths are jailed to the workspace: anything resolving outside `WORKDIR` is rejected.

## Demo video

▶ **[Watch the 90-second demo (English subtitles)](demo/demo.mp4)** — a live Chinese session: the developer asks for the project layout and for where an agent is defined; SpeakToDebug calls `list_files` / `search_code` against the real workspace and speaks grounded answers. Nothing is uploaded — the tools run on the developer's machine.

## Demo script (60 s)

1. *"Login page throws a 500 when the email is empty — find it."*
2. Agent: `search_code("login")` → `read_file src/auth.ts` → speaks the root cause with the line number
3. *"Run the auth tests."* → `run_tests` → speaks pass/fail
4. *"Add a null check to the email field."* → agent edits → tests green → spoken confirmation

## Stack

Node.js (no runtime dependencies in the voice path) · AssemblyAI Voice Agent API · vanilla Web Audio capture/playback · JSON-Schema tool calling

## License

MIT
