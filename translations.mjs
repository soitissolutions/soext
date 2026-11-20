import fs from 'node:fs'
import path from 'node:path'

function isObject(value) {
  return value != null && typeof value == 'object' && !Array.isArray(value)
}

/**
 * Merges key-first updates into an existing locale-first translation dictionary.
 * Values are stored directly, without WebExtension message wrapping or merging.
 * @param {Record<string, Record<string, unknown>>} translations
 * @param {string} targetFile
 * @param {{root?: string, dryRun?: boolean}} [options]
 * @returns {string[]} Changed file paths (also returned during a dry run).
 */
export function mergeTranslations(
  translations,
  targetFile,
  { root = process.cwd(), dryRun = false } = {},
) {
  if (!isObject(translations)) throw new Error('Expected a translations object')
  const file = path.resolve(root, targetFile)
  const original = fs.readFileSync(file, 'utf8')
  const dictionary = JSON.parse(original)
  if (!isObject(dictionary)) throw new Error(`Expected a translation dictionary in ${targetFile}`)
  const updatedLocales = new Set()
  for (const [key, locales] of Object.entries(translations)) {
    if (!key || !isObject(locales)) throw new Error(`Invalid translations for ${key}`)
    for (const [locale, value] of Object.entries(locales)) {
      if (!Object.hasOwn(dictionary, locale) || !isObject(dictionary[locale])) {
        throw new Error(`Expected an existing locale dictionary for ${locale} in ${targetFile}`)
      }
      dictionary[locale] = { ...dictionary[locale], [key]: value }
      updatedLocales.add(locale)
    }
  }
  if (!updatedLocales.size) return []
  for (const locale of updatedLocales) {
    dictionary[locale] = Object.fromEntries(
      Object.entries(dictionary[locale]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    )
  }
  const output = `${JSON.stringify(dictionary, null, 2)}\n`
  if (output == original) return []
  if (!dryRun) fs.writeFileSync(file, output, 'utf8')
  return [file]
}
