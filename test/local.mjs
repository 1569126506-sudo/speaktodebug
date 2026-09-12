// Offline health check: page + local tools + path jailing. No AssemblyAI
// traffic, no spend. Requires the dev server on localhost:3000 — which the
// voice agent itself runs on, so "npm test" from run_tests is always valid.
const BASE = 'http://localhost:3000'
let failed = 0
const check = (name, ok, note = '') => {
  if (!ok) failed++
  console.log(ok ? 'ok' : 'FAIL', '-', name, note ? '(' + note + ')' : '')
}

const page = await fetch(BASE + '/').then(r => r.text())
const inj = page.match(/window\.AGENT = (\{.*\})<\/script>/)
const agent = inj ? JSON.parse(inj[1]) : null
check('page served with agent config', !!agent)
check('4 tools in the injected config', agent?.tools?.length === 4)

const call = (name, args) => fetch(BASE + '/api/tools', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, args }),
}).then(r => r.json())

const list = await call('list_files', {})
check('list_files', (list.result?.entries?.length ?? 0) > 0)

const read = await call('read_file', { path: 'package.json' })
check('read_file', /voice-agent-starter/.test(read.result?.content || ''))

const search = await call('search_code', { query: 'SpeakToDebug' })
check('search_code', (search.result?.hits?.length ?? 0) > 0, search.result?.hits?.length + ' hits')

// run_tests is deliberately NOT called here: it spawns `npm test`, which
// runs this file — calling it would recurse until the 110s timeout.

const jail = await call('read_file', { path: '../../.env' })
check('path jailing', !!jail.error, jail.error ? 'refused' : 'LEAK')

process.exit(failed ? 1 : 0)
