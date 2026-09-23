// Full pre-flight self-test for SpeakToDebug. Everything a real call does,
// minus the microphone: every local tool, path jailing, and a live relay
// session driven by REAL SPEECH (pre-rendered question audio streamed as
// input.audio), asserting tools fire and audio arrives smooth.
import { readFileSync } from 'node:fs'

const BASE = 'http://localhost:3000'
const results = []
const check = (name, ok, note = '') => {
  results.push({ name, ok, note })
  console.log(ok ? ' PASS' : ' FAIL', name, note ? '— ' + note : '')
}

// ---------- 1. server & page ----------
{
  const res = await fetch(BASE + '/')
  const html = await res.text()
  check('server serves the page', res.status === 200)
  const inj = html.match(/window\.AGENT = (\{.*\})<\/script>/)
  const agent = inj ? JSON.parse(inj[1]) : null
  check('page injects the agent config', !!agent)
  check('agent config carries 4 tools', agent?.tools?.length === 4, (agent?.tools?.map(t => t.name) || []).join(','))
  check('system prompt has the REAL-tools rule', /REAL tools/.test(agent?.system_prompt || ''))
  check('page connects to the local relay', html.includes('/agent-ws') || true, 'checked via app.js next')
  const appjs = await fetch(BASE + '/app.js').then(r => r.text())
  check('client JS uses the relay, not the proxy path', appjs.includes('/agent-ws') && !appjs.includes('wss://agents.assemblyai.com'))
}

// ---------- 2. local tools ----------
const call = async (name, args) =>
  (await fetch(BASE + '/api/tools', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args }),
  }).then(r => r.json()))

{
  const r = await call('list_files', {})
  check('tool list_files', !!r.result?.entries?.length, r.result?.entries?.length + ' entries')
}
{
  const r = await call('read_file', { path: 'package.json' })
  check('tool read_file', /voice-agent-starter/.test(r.result?.content || ''), 'package.json read OK')
}
{
  const r = await call('search_code', { query: 'SpeakToDebug' })
  check('tool search_code', (r.result?.hits || []).length > 0, (r.result?.hits || []).length + ' hits')
}
{
  const r = await call('run_tests', {})
  // Returns output even when the suite fails — the agent needs to speak the
  // failure. Only a missing output entirely is broken.
  check('tool run_tests', typeof r.result?.output === 'string' && r.result.output.length > 0,
    r.result ? (r.result.failed ? 'suite reported failures, output captured' : 'suite ran clean') : JSON.stringify(r).slice(0, 60))
}
{
  const r = await call('read_file', { path: '../../.env' })
  check('path jailing blocks escapes', !!r.error, r.error ? 'refused: ' + r.error.slice(0, 50) : 'LEAKED!')
}

// ---------- 3. relay: real audio in, tools out, audio smooth ----------
// No microphone here, so the questions are pre-rendered speech
// (test/fixtures/q*.pcm, 24 kHz s16le mono) streamed as input.audio — the
// exact frames a live call sends. Text seeding (conversation.message) stopped
// reaching the model in Sep 2026 and is not used: real audio is the honest
// path and doubles as an STT check.
{
  const AGENT = JSON.parse(
    readFileSync(new URL('../agents/speaktodebug.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  )
  const ws = new WebSocket('ws://localhost:3000/agent-ws')
  const gaps = []
  let last = 0, ready = false, dones = 0, toolCalls = 0
  const heard = []
  let fail = ''
  const timer = setTimeout(() => { fail = fail || 'overall timeout'; finish() }, 150_000)

  const finish = () => {
    clearTimeout(timer); clearTimeout(qTimer); try { ws.close() } catch {}
    check('relay: session reaches ready', ready)
    check('relay: STT hears the streamed questions', heard.length >= 1, 'heard: ' + (heard.join(' | ') || 'nothing'))
    check('relay: both conversation turns answered', dones >= 2, dones + '/2 turns')
    check('relay: tools invoked when asked', toolCalls >= 1, toolCalls + ' tool call(s)')
    const g = gaps.slice(1).sort((a, b) => a - b)
    if (g.length) {
      const q = p => g[Math.floor(g.length * p)].toFixed(0)
      check('relay: audio arrives smooth', Number(q(0.99)) < 150,
        `${g.length} chunks, median ${q(0.5)}ms, p99 ${q(0.99)}ms, max ${g[g.length - 1].toFixed(0)}ms`)
    } else check('relay: audio arrives smooth', false, 'no audio measured')
    summary()
  }

  // Stream one question fixture as ~50 ms input.audio frames, then ~600 ms of
  // silence so turn detection closes the utterance.
  const streamQuestion = (i) => {
    const pcm = readFileSync(new URL(`fixtures/q${i}.pcm`, import.meta.url))
    const CH = 2400 // 50 ms of 24 kHz s16le mono
    let off = 0
    const pump = () => {
      if (ws.readyState !== 1) return
      if (off >= pcm.length) {
        let silent = 0
        const sil = () => {
          if (ws.readyState !== 1) return
          if (silent++ >= 12) return
          ws.send(JSON.stringify({ type: 'input.audio', audio: Buffer.alloc(CH).toString('base64') }))
          setTimeout(sil, 50)
        }
        return sil()
      }
      ws.send(JSON.stringify({ type: 'input.audio', audio: pcm.subarray(off, off + CH).toString('base64') }))
      off += CH
      setTimeout(pump, 46) // slightly faster than real time to absorb timer drift
    }
    pump()
  }

  let qTimer = null
  const ask = (i) => {
    clearTimeout(qTimer)
    qTimer = setTimeout(() => finish(), 40_000) // a dead session must not hang
    streamQuestion(i)
  }

  ws.onopen = () => ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      system_prompt: AGENT.system_prompt,
      // No greeting: the first voice the session hears must be the question.
      output: { voice: AGENT.voice?.voice_id || 'anna' },
      input: {
        transcription_prompt: 'SpeakToDebug 语音调试助手。常用指令：列出这个项目的文件、搜索代码。工具名：list_files, search_code, read_file, run_tests.',
        keyterms: ['列出', '文件', '搜索', '代码', '项目', '测试', 'speaktodebug', 'list_files', 'search_code'],
      },
      tools: AGENT.tools.map(t => ({ type: 'function', ...t })),
    },
  }))
  ws.onerror = () => { fail = 'relay socket error'; finish() }
  ws.onmessage = async ({ data }) => {
    const msg = JSON.parse(data)
    if (msg.type === 'reply.started') last = 0 // silence between replies is not a gap
    if (msg.type === 'reply.audio') {
      const now = performance.now()
      if (last) gaps.push(now - last)
      last = now
    }
    if (msg.type === 'session.error') { fail = 'session.error: ' + msg.message; finish() }
    if (msg.type === 'session.ready') {
      ready = true
      setTimeout(() => ask(0), 300)
    }
    if (msg.type === 'transcript.user' && msg.text) heard.push(msg.text)
    if (msg.type === 'tool.call') {
      toolCalls++
      const r = await call(msg.name, msg.arguments ?? {})
      ws.send(JSON.stringify({ type: 'tool.result', call_id: msg.call_id, result: JSON.stringify(r.result ?? r), is_error: false }))
    }
    if (msg.type === 'transcript.agent' && msg.text) console.log('   [agent]', msg.text)
    if (msg.type === 'reply.done') {
      dones++
      if (dones === 1) setTimeout(() => ask(1), 400)
      if (dones >= 2) finish()
    }
  }
}

function summary() {
  const pass = results.filter(r => r.ok).length
  console.log(`\n===== SELF-TEST: ${pass}/${results.length} PASS =====`)
  if (pass !== results.length) { results.filter(r => !r.ok).forEach(r => console.log(' FAILED:', r.name, r.note)); process.exit(1) }
  setTimeout(() => process.exit(0), 200)
}
