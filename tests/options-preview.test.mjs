import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { createOptionsPreviewServer } from '../index.mjs'

let root
let config
let server
let origin
const plain = (value) => JSON.parse(JSON.stringify(value))
function write(file, value) {
  const absolute = path.join(root, file)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, typeof value == 'string' ? value : JSON.stringify(value))
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'soext-preview-'))
  write('manifest.mv3.json', { name: 'Example', version: '1.0.0', default_locale: 'en' })
  write('_locales/en/messages.json', {
    greeting: { message: 'Hello $NAME$!', placeholders: { name: { content: '$1' } } },
    fallback: { message: 'English fallback' },
  })
  write('_locales/fr/messages.json', { greeting: { message: 'Bonjour $1!' } })
  write('options.html', '<head></head><body><script src="options.js"></script></body>')
  write('options.js', 'console.log("real page")')
  write('options.css', 'body { color: red }')
  write('options-icon.png', 'root image')
  write('shared/trace.html', '<head></head><body>Trace</body>')
  write('private.txt', 'Not whitelisted')
  config = {
    archiveName: 'example',
    files: [
      'options.html',
      'options.js',
      'options.css',
      'options-icon.png',
      'shared/trace.html',
      'icons/*.png',
    ],
    preview: {
      parameters: { layout: 'layout' },
      configure: ({ params }) => ({
        storageGroup: params.get('group') ?? 'default',
        urlParams: { group: params.get('group') ?? 'default' },
      }),
    },
  }
  server = createOptionsPreviewServer({ root, config })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = `http://127.0.0.1:${server.address().port}`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(root, { recursive: true, force: true })
})

function browserHub() {
  const data = new Map()
  const windows = []
  return {
    create() {
      const handlers = []
      const window = {
        location: new URL(`${origin}/options.html`),
        navigator: { languages: ['en-GB'] },
        document: { documentElement: {} },
        queueMicrotask,
        console: { info() {} },
        open() {},
        addEventListener: (type, handler) => {
          if (type == 'storage') handlers.push(handler)
        },
        localStorage: {
          getItem: (key) => data.get(key) ?? null,
          setItem(key, value) {
            const oldValue = data.get(key) ?? null
            data.set(key, value)
            if (oldValue == value) return
            for (const other of windows) {
              if (other.window == window) continue
              queueMicrotask(() => {
                for (const handler of other.handlers) handler({ key, oldValue, newValue: value })
              })
            }
          },
        },
      }
      windows.push({ window, handlers })
      return window
    },
  }
}

async function api(query = '', window = browserHub().create(), headers = {}) {
  const response = await fetch(`${origin}/__preview/api.js${query}`, { headers })
  assert.equal(response.status, 200)
  vm.runInNewContext(await response.text(), { window, URL })
  return window.chrome
}

test('serves whitelisted live assets and both page layouts, with no preparation or generated files', async () => {
  const response = await fetch(origin)
  const html = await response.text()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.ok(html.indexOf('__preview/api.js') < html.indexOf('src="options.js"'))
  assert.match(
    await (await fetch(`${origin}/browser_action.html`)).text(),
    /<body class="browserAction">/,
  )
  assert.match(await (await fetch(`${origin}/shared/trace.html`)).text(), /__preview\/api.js/)
  assert.equal((await fetch(`${origin}/options-icon.png`)).headers.get('content-type'), 'image/png')
  assert.equal(await (await fetch(`${origin}/options.js`)).text(), 'console.log("real page")')
  write('options.js', 'Updated source')
  assert.equal(await (await fetch(`${origin}/options.js`)).text(), 'Updated source')
  assert.equal(fs.existsSync(path.join(root, 'manifest.json')), false)
  assert.equal(fs.existsSync(path.join(root, 'browser_action.html')), false)
  const head = await fetch(`${origin}/options.css`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  assert.equal((await fetch(origin, { method: 'POST' })).status, 405)
})

test('does not serve unlisted files or whitelisted symlinks outside the extension', async () => {
  for (const route of ['/private.txt', '/.git/config', '/icons/%2e%2e/private.txt']) {
    assert.equal((await fetch(`${origin}${route}`)).status, 404)
  }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'soext-preview-outside-'))
  try {
    fs.writeFileSync(path.join(outside, 'private.png'), 'Outside')
    fs.mkdirSync(path.join(root, 'icons'))
    fs.symlinkSync(path.join(outside, 'private.png'), path.join(root, 'icons/private.png'))
    assert.equal((await fetch(`${origin}/icons/private.png`)).status, 404)
  } finally {
    fs.rmSync(outside, { recursive: true, force: true })
  }
  assert.throws(
    () => createOptionsPreviewServer({ root, config: { files: ['!private.txt'] } }),
    /whitelist/,
  )
})

test('uses real catalogs, regional/default-language fallback and literal placeholder values', async () => {
  const french = await api('?lang=fr-CA')
  assert.equal(french.i18n.getMessage('GREETING', '$2 $$'), 'Bonjour $2 $$!')
  assert.equal(french.i18n.getMessage('fallback'), 'English fallback')
  assert.equal(french.i18n.getUILanguage(), 'fr')
  assert.equal(
    (await api('', undefined, { 'Accept-Language': 'ja-JP' })).i18n.getUILanguage(),
    'en',
  )
  assert.equal((await api()).i18n.getMessage('greeting', '$2 $$'), 'Hello $2 $$!')
  write('_locales/fr/messages.json', { greeting: { message: 'Updated catalog' } })
  assert.equal((await api('?lang=fr')).i18n.getMessage('greeting'), 'Updated catalog')
  assert.equal((await fetch(`${origin}/?lang=unknown`)).status, 400)
  assert.equal((await fetch(`${origin}/__preview/api.js?lang=unknown`)).status, 400)
})

test('supports old and new storage listener locations, callback APIs and cloned results', async () => {
  const browser = await api()
  assert.equal(browser.storage.local.onChanged, browser.storage.onChanged)
  await browser.storage.local.set({ enabled: true })
  const changes = []
  const listener = (change) => changes.push(plain(change))
  browser.storage.local.onChanged.addListener(listener)
  await new Promise((resolve) => browser.storage.local.set({ enabled: false }, resolve))
  assert.deepEqual(changes.at(-1), { enabled: { oldValue: true, newValue: false } })
  assert.equal((await new Promise((resolve) => browser.storage.local.get(resolve))).enabled, false)
  assert.deepEqual(plain(await browser.storage.local.get({ absent: 'fallback' })), {
    absent: 'fallback',
  })
  await browser.storage.local.set({ settings: { feature: true } })
  const result = await browser.storage.local.get('settings')
  result.settings.feature = false
  assert.equal((await browser.storage.local.get('settings')).settings.feature, true)
  browser.storage.onChanged.removeListener(listener)
  assert.equal(browser.storage.local.onChanged.hasListener(listener), false)
  await browser.storage.local.remove('enabled')
  assert.equal((await browser.storage.local.get()).enabled, undefined)
  await browser.storage.local.clear()
  assert.deepEqual(plain(await browser.storage.local.get()), {})
})

test('shares settings across languages and tabs while isolating projects and configured groups', async () => {
  const hub = browserHub()
  const first = await api('?lang=en', hub.create())
  await first.storage.local.set({ enabled: false })
  const second = await api('?lang=fr', hub.create())
  assert.equal((await second.storage.local.get()).enabled, false)
  const changes = []
  second.storage.onChanged.addListener((change) => changes.push(plain(change)))
  await first.storage.local.set({ flatSetting: true })
  assert.equal(changes.at(-1).flatSetting.newValue, true)
  const isolated = await api('?group=other', hub.create())
  assert.equal((await isolated.storage.local.get()).flatSetting, undefined)
  config.preview.id = 'another-extension'
  assert.equal((await (await api('', hub.create())).storage.local.get()).flatSetting, undefined)
  delete config.preview.id
  const reset = await api('?reset=1', hub.create())
  assert.deepEqual(plain(await reset.storage.local.get()), {})
})

test('simulates shared settings writes, imports and trace messages, preserving preview state', async () => {
  const browser = await api('?layout=custom-value&reset=1')
  await browser.storage.local.set({ settings: { first: true, second: true } })
  await browser.runtime.sendMessage({ type: 'SET_SETTINGS', settings: { first: false } })
  assert.deepEqual(plain((await browser.storage.local.get()).settings), {
    first: false,
    second: true,
  })
  await new Promise((resolve) =>
    browser.runtime.sendMessage({ type: 'SET_SETTINGS', settings: {}, replace: true }, resolve),
  )
  const state = await browser.storage.local.get()
  assert.deepEqual(plain(state.settings), {})
  assert.equal(state.layout, 'custom-value')
  assert.deepEqual(plain(await browser.runtime.sendMessage({ type: 'GET_DEBUG_TRACE' })), [])
  const url = new URL(browser.runtime.getURL('options.html#section'))
  assert.equal(url.hash, '#section')
  assert.equal(url.searchParams.get('layout'), 'custom-value')
  assert.equal(url.searchParams.get('group'), 'default')
  assert.equal(url.searchParams.has('reset'), false)
})

test('CLI loads local configuration and starts on the requested port', {
  timeout: 5000,
}, async () => {
  write('soext.config.mjs', `export default ${JSON.stringify(config)}`)
  const cli = fileURLToPath(new URL('../bin/soext.mjs', import.meta.url))
  const child = spawn(
    process.execPath,
    [cli, 'preview', 'options', '--root', root, '--port', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  try {
    const address = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (code) => reject(new Error(`Preview exited with ${code}`)))
      child.stdout.on('data', (chunk) => {
        const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/)
        if (match) resolve(match[0])
      })
    })
    assert.equal((await fetch(address)).status, 200)
    assert.equal(fs.existsSync(path.join(root, 'manifest.json')), false)
  } finally {
    child.kill()
    if (child.exitCode == null) await new Promise((resolve) => child.once('exit', resolve))
  }
  const invalid = spawnSync(
    process.execPath,
    [cli, 'preview', 'options', '--root', root, '--port', 'invalid'],
    { encoding: 'utf8' },
  )
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /Invalid port/)
})
