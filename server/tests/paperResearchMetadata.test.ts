import assert from 'node:assert/strict'
import test from 'node:test'
import { arxivPaperId, parseArxivResearchMetadata } from '../src/services/paperResearchMetadataService.js'

const authors = ['Samuel J. Vincent', 'Daniel Calloway', 'Fangyi Yu', 'Andrew M. Bean', 'Nabeel Seedat']

const sampleHtml = `
  <html><body>
    <a id="license-tr" href="https://info.arxiv.org/help/license/index.html">License: CC BY-NC-SA 4.0</a>
    <div class="ltx_authors">
      <p>InsufficiencyBench 1]Thomson Reuters Foundational Research 2]Imperial College London
        \\correspondence contact@example.com
        \\contribution[*]Joint first author. \\contribution[†]Joint senior author.</p>
      <span class="ltx_personname">Samuel J. Vincent<sup>∗</sup></span>
      <span class="ltx_personname">Daniel Calloway<sup>∗</sup></span>
      <span class="ltx_personname">Fangyi Yu<sup>∗</sup></span>
      <span class="ltx_personname">Andrew M. Bean<sup>†</sup></span>
      <span class="ltx_personname">Nabeel Seedat<sup>†</sup></span>
    </div>
    <h1 class="ltx_title ltx_title_document">InsufficiencyBench</h1>
    <div class="ltx_abstract">Dataset: <a href="https://huggingface.co/datasets/example/bench">Hugging Face</a></div>
  </body></html>`

test('parses source-confirmed paper affiliations, contribution roles and article license', () => {
  const metadata = parseArxivResearchMetadata({
    html: sampleHtml,
    authors,
    projectName: 'InsufficiencyBench',
    sourceUrl: 'https://arxiv.org/html/2608.20220v1',
  })
  assert.deepEqual(metadata.affiliations.map((item) => item.name), [
    'Thomson Reuters Foundational Research',
    'Imperial College London',
  ])
  assert.deepEqual(metadata.authorContributions.map((item) => item.label), [
    '共同第一作者', '共同第一作者', '共同第一作者', '共同资深作者', '共同资深作者',
  ])
  assert.equal(metadata.researchTeam.name, 'InsufficiencyBench联合研究团队')
  assert.equal(metadata.researchTeam.memberCount, 5)
  assert.deepEqual(metadata.paperAuthors.map((item) => item.name), authors)
  assert(metadata.paperAuthors.every((item) => item.identityStatus === 'ambiguous'))
  assert.deepEqual(metadata.paperAuthors.map((item) => item.position), [1, 2, 3, 4, 5])
  assert.deepEqual(metadata.authorAffiliations, [])
  assert.equal(metadata.rights.articleLicense?.code, 'CC BY-NC-SA 4.0')
  assert.equal(metadata.rights.articleLicense?.url, 'https://creativecommons.org/licenses/by-nc-sa/4.0/')
  assert.equal(metadata.rights.dataset?.url, 'https://huggingface.co/datasets/example/bench')
  assert.equal(metadata.rights.dataset?.licenseStatus, 'pending')
  assert.equal(metadata.rights.intellectualProperty.label, '未披露')
  assert.match(metadata.rights.intellectualProperty.note, /不等于知识产权归属/)
})

test('rejects malformed LaTeXML affiliation placeholders and does not infer IP ownership', () => {
  const metadata = parseArxivResearchMetadata({
    html: '<span class="ltx_contact ltx_role_affiliation">Affiliation: [</span><h1 class="ltx_title_document">Paper</h1>',
    authors: ['A. Author'],
    projectName: 'Paper',
    sourceUrl: 'https://arxiv.org/html/2608.00001v1',
  })
  assert.deepEqual(metadata.affiliations, [])
  assert.equal(metadata.authorContributions[0]?.label, '第一作者')
  assert.equal(metadata.rights.articleLicense, undefined)
  assert.equal(metadata.rights.intellectualProperty.status, 'undisclosed')
})

test('parses nested LaTeXML affiliation and abs-page arXiv license markup', () => {
  const metadata = parseArxivResearchMetadata({
    html: `<span class="ltx_contact ltx_role_affiliation"><span class="ltx_contact_name">Affiliation: </span>Google DeepMind</span>
      <div class="abs-license"><a href="http://arxiv.org/licenses/nonexclusive-distrib/1.0/" title="Rights to this article">view license</a></div>`,
    authors: ['Kate Larson'],
    projectName: 'Paper',
    sourceUrl: 'https://arxiv.org/abs/2608.20316v1',
  })
  assert.deepEqual(metadata.affiliations.map((item) => item.name), ['Google DeepMind'])
  assert.equal(metadata.rights.articleLicense?.code, 'arXiv.org perpetual non-exclusive license')
})

test('filters malformed affiliation annotations and resolves Creative Commons URL labels', () => {
  const metadata = parseArxivResearchMetadata({
    html: `<span class="ltx_contact ltx_role_affiliation"><span class="ltx_contact_name">Affiliation: </span>University of Technology Nuremberg</span>
      <span class="ltx_contact ltx_role_affiliation"><span class="ltx_contact_name">Affiliation: </span>person@example.com</span>
      <span class="ltx_contact ltx_role_affiliation"><span class="ltx_contact_name">Affiliation: </span>NP-hard</span>
      <div class="abs-license"><a href="http://creativecommons.org/licenses/by/4.0/"><span>view license</span></a></div>`,
    authors: [],
    projectName: 'Paper',
    sourceUrl: 'https://arxiv.org/abs/2608.00002v1',
  })
  assert.deepEqual(metadata.affiliations.map((item) => item.name), ['University of Technology Nuremberg'])
  assert.equal(metadata.rights.articleLicense?.code, 'CC BY 4.0')
  assert.equal(metadata.rights.articleLicense?.url, 'https://creativecommons.org/licenses/by/4.0/')
})

test('keeps the exact arXiv version when present', () => {
  assert.equal(arxivPaperId('https://arxiv.org/abs/2608.20220v1'), '2608.20220v1')
  assert.equal(arxivPaperId('arXiv:2608.20220'), '2608.20220')
})
