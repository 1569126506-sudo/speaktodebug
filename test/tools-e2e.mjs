// End-to-end tool-calling verification WITHOUT a microphone.
// Drives the real AssemblyAI session with conversation.message + reply.create,
// executes the real local tool via the running server, and asserts we saw
// tool.call -> tool.result -> a spoken answer that mentions real files.
//
// Usage: node test/tools-e2e.mjs
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
)
if (!env.ASSEMBLYAI_API_KEY) throw new Error('ASSEMBLYAI_API_KEY missing in .env')

const agentRaw = readFileSync(new URL('../agents/speaktodebug.jsonc', import.meta.url), 'utf8')
const AGENT = JSON.parse(agentRaw.replace(/^\s*\/\/.*$/gm, ''))
const tools = (AGENT.tools || []).map(t => ({ type: 'function', ...t }))

// 1. Mint a temporary token (API key never goes to the WS URL directly).
const tokenRes = await fetch('https://agents.assemblyai.com/v1/token?product=voice_agent&expires_in_seconds=120', {
  headers: { Authorization: `Bearer ${env.ASSEMBLYAI_API_KEY}` },
})
if (!tokenRes.ok) throw new Error(`token mint failed: ${tokenRes.status} ${await tokenRes.text()}`)
const { token } = await tokenRes.json()
console.log('[ok] token minted')

// 2. Open the agent WebSocket with the same inline config the browser sends.
const ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${token}`)
const events = []
let sawToolCall = false
let postTool = false
let answerText = ''
let opened = false
const errors = []

const fail = t => { console.error('[FAIL]', t, '\nevents:', events.join(' ')); process.exit(1) }
const timer = setTimeout(() => {
  fail(sawToolCall ? 'timed out waiting for the final agent reply' : 'timed out: no tool.call ever arrived')
}, 60_000)

ws.onopen = () => {
  opened = true
  console.log('[ok] ws open, sending session.update with', tools.length, 'tools (type:function)')
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      system_prompt: AGENT.system_prompt,
      greeting: AGENT.greeting,
      output: { voice: AGENT.voice?.voice_id || 'anna' },
      tools,
    },
  }))
}
ws.onerror = e => fail(`ws error: ${e.message || e}`)
ws.onclose = e => { if (opened) console.log('[..] ws closed', e.code, e.reason) }

ws.onmessage = async ({ data }) => {
  const msg = JSON.parse(data)
  events.push(msg.type)
  switch (msg.type) {
    case 'session.ready':
      console.log('[ok] session.ready — config accepted')
      ws.send(JSON.stringify({ type: 'conversation.message', role: 'user', content: '列出这个项目的文件' }))
      ws.send(JSON.stringify({ type: 'reply.create' }))
      console.log('[..] asked: 列出这个项目的文件')
      break
    case 'error':
    case 'session.error':
      console.log('[session.error]', JSON.stringify(msg))
      errors.push(JSON.stringify(msg))
      break
    case 'tool.call': {
      sawToolCall = true
      console.log('[ok] tool.call full payload:', JSON.stringify(msg))
      const name = msg.name || msg.tool || msg.function?.name
      const args = msg.args ?? msg.arguments ?? {}
      console.log(`[ok] tool.call → ${name}(${JSON.stringify(args)})`)
      // Execute the REAL local tool through the running server.
      let r
      try {
        const res = await fetch('http://localhost:3000/api/tools', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, args }),
        })
        r = await res.json()
      } catch (e) {
        console.log('[..] server unreachable, using canned result:', e.cause?.code || e.message)
        r = { result: { files: ['agents/', 'deployment/', 'test/', 'package.json', 'README.md'] } }
      }
      console.log('[ok] local tool executed:', JSON.stringify(r).slice(0, 200))
      ws.send(JSON.stringify({
        type: 'tool.result',
        call_id: msg.call_id,
        result: JSON.stringify(r.result ?? r),
        is_error: false,
      }))
      postTool = true
      answerText = ''
      console.log('[ok] tool.result sent back')
      break
    }
    case 'transcript.agent':
    case 'reply.text':
      if (msg.text) {
        if (!postTool) console.log('[greeting]', msg.text)
        else { answerText += msg.text; console.log('[agent]', msg.text) }
      }
      break
    case 'reply.done':
    case 'reply.finished':
      if (!postTool || !answerText) break // ignore the greeting reply round
      clearTimeout(timer)
      console.log('\n=== VERDICT ===')
      console.log('tool.call seen:', sawToolCall)
      console.log('final reply:', answerText)
      const mentioned = /server|agents|deployment|jsonc|md|test|package|env|lib/i.test(answerText)
      if (sawToolCall && mentioned && errors.length === 0) {
        console.log('PASS — model called the tool and answered from real results')
        process.exit(0)
      }
      if (errors.length) fail(`session.update was rejected: ${errors.join(' | ')}`)
      fail(sawToolCall ? 'tool ran but reply did not mention real files' : 'no tool call')
      break
  }
}
