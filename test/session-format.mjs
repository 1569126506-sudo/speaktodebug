// Bisect which session.update payload shape AssemblyAI accepts.
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
)
const AGENT = JSON.parse(
  readFileSync(new URL('../agents/speaktodebug.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')
)

const { token } = await fetch(
  'https://agents.assemblyai.com/v1/token?product=voice_agent&expires_in_seconds=300',
  { headers: { Authorization: `Bearer ${env.ASSEMBLYAI_API_KEY}` } }
).then(r => r.json())

const variants = [
  ['minimal: system_prompt only', { system_prompt: 'You are a test.' }],
  ['prompt+greeting', { system_prompt: 'You are a test.', greeting: 'Hello.' }],
  ['+voice as string', { system_prompt: 'You are a test.', greeting: 'Hello.', voice: 'anna' }],
  ['+voice as {voice_id}', { system_prompt: 'You are a test.', greeting: 'Hello.', voice: { voice_id: 'anna' } }],
  ['+tools(1) type:function', {
    system_prompt: 'You are a test.', greeting: 'Hello.', voice: 'anna',
    tools: [{ type: 'function', name: 'list_files', description: 'List files.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] }, execution_mode: 'interactive', timeout_seconds: 20 }],
  }],
  ['+tools(1) no required[]', {
    system_prompt: 'You are a test.', greeting: 'Hello.', voice: 'anna',
    tools: [{ type: 'function', name: 'list_files', description: 'List files.', parameters: { type: 'object', properties: { path: { type: 'string' } } }, execution_mode: 'interactive' }],
  }],
  ['full: all 4 real tools', {
    system_prompt: AGENT.system_prompt, greeting: AGENT.greeting, voice: 'anna',
    tools: AGENT.tools.map(t => ({ type: 'function', ...t })),
  }],
]

for (const [label, session] of variants) {
  const ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${token}`)
  const result = await new Promise(resolve => {
    const t = setTimeout(() => resolve('TIMEOUT'), 15_000)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'session.update', session }))
    ws.onmessage = ({ data }) => {
      const m = JSON.parse(data)
      if (m.type === 'session.error') { clearTimeout(t); ws.close(); resolve('REJECTED: ' + m.message) }
      if (m.type === 'session.ready') { clearTimeout(t); ws.close(); resolve('ACCEPTED') }
    }
    ws.onerror = () => { clearTimeout(t); resolve('WS_ERROR') }
  })
  console.log(result === 'ACCEPTED' ? '✓' : '✗', label, '→', result)
}
process.exit(0)
