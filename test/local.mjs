// Offline health check: page + local tools + path jailing. No AssemblyAI
// traffic, no spend. Requires the dev server on localhost:3000 — which the
// voice agent itself runs on, so "npm test" from run_tests is always valid.
const BASE = 'http://localhost:3000'
let failed = 0
const check = (name, ok, note = '') => {
  if (!ok) failed++
  console.log(ok ? 'ok' : 'FAIL', '-', name, note ? '(' + note + ')' : '')
}

let page
try {
  page = await fetch(BASE + '/').then(r => r.text())
} catch {
  console.error(`no server on ${BASE} — run "npm start" in another terminal first`)
  process.exit(1)
}
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

// glob narrows hits to the requested directory/extension subset.
const all = await call('search_code', { query: 'check' })
const globbed = await call('search_code', { query: 'check', glob: '**/*.mjs' })
check('search_code honors glob',
  (globbed.result?.hits ?? []).length > 0 &&
  (globbed.result?.hits ?? []).every(h => h.file.endsWith('.mjs')))

// run_tests is deliberately NOT called here: it spawns `npm test`, which
// runs this file — calling it would recurse until the 110s timeout.

const jail = await call('read_file', { path: '../../.env' })
check('path jailing blocks ../ escapes', !!jail.error, jail.error ? 'refused' : 'LEAK')

// The old startsWith containment let a sibling sharing the WORKDIR string
// prefix through ("..escape-probe" resolving beside the workspace). The
// probe dir must really exist for the request to have been answerable.
const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
const probeRel = '../speaktodebug-escape-probe'
try {
  mkdirSync(probeRel, { recursive: true })
  writeFileSync(probeRel + '/secret.txt', 'TOP_SECRET')
  const sibling = await call('read_file', { path: probeRel + '/secret.txt' })
  check('path jailing blocks sibling-prefix escapes', !!sibling.error, sibling.error ? 'refused' : 'LEAKED ' + (sibling.result?.content || ''))
} finally {
  rmSync(probeRel, { recursive: true, force: true })
}

const secret = await call('read_file', { path: '.env' })
check('read_file refuses secret files', !!secret.error, secret.error ? 'refused' : 'LEAK')

const shell = await call('run_tests', { test_path: 'x"; calc & echo "' })
check('run_tests rejects shell metacharacters in test_path', !!shell.error, shell.error ? 'refused' : 'EXECUTED')

process.exit(failed ? 1 : 0)
