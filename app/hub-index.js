/* hub-index.json — the landing page's cross-module term/QA/topic index.
 *
 * The hub tree, its counts and its title search all read one baked file at the
 * Drive root rather than opening seventeen modules' terms/qa/topics. That is
 * one round trip instead of fifty-one, which is the whole reason it exists.
 *
 * The cost of a bake is that it goes stale, and this one had no way to be
 * rebuilt: tools/build-docs-index.py bakes it by importing serve_hub.py and
 * reading every module's data files from disk, and that content was deleted
 * once Drive became the source of truth. A term added in a module app landed
 * in its terms.json and stayed invisible to the hub.
 *
 * So the index maintains itself. Store.flush() calls patchHubIndex() right
 * after it uploads a module's terms/qa/topics, and the entry for that module
 * is rewritten in place. A write only happens when the index actually
 * changed — editing a term's body leaves its id, label and group alone, so
 * the common case costs nothing beyond one cached read.
 *
 * indexList() is shared with app/hub.js, which uses it to assemble an index
 * from scratch when no baked file exists, so both paths order the tree
 * identically. tools/build-hub-index.mjs reproduces it for Node.
 */
import { readRootJson, writeRootJson } from './drive.js'

/** Kinds that appear in the index. `notes` is per-item and never listed. */
export const INDEXED = new Set(['terms', 'qa', 'topics'])

// Which field names a kind's label. First non-empty one wins: a QA item keeps
// its question, a topic falls back to its summary when it has no title.
const LABEL_KEYS = {
  terms:  ['title'],
  qa:     ['question', 'title'],
  topics: ['title', 'summary'],
}

function label(entry, keys) {
  for (const k of keys) {
    const v = entry[k]
    if (typeof v === 'string' && v.trim()) {
      const t = v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (t) return t
    }
  }
  return entry.id ?? ''
}

/**
 * One kind's data file → the [{id,label,group}] list the tree renders.
 * Sorted by (group, label) to match what serve_hub.py's build_index emitted,
 * so the tree reads the same whichever path produced it.
 */
export function indexList(obj, kind) {
  const keys = LABEL_KEYS[kind] ?? ['title']
  return Object.entries(obj ?? {})
    .flatMap(([k, v]) => v && typeof v === 'object'
      ? [{ id: v.id ?? k, label: label(v, keys), group: v.group ?? '' }] : [])
    .sort((a, b) => a.group.toLowerCase().localeCompare(b.group.toLowerCase())
                 || a.label.toLowerCase().localeCompare(b.label.toLowerCase()))
}

const sameList = (a, b) =>
  Array.isArray(a) && a.length === b.length &&
  a.every((x, i) => x.id === b[i].id && x.label === b[i].label && x.group === b[i].group)

// Held for the session so a burst of saves costs one read, and so the copy we
// write back carries every earlier patch. Reads are serialised by flush().
let _index

/**
 * Bring the baked index in step with a module file that was just uploaded.
 * Returns true when Drive was written.
 *
 * Silent no-ops, all deliberate: an unindexed kind, no baked file at all (the
 * landing page then assembles a live index and needs no help), or a module the
 * bake has never heard of — inventing an entry here would give it no title or
 * emoji and a wrong position in the tree.
 */
export async function patchHubIndex(mod, kind, data) {
  if (!INDEXED.has(kind) || !mod) return false

  _index ??= await readRootJson('hub-index.json', null)
  const entry = _index?.modules?.find(m => m.dir === mod)
  if (!entry) return false

  const next = indexList(data, kind)
  if (sameList(entry[kind], next)) return false

  entry[kind] = next
  await writeRootJson('hub-index.json', _index)
  return true
}
