export interface ParsedBibliography {
  format: 'bibtex' | 'ris' | 'endnote' | 'gbt7714' | 'apa' | 'labeled'
  title?: string
  authors?: string
  year?: number
  journal?: string
  volume?: string
  issue?: string
  pages?: string
  doi?: string
  publisher?: string
}

export interface BibliographyFormValue {
  title: string
  authors: string
  year: string
  journal: string
  volume: string
  issue: string
  pages: string
  doi: string
  publisher: string
  metadataRaw: string
}

const DOI_PATTERN = /\b10\.\d{4,9}\/[\w.()/:;+-]+/i

export function parseBibliography(raw: string): ParsedBibliography | null {
  const source = raw.trim()
  if (!source) return null

  const citationSource = stripLeadingCitationIndex(source)

  const parsed = source.startsWith('@')
    ? parseBibTeX(source)
    : looksLikeRis(source)
      ? parseRis(source)
      : looksLikeEndNote(source)
        ? parseEndNote(source)
        : bestCandidate(
            parseGbt7714(citationSource),
            parseApa(citationSource),
            parseLabeled(source)
          )

  if (!parsed) return null
  const doi = extractDoi(source)
  if (doi && !parsed.doi) parsed.doi = doi
  return hasBibliographicValue(parsed) ? parsed : null
}

export function mergeParsedBibliography<T extends BibliographyFormValue>(
  value: T,
  parsed: ParsedBibliography,
  overwrite = false
): T {
  const next = { ...value }
  const assign = (key: Exclude<keyof BibliographyFormValue, 'metadataRaw'>, parsedValue?: string): void => {
    if (!parsedValue || (!overwrite && next[key].trim())) return
    next[key] = parsedValue
  }

  assign('title', parsed.title)
  assign('authors', parsed.authors)
  assign('year', parsed.year ? String(parsed.year) : undefined)
  assign('journal', parsed.journal)
  assign('volume', parsed.volume)
  assign('issue', parsed.issue)
  assign('pages', parsed.pages)
  assign('doi', parsed.doi)
  assign('publisher', parsed.publisher)
  return next
}

export function fillBibliographyFromRaw<T extends BibliographyFormValue>(value: T): T {
  const parsed = parseBibliography(value.metadataRaw)
  return parsed ? mergeParsedBibliography(value, parsed) : value
}

function parseBibTeX(source: string): ParsedBibliography | null {
  const fields = new Map<string, string>()
  const fieldPattern = /(\w+)\s*=\s*(?:\{([\s\S]*?)\}|"([\s\S]*?)")\s*,?(?=\s*\w+\s*=|\s*\}\s*$)/g
  for (const match of source.matchAll(fieldPattern)) {
    const key = match[1]?.toLocaleLowerCase()
    const value = cleanValue(match[2] ?? match[3] ?? '')
    if (key && value) fields.set(key, value)
  }
  const year = parseYear(fields.get('year'))
  const pages = normalizePageRange(fields.get('pages'))
  return compact({
    format: 'bibtex',
    title: fields.get('title'),
    authors: normalizeAuthors(fields.get('author')),
    year,
    journal: fields.get('journal') ?? fields.get('booktitle'),
    volume: fields.get('volume'),
    issue: fields.get('number') ?? fields.get('issue'),
    pages,
    doi: normalizeDoi(fields.get('doi')),
    publisher: fields.get('publisher')
  })
}

function looksLikeRis(source: string): boolean {
  return /^(?:TY|TI|T1|AU|A1|PY|Y1|JO|JF|T2|DO)  - /m.test(source)
}

function parseRis(source: string): ParsedBibliography | null {
  const fields = new Map<string, string[]>()
  let lastKey: string | null = null
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9]{2})  -\s*(.*)$/)
    if (match?.[1]) {
      lastKey = match[1]
      const values = fields.get(lastKey) ?? []
      values.push(match[2]?.trim() ?? '')
      fields.set(lastKey, values)
    } else if (lastKey && line.trim()) {
      const values = fields.get(lastKey)
      if (values?.length) values[values.length - 1] = `${values.at(-1)} ${line.trim()}`
    }
  }
  const first = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = fields.get(key)?.find(Boolean)
      if (value) return cleanValue(value)
    }
    return undefined
  }
  const authors = [...(fields.get('AU') ?? []), ...(fields.get('A1') ?? [])]
    .map(cleanValue)
    .filter(Boolean)
    .join('；')
  const startPage = first('SP')
  const endPage = first('EP')
  return compact({
    format: 'ris',
    title: first('TI', 'T1'),
    authors: authors || undefined,
    year: parseYear(first('PY', 'Y1', 'DA')),
    journal: first('JO', 'JF', 'T2'),
    volume: first('VL'),
    issue: first('IS'),
    pages: startPage ? (endPage && endPage !== startPage ? `${startPage}-${endPage}` : startPage) : undefined,
    doi: normalizeDoi(first('DO')),
    publisher: first('PB')
  })
}

function looksLikeEndNote(source: string): boolean {
  return /^%(?:0|A|E|T|D|J|B|V|N|P|R|I|U)\s+/m.test(source)
}

function parseEndNote(source: string): ParsedBibliography | null {
  const fields = new Map<string, string[]>()
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^%([0A-Z])\s+(.+)$/)
    if (!match?.[1] || !match[2]) continue
    const values = fields.get(match[1]) ?? []
    values.push(cleanValue(match[2]))
    fields.set(match[1], values)
  }
  const first = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = fields.get(key)?.find(Boolean)
      if (value) return value
    }
    return undefined
  }
  const authors = [...(fields.get('A') ?? []), ...(fields.get('E') ?? [])]
    .map(cleanValue)
    .filter(Boolean)
    .join('；')

  return compact({
    format: 'endnote',
    title: first('T'),
    authors: authors || undefined,
    year: parseYear(first('D')),
    journal: first('J', 'B'),
    volume: first('V'),
    issue: first('N'),
    pages: normalizePageRange(first('P')),
    doi: normalizeDoi(first('R')),
    publisher: first('I')
  })
}

function parseLabeled(source: string): ParsedBibliography | null {
  const values: Partial<ParsedBibliography> = {}
  const labels: Array<[Exclude<keyof ParsedBibliography, 'format' | 'year'>, RegExp]> = [
    ['title', /^(?:篇名|题名|标题|文献题名|论文题目|title)\s*[:：]\s*(.+)$/i],
    ['authors', /^(?:作者|责任者|authors?|creators?)\s*[:：]\s*(.+)$/i],
    ['journal', /^(?:刊名|期刊|期刊名称|来源|来源出版物|journal|publication(?:\s+title)?|source)\s*[:：]\s*(.+)$/i],
    ['volume', /^(?:卷|卷号|volume)\s*[:：]\s*(.+)$/i],
    ['issue', /^(?:期|期号|issue|number)\s*[:：]\s*(.+)$/i],
    ['pages', /^(?:页码|页|pages?)\s*[:：]\s*(.+)$/i],
    ['doi', /^(?:doi)\s*[:：]\s*(.+)$/i],
    ['publisher', /^(?:出版社|出版者|publisher)\s*[:：]\s*(.+)$/i]
  ]
  for (const line of source.split(/\r?\n|[；;]/)) {
    const trimmed = line.trim()
    const yearMatch = trimmed.match(/^(?:年份|出版年|发表时间|年|year|publication\s+year|date|issued)\s*[:：]\s*(.+)$/i)
    if (yearMatch) {
      values.year = parseYear(yearMatch[1])
      continue
    }
    for (const [key, pattern] of labels) {
      const match = trimmed.match(pattern)
      if (!match?.[1]) continue
      const value = cleanValue(match[1])
      const normalized =
        key === 'authors'
          ? normalizeAuthors(value)
          : key === 'pages'
            ? normalizePageRange(value)
            : key === 'doi'
              ? normalizeDoi(value)
              : value
      Object.assign(values, { [key]: normalized })
      break
    }
  }
  return Object.keys(values).length > 0 ? compact({ format: 'labeled', ...values }) : null
}

function parseGbt7714(source: string): ParsedBibliography | null {
  const normalized = source.replace(/\s+/g, ' ').trim()
  const marker = normalized.match(/\[([A-Z]+)(?:\/OL)?\]/i)
  if (!marker || marker.index === undefined) return null
  const beforeMarker = normalized.slice(0, marker.index).trim()
  const separatorIndex = beforeMarker.search(/[.．。]\s*/)
  if (separatorIndex < 1) return null

  const authors = normalizeAuthors(beforeMarker.slice(0, separatorIndex))
  const title = cleanValue(beforeMarker.slice(separatorIndex + 1))
  const tail = normalized.slice(marker.index + marker[0].length).replace(/^[.．。\s]+/, '')
  const yearMatch = tail.match(/(?:^|[,，]\s*)((?:18|19|20)\d{2})/)
  const year = parseYear(yearMatch?.[1])
  const yearIndex = yearMatch?.index ?? -1
  const journal = yearIndex >= 0 ? cleanValue(tail.slice(0, yearIndex).replace(/[,，\s]+$/, '')) : undefined
  const afterYear = yearMatch ? tail.slice(yearIndex + yearMatch[0].length).replace(/^[,，\s]+/, '') : ''
  const volumeIssuePages = afterYear.match(/^([^,，(:：\s]+)?\s*(?:\(([^)]+)\))?\s*(?:[:：]\s*([^,，.。\s]+))?/)
  const volume = cleanValue(volumeIssuePages?.[1] ?? '') || undefined
  const issue = cleanValue(volumeIssuePages?.[2] ?? '') || undefined
  const pages = normalizePageRange(volumeIssuePages?.[3])
  const publicationType = marker[1]?.toLocaleUpperCase()
  const publisher =
    publicationType && ['M', 'D', 'R'].includes(publicationType) && journal
      ? cleanValue(journal.split(/[:：]/).at(-1) ?? journal)
      : undefined

  return compact({
    format: 'gbt7714',
    title,
    authors,
    year,
    journal: publisher ? undefined : journal,
    volume: publisher ? undefined : volume,
    issue: publisher ? undefined : issue,
    pages: publisher ? undefined : pages,
    publisher,
    doi: extractDoi(normalized)
  })
}

function parseApa(source: string): ParsedBibliography | null {
  const normalized = source.replace(/\s+/g, ' ').trim()
  const yearMatch = normalized.match(/\(((?:18|19|20)\d{2})[a-z]?\)/i)
  if (!yearMatch || yearMatch.index === undefined || yearMatch.index < 1) return null

  const authors = normalizeAuthors(normalized.slice(0, yearMatch.index).replace(/[.．。\s]+$/, ''))
  const afterYear = normalized
    .slice(yearMatch.index + yearMatch[0].length)
    .replace(/^[.．。\s]+/, '')
  const titleBoundary = afterYear.search(/[.．。]\s+/)
  if (titleBoundary < 1) return null
  const title = cleanValue(afterYear.slice(0, titleBoundary))
  const publication = afterYear.slice(titleBoundary + 1).trim()
  const journalMatch = publication.match(
    /^(.+?)[,，]\s*(\d+)?\s*(?:\(([^)]+)\))?(?:[,，]\s*([^.;。]+))?(?:[.。]|$)/
  )
  const journal = cleanValue(journalMatch?.[1] ?? '') || undefined
  if (!title || !authors || !journal) return null

  return compact({
    format: 'apa',
    title,
    authors,
    year: parseYear(yearMatch[1]),
    journal,
    volume: cleanValue(journalMatch?.[2] ?? '') || undefined,
    issue: cleanValue(journalMatch?.[3] ?? '') || undefined,
    pages: normalizePageRange(journalMatch?.[4]),
    doi: extractDoi(normalized)
  })
}

function compact<T extends ParsedBibliography>(value: T): T | null {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined || value[key] === '') delete value[key]
  }
  return hasBibliographicValue(value) ? value : null
}

function hasBibliographicValue(value: ParsedBibliography): boolean {
  return Boolean(value.title || value.authors || value.year || value.journal || value.doi || value.publisher)
}

function bestCandidate(...candidates: Array<ParsedBibliography | null>): ParsedBibliography | null {
  const available = candidates.filter((candidate): candidate is ParsedBibliography => candidate !== null)
  if (!available.length) return null
  const score = (candidate: ParsedBibliography): number =>
    [candidate.title, candidate.authors, candidate.year, candidate.journal, candidate.volume, candidate.issue, candidate.pages, candidate.doi, candidate.publisher]
      .filter(Boolean).length
  const best = available.reduce((current, candidate) => (score(candidate) > score(current) ? candidate : current))
  const merged: ParsedBibliography = { ...best }
  for (const candidate of available) {
    for (const key of ['title', 'authors', 'year', 'journal', 'volume', 'issue', 'pages', 'doi', 'publisher'] as const) {
      if (merged[key] === undefined && candidate[key] !== undefined) {
        Object.assign(merged, { [key]: candidate[key] })
      }
    }
  }
  return merged
}

function cleanValue(value: string): string {
  return value
    .trim()
    .replace(/^\{+|\}+$/g, '')
    .replace(/[.。；;]+$/, '')
    .trim()
}

function normalizeAuthors(value?: string): string | undefined {
  if (!value) return undefined
  const normalized = stripLeadingCitationIndex(cleanValue(value))
    .replace(/\s+and\s+/gi, '；')
    .replace(/\s*[、;；]\s*/g, '；')
  return normalized || undefined
}

function stripLeadingCitationIndex(value: string): string {
  return value
    .replace(/^\s*(?:\[\s*\d+\s*\]|【\s*\d+\s*】|\(\s*\d+\s*\)|\d+\s*[.．、])\s*/, '')
    .trim()
}

function parseYear(value?: string): number | undefined {
  const match = value?.match(/(?:18|19|20)\d{2}/)
  return match ? Number(match[0]) : undefined
}

function normalizePageRange(value?: string): string | undefined {
  if (!value) return undefined
  const normalized = cleanValue(value).replace(/--/g, '-').replace(/[–—]/g, '-')
  return normalized || undefined
}

function extractDoi(value: string): string | undefined {
  return normalizeDoi(value.match(DOI_PATTERN)?.[0])
}

function normalizeDoi(value?: string): string | undefined {
  if (!value) return undefined
  const normalized = value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi\s*[:：]\s*/i, '')
    .replace(/[.。,，;；]+$/, '')
  return normalized || undefined
}
