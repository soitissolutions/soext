import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { mergeTranslations } from '../index.mjs'

let root
let target
const cli = fileURLToPath(new URL('../bin/soext.mjs', import.meta.url))

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'soext-translations-'))
  target = path.join(root, 'base-locales.json')
  fs.writeFileSync(
    target,
    JSON.stringify({
      en: { Z: 'Last', A: 'Old', OBJECT: { old: 'Replaced' } },
      es: { Z: 'Último', A: 'Anterior' },
      untouched: { Z: 'Keep order', A: 'Keep text' },
    }),
  )
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

test('merges key-first updates directly into locale dictionaries, sorting only updated locales', () => {
  assert.deepEqual(
    mergeTranslations(
      {
        A: { en: 'New', es: 'Nuevo' },
        B: { en: 'Added' },
        OBJECT: { en: { replacement: 'Whole value' } },
      },
      target,
    ),
    [target],
  )
  const dictionary = JSON.parse(fs.readFileSync(target, 'utf8'))
  assert.deepEqual(dictionary.en, {
    A: 'New',
    B: 'Added',
    OBJECT: { replacement: 'Whole value' },
    Z: 'Last',
  })
  assert.deepEqual(dictionary.es, { A: 'Nuevo', Z: 'Último' })
  assert.deepEqual(Object.keys(dictionary.en), ['A', 'B', 'OBJECT', 'Z'])
  assert.deepEqual(Object.keys(dictionary.untouched), ['Z', 'A'])
  assert.deepEqual(Object.keys(dictionary), ['en', 'es', 'untouched'])
  assert.deepEqual(mergeTranslations({ A: { en: 'New' } }, target), [])
})

test('dry runs and empty updates do not change destination bytes', () => {
  const before = fs.readFileSync(target, 'utf8')
  assert.deepEqual(
    mergeTranslations({ A: { en: 'New' } }, 'base-locales.json', { root, dryRun: true }),
    [target],
  )
  assert.equal(fs.readFileSync(target, 'utf8'), before)
  assert.deepEqual(mergeTranslations({}, target), [])
  assert.equal(fs.readFileSync(target, 'utf8'), before)
})

test('invalid later updates and unknown locales fail before writing', () => {
  const before = fs.readFileSync(target, 'utf8')
  for (const input of [
    null,
    [],
    { A: { en: 'New' }, B: null },
    { A: { en: 'New', fr: 'Unknown locale' } },
  ]) {
    assert.throws(() => mergeTranslations(input, target))
    assert.equal(fs.readFileSync(target, 'utf8'), before)
  }
  for (const invalid of ['{broken', '[]', '{"en":null}']) {
    fs.writeFileSync(target, invalid)
    assert.throws(() => mergeTranslations({ A: { en: 'New' } }, target))
    assert.equal(fs.readFileSync(target, 'utf8'), invalid)
  }
})

test('CLI resolves both paths from --root and requires input and destination', () => {
  fs.writeFileSync(
    path.join(root, 'translations.json'),
    JSON.stringify({ A: { en: 'CLI update' } }),
  )
  const run = (...args) =>
    spawnSync(process.execPath, [cli, 'translations', 'merge', ...args, '--root', root], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
    })
  const before = fs.readFileSync(target, 'utf8')
  let result = run('translations.json', 'base-locales.json', '--dry-run')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Would update base-locales.json/)
  assert.equal(fs.readFileSync(target, 'utf8'), before)
  result = run('translations.json', 'base-locales.json')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).en.A, 'CLI update')
  assert.equal(run('translations.json').status, 1)
  assert.equal(run('missing.json', 'base-locales.json').status, 1)
})
