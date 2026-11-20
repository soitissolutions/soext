#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

import {
  build,
  clean,
  createPopup,
  loadProject,
  mergeTranslations,
  prepare,
  removeLocaleMessages,
  startOptionsPreview,
  updateLocaleMessages,
  updateVersion,
} from '../index.mjs'

const help = `Usage:
  soext popup [--watch]
  soext preview options [--host 127.0.0.1] [--port 5011]
  soext prepare --mv 2|3
  soext build [--mv 2|3] [--overwrite] [--dry-run]
  soext clean [--dry-run]
  soext version patch|minor|major|<version> [--dry-run]
  soext locales update [translations.json] [--dry-run] [--root directory]
  soext locales remove <key> [key...] [--dry-run] [--root directory]
  soext translations merge <updates.json> <dictionary.json> [--dry-run] [--root directory]

Run from the extension root, or select it with --root.
Locales update defaults to scripts/translations.json, relative to that root.
Locale updates use { "messageKey": { "en": "Text", "es": { "message": "Texto" } } }.
Locale strings preserve message metadata; objects merge their supplied fields.
Shared placeholders: { "messageKey": { "message": { "en": "Text $NAME$" }, "placeholders": { "NAME": { "content": "$1" } } } }.
Translations merge takes key-first updates and an existing locale-first dictionary.
Dictionary values replace entries directly, without WebExtension message handling.
Updates are validated before any writes.`

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mv: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      watch: { type: 'boolean' },
      overwrite: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      root: { type: 'string', default: process.cwd() },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  if (values.help || !positionals.length) {
    console.log(help)
  } else {
    const [command, action, ...args] = positionals
    const options = { root: path.resolve(values.root), dryRun: values['dry-run'] }
    if (values.mv != null && !['2', '3'].includes(values.mv))
      throw new Error('Choose manifest version 2 or 3')
    const mv = values.mv == null ? undefined : Number(values.mv)
    if (values.watch && (command != 'popup' || options.dryRun))
      throw new Error('--watch requires popup without --dry-run')
    let files
    if (command == 'locales' && action == 'update' && args.length <= 1) {
      const file = path.resolve(options.root, args[0] ?? 'scripts/translations.json')
      files = updateLocaleMessages(JSON.parse(fs.readFileSync(file, 'utf8')), options)
    } else if (command == 'locales' && action == 'remove' && args.length) {
      files = removeLocaleMessages(args, options)
    } else if (command == 'translations' && action == 'merge' && args.length == 2) {
      const file = path.resolve(options.root, args[0])
      files = mergeTranslations(JSON.parse(fs.readFileSync(file, 'utf8')), args[1], options)
    } else if (command == 'preview' && action == 'options' && !args.length) {
      if (options.dryRun) throw new Error('--dry-run is not supported for preview')
      startOptionsPreview(await loadProject(options.root), {
        host: values.host,
        port: values.port == null ? undefined : Number(values.port),
      })
    } else if (command == 'popup' && positionals.length == 1) {
      files = [createPopup(options)]
      if (values.watch) {
        fs.watch(options.root, (_, filename) => {
          if (filename != null && filename.toString() != 'options.html') return
          try {
            createPopup(options)
          } catch (error) {
            console.error(error.message)
          }
        })
        console.log('Watching options.html')
      }
    } else if (['prepare', 'build', 'clean', 'version'].includes(command)) {
      if (positionals.length != (command == 'version' ? 2 : 1))
        throw new Error(`Unexpected arguments for ${command}`)
      if (command == 'prepare' && mv == null)
        throw new Error(`${command} requires --mv 2 or --mv 3`)
      const project = await loadProject(options.root)
      if (command == 'prepare') files = prepare(project, mv, options)
      if (command == 'clean') files = clean(project, options)
      if (command == 'build') await build(project, { ...options, mv, overwrite: values.overwrite })
      if (command == 'version')
        console.log(
          `${options.dryRun ? 'Would bump' : 'Bumped'} to v${updateVersion(project, action, options)}`,
        )
    } else {
      throw new Error(`Unknown or incomplete command.\n\n${help}`)
    }
    for (const file of files ?? []) {
      const verb = command == 'clean' ? 'remove' : command == 'prepare' ? 'prepare' : 'update'
      const status = options.dryRun
        ? `Would ${verb}`
        : command == 'clean'
          ? 'Removed'
          : command == 'prepare'
            ? 'Prepared'
            : 'Updated'
      console.log(`${status} ${path.relative(options.root, path.resolve(options.root, file))}`)
    }
    if (files?.length == 0) console.log('No changes')
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = typeof error.status == 'number' && error.status > 0 ? error.status : 1
}
