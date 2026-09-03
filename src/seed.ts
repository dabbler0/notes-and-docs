// Seeds one small worked example on first run only, so the prototype opens
// showing what it does (a section tree, a real version history, a comment,
// an inline citation) instead of an empty shell. Never overwrites real data:
// it no-ops the moment either collection is non-empty.
import { listSources, createSource } from './models/sourcesRepo'
import { listEssays, createEssay, createChildNode, attachChild, commitNewVersion, addComment, saveNode, getNode } from './models/essaysRepo'
import { emptyEntry } from './lib/bibtex'

export async function seedDemoDataIfEmpty() {
  const [essays, sources] = await Promise.all([listEssays(), listSources()])
  if (essays.length > 0 || sources.length > 0) return

  const ong = emptyEntry('ong1982orality')
  ong.type = 'book'
  ong.fields = { title: 'Orality and Literacy: The Technologizing of the Word', author: 'Walter J. Ong', year: '1982', publisher: 'Methuen' }
  await createSource(ong, { comment: 'On how writing restructures thought — good for the intro\'s framing paragraph.' })

  const essay = await createEssay('On the Uses of Marginal Notes')
  const root = await getNode(essay.rootNodeId)
  if (!root) return

  root.draftContent =
    '<p>Marginal notes have always done two jobs at once: they record a reaction, and they mark a place worth returning to. This draft argues that a good annotation tool should keep those jobs separate.</p>'
  await saveNode(root)
  await commitNewVersion(root, 'First pass')
  root.draftContent =
    '<p>Marginal notes have always done two jobs at once: they record a reaction, and they mark a place worth returning to. This draft argues that a good annotation tool should keep those jobs separate <cite class="citation" data-source-id="' +
    (await listSources())[0].id +
    '">(Ong, 1982)</cite>, rather than flattening them into a single "comment" feature.</p>'
  await saveNode(root)
  await commitNewVersion(root, 'Add the Ong framing')
  await addComment(root, root.headVersionId, 'flattening them into a single "comment" feature', 'Is this too strong a claim for an opening paragraph? Might want a hedge.')

  const related = await createChildNode(
    essay.id,
    'Related work',
    '<p>Most reference managers treat a PDF as an inert file with metadata attached. Most word processors treat "track changes" as the only unit of history. Neither models a section of prose as something with its own independent lineage.</p>',
  )
  await attachChild(root, related.id)

  const method = await createChildNode(essay.id, 'A tree of independently-versioned sections', '<p>[Sketch the data model here — see the demo child "Related work" for how a subsection looks once it has its own text.]</p>')
  await attachChild(root, method.id)
}
