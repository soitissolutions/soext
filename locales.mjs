import fs from 'node:fs'
import path from 'node:path'

/** @returns {value is Record<string, any>} */
function isObject(value) {
  return value != null && typeof value == 'object' && !Array.isArray(value)
}

function readMessages(file) {
  const messages = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!isObject(messages)) throw new Error(`Expected a messages object in ${file}`)
  return messages
}

function saveChanges(changes, dryRun) {
  const changedFiles = []
  for (const [file, messages] of changes) {
    const output = `${JSON.stringify(messages, null, 2)}\n`
    if (output == fs.readFileSync(file, 'utf8')) continue
    changedFiles.push(file)
    if (!dryRun) fs.writeFileSync(file, output, 'utf8')
  }
  return changedFiles
}

/**
 * Merge message-first translations into an extension's locale files.
 * Validate every update and read every affected file before writing any changes.
 * @param {Record<string, Record<string, unknown>>} translations
 * @param {{root?: string, dryRun?: boolean}} [options]
 * @returns {string[]} Changed file paths (also returned during a dry run).
 */
export function updateLocaleMessages(translations, { root = process.cwd(), dryRun = false } = {}) {
  if (!isObject(translations)) throw new Error('Expected a translations object')
  const changes = new Map()
  for (const [key, entry] of Object.entries(translations)) {
    if (!key || !isObject(entry)) throw new Error(`Invalid translations for ${key}`)
    let locales = entry
    let shared = {}
    if (Object.hasOwn(entry, 'message')) {
      const { message, ...metadata } = entry
      if (!isObject(message)) throw new Error(`Expected a message locale map for ${key}`)
      for (const field of Object.keys(metadata)) {
        if (!['description', 'placeholders'].includes(field)) {
          throw new Error(`Unknown shared message field: ${key}.${field}`)
        }
      }
      if (Object.hasOwn(metadata, 'description') && typeof metadata.description != 'string') {
        throw new Error(`Expected a description string for ${key}`)
      }
      if (Object.hasOwn(metadata, 'placeholders')) {
        if (
          !isObject(metadata.placeholders) ||
          Object.values(metadata.placeholders).some(
            (placeholder) => !isObject(placeholder) || typeof placeholder.content != 'string',
          )
        )
          throw new Error(`Expected placeholder objects with content strings for ${key}`)
      }
      locales = message
      shared = metadata
    }
    for (const [locale, message] of Object.entries(locales)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(locale)) throw new Error(`Invalid locale: ${locale}`)
      const update = typeof message == 'string' ? { message } : message
      if (!isObject(update) || typeof update.message != 'string') {
        throw new Error(`Expected a string or message object for ${key}.${locale}`)
      }
      const file = path.resolve(root, '_locales', locale, 'messages.json')
      const messages = changes.get(file) ?? readMessages(file)
      // A computed property also safely handles keys such as __proto__.
      changes.set(file, { ...messages, [key]: { ...messages[key], ...shared, ...update } })
    }
  }
  for (const [file, messages] of changes) {
    const entries = Object.entries(messages).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    changes.set(file, Object.fromEntries(entries))
  }
  return saveChanges(changes, dryRun)
}

/**
 * Remove keys across existing locales, preserving the order of remaining keys.
 * @param {string[]} keys
 * @param {{root?: string, dryRun?: boolean}} [options]
 * @returns {string[]} Changed file paths (also returned during a dry run).
 */
export function removeLocaleMessages(keys, { root = process.cwd(), dryRun = false } = {}) {
  if (!Array.isArray(keys) || !keys.length || keys.some((key) => typeof key != 'string' || !key)) {
    throw new Error('Provide at least one message key to remove')
  }
  const locales = path.resolve(root, '_locales')
  const changes = new Map()
  for (const locale of fs
    .readdirSync(locales, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!locale.isDirectory()) continue
    const file = path.join(locales, locale.name, 'messages.json')
    const messages = readMessages(file)
    if (!keys.some((key) => Object.hasOwn(messages, key))) continue
    for (const key of keys) delete messages[key]
    changes.set(file, messages)
  }
  return saveChanges(changes, dryRun)
}
