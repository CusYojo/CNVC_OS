import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'

assertIsolatedMysqlAcceptanceDatabase('leadEnrichmentMysqlFixtureAcceptance')
await import('./leadEnrichmentMysqlFixtureAcceptance.js')
