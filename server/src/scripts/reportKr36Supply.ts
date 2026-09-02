import { getKr36CandidateSupplySnapshot } from '../services/kr36ProjectCandidateService.js'

const snapshot = await getKr36CandidateSupplySnapshot()
console.log(JSON.stringify({ source: '36kr-project', capturedAt: new Date().toISOString(), ...snapshot }, null, 2))
