import assert from 'node:assert/strict'
import test from 'node:test'
import {
  authorContributions,
  doiFromPaperSource,
  parseCrossrefPaperMetadata,
  parseDataCitePaperMetadata,
  parseZenodoPaperMetadata,
} from '../src/services/externalPaperMetadataService.js'

test('derives Cairn DOI from legacy attachment URL', () => {
  assert.equal(doiFromPaperSource('https://shs.cairn.info/article/INNO_PR2_0208/pdf?lang=fr'), '10.3917/inno.pr2.0208')
  assert.equal(doiFromPaperSource('https://shs.cairn.info/revue-innovations-2026-0-page-I206?lang=fr'), '10.3917/inno.pr2.0206')
  assert.equal(doiFromPaperSource('https://doi.org/10.21954/ou.ro.00109205'), '10.21954/ou.ro.00109205')
})

test('parses Crossref journal metadata and author order', () => {
  const metadata = parseCrossrefPaperMetadata({ message: {
    DOI: '10.3917/inno.pr2.0208',
    title: ['Motivations intrinsèque et&nbsp;extrinsèque'],
    author: [
      { given: 'Yosra', family: 'Oueslati', affiliation: [] },
      { given: 'Azza', family: 'Temessek–Behi', affiliation: [] },
    ],
    published: { 'date-parts': [[2026, 6, 5]] },
    created: { 'date-time': '2026-06-05T08:07:31Z' },
    URL: 'https://doi.org/10.3917/inno.pr2.0208',
    publisher: 'CAIRN.INFO',
    'container-title': ['Innovations'],
    type: 'journal-article',
  } }, '10.3917/inno.pr2.0208', new Date('2026-08-25T00:00:00Z'))
  assert.equal(metadata.title, 'Motivations intrinsèque et extrinsèque')
  assert.deepEqual(metadata.authors, ['Yosra Oueslati', 'Azza Temessek–Behi'])
  assert.equal(metadata.publishedAt, '2026-06-05')
  assert.equal(metadata.resourceType, '期刊论文')
})

test('uses metadata creation date when DataCite declares a future publication date', () => {
  const metadata = parseDataCitePaperMetadata({ data: { attributes: {
    created: '2026-03-23T11:07:24.000Z',
    published: '2028',
    publicationYear: 2028,
    creators: [{ givenName: 'Gabriele', familyName: 'De Falco', affiliation: [] }],
    rightsList: [{ rightsIdentifier: 'cc-by-nc-nd-4.0', rightsUri: 'https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode' }],
    url: 'https://oro.open.ac.uk/id/eprint/109205',
    types: { resourceType: 'Thesis', resourceTypeGeneral: 'Text' },
    publisher: 'The Open University',
    titles: [{ title: 'MicroRNAs thesis' }],
  } } }, '10.21954/ou.ro.00109205', new Date('2026-08-25T00:00:00Z'))
  assert.equal(metadata.publishedAt, '2026-03-23')
  assert.equal(metadata.declaredPublishedAt, '2028-01-01')
  assert.equal(metadata.publicationDateStatus, 'source_declared_future')
  assert.equal(metadata.publicationDateBasis, 'metadata_record_created_at')
  assert.equal(metadata.license?.code, 'CC BY-NC-ND 4.0')
})

test('labels sole author and ordered multi-author teams without inventing contribution roles', () => {
  assert.deepEqual(authorContributions(['Christian Ortiz']), [{ author: 'Christian Ortiz', role: 'sole_author', label: '独立作者' }])
  assert.deepEqual(authorContributions(['A', 'B']).map((item) => item.label), ['第一作者', '共同作者'])
})

test('keeps Zenodo exact publication date and canonical record link', () => {
  const metadata = parseZenodoPaperMetadata({
    id: 19103128,
    created: '2026-03-19T00:47:34Z',
    metadata: {
      title: 'SiC model', publication_date: '2025-09-05',
      creators: [{ name: 'Ansari Dezfoli, Amir Reza', affiliation: null }],
      license: { id: 'cc-by-4.0' }, resource_type: { type: 'model' },
    },
    files: [],
  }, '10.5281/zenodo.19103128', new Date('2026-08-25T00:00:00Z'))
  assert.equal(metadata.publishedAt, '2025-09-05')
  assert.equal(metadata.resourceType, '研究数据/模型')
  assert.equal(metadata.license?.code, 'CC BY 4.0')
  assert.equal(metadata.landingPageUrl, 'https://zenodo.org/records/19103128')
})
