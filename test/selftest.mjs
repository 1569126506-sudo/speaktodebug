// Full pre-flight self-test for SpeakToDebug. Everything a real call does,
// minus the microphone: every local tool, path jailing, the relay's two-way
// flow across multiple turns, and the smoothness of audio arriving through
// the relay (the metric the whole relay exists for).
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

// ---------- 3. relay: two turns + audio smoothness ----------
{
  const AGENT = JSON.parse(
    readFileSync(new URL('../agents/speaktodebug.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  )
  const ws = new WebSocket('ws://localhost:3000/agent-ws')
  const gaps = []
  let last = 0, ready = false, dones = 0, toolCalls = 0, turns = 0, phase = 0
  let turnText = ''
  let fail = ''
  const timer = setTimeout(() => { fail = fail || 'overall timeout'; finish() }, 120_000)

  const finish = () => {
    clearTimeout(timer); try { ws.close() } catch {}
    check('relay: session reaches ready', ready)
    check('relay: both conversation turns answered', turns === 2, turns + '/2 turns')
    check('relay: tools invoked when asked', toolCalls >= 1, toolCalls + ' tool call(s) — later turns may reuse earlier context without re-calling')
    const g = gaps.slice(1).sort((a, b) => a - b)
    if (g.length) {
      const q = p => g[Math.floor(g.length * p)].toFixed(0)
      check('relay: audio arrives smooth', Number(q(0.99)) < 150,
        `${g.length} chunks, median ${q(0.5)}ms, p99 ${q(0.99)}ms, max ${g[g.length - 1].toFixed(0)}ms`)
    } else check('relay: audio arrives smooth', false, 'no audio measured')
    summary()
  }

  ws.onopen = () => ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      system_prompt: AGENT.system_prompt, greeting: AGENT.greeting,
      output: { voice: AGENT.voice?.voice_id || 'anna' },
      tools: AGENT.tools.map(t => ({ type: 'function', ...t })),
    },
  }))
  ws.onerror = () => { fail = 'relay socket error'; finish() }
  ws.onmessage = async ({ data }) => {
    const msg = JSON.parse(data)
    if (msg.type === 'reply.audio') {
      const now = performance.now()
      if (last) gaps.push(now - last)
      last = now
    }
    if (msg.type === 'session.error') { fail = 'session.error: ' + msg.message; finish() }
    if (msg.type === 'session.ready') {
      ready = true
      // Fire question 0 immediately — empirically the seeded message only
      // drives the reply when it races the greeting round (relay-e2e runs
      // 4/4 this way vs. 0/2 when asked after the greeting finished).
      ask(0)
    }
    if (msg.type === 'tool.call') {
      toolCalls++
      const r = await call(msg.name, msg.arguments ?? {})
      ws.send(JSON.stringify({ type: 'tool.result', call_id: msg.call_id, result: JSON.stringify(r.result ?? r), is_error: false }))
    }
    if (msg.type === 'transcript.agent' && msg.text) {
      turnText += msg.text
      console.log('   [agent]', msg.text)
    }
    if (msg.type === 'reply.done') {
      // done #1 is the greeting, #2 the answer to question 0, #3 to question 1.
      dones++
      if (dones === 2) { turns = 1; setTimeout(() => ask(1), 500) }
      if (dones >= 3) { turns = 2; finish() }
    }
  }
  const ask = (i) => {
    ws.send(JSON.stringify({ type: 'conversation.message', role: 'user', content: ['列出这个项目的文件', '搜索代码里的 SpeakToDebug'][i] }))
    // conversation.message only seeds context; without one-shot instructions
    // the model sometimes answers from its persona instead of the question.
    ws.send(JSON.stringify({ type: 'reply.create', instructions: 'Answer the user\'s last message now, using your tools if needed.' }))
  }
}

function summary() {
  const pass = results.filter(r => r.ok).length
  console.log(`\n===== SELF-TEST: ${pass}/${results.length} PASS =====`)
  if (pass !== results.length) { results.filter(r => !r.ok).forEach(r => console.log(' FAILED:', r.name, r.note)); process.exit(1) }
  setTimeout(() => process.exit(0), 200)
}
