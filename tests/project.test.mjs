import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import yauzl from 'yauzl'

import { build, clean, prepare, selectFiles, updateVersion } from '../index.mjs'
import { readTargetManifest } from '../manifest.mjs'

let root
let project

function write(file, value) {
  const absolute = path.join(root, file)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, typeof value == 'string' ? value : JSON.stringify(value, null, 2))
}
function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8')
}
function json(file) {
  return JSON.parse(read(file))
}
function snapshot() {
  return new Map(
    ['manifest.json', 'browser_action.html', 'variant.js'].map((file) => [
      file,
      fs.existsSync(path.join(root, file)) ? read(file) : null,
    ]),
  )
}
function archiveFiles(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error)
      const contents = new Map()
      zip.on('error', reject)
      zip.on('end', () => resolve(contents))
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error)
          const chunks = []
          stream.on('error', reject)
          stream.on('data', (data) => chunks.push(data))
          stream.on('end', () => {
            contents.set(entry.fileName, Buffer.concat(chunks).toString())
            zip.readEntry()
          })
        })
      })
      zip.readEntry()
    })
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'soext-project-'))
  project = {
    root,
    config: {
      archiveName: 'example',
      files: [
        'manifest.json',
        'browser_action.html',
        'options.html',
        'content.js',
        '_locales/*/messages.json',
      ],
    },
  }
  write('manifest.mv3.json', { manifest_version: 3, name: 'Example', version: '1.2.3' })
  write('manifest.firefox.json', {})
  for (const mv of [2, 3]) write(`variant.mv${mv}.js`, `version${mv}`)
  write('options.html', '<body><span id="version">v1.2.3<b>Debug</b></span></body>')
  write('content.js', 'console.log("extension")')
  write('_locales/en/messages.json', {})
  write('notes.md', 'Must not ship')
  write('tests/example.test.js', 'Must not ship')
  write('safari/Shared (Extension)/Resources/manifest.json', {
    manifest_version: 3,
    name: 'Example',
    version: '1.2.3',
  })
  write(
    'safari/Example.xcodeproj/project.pbxproj',
    'CURRENT_PROJECT_VERSION = 9;\nMARKETING_VERSION = 1.2.3;\nCURRENT_PROJECT_VERSION = 9;\nMARKETING_VERSION = 1.2.3;',
  )
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

test('prepare selects MV2/MV3 root variants and generates the popup; clean only removes generated files', () => {
  for (const mv of [2, 3]) {
    prepare(project, mv)
    assert.equal(json('manifest.json').manifest_version, mv)
    assert.equal(read('variant.js'), `version${mv}`)
    assert.match(read('browser_action.html'), /<body class="browserAction">/)
  }
  assert.throws(() => prepare(project, 4), /manifest version/)
  const before = snapshot()
  clean(project, { dryRun: true })
  assert.deepEqual(snapshot(), before)
  clean(project)
  assert.deepEqual([...snapshot().values()], [null, null, null])
  assert.ok(fs.existsSync(path.join(root, 'options.html')))
  assert.ok(fs.existsSync(path.join(root, 'manifest.mv3.json')))
  assert.ok(fs.existsSync(path.join(root, 'manifest.firefox.json')))
})

test('both ZIPs contain exactly the explicit whitelist and preserve the active development state', async () => {
  prepare(project, 2)
  const before = snapshot()
  const archives = await build(project)
  assert.deepEqual(snapshot(), before)
  for (const [i, file] of archives.entries()) {
    const contents = await archiveFiles(file)
    assert.deepEqual([...contents.keys()], selectFiles(project))
    assert.equal(JSON.parse(contents.get('manifest.json')).manifest_version, i + 2)
    assert.equal(contents.get('content.js'), read('content.js'))
    assert.equal(contents.has('notes.md'), false)
    assert.equal(contents.has('tests/example.test.js'), false)
  }
  await assert.rejects(build(project, { mv: 2 }), /EEXIST/)
  assert.deepEqual(snapshot(), before)
  await build(project, { mv: 2, overwrite: true })
  assert.deepEqual(snapshot(), before)
})

test('dry-run and failed builds leave absent/generated files and existing archives intact', async () => {
  const before = snapshot()
  await build(project, { dryRun: true, mv: 3 })
  assert.deepEqual(snapshot(), before)
  assert.equal(fs.existsSync(path.join(root, 'dist')), false)
  await build(project, { mv: 3 })
  const file = path.join(root, 'dist/example-1.2.3.mv3.zip')
  const archive = fs.readFileSync(file)
  project.config.files.push('missing.js')
  await assert.rejects(build(project, { mv: 3, overwrite: true }), /matches no files/)
  assert.deepEqual(fs.readFileSync(file), archive)
  assert.deepEqual(snapshot(), before)
})

test('whitelist fails on missing paths, exclusions and external links', () => {
  prepare(project, 3)
  for (const pattern of ['missing.js', '!notes.md', '../outside']) {
    assert.throws(() => selectFiles({ root, config: { files: ['manifest.json', pattern] } }))
  }
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'soext-external-'))
  try {
    fs.writeFileSync(path.join(external, 'private.txt'), 'Not extension data')
    fs.symlinkSync(path.join(external, 'private.txt'), path.join(root, 'outside.txt'))
    assert.throws(
      () => selectFiles({ root, config: { files: ['manifest.json', 'outside.txt'] } }),
      /outside/,
    )
  } finally {
    fs.rmSync(external, { recursive: true, force: true })
  }
})

test('version updates all manifests, HTML and Xcode targets, including already-prepared files', () => {
  prepare(project, 3)
  assert.equal(updateVersion(project, 'minor', { dryRun: true }), '1.3.0')
  assert.equal(json('manifest.mv3.json').version, '1.2.3')
  assert.equal(updateVersion(project, 'minor'), '1.3.0')
  for (const file of [
    'manifest.mv3.json',
    'safari/Shared (Extension)/Resources/manifest.json',
    'manifest.json',
  ])
    assert.equal(json(file).version, '1.3.0')
  assert.match(read('options.html'), /v1.3.0<b>Debug/)
  assert.match(read('browser_action.html'), /v1.3.0<b>Debug/)
  const xcode = read('safari/Example.xcodeproj/project.pbxproj')
  assert.equal(xcode.match(/CURRENT_PROJECT_VERSION = 10/g).length, 2)
  assert.equal(xcode.match(/MARKETING_VERSION = 1.3.0/g).length, 2)
  assert.equal(updateVersion(project, '2.0.0'), '2.0.0')
  assert.throws(() => updateVersion(project, '1.0.0'), /higher/)
})

test('version updates a prepared Firefox manifest while keeping overrides unchanged', () => {
  prepare(project, 2)
  const overrides = read('manifest.firefox.json')
  updateVersion(project, 'patch')
  assert.equal(json('manifest.json').manifest_version, 2)
  assert.equal(json('manifest.json').version, '1.2.4')
  assert.equal(readTargetManifest(root, 2).version, '1.2.4')
  assert.equal(read('manifest.firefox.json'), overrides)
  assert.equal(fs.existsSync(path.join(root, 'manifest.mv2.json')), false)
})

test('invalid Firefox overrides reject versioning before changes are written', () => {
  const before = read('manifest.mv3.json')
  for (const invalid of ['{broken', '[]', '{"version":"0.0.1"}', '{"manifest_version":3}']) {
    write('manifest.firefox.json', invalid)
    assert.throws(() => updateVersion(project, 'patch'))
    assert.equal(read('manifest.mv3.json'), before)
  }
})

test('inconsistent manifests and missing Xcode files reject version changes before writes', () => {
  const before = read('manifest.mv3.json')
  write('safari/Shared (Extension)/Resources/manifest.json', {
    manifest_version: 3,
    name: 'Example',
    version: '1.0.0',
  })
  assert.throws(() => updateVersion(project, 'patch'), /mismatch/)
  assert.equal(read('manifest.mv3.json'), before)
  write('safari/Shared (Extension)/Resources/manifest.json', {
    manifest_version: 3,
    name: 'Example',
    version: '1.2.3',
  })
  fs.rmSync(path.join(root, 'safari/Example.xcodeproj/project.pbxproj'))
  assert.throws(() => updateVersion(project, 'patch'), /ENOENT/)
  assert.equal(read('manifest.mv3.json'), before)
})

test('version discovers a renamed Xcode project without configuration', () => {
  fs.renameSync(
    path.join(root, 'safari/Example.xcodeproj'),
    path.join(root, 'safari/Renamed Extension.xcodeproj'),
  )
  updateVersion(project, 'patch')
  assert.equal(json('safari/Shared (Extension)/Resources/manifest.json').version, '1.2.4')
  assert.match(
    read('safari/Renamed Extension.xcodeproj/project.pbxproj'),
    /CURRENT_PROJECT_VERSION = 10/,
  )
})

test('missing or ambiguous Safari projects fail before changing versions', () => {
  const before = read('manifest.mv3.json')
  const safariBefore = read('safari/Shared (Extension)/Resources/manifest.json')
  fs.mkdirSync(path.join(root, 'safari/Other.xcodeproj'))
  assert.throws(() => updateVersion(project, 'patch'), /exactly one.*found 2/)
  fs.rmSync(path.join(root, 'safari/Example.xcodeproj'), { recursive: true })
  fs.rmSync(path.join(root, 'safari/Other.xcodeproj'), { recursive: true })
  assert.throws(() => updateVersion(project, 'patch'), /exactly one.*found 0/)
  assert.equal(read('manifest.mv3.json'), before)
  assert.equal(read('safari/Shared (Extension)/Resources/manifest.json'), safariBefore)
})

test('version supports projects with no Safari directory and rejects an incomplete Safari layout', () => {
  const before = read('manifest.mv3.json')
  fs.rmSync(path.join(root, 'safari/Shared (Extension)/Resources/manifest.json'))
  assert.throws(() => updateVersion(project, 'patch'), /ENOENT/)
  assert.equal(read('manifest.mv3.json'), before)
  fs.rmSync(path.join(root, 'safari'), { recursive: true })
  assert.equal(updateVersion(project, 'patch'), '1.2.4')
  assert.equal(json('manifest.mv3.json').version, '1.2.4')
})

test('CLI loads the project from --root and validates manifest choices', () => {
  write('soext.config.mjs', `export default ${JSON.stringify(project.config)}`)
  const cli = fileURLToPath(new URL('../bin/soext.mjs', import.meta.url))
  const run = (...args) =>
    execFileSync(process.execPath, [cli, ...args, '--root', root], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      stdio: 'pipe',
    })
  run('prepare', '--mv', '2')
  assert.equal(json('manifest.json').manifest_version, 2)
  run('build', '--mv', '3')
  assert.equal(json('manifest.json').manifest_version, 2)
  assert.ok(fs.existsSync(path.join(root, 'dist/example-1.2.3.mv3.zip')))
  assert.match(run('version', 'patch', '--dry-run'), /1.2.4/)
  for (const args of [['prepare'], ['build', '--mv', '4'], ['version']]) {
    assert.throws(() => run(...args))
  }
})

test('popup watcher handles an editor replacing options.html', { timeout: 5000 }, async () => {
  const cli = fileURLToPath(new URL('../bin/soext.mjs', import.meta.url))
  const child = spawn(process.execPath, [cli, 'popup', '--watch', '--root', root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (code) => reject(new Error(`Watcher exited with ${code}`)))
      child.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('Watching')) resolve()
      })
    })
    write('replacement.html', '<body>Updated options</body>')
    fs.renameSync(path.join(root, 'replacement.html'), path.join(root, 'options.html'))
    const deadline = Date.now() + 2500
    while (!read('browser_action.html').includes('Updated options') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(read('browser_action.html'), '<body class="browserAction">Updated options</body>')
  } finally {
    child.kill()
    if (child.exitCode == null) await new Promise((resolve) => child.once('exit', resolve))
  }
})
