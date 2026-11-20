import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { removeLocaleMessages, updateLocaleMessages } from '../locales.mjs'

let root
const cli = fileURLToPath(new URL('../bin/soext.mjs', import.meta.url))
const metadata = { description: 'Greeting', placeholders: { name: { content: '$1' } } }

function file(locale) {
  return path.join(root, '_locales', locale, 'messages.json')
}

function read(locale) {
  return JSON.parse(fs.readFileSync(file(locale), 'utf8'))
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'soext-'))
  for (const locale of ['en', 'es']) {
    fs.mkdirSync(path.dirname(file(locale)), { recursive: true })
    fs.writeFileSync(
      file(locale),
      JSON.stringify({ z: { message: 'Last' }, hello: { message: 'Hello', ...metadata } }),
    )
  }
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

test('updates strings and full objects while preserving metadata and sorting keys', () => {
  const files = updateLocaleMessages(
    {
      hello: { en: 'Welcome', es: { message: 'Hola', description: 'Saludo' } },
      a: { en: 'First' },
    },
    { root },
  )
  assert.equal(files.length, 2)
  assert.deepEqual(read('en').hello, { message: 'Welcome', ...metadata })
  assert.deepEqual(read('es').hello, { message: 'Hola', ...metadata, description: 'Saludo' })
  assert.deepEqual(Object.keys(read('en')), ['a', 'hello', 'z'])
  assert.ok(fs.readFileSync(file('en'), 'utf8').endsWith('\n'))
  assert.deepEqual(updateLocaleMessages({ hello: { en: 'Welcome' } }, { root }), [])
})

test('applies shared placeholders to supplied translations alongside shorthand entries', () => {
  fs.mkdirSync(path.dirname(file('fr')), { recursive: true })
  fs.writeFileSync(file('fr'), JSON.stringify({ hello: { message: 'Unchanged' } }))
  const untouched = fs.readFileSync(file('fr'), 'utf8')
  const placeholders = { KEYS: { content: '$1', example: 'Ctrl+K' } }
  updateLocaleMessages(
    {
      hello: {
        message: { en: 'Selected: $KEYS$', es: 'Seleccionado: $KEYS$' },
        placeholders,
      },
      a: { en: 'Existing shorthand' },
    },
    { root },
  )
  for (const [locale, message] of Object.entries({
    en: 'Selected: $KEYS$',
    es: 'Seleccionado: $KEYS$',
  })) {
    assert.deepEqual(read(locale).hello, { message, description: 'Greeting', placeholders })
  }
  assert.equal(read('en').a.message, 'Existing shorthand')
  assert.equal(fs.readFileSync(file('fr'), 'utf8'), untouched)
})

test('locale message objects override shared metadata and omitted metadata is preserved', () => {
  const placeholders = { name: { content: '$1' } }
  updateLocaleMessages(
    {
      hello: {
        message: {
          en: { message: 'Welcome', description: 'English description', placeholders: {} },
          es: 'Hola',
        },
        description: 'Shared description',
        placeholders,
      },
    },
    { root },
  )
  assert.deepEqual(read('en').hello, {
    message: 'Welcome',
    description: 'English description',
    placeholders: {},
  })
  assert.deepEqual(read('es').hello, {
    message: 'Hola',
    description: 'Shared description',
    placeholders,
  })
  updateLocaleMessages({ hello: { message: { es: 'Actualizado' } } }, { root })
  assert.deepEqual(read('es').hello, {
    message: 'Actualizado',
    description: 'Shared description',
    placeholders,
  })
})

test('rejects malformed expanded entries before writing any locale files', () => {
  const before = new Map(
    ['en', 'es'].map((locale) => [locale, fs.readFileSync(file(locale), 'utf8')]),
  )
  for (const invalid of [
    { message: 'Not a locale map' },
    { message: { en: 'New' }, placeholders: null },
    { message: { en: 'New' }, placeholders: { KEYS: { example: 'Missing content' } } },
    { message: { en: 'New' }, description: 123 },
    { message: { en: 'New' }, placeholder: {} },
    { message: { en: 'New', es: 123 } },
  ]) {
    assert.throws(() =>
      updateLocaleMessages({ a: { en: 'Would update' }, hello: invalid }, { root }),
    )
    for (const [locale, original] of before)
      assert.equal(fs.readFileSync(file(locale), 'utf8'), original)
  }
})

test('CLI supports expanded placeholder entries with dry runs', () => {
  fs.mkdirSync(path.join(root, 'scripts'))
  const input = {
    hello: {
      message: { en: 'Selected: $KEYS$', es: 'Seleccionado: $KEYS$' },
      placeholders: { KEYS: { content: '$1' } },
    },
  }
  fs.writeFileSync(path.join(root, 'scripts/translations.json'), JSON.stringify(input))
  const before = fs.readFileSync(file('en'), 'utf8')
  const run = (...args) =>
    spawnSync(process.execPath, [cli, 'locales', 'update', ...args], {
      cwd: root,
      encoding: 'utf8',
    })
  let result = run('--dry-run')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readFileSync(file('en'), 'utf8'), before)
  result = run()
  assert.equal(result.status, 0, result.stderr)
  for (const locale of ['en', 'es']) {
    assert.equal(read(locale).hello.message, input.hello.message[locale])
    assert.deepEqual(read(locale).hello.placeholders, input.hello.placeholders)
  }
})

test('rejects invalid later updates and missing or malformed locales before writing', () => {
  const before = fs.readFileSync(file('en'), 'utf8')
  for (const invalid of [
    { hello: { en: 'Changed', es: 123 } },
    { hello: { en: 'Changed', es: { description: 'Missing message' } } },
    { hello: { en: 'Changed', '../elsewhere': 'Invalid locale' } },
    { hello: { en: 'Changed', fr: 'Missing locale' } },
  ]) {
    assert.throws(() => updateLocaleMessages(invalid, { root }))
    assert.equal(fs.readFileSync(file('en'), 'utf8'), before)
  }
  fs.writeFileSync(file('es'), '{broken')
  assert.throws(() => updateLocaleMessages({ hello: { en: 'Changed', es: 'Hola' } }, { root }))
  assert.equal(fs.readFileSync(file('en'), 'utf8'), before)
})

test('dry runs return affected paths without changing file bytes', () => {
  const before = fs.readFileSync(file('en'), 'utf8')
  assert.deepEqual(updateLocaleMessages({ hello: { en: 'Changed' } }, { root, dryRun: true }), [
    file('en'),
  ])
  assert.equal(removeLocaleMessages(['hello'], { root, dryRun: true }).length, 2)
  assert.equal(fs.readFileSync(file('en'), 'utf8'), before)
})

test('removes multiple keys across locales, preserves remaining order, and ignores absent keys', () => {
  const changed = removeLocaleMessages(['hello', 'missing'], { root })
  assert.equal(changed.length, 2)
  assert.deepEqual(Object.keys(read('en')), ['z'])
  assert.deepEqual(removeLocaleMessages(['hello'], { root }), [])
  assert.throws(() => removeLocaleMessages([], { root }))
})

test('malformed later locale prevents removals from earlier locales', () => {
  const before = fs.readFileSync(file('en'), 'utf8')
  fs.writeFileSync(file('es'), '[]')
  assert.throws(() => removeLocaleMessages(['hello'], { root }), /messages object/)
  assert.equal(fs.readFileSync(file('en'), 'utf8'), before)
})

test('CLI uses the extension root, supports default input and dry runs, and reports invalid commands', () => {
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.writeFileSync(
    path.join(root, 'scripts/translations.json'),
    JSON.stringify({ hello: { en: 'Updated' } }),
  )
  function run(...args) {
    return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' })
  }
  let result = run('locales', 'update', '--dry-run')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Would update/)
  assert.equal(read('en').hello.message, 'Hello')
  result = run('locales', 'update')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(read('en').hello.message, 'Updated')
  result = spawnSync(process.execPath, [cli, 'locales', 'remove', 'hello', 'z', '--root', root], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(read('en'), {})
  for (const args of [['locales', 'remove'], ['locales', 'update', '--typo'], ['unknown']]) {
    assert.equal(run(...args).status, 1)
  }
  assert.equal(run('--help').status, 0)
})
