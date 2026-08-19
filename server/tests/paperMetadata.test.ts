import assert from 'node:assert/strict'
import test from 'node:test'
import { parseFeedEntries } from '../src/services/radarCollectorService.js'
import { mergePaperMetadataPreservingAuthors } from '../src/services/paperMetadata.js'

test('extracts comma-separated authors from arXiv dc:creator', () => {
  const [entry] = parseFeedEntries(`
    <rss xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel><item>
        <title>Example Paper</title>
        <link>https://arxiv.org/abs/2608.16801</link>
        <description>Abstract</description>
        <dc:creator>Giuseppe Destefanis, Tomaso Aste</dc:creator>
      </item></channel>
    </rss>
  `)

  assert.deepEqual(entry.authors, ['Giuseppe Destefanis', 'Tomaso Aste'])
})

test('keeps Atom author names as separate authors', () => {
  const [entry] = parseFeedEntries(`
    <feed><entry>
      <title>Example Paper</title>
      <author><name>Ada Example</name></author>
      <author><name>Lin Example</name></author>
    </entry></feed>
  `)

  assert.deepEqual(entry.authors, ['Ada Example', 'Lin Example'])
})

test('does not overwrite existing authors with an empty refresh', () => {
  const merged = mergePaperMetadataPreservingAuthors(
    { authors: ['Ada Example', 'Lin Example'], firstAuthor: 'Ada Example', secondAuthor: 'Lin Example' },
    { title: 'Updated title', authors: [], firstAuthor: '', secondAuthor: '' },
  )

  assert.equal(merged.title, 'Updated title')
  assert.deepEqual(merged.authors, ['Ada Example', 'Lin Example'])
  assert.equal(merged.firstAuthor, 'Ada Example')
  assert.equal(merged.secondAuthor, 'Lin Example')
})

test('uses refreshed authors when the incoming source has them', () => {
  const merged = mergePaperMetadataPreservingAuthors(
    { authors: ['Old Author'] },
    { authors: ['New Author', 'Second Author'] },
  )

  assert.deepEqual(merged.authors, ['New Author', 'Second Author'])
  assert.equal(merged.firstAuthor, 'New Author')
  assert.equal(merged.secondAuthor, 'Second Author')
})
