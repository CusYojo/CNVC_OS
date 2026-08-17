export * from './contracts.js'
export * from './identityRepository.js'
export * from './agentConversationRepository.js'
export * from './aiTaskRepository.js'
export * from './aiConfigurationRepository.js'
export * from './imIntegrationRepository.js'
export * from './adminConfigurationRevisionRepository.js'
import type { IdentityRepositoryProvider } from './identityRepository.js'
import { mysqlIdentityRepositories } from './mysql/mysqlIdentityRepository.js'

export { createMySqlIdentityRepositoryContext } from './mysql/mysqlIdentityRepository.js'
export { createMySqlAgentConversationRepository } from './mysql/mysqlAgentConversationRepository.js'
import type { AgentConversationRepository } from './agentConversationRepository.js'
import { mysqlAgentConversationRepository } from './mysql/mysqlAgentConversationRepository.js'
export { createMySqlAiTaskRepository } from './mysql/mysqlAiTaskRepository.js'
import type { AiTaskRepository } from './aiTaskRepository.js'
import { mysqlAiTaskRepository } from './mysql/mysqlAiTaskRepository.js'
export { createMySqlAiConfigurationRepository } from './mysql/mysqlAiConfigurationRepository.js'
import type { AiConfigurationRepository } from './aiConfigurationRepository.js'
import { mysqlAiConfigurationRepository } from './mysql/mysqlAiConfigurationRepository.js'
export { createMySqlImIntegrationRepository } from './mysql/mysqlImIntegrationRepository.js'
import type { ImIntegrationRepository } from './imIntegrationRepository.js'
import { mysqlImIntegrationRepository } from './mysql/mysqlImIntegrationRepository.js'
import { mysqlAdminConfigurationRevisionRepository } from './mysql/mysqlAdminConfigurationRevisionRepository.js'

// Composition root: services depend on the contract, while the process selects MySQL here.
export const identityRepositories: IdentityRepositoryProvider = mysqlIdentityRepositories
export const agentConversationRepository: AgentConversationRepository = mysqlAgentConversationRepository
export const aiTaskRepository: AiTaskRepository = mysqlAiTaskRepository
export const aiConfigurationRepository: AiConfigurationRepository = mysqlAiConfigurationRepository
export const imIntegrationRepository: ImIntegrationRepository = mysqlImIntegrationRepository
export const adminConfigurationRevisionRepository = mysqlAdminConfigurationRevisionRepository
