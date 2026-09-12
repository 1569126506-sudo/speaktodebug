// Measures inter-arrival jitter of reply.audio chunks on a DIRECT connection
// (Node fetch/WebSocket never uses the system proxy). The greeting reply
// streams audio right after session.ready, so no mic input is needed.
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
)
const { token } = await fetch(
  'https://agents.assemblyai.com/v1/token?product=voice_agent&expires_in_seconds=120',
  { headers: { Authorization: `Bearer ${env.ASSEMBLYAI_API_KEY}` } }
).then(r => r.json())

const ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${token}`)
const arrivals = []
let last = 0
ws.onopen = () => ws.send(JSON.stringify({
  type: 'session.update',
  session: { system_prompt: 'You are a test.', greeting: 'Hello there, this is a jitter measurement test.', output: { voice: 'anna' } },
}))
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data)
  if (msg.type === 'reply.audio') {
    const now = performance.now()
    if (last) arrivals.push(now - last)
    last = now
  }
}
setTimeout(() => {
  ws.close()
  const gaps = arrivals.slice(1).sort((a, b) => a - b)
  if (gaps.length < 10) { console.log('not enough audio chunks:', gaps.length); process.exit(1) }
  const q = p => gaps[Math.floor(gaps.length * p)].toFixed(0)
  console.log(`chunks=${gaps.length} gap ms: min=${gaps[0].toFixed(0)} median=${q(0.5)} p90=${q(0.9)} p99=${q(0.99)} max=${gaps[gaps.length - 1].toFixed(0)}`)
  console.log('verdict: a pre-roll buffer of', (Number(q(0.99)) + 100).toFixed(0) + 'ms would absorb 99% of this jitter (DIRECT path)')
  process.exit(0)
}, 10_000)
