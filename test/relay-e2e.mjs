// E2E through the LOCAL RELAY (ws://localhost:3000/agent-ws) — the exact
// path the browser now uses. Verifies upgrade handling, token minting,
// both-direction relay, and tool calling end to end.
import { readFileSync } from 'node:fs'

const AGENT = JSON.parse(
  readFileSync(new URL('../agents/speaktodebug.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')
)
const tools = (AGENT.tools || []).map(t => ({ type: 'function', ...t }))

const ws = new WebSocket('ws://localhost:3000/agent-ws')
let sawToolCall = false, postTool = false, answerText = '', opened = false
const fail = t => { console.error('[FAIL]', t); process.exit(1) }
const timer = setTimeout(() => fail(sawToolCall ? 'timeout after tool call' : 'timeout: no tool.call through relay'), 60_000)

ws.onopen = () => {
  opened = true
  console.log('[ok] relay ws open')
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      system_prompt: AGENT.system_prompt, greeting: AGENT.greeting,
      output: { voice: AGENT.voice?.voice_id || 'anna' },
      input: { keyterms: ['列出', '文件', '搜索', '代码', '项目'] },
      tools,
    },
  }))
}
ws.onerror = () => fail('relay ws error')
ws.onclose = () => { if (opened) console.log('[..] relay ws closed') }

ws.onmessage = async ({ data }) => {
  const msg = JSON.parse(data)
  switch (msg.type) {
    case 'session.error':
      fail('session.error through relay: ' + msg.message)
      break
    case 'session.ready':
      console.log('[ok] session.ready through relay')
      ws.send(JSON.stringify({ type: 'conversation.message', role: 'user', content: '列出这个项目的文件' }))
      ws.send(JSON.stringify({ type: 'reply.create' }))
      break
    case 'tool.call': {
      sawToolCall = true
      console.log(`[ok] tool.call through relay → ${msg.name}(${JSON.stringify(msg.arguments)})`)
      const r = await fetch('http://localhost:3000/api/tools', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: msg.name, args: msg.arguments ?? {} }),
      }).then(r => r.json())
      console.log('[ok] local tool executed:', JSON.stringify(r).slice(0, 120))
      ws.send(JSON.stringify({ type: 'tool.result', call_id: msg.call_id, result: JSON.stringify(r.result ?? r), is_error: false }))
      postTool = true; answerText = ''
      break
    }
    case 'transcript.agent':
      if (msg.text) { if (postTool) { answerText += msg.text; console.log('[agent]', msg.text) } else console.log('[greeting]', msg.text) }
      break
    case 'reply.done':
      if (!postTool || !answerText) break
      clearTimeout(timer)
      // The point is the round-trip: tool called over the relay, executed
      // locally, answered. Whether the model names specific files varies.
      const pass = sawToolCall && answerText.length > 5
      console.log('\nVERDICT: relay path', pass ? 'PASS' : 'FAIL')
      process.exit(pass ? 0 : 1)
  }
}
