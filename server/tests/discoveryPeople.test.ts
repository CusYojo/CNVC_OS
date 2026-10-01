import assert from 'node:assert/strict'
import test from 'node:test'
import { peopleFromResearchCandidates } from '../src/contracts/discoveryPeopleContract.js'

test('research people aggregate only by stable author identity and retain article evidence', () => {
  const people = peopleFromResearchCandidates([
    { source: 'openalex', sourceGroup: '论文', payload: { title: 'First paper', link: 'https://doi.org/10.1000/first', published_at: '2025-01-02', paper_authors: [{ name: '李明', openAlexAuthorId: 'A123', affiliations: [{ name: '清华大学' }] }] } },
    { source: 'openalex', sourceGroup: '论文', payload: { title: 'Second paper', link: 'https://doi.org/10.1000/second', published_at: '2025-02-02', paper_authors: [{ name: '李明', openAlexAuthorId: 'A123', affiliations: [{ name: '清华大学' }] }] } },
    { source: 'openalex', sourceGroup: '论文', payload: { title: 'Namesake paper', link: 'https://doi.org/10.1000/third', paper_authors: [{ name: '李明', openAlexAuthorId: 'A999' }] } },
  ])
  assert.equal(people.length, 2)
  assert.equal(people.find((person) => person.identityKey === 'openalex:A123')?.evidence.length, 2)
  assert.equal(people.find((person) => person.identityKey === 'openalex:A123')?.organization, '清华大学')
})

test('unidentified names are not merged and unsupported URLs never become evidence', () => {
  const people = peopleFromResearchCandidates([
    { source: 'arxiv', sourceGroup: '论文', payload: { title: 'Paper one', link: 'https://arxiv.org/abs/1234.5678', paper_authors: [{ name: '王伟' }] } },
    { source: 'arxiv', sourceGroup: '论文', payload: { title: 'Paper two', link: 'https://arxiv.org/abs/1234.5679', paper_authors: [{ name: '王伟' }] } },
    { source: 'openalex', sourceGroup: '论文', payload: { title: 'No trusted URL', link: 'javascript:alert(1)', paper_authors: [{ name: '张三', openAlexAuthorId: 'A1' }] } },
  ])
  assert.equal(people.length, 2)
  assert.notEqual(people[0]?.identityKey, people[1]?.identityKey)
  assert.match(people[0]?.identityKey || '', /^paper:https/)
  assert.ok(people.every((person) => person.evidence.every((item) => item.url.startsWith('https://'))))
})
