import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import {
  PLATFORM_AUDIT_ONLY_COMMANDS,
  PRODUCTION_RELEASE_REQUIRED_COMMANDS,
} from '../contracts/productionReleaseGatePolicy.js'

const root = process.cwd()
const textExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.sh'])

async function filesUnder(relativeRoot: string): Promise<string[]> {
  const absoluteRoot = path.resolve(root, relativeRoot)
  const result: string[] = []
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const absolute = path.resolve(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (textExtensions.has(path.extname(entry.name))) result.push(path.relative(root, absolute))
    }
  }
  await walk(absoluteRoot)
  return result
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[single-service-boundary] ${message}`)
}

function aipinEvidenceCounts(source: string): string | null {
  const match = source.match(
    /扫描\s+(\d+)\s*个活动运行时\/配置文件\s*、\s*(\d+)\s*张目标表\s*(?:和|、)\s*(\d+)\s*个文本\/JSON\s*列/,
  )
  return match ? `${match[1]}:${match[2]}:${match[3]}` : null
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.resolve(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const deploy = await readFile(path.resolve(root, 'deploy.sh'), 'utf8')
  const perReleaseCommands = new Set<string>(PRODUCTION_RELEASE_REQUIRED_COMMANDS)
  const auditOnlyCommands = new Set<string>(PLATFORM_AUDIT_ONLY_COMMANDS)
  const releaseGatePolicyCovers = (command: string): boolean => {
    if (perReleaseCommands.has(command)) return deploy.includes(`npm run ${command}`)
    return auditOnlyCommands.has(command) && typeof packageJson.scripts?.[command] === 'string'
  }
  requireCondition(
    packageJson.scripts?.['check:production-release-gates']
      === 'node --import tsx server/src/scripts/productionReleaseGateAcceptance.ts'
    && releaseGatePolicyCovers('check:production-release-gates'),
    'production release must validate its explicit per-release and platform-audit-only gate policy before mutation',
  )
  const leadDuplicateReleaseAcceptance = await readFile(path.resolve(root, 'server/src/scripts/leadDuplicateReleaseAcceptance.ts'), 'utf8')
  const pythonCaPreflight = await readFile(path.resolve(root, 'server/scripts/check-python-ca.mjs'), 'utf8')
  const documentNativePreflight = await readFile(path.resolve(root, 'server/src/scripts/verifyDocumentRuntimeDependencies.ts'), 'utf8')
  const qaCommandDiscovery = await readFile(path.resolve(root, 'server/src/services/documentRuntimeDiscovery.ts'), 'utf8')
  const buildPlatform = await readFile(path.resolve(root, 'server/scripts/build-platform.mjs'), 'utf8')
  const cleanBuild = await readFile(path.resolve(root, 'server/scripts/clean-build.mjs'), 'utf8')
  const buildReleaseAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/buildReleaseAcceptance.ts'),
    'utf8',
  )
  const singleServicePrestart = await readFile(
    path.resolve(root, 'server/src/scripts/singleServicePrestart.ts'),
    'utf8',
  )
  const singleServicePrestartAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/singleServicePrestartAcceptance.ts'),
    'utf8',
  )
  const migrationCutoverReadiness = await readFile(
    path.resolve(root, 'server/src/scripts/migrationCutoverReadiness.ts'),
    'utf8',
  )
  const migrationCutoverReadinessAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/migrationCutoverReadinessAcceptance.ts'),
    'utf8',
  )
  const environmentExample = await readFile(path.resolve(root, '.env.example'), 'utf8')
  const targetSingleServiceEvidence = await readFile(
    path.resolve(root, 'server/src/scripts/targetSingleServiceEvidence.ts'),
    'utf8',
  )
  const targetSingleServiceHandoff = await readFile(
    path.resolve(root, 'docs/迁移计划/目标Linux单服务现场取证手册-20260811.md'),
    'utf8',
  )
  const gordenSuperPptService = await readFile(
    path.resolve(root, 'server/src/services/aiGordenSuperPptService.ts'),
    'utf8',
  )
  const aiGatewayService = await readFile(
    path.resolve(root, 'server/src/services/aiGatewayService.ts'),
    'utf8',
  )
  const projectQaSkillRuntime = await readFile(
    path.resolve(root, 'server/src/services/aiProjectQaSkillRuntimeService.ts'),
    'utf8',
  )
  const dueDiligenceRuntimeCheck = await readFile(
    path.resolve(
      root,
      'server/workspace/.agents/skills/draft-due-diligence-report/scripts/check_runtime.py',
    ),
    'utf8',
  )
  const dueDiligenceRender = await readFile(
    path.resolve(
      root,
      'server/workspace/.agents/skills/draft-due-diligence-report/scripts/render_and_verify.py',
    ),
    'utf8',
  )
  const migrationGitBaseline = await readFile(
    path.resolve(root, 'server/src/scripts/captureMigrationGitBaseline.ts'),
    'utf8',
  )
  const migrationEnvironmentBaseline = await readFile(
    path.resolve(root, 'server/src/scripts/captureMigrationEnvironmentBaseline.ts'),
    'utf8',
  )
  const migrationDecisionLedger = await readFile(
    path.resolve(root, 'docs/迁移计划/迁移决策与问题台账.md'),
    'utf8',
  )
  const retiredLeadDedup = await readFile(
    path.resolve(root, 'server/src/scripts/dedupLeads.ts'),
    'utf8',
  )
  const retiredLeadSubjectRepair = await readFile(
    path.resolve(root, 'server/src/scripts/repairLeadSubjectNames.ts'),
    'utf8',
  )
  const leadDuplicateDispositionContract = await readFile(
    path.resolve(root, 'server/src/scripts/leadDuplicateDispositionContract.ts'),
    'utf8',
  )
  const prepareLeadDuplicateDispositions = await readFile(
    path.resolve(root, 'server/src/scripts/prepareLeadDuplicateDispositions.ts'),
    'utf8',
  )
  const validateLeadDuplicateDispositions = await readFile(
    path.resolve(root, 'server/src/scripts/validateLeadDuplicateDispositions.ts'),
    'utf8',
  )
  const leadDuplicateDispositionAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadDuplicateDispositionAcceptance.ts'),
    'utf8',
  )
  const leadDuplicateDispositionApplyRuntime = await readFile(
    path.resolve(root, 'server/src/scripts/leadDuplicateDispositionApplyRuntime.ts'),
    'utf8',
  )
  const applyLeadDuplicateDispositions = await readFile(
    path.resolve(root, 'server/src/scripts/applyLeadDuplicateDispositions.ts'),
    'utf8',
  )
  const leadDuplicateApplyAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadDuplicateApplyAcceptance.ts'),
    'utf8',
  )
  const mysqlNormalizationAudit = await readFile(
    path.resolve(root, 'server/src/scripts/mysqlNormalizationAudit.ts'),
    'utf8',
  )
  const sourceGapDispositionContract = await readFile(
    path.resolve(root, 'server/src/scripts/sourceGapDispositionContract.ts'), 'utf8',
  )
  const prepareSourceGapDispositions = await readFile(
    path.resolve(root, 'server/src/scripts/prepareSourceGapDispositions.ts'), 'utf8',
  )
  const validateSourceGapDispositions = await readFile(
    path.resolve(root, 'server/src/scripts/validateSourceGapDispositions.ts'), 'utf8',
  )
  const sourceGapDispositionAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/sourceGapDispositionAcceptance.ts'), 'utf8',
  )
  const applySourceGapDispositions = await readFile(
    path.resolve(root, 'server/src/scripts/applySourceGapDispositions.ts'), 'utf8',
  )
  const pageAuthorityMatrix = await readFile(
    path.resolve(root, 'docs/迁移计划/页面API事实源与验收追踪矩阵.md'),
    'utf8',
  )
  const migrationContractBaseline = await readFile(
    path.resolve(root, 'server/src/scripts/migrationContractBaselineAcceptance.ts'),
    'utf8',
  )
  const migrationContractBaselineDocument = await readFile(
    path.resolve(root, 'docs/迁移计划/迁移契约与交互基线-20260810.md'),
    'utf8',
  )
  const legacyApiCompatibilityAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/legacyApiCompatibilityAcceptance.ts'),
    'utf8',
  )
  const legacyApiCompatibilityMatrix = await readFile(
    path.resolve(root, 'docs/迁移计划/旧API兼容与退场矩阵-20260810.md'),
    'utf8',
  )
  const legacyIssueBaseline = await readFile(
    path.resolve(root, 'docs/迁移计划/旧系统已知问题基线-20260810.md'),
    'utf8',
  )
  const legacySourceBackupAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/legacySourceBackupAcceptance.ts'),
    'utf8',
  )
  const fileAssetBackupRestoreAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/fileAssetBackupRestoreAcceptance.ts'),
    'utf8',
  )
  const migrationFileSampleAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/migrationFileSampleAcceptance.ts'),
    'utf8',
  )
  const mysqlAccountProvisioningService = await readFile(
    path.resolve(root, 'server/src/services/mysqlAccountProvisioningService.ts'),
    'utf8',
  )
  const mysqlAccountProvisioningCli = await readFile(
    path.resolve(root, 'server/src/scripts/provisionMysqlAccounts.ts'),
    'utf8',
  )
  const mysqlAccountSeparationAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/mysqlAccountSeparationAcceptance.ts'),
    'utf8',
  )
  const mysqlAccountCutover = await readFile(
    path.resolve(root, 'server/src/scripts/cutoverMysqlAccounts.ts'),
    'utf8',
  )
  const mysqlAccountCutoverAudit = await readFile(
    path.resolve(root, 'server/src/scripts/mysqlAccountCutoverAudit.ts'),
    'utf8',
  )
  const mysqlAccountHostRotation = await readFile(
    path.resolve(root, 'server/src/scripts/rotateMysqlAccountHost.ts'),
    'utf8',
  )
  const mysqlPrivilegeAudit = await readFile(
    path.resolve(root, 'server/src/scripts/mysqlPrivilegeAudit.ts'),
    'utf8',
  )
  const passwordHashAudit = await readFile(
    path.resolve(root, 'server/src/scripts/passwordHashAudit.ts'),
    'utf8',
  )
  const mysqlMigrationRuntime = await readFile(
    path.resolve(root, 'server/src/db/migrate.ts'),
    'utf8',
  )
  const mysqlArchitectureContractAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/mysqlArchitectureContractAcceptance.ts'),
    'utf8',
  )
  const mysqlArchitectureDecision = await readFile(
    path.resolve(root, 'docs/迁移计划/MySQL领域命名与约束裁决-20260811.md'),
    'utf8',
  )
  const mysqlSchemaBackupCommand = await readFile(
    path.resolve(root, 'server/src/scripts/backupMySqlSchema.ts'),
    'utf8',
  )
  const mysqlBackupInventoryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/mysqlBackupInventoryAcceptance.ts'),
    'utf8',
  )
  const mysqlBackupRestoreHandoff = await readFile(
    path.resolve(root, 'docs/迁移计划/MySQL备份恢复手册-20260809.md'),
    'utf8',
  )
  const mysqlSchemaRollbackCommand = await readFile(
    path.resolve(root, 'server/src/scripts/rollbackMySqlSchema.ts'),
    'utf8',
  )
  const mysqlSeedCommand = await readFile(
    path.resolve(root, 'server/src/scripts/seedMySql.ts'),
    'utf8',
  )
  const mysqlSchemaLifecycleAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/mysqlSchemaLifecycleAcceptance.ts'),
    'utf8',
  )
  const mysqlSchemaLifecycleHandoff = await readFile(
    path.resolve(root, 'docs/迁移计划/MySQL-Schema变更种子与回退手册-20260811.md'),
    'utf8',
  )
  requireCondition(packageJson.scripts?.['start:all'] === 'npm run start:app', 'start:all must delegate only to start:app')
  requireCondition(
    packageJson.scripts?.['start:app'] === 'node --env-file-if-exists=.env server-dist/index.js',
    'start:app must launch the compiled unified Node entry directly',
  )
  requireCondition(
    packageJson.scripts?.['build:platform'] === 'node server/scripts/build-platform.mjs'
    && packageJson.scripts?.['activate:build'] === 'node server/scripts/build-platform.mjs --activate'
    && packageJson.scripts?.['rollback:build'] === 'node server/scripts/build-platform.mjs --rollback'
    && packageJson.scripts?.['accept:build-release']
      === 'node --import tsx server/src/scripts/buildReleaseAcceptance.ts'
    && packageJson.scripts?.['prebuild:platform'] === undefined
    && /build-candidates/.test(buildPlatform)
    && /refusing to activate build while port/.test(buildPlatform)
    && /validateArtifacts\(liveDist, liveServerDist, manifest\)/.test(buildPlatform)
    && /build-rollback\.json/.test(buildPlatform)
    && /failedReleasePreserved: true/.test(buildPlatform)
    && /--discard-candidate/.test(cleanBuild)
    && !/\['dist', 'server-dist'\]/.test(cleanBuild)
    && deploy.indexOf('systemctl stop "$SERVICE_UNIT"') < deploy.indexOf('npm run activate:build:if-present')
    && /npm run rollback:build/.test(deploy)
    && /npm run accept:build-release/.test(deploy)
    && /rollback_failed_release/.test(deploy)
    && deploy.indexOf('npm run db:migrate:separated') < deploy.indexOf('systemctl stop "$SERVICE_UNIT"')
    && /active-listener-blocks-activation-with-live-artifacts-unchanged/.test(buildReleaseAcceptance)
    && /invalid-candidate-hash-blocks-activation-with-live-artifacts-unchanged/.test(buildReleaseAcceptance)
    && /rollback-restores-previous-web-and-server-pair/.test(buildReleaseAcceptance)
    && /productionFilesChanged: 0/.test(buildReleaseAcceptance),
    'production build must stage a validated Web/server pair, activate only after stop, and preserve an automatic rollback',
  )
  requireCondition(
    packageJson.scripts?.['check:single-service-prestart']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/singleServicePrestart.ts'
    && packageJson.scripts?.['accept:single-service-prestart']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/singleServicePrestartAcceptance.ts'
    && /requiredPorts = \[4100, 3584, 8121\]/.test(singleServicePrestart)
    && /\.env mode must be 0600/.test(singleServicePrestart)
    && /build output contains a symbolic link/.test(singleServicePrestart)
    && /a staged build candidate is still pending activation/.test(singleServicePrestart)
    && /MIGRATION_WRITE_FREEZE = 'true'/.test(singleServicePrestart)
    && /MIGRATION_WRITE_FREEZE_MODE = 'rollback-window'/.test(singleServicePrestart)
    && /mysqlConfig\.port === 3306/.test(singleServicePrestart)
    && /await assertSchemaReady\(\)/.test(singleServicePrestart)
    && /databaseWrites: 0/.test(singleServicePrestart)
    && /processMutation: false/.test(singleServicePrestart)
    && /configuredValuesExcluded: true/.test(singleServicePrestart)
    && /pathsExcluded: true/.test(singleServicePrestart)
    && /SINGLE_SERVICE_PRESTART_EVIDENCE_DIR must be absolute/.test(singleServicePrestart)
    && /prestart evidence directory must be a non-symlink directory/.test(singleServicePrestart)
    && deploy.indexOf('npm run activate:build:if-present')
      < deploy.indexOf('npm run check:single-service-prestart')
    && deploy.indexOf('npm run check:single-service-prestart')
      < deploy.indexOf('systemctl start "$SERVICE_UNIT"', deploy.indexOf('start_project()'))
    && /env-permission-failure-closed/.test(singleServicePrestartAcceptance)
    && /build-symlink-failure-closed/.test(singleServicePrestartAcceptance)
    && /occupied-port-failure-closed/.test(singleServicePrestartAcceptance)
    && /current-runtime-config-build-schema-and-mysql-prestart/.test(singleServicePrestartAcceptance)
    && /mysql-authoritative-counts-unchanged/.test(singleServicePrestartAcceptance)
    && /listener-process-set-unchanged/.test(singleServicePrestartAcceptance)
    && /owner-only-configured-value-and-path-free-evidence/.test(singleServicePrestartAcceptance),
    'stopped unified service must pass an offline build, config, port, schema and read-only MySQL prestart gate before restart',
  )
  requireCondition(
    packageJson.scripts?.['audit:cutover-readiness']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/migrationCutoverReadiness.ts'
    && packageJson.scripts?.['check:cutover-readiness']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/migrationCutoverReadiness.ts --strict'
    && packageJson.scripts?.['accept:cutover-readiness']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/migrationCutoverReadinessAcceptance.ts'
    && /MIGRATION_WRITE_FREEZE: 'true'/.test(migrationCutoverReadiness)
    && /MIGRATION_WRITE_FREEZE_MODE: 'rollback-window'/.test(migrationCutoverReadiness)
    && /P0_ACCEPTANCE_ITEMS_PENDING/.test(migrationCutoverReadiness)
    && /DEFERRED_PRODUCTION_BLOCKERS_REMAIN/.test(migrationCutoverReadiness)
    && /UNAPPROVED_ACCEPTANCE_EXCEPTIONS_REMAIN/.test(migrationCutoverReadiness)
    && /PRODUCTION_SMOKE_ITEMS_PENDING/.test(migrationCutoverReadiness)
    && /FINAL_ACCEPTANCE_CONFIRMATIONS_PENDING/.test(migrationCutoverReadiness)
    && /WEAK_PASSWORD_ACCOUNTS_REMAIN/.test(migrationCutoverReadiness)
    && /TARGET_LINUX_DEPLOYMENT_EVIDENCE_NOT_READY/.test(migrationCutoverReadiness)
    && /pathsExcluded: true/.test(migrationCutoverReadiness)
    && /identitiesExcluded: true/.test(migrationCutoverReadiness)
    && /databaseSessionsReadOnly: true/.test(migrationCutoverReadiness)
    && /mode: 0o600/.test(migrationCutoverReadiness)
    && /authoritative-mysql-counts-unchanged/.test(migrationCutoverReadinessAcceptance)
    && /single-service-listener-set-unchanged/.test(migrationCutoverReadinessAcceptance)
    && /deferred-production-blockers-fail-closed/.test(migrationCutoverReadinessAcceptance)
    && /unapproved-acceptance-exceptions-fail-closed/.test(migrationCutoverReadinessAcceptance)
    && /pending-production-smoke-fails-closed/.test(migrationCutoverReadinessAcceptance)
    && /pending-final-confirmations-fail-closed/.test(migrationCutoverReadinessAcceptance)
    && /databaseWrites: 0/.test(migrationCutoverReadinessAcceptance)
    && /processMutation: false/.test(migrationCutoverReadinessAcceptance),
    'cutover readiness must aggregate stable blockers through read-only sessions without exposing paths, identities or secrets',
  )
  requireCondition(
    /GORDEN_LLM_BASE}\/responses/.test(gordenSuperPptService)
    && /type: 'input_text'/.test(gordenSuperPptService)
    && /type: 'input_image'/.test(gordenSuperPptService)
    && /max_output_tokens: 8000/.test(gordenSuperPptService)
    && /reasoning: \{ effort: 'low' \}/.test(gordenSuperPptService)
    && /text: \{ format: \{ type: 'json_object' \} \}/.test(gordenSuperPptService)
    && /shouldFallbackGordenVisionToChat/.test(gordenSuperPptService)
    && /gordenVisionResponseText/.test(gordenSuperPptService)
    && /AI_PYTHON_CA_FILE/.test(gordenSuperPptService)
    && /SSL_CERT_FILE/.test(gordenSuperPptService)
    && /REQUESTS_CA_BUNDLE/.test(gordenSuperPptService)
    && !/PYTHONHTTPSVERIFY/.test(gordenSuperPptService)
    && /AI_PYTHON_CA_FILE=/.test(environmentExample)
    // deploy.sh is now an operational wrapper, not a host installer. Require
    // an actual fail-closed probe before mutation, without overwriting .env.
    && /node --env-file="\$APP_ENV_FILE".*check-python-ca\.mjs.*--print-ca-file/.test(deploy)
    && /prepare_mutation\(\) \{\s*prepare_document_tls\s*prepare_document_native_tools\s*systemctl daemon-reload/.test(deploy)
    && /export SSL_CERT_FILE="\$ca_file"/.test(deploy)
    && /export REQUESTS_CA_BUNDLE="\$ca_file"/.test(deploy)
    && /ssl\.create_default_context/.test(pythonCaPreflight)
    && /context\.check_hostname and context\.verify_mode == ssl\.CERT_REQUIRED/.test(pythonCaPreflight)
    && /stats\.get\('x509_ca', 0\) > 0/.test(pythonCaPreflight)
    && /configured \? \[configured\]/.test(pythonCaPreflight)
    && /realpathSync\(process\.argv\[1\]\)/.test(pythonCaPreflight)
    && /process\.exitCode = 78/.test(pythonCaPreflight)
    && !/CERT_NONE|check_hostname\s*=\s*False|_create_unverified_context/.test(pythonCaPreflight),
    'Gorden vision must support the Responses API and verified Python CA chains without disabling TLS',
  )
  requireCondition(
    /\$\{baseUrl\}\/responses/.test(aiGatewayService)
    && /max_output_tokens/.test(aiGatewayService)
    && /text: \{ format: \{ type: 'json_object' \} \}/.test(aiGatewayService)
    && /type: 'input_image'/.test(aiGatewayService)
    && /shouldFallbackAiGatewayToChat/.test(aiGatewayService)
    && /fetchAiGatewayChatCompatible/.test(aiGatewayService)
    && /homedir\(\)/.test(projectQaSkillRuntime)
    && /projectQaCommandCandidates\(\)/.test(projectQaSkillRuntime)
    && /AI_QA_PDFFONTS_BINARY/.test(qaCommandDiscovery)
    && !/\/Users\/lh\//.test(projectQaSkillRuntime)
    && /Microsoft Word\.app\/Contents\/Resources\/DFonts\/Fangsong\.ttf/.test(dueDiligenceRuntimeCheck)
    && /Microsoft Word\.app\/Contents\/Resources\/DFonts\/SimHei\.ttf/.test(dueDiligenceRuntimeCheck)
    && /any_font_file_exists/.test(dueDiligenceRuntimeCheck)
    && /AI_DD_SOFFICE_BINARY/.test(dueDiligenceRender)
    && /AI_QA_SOFFICE_BINARY/.test(dueDiligenceRender)
    && dueDiligenceRender.indexOf('or shutil.which("soffice")')
      < dueDiligenceRender.indexOf('word_pdf = convert_with_word')
    && /AI_QA_SOFFICE_BINARY=/.test(environmentExample)
    && /verifyDocumentRuntimeDependencies\.ts --native-only --stdout-only/.test(deploy)
    && /projectQaCommandCandidates\(context\.env, context\.home\)/.test(documentNativePreflight)
    && /qaRenderRuntimeCompatible/.test(documentNativePreflight)
    && /fontFamilyMatches\(match, family\)/.test(documentNativePreflight)
    && /pythonPackagesChecked: !nativeOnly/.test(documentNativePreflight)
    && /languageOutput\.split/.test(documentNativePreflight),
    'shared AI gateway and document render runtimes must use Responses contracts and portable executable/font discovery',
  )
  requireCondition(
    packageJson.scripts?.dev === 'concurrently -k -n API,WEB -c green,blue "npm:dev:server" "npm:dev:web"',
    'development entry may only launch API and Web',
  )
  requireCondition(
    /status', '--porcelain=v1', '-z', '--untracked-files=all/.test(migrationGitBaseline)
    && /projectUsesDedicatedMigrationBranch/.test(migrationGitBaseline)
    && /projectHeadMatchesRecordedBase/.test(migrationGitBaseline)
    && /jwSourceBranchAndCommitCaptured/.test(migrationGitBaseline)
    && /parsed\.username = ''/.test(migrationGitBaseline)
    && /parsed\.password = ''/.test(migrationGitBaseline)
    && /mode: 0o600/.test(migrationGitBaseline)
    && /does not infer ownership or classify pre-existing user changes/.test(migrationGitBaseline)
    && packageJson.scripts?.['capture:migration-git-baseline']
      === 'node --import tsx server/src/scripts/captureMigrationGitBaseline.ts',
    'migration Git baseline must capture both repositories and the complete dirty-file inventory without inferring ownership or leaking remote credentials',
  )
  requireCondition(
    /'package\.json'/.test(migrationEnvironmentBaseline)
    && /'package-lock\.json'/.test(migrationEnvironmentBaseline)
    && /'\.env\.example'/.test(migrationEnvironmentBaseline)
    && /'start\.sh'/.test(migrationEnvironmentBaseline)
    && /'deploy\.sh'/.test(migrationEnvironmentBaseline)
    && /'docker-compose\.yml'/.test(migrationEnvironmentBaseline)
    && /SELECT VERSION\(\) AS version/.test(migrationEnvironmentBaseline)
    && /runtimeEnvExcluded/.test(migrationEnvironmentBaseline)
    && /configuration-baseline\.tar/.test(migrationEnvironmentBaseline)
    && /sha256/.test(migrationEnvironmentBaseline)
    && /mode: 0o600/.test(migrationEnvironmentBaseline)
    && packageJson.scripts?.['capture:migration-environment-baseline']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/captureMigrationEnvironmentBaseline.ts',
    'migration environment baseline must version runtime dependencies and checksum an approved configuration archive that excludes the real environment file',
  )
  for (const id of [
    'ADR-001', 'ADR-002', 'ADR-003', 'ADR-004', 'ADR-005', 'ADR-006', 'ADR-007', 'ADR-008', 'ADR-009',
    'ADR-010', 'ADR-011', 'ADR-012', 'ADR-013', 'ADR-014', 'ADR-015',
    'ISSUE-001', 'ISSUE-002', 'ISSUE-003', 'ISSUE-004', 'ISSUE-005', 'ISSUE-006',
    'ISSUE-007', 'ISSUE-008', 'ISSUE-009', 'ISSUE-010', 'ISSUE-011', 'ISSUE-012',
  ]) requireCondition(migrationDecisionLedger.includes(id), `migration decision/issue ledger is missing: ${id}`)
  requireCondition(
    /问题关闭必须同时更新本台账、执行清单、验收清单和对应机器证据/.test(migrationDecisionLedger),
    'migration issue closure must require synchronized checklist and machine evidence updates',
  )
  requireCondition(
    /LEAD_DEDUP_REQUIRES_APPROVED_LEDGER/.test(retiredLeadDedup)
    && /destructiveWriteAttempted: false/.test(retiredLeadDedup)
    && /process\.exitCode = 78/.test(retiredLeadDedup)
    && !/db\.delete\(leads\)|db\.update\(leads\)|DELETE\s+FROM/i.test(retiredLeadDedup),
    'legacy lead dedup must fail closed until every duplicate group has a versioned business disposition',
  )
  requireCondition(
    /LEAD_SUBJECT_REPAIR_REQUIRES_PIPELINE_REVIEW/.test(retiredLeadSubjectRepair)
    && /destructiveWriteAttempted: false/.test(retiredLeadSubjectRepair)
    && /process\.exitCode = 78/.test(retiredLeadSubjectRepair)
    && !/db\.update\(leads\)|reviewRadarCandidatesWithAi|DELETE\s+FROM/i.test(retiredLeadSubjectRepair),
    'standalone lead subject repair must fail closed outside the Pipeline decision and review boundary',
  )
  requireCondition(
    packageJson.scripts?.['accept:lead-dedup-safety']
      === 'node --import tsx server/src/scripts/leadDedupSafetyAcceptance.ts'
    && releaseGatePolicyCovers('accept:lead-dedup-safety'),
    'lead dedup fail-closed behavior must be enforced by the release acceptance gate',
  )
  requireCondition(
    /normalizationReportSha256/.test(leadDuplicateDispositionContract)
    && /rowFingerprint/.test(leadDuplicateDispositionContract)
    && /physicalDeleteForbidden: true/.test(leadDuplicateDispositionContract)
    && /CONFLICTING_MERGE_CANONICALS/.test(leadDuplicateDispositionContract)
    && /MERGE_CONTRADICTS_SEPARATE_DECISION/.test(leadDuplicateDispositionContract)
    && /LEAD_DUPLICATE_DECISIONS_EXIST_REFUSING_OVERWRITE/.test(prepareLeadDuplicateDispositions)
    && !/\.delete\(|\.update\(|\.insert\(|DELETE\s+FROM|UPDATE\s+|INSERT\s+INTO/i.test(prepareLeadDuplicateDispositions)
    && /LEAD_DUPLICATE_DECISION_FILE_MUST_BE_OWNER_ONLY_REGULAR_FILE/.test(validateLeadDuplicateDispositions)
    && /strict && !result\.ready/.test(validateLeadDuplicateDispositions)
    && !/\.delete\(|\.update\(|\.insert\(|DELETE\s+FROM|UPDATE\s+|INSERT\s+INTO/i.test(validateLeadDuplicateDispositions)
    && /acceptance-is-read-only-and-baseline-remains-unchanged/.test(leadDuplicateDispositionAcceptance)
    && /overlapping-groups-with-conflicting-canonicals-are-rejected/.test(leadDuplicateDispositionAcceptance)
    && /LEAD_DUPLICATE_CONVERTED_LEAD_MUST_BE_CANONICAL/.test(leadDuplicateDispositionApplyRuntime)
    && /LEAD_DUPLICATE_SCORE_JOB_COLLISION/.test(leadDuplicateDispositionApplyRuntime)
    && /LEAD_DUPLICATE_RESERVE_LINK_COLLISION/.test(leadDuplicateDispositionApplyRuntime)
    && /pool_status='已合并'/.test(leadDuplicateDispositionApplyRuntime)
    && /lead_pipeline_items/.test(leadDuplicateDispositionApplyRuntime)
    && /lead_pipeline_entity_matches/.test(leadDuplicateDispositionApplyRuntime)
    && /lead_reserve/.test(leadDuplicateDispositionApplyRuntime)
    && /migration_entity_mappings/.test(leadDuplicateDispositionApplyRuntime)
    && /physicalDeletes: 0/.test(leadDuplicateDispositionApplyRuntime)
    && /LEAD_DUPLICATE_DECISION_SET_ALREADY_APPLIED_WITH_DIFFERENT_HASH/.test(applyLeadDuplicateDispositions)
    && /databaseWrites: 0/.test(applyLeadDuplicateDispositions)
    && /transaction-probe-removes-all-ledger-fixtures/.test(leadDuplicateApplyAcceptance)
    && /transactionProbeRolledBack: true/.test(leadDuplicateApplyAcceptance)
    && /LEAD_DUPLICATE_KEEP_SEPARATE_APPROVED/.test(mysqlNormalizationAudit)
    && /pool_status<>'已合并'/.test(mysqlNormalizationAudit)
    && packageJson.scripts?.['prepare:lead-duplicate-dispositions']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/prepareLeadDuplicateDispositions.ts'
    && packageJson.scripts?.['validate:lead-duplicate-dispositions:strict']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/validateLeadDuplicateDispositions.ts --strict'
    && packageJson.scripts?.['accept:lead-duplicate-dispositions']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/leadDuplicateDispositionAcceptance.ts'
    && packageJson.scripts?.['apply:lead-duplicate-dispositions:preview']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/applyLeadDuplicateDispositions.ts'
    && packageJson.scripts?.['apply:lead-duplicate-dispositions']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/applyLeadDuplicateDispositions.ts --apply'
    && packageJson.scripts?.['accept:lead-duplicate-apply']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/leadDuplicateApplyAcceptance.ts'
    && packageJson.scripts?.['accept:lead-duplicate-release']
      === 'node --env-file-if-exists=.env --env-file-if-exists=.runtime/secrets/mysql-acceptance.env --import tsx server/src/scripts/leadDuplicateReleaseAcceptance.ts'
    && /assertIsolatedMysqlAcceptanceDatabase\('leadDuplicateReleaseAcceptance'\)/.test(leadDuplicateReleaseAcceptance)
    && releaseGatePolicyCovers('accept:lead-duplicate-release')
    && !/run accept:lead-duplicate-(?:dispositions|apply)(?:\s|;)/.test(deploy)
    && /leadDuplicateDispositionAcceptance\.ts/.test(leadDuplicateReleaseAcceptance)
    && /leadDuplicateApplyAcceptance\.ts/.test(leadDuplicateReleaseAcceptance)
    && /assertLeadDuplicateAcceptanceIsolation/.test(leadDuplicateApplyAcceptance)
    && /cleanupFdeTables/.test(leadDuplicateReleaseAcceptance)
    && /withFdeAcceptanceSignals/.test(leadDuplicateReleaseAcceptance)
    && /cwd: fixtureRoot/.test(leadDuplicateReleaseAcceptance)
    && /cleanupCompleted: true/.test(leadDuplicateReleaseAcceptance),
    'lead duplicate adjudication must bind exact groups and live row fingerprints, reject conflicting decisions, preserve source rows, atomically move exact references, and fail closed until every group is approved',
  )
  requireCondition(
    /approved-permanent-quarantine/.test(sourceGapDispositionContract)
    && /approved-permanent-archive/.test(sourceGapDispositionContract)
    && /PPT and report-generation test exclusions do not imply source-gap approval/.test(sourceGapDispositionContract)
    && /FINGERPRINT_DRIFT/.test(sourceGapDispositionContract)
    && /approved or partially approved source-gap disposition cannot be replaced/.test(prepareSourceGapDispositions)
    && /databaseWrites: 0/.test(prepareSourceGapDispositions)
    && /databaseWrites: 0/.test(validateSourceGapDispositions)
    && /testExclusionIsNotDisposition: true/.test(sourceGapDispositionAcceptance)
    && /assert\.deepEqual\(afterLedger, beforeLedger\)/.test(sourceGapDispositionAcceptance)
    && /transactionalApplyProbeRolledBack: true/.test(sourceGapDispositionAcceptance)
    && /--probe-rollback/.test(applySourceGapDispositions)
    && /LEAD_RESERVE_PERMANENT_SOURCE_GAP_APPROVED/.test(applySourceGapDispositions)
    && /AI_ARTIFACT_PERMANENT_SOURCE_GAP_APPROVED/.test(applySourceGapDispositions)
    && /source-gap baseline changed before apply/.test(applySourceGapDispositions)
    && /await connection\.rollback\(\)/.test(applySourceGapDispositions)
    && packageJson.scripts?.['prepare:source-gap-dispositions']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/prepareSourceGapDispositions.ts'
    && packageJson.scripts?.['validate:source-gap-dispositions:strict']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/validateSourceGapDispositions.ts --strict'
    && packageJson.scripts?.['accept:source-gap-dispositions']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/sourceGapDispositionAcceptance.ts'
    && packageJson.scripts?.['apply:source-gap-dispositions:preview']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/applySourceGapDispositions.ts'
    && packageJson.scripts?.['apply:source-gap-dispositions']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/applySourceGapDispositions.ts --apply'
    && releaseGatePolicyCovers('accept:source-gap-dispositions'),
    'source gaps must bind the exact live 97/7 records, reject drift and test-exclusion shortcuts, remain read-only, and fail closed until separately approved',
  )
  for (const route of [
    '/login', '/projects', '/projects/:id', '/sourcing', '/ai', '/meetings', '/workflow', '/risks',
    '/knowledge', '/system', '/system/ai/models', '/system/ai/capabilities',
    '/system/integrations/im-bots', '/materials', '/post-investment',
  ]) requireCondition(pageAuthorityMatrix.includes(`\`${route}\``), `page authority matrix is missing route: ${route}`)
  for (const target of [
    'auth_sessions', 'projects', 'project_files', 'lead_pipeline_raw_events', 'agent_conversations',
    'ai_tasks', 'oa_approval_requests', 'risks', 'ai_model_providers', 'ai_capabilities',
    'im_bots', 'im_lead_push_rules',
  ]) requireCondition(pageAuthorityMatrix.includes(`\`${target}\``), `page authority matrix is missing target authority: ${target}`)
  requireCondition(
    /页面操作 \| API\/实时通道 \| 当前事实源 \| 目标 Repository\/表或存储 \| 审计\/历史 \| 主要验收 \| 状态/.test(pageAuthorityMatrix)
    && /浏览器只保存瞬时 UI 状态和认证 Cookie，不作为业务事实源/.test(pageAuthorityMatrix)
    && /PRE-012\/013/.test(pageAuthorityMatrix)
    && /GATE-M0-06/.test(pageAuthorityMatrix),
    'page authority matrix must trace operations through API, source, target, audit and acceptance without claiming production approval',
  )
  requireCondition(
    /expectedFrontendRoutes/.test(migrationContractBaseline)
    && /expectedApiMounts/.test(migrationContractBaseline)
    && /expectedScreenshots/.test(migrationContractBaseline)
    && /isolated-synthetic-schema-only/.test(migrationContractBaseline)
    && /code', 'message', 'details', 'requestId/.test(migrationContractBaseline)
    && /MIG-0020～0023/.test(migrationContractBaselineDocument)
    && /MIG-0026/.test(legacyIssueBaseline)
    && /ISSUE-012/.test(legacyIssueBaseline)
    && packageJson.scripts?.['capture:contract-baseline']
      === 'node --import tsx server/src/scripts/migrationContractBaselineAcceptance.ts',
    'route, REST, AI, lead workflow and known-issue baselines must be reproducible from isolated synthetic evidence',
  )
  for (const retiredPath of [
    '/api/materials/generate-internal',
    '/api/internal/search-docs',
    '/api/internal/collect-intel',
    '/api/ai/project-summary',
    '/api/ai/bp-parse',
    '/api/ai/jobs/:id',
    '/api/projects/files',
    '/api/projects/files/:id/parse-finish',
  ]) {
    requireCondition(legacyApiCompatibilityMatrix.includes(retiredPath), `legacy API retirement matrix is missing: ${retiredPath}`)
  }
  requireCondition(
    /0a43c7d2d7eca0c55630a77c1ae29b02cf0d367d/.test(legacyApiCompatibilityAcceptance)
    && /legacy routes must be retained or explicitly retired/.test(legacyApiCompatibilityAcceptance)
    && /unsafe\/placeholder legacy routes must not be reintroduced/.test(legacyApiCompatibilityAcceptance)
    && /retiredRoutesReturnAuthenticatedJson404/.test(legacyApiCompatibilityAcceptance)
    && /syntheticFixtureRowsRemaining: 0/.test(legacyApiCompatibilityAcceptance)
    && /API misses must never fall through/.test(await readFile(path.resolve(root, 'server/src/index.ts'), 'utf8'))
    && packageJson.scripts?.['accept:legacy-api-compatibility']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/legacyApiCompatibilityAcceptance.ts'
    && releaseGatePolicyCovers('accept:legacy-api-compatibility'),
    'release must preserve classified legacy APIs and prove explicit unsafe/placeholder endpoint retirement on the real unified service',
  )
  requireCondition(
    /PRAGMA integrity_check/.test(legacySourceBackupAcceptance)
    && /allSqliteHashesMatchApprovedBaseline/.test(legacySourceBackupAcceptance)
    && /allSqliteBackupsOwnerOnly/.test(legacySourceBackupAcceptance)
    && /postgresDumpHasExpectedCopyTables/.test(legacySourceBackupAcceptance)
    && /postgresDumpHasExpectedRows/.test(legacySourceBackupAcceptance)
    && /maxTimestamp/.test(legacySourceBackupAcceptance)
    && /not proof of complete production source inventory/.test(legacySourceBackupAcceptance)
    && /mode: 0o600/.test(legacySourceBackupAcceptance)
    && packageJson.scripts?.['accept:legacy-source-backups']
      === 'node --import tsx server/src/scripts/legacySourceBackupAcceptance.ts',
    'legacy PostgreSQL, JW and Flue backup evidence must be hash-bound, readable, owner-only and explicitly scoped short of production inventory approval',
  )
  requireCondition(
    /project-files/.test(fileAssetBackupRestoreAcceptance)
    && /ai-artifacts/.test(fileAssetBackupRestoreAcceptance)
    && /ai-template-data/.test(fileAssetBackupRestoreAcceptance)
    && /workspace/.test(fileAssetBackupRestoreAcceptance)
    && /radar-data/.test(fileAssetBackupRestoreAcceptance)
    && /server-assets/.test(fileAssetBackupRestoreAcceptance)
    && /symlink is not allowed/.test(fileAssetBackupRestoreAcceptance)
    && /restoredContentIdentityMatches/.test(fileAssetBackupRestoreAcceptance)
    && /maxModifiedAt/.test(fileAssetBackupRestoreAcceptance)
    && /archiveOwnerOnly/.test(fileAssetBackupRestoreAcceptance)
    && /missing production roots and missing source bytes remain external blockers/.test(fileAssetBackupRestoreAcceptance)
    && /mode: 0o600/.test(fileAssetBackupRestoreAcceptance)
    && packageJson.scripts?.['accept:file-asset-backup-restore']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/fileAssetBackupRestoreAcceptance.ts',
    'local file assets must be archived owner-only and restored by content identity without weakening production source completeness gates',
  )
  requireCondition(
    /MYSQL_RUNTIME_PRIVILEGES = \['SELECT', 'INSERT', 'UPDATE', 'DELETE'\]/.test(mysqlAccountProvisioningService)
    && /MYSQL_MIGRATION_PRIVILEGES/.test(mysqlAccountProvisioningService)
    && /REVOKE ALL PRIVILEGES, GRANT OPTION/.test(mysqlAccountProvisioningService)
    && /globalPrivilegePresent/.test(mysqlAccountProvisioningService)
    && /Passwords are required only for --apply and are never printed or written to reports/.test(mysqlAccountProvisioningCli)
    && /currentConfiguredRuntimeAccountChanged: false/.test(mysqlAccountSeparationAcceptance)
    && /runtimeDmlRoundTrip/.test(mysqlAccountSeparationAcceptance)
    && /runtimeDdlDenied/.test(mysqlAccountSeparationAcceptance)
    && /migrationDdlRoundTrip/.test(mysqlAccountSeparationAcceptance)
    && /runtimeReleaseAuditAccepted/.test(mysqlAccountSeparationAcceptance)
    && /fixtureAccountsAndTablesRemoved/.test(mysqlAccountSeparationAcceptance)
    && /exact-observed-client-host/.test(mysqlAccountCutover)
    && /\.env\.before-mysql-account-cutover/.test(mysqlAccountCutover)
    && /passwordsExcludedFromOutputAndEvidence: true/.test(mysqlAccountCutover)
    && /runtimeDmlRoundTrip/.test(mysqlAccountCutover)
    && /runtimeDdlDenied/.test(mysqlAccountCutover)
    && /runtimeGrantSetIsDmlOnly/.test(mysqlAccountCutoverAudit)
    && /migrationGrantSetIsSchemaScoped/.test(mysqlAccountCutoverAudit)
    && /environmentAndMigrationCredentialFilesOwnerOnly/.test(mysqlAccountCutoverAudit)
    && /passwordsExcludedFromOutputAndEvidence: true/.test(mysqlAccountCutoverAudit)
    && /hostBindingDriftDetected/.test(mysqlAccountHostRotation)
    && /staleBindingsRemovedAfterLiveVerification/.test(mysqlAccountHostRotation)
    && /exactHostValueExcluded: true/.test(mysqlAccountHostRotation)
    && /passwordsExcludedFromOutputAndEvidence: true/.test(mysqlAccountHostRotation)
    && /await verifyConnections\(runtime, migration\)/.test(mysqlAccountHostRotation)
    && releaseGatePolicyCovers('audit:mysql-account-cutover')
    && /export async function applySchemaMigrations/.test(mysqlMigrationRuntime)
    && /await assertSchemaReady\(\)/.test(mysqlMigrationRuntime)
    && /DB_USERNAME has no DDL permission/.test(mysqlMigrationRuntime)
    && packageJson.scripts?.['provision:mysql-accounts:preview']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/provisionMysqlAccounts.ts'
    && packageJson.scripts?.['provision:mysql-accounts']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/provisionMysqlAccounts.ts --apply'
    && packageJson.scripts?.['accept:mysql-account-separation']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/mysqlAccountSeparationAcceptance.ts'
    && packageJson.scripts?.['cutover:mysql-accounts']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/cutoverMysqlAccounts.ts --apply'
    && packageJson.scripts?.['rollback:mysql-accounts']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/cutoverMysqlAccounts.ts --rollback'
    && packageJson.scripts?.['audit:mysql-account-cutover']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/mysqlAccountCutoverAudit.ts'
    && packageJson.scripts?.['rotate:mysql-account-host:preview']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/rotateMysqlAccountHost.ts'
    && packageJson.scripts?.['rotate:mysql-account-host']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/rotateMysqlAccountHost.ts --apply',
    'MySQL runtime/migration account provisioning must be previewable, password-safe, schema-scoped and prove DML/DDL separation with complete fixture cleanup',
  )
  const identityResolutionApply = await readFile(
    path.resolve(root, 'server/src/scripts/applyIdentitySourceResolutions.ts'),
    'utf8',
  )
  const identityResolutionService = await readFile(
    path.resolve(root, 'server/src/services/identityResolutionService.ts'),
    'utf8',
  )
  const identityResolutionAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/identityMappingAcceptance.ts'),
    'utf8',
  )
  const identityAdministrationService = await readFile(
    path.resolve(root, 'server/src/services/identityAdministrationService.ts'),
    'utf8',
  )
  const identityAdministrationAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/identityAdministrationAcceptance.ts'),
    'utf8',
  )
  const systemAdministrationService = await readFile(
    path.resolve(root, 'server/src/services/systemAdministrationService.ts'),
    'utf8',
  )
  const systemAuthorizationService = await readFile(
    path.resolve(root, 'server/src/services/systemAuthorizationService.ts'),
    'utf8',
  )
  const systemAdministrationRoutes = await readFile(
    path.resolve(root, 'server/src/routes/systemAdministration.ts'),
    'utf8',
  )
  const systemAdministrationAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/systemAdministrationAcceptance.ts'),
    'utf8',
  )
  const systemAdministrationMigration = await readFile(
    path.resolve(root, 'server/drizzle/0036_add_system_administration.sql'),
    'utf8',
  )
  const systemPermissionActivationMigration = await readFile(
    path.resolve(root, 'server/drizzle/0037_activate_system_permissions.sql'),
    'utf8',
  )
  const businessOptimisticVersionMigration = await readFile(
    path.resolve(root, 'server/drizzle/0038_add_business_optimistic_versions.sql'),
    'utf8',
  )
  const leadFieldProvenanceMigration = await readFile(
    path.resolve(root, 'server/drizzle/0039_add_lead_field_provenance.sql'),
    'utf8',
  )
  const repositoryContracts = await readFile(
    path.resolve(root, 'server/src/repositories/contracts.ts'),
    'utf8',
  )
  const identityRepositoryContract = await readFile(
    path.resolve(root, 'server/src/repositories/identityRepository.ts'),
    'utf8',
  )
  const mysqlIdentityRepository = await readFile(
    path.resolve(root, 'server/src/repositories/mysql/mysqlIdentityRepository.ts'),
    'utf8',
  )
  const identityRepositoryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/identityRepositoryAcceptance.ts'),
    'utf8',
  )
  const identityAuthorityAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/identityAuthorityAcceptance.ts'),
    'utf8',
  )
  const agentConversationRepositoryContract = await readFile(
    path.resolve(root, 'server/src/repositories/agentConversationRepository.ts'),
    'utf8',
  )
  const mysqlAgentConversationRepository = await readFile(
    path.resolve(root, 'server/src/repositories/mysql/mysqlAgentConversationRepository.ts'),
    'utf8',
  )
  const agentConversationRepositoryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/agentConversationRepositoryAcceptance.ts'),
    'utf8',
  )
  const agentRepositoryConversationService = await readFile(
    path.resolve(root, 'server/src/services/conversationService.ts'),
    'utf8',
  )
  const jwAgentRepositoryRuntime = await readFile(
    path.resolve(root, 'server/src/runtime/jwAgentRuntime.ts'),
    'utf8',
  )
  const aiTaskRepositoryContract = await readFile(
    path.resolve(root, 'server/src/repositories/aiTaskRepository.ts'),
    'utf8',
  )
  const mysqlAiTaskRepository = await readFile(
    path.resolve(root, 'server/src/repositories/mysql/mysqlAiTaskRepository.ts'),
    'utf8',
  )
  const aiCustomTemplateRepositoryService = await readFile(
    path.resolve(root, 'server/src/services/aiCustomTemplateService.ts'),
    'utf8',
  )
  const aiTemplateProgressRepositoryService = await readFile(
    path.resolve(root, 'server/src/services/aiTemplateAnalysisProgressService.ts'),
    'utf8',
  )
  const aiTaskCoreRepositoryService = await readFile(
    path.resolve(root, 'server/src/services/aiTaskService.ts'),
    'utf8',
  )
  const aiTaskRepositoryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/aiTaskRepositoryAcceptance.ts'),
    'utf8',
  )
  const aiConfigurationRepositoryContract = await readFile(
    path.resolve(root, 'server/src/repositories/aiConfigurationRepository.ts'),
    'utf8',
  )
  const mysqlAiConfigurationRepository = await readFile(
    path.resolve(root, 'server/src/repositories/mysql/mysqlAiConfigurationRepository.ts'),
    'utf8',
  )
  const configRepositoryModelService = await readFile(
    path.resolve(root, 'server/src/services/aiModelSettingsService.ts'),
    'utf8',
  )
  const configRepositoryCapabilityService = await readFile(
    path.resolve(root, 'server/src/services/aiCapabilityService.ts'),
    'utf8',
  )
  const aiConfigurationRepositoryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/aiConfigurationRepositoryAcceptance.ts'),
    'utf8',
  )
  const adminConfigurationRollbackAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/adminConfigurationRollbackAcceptance.ts'),
    'utf8',
  )
  const adminConfigurationRevisionRepository = await readFile(
    path.resolve(root, 'server/src/repositories/mysql/mysqlAdminConfigurationRevisionRepository.ts'),
    'utf8',
  )
  const configurationRevisionCrypto = await readFile(
    path.resolve(root, 'server/src/security/configurationRevisionCrypto.ts'),
    'utf8',
  )
  const adminConfigurationRevisionMigration = await readFile(
    path.resolve(root, 'server/drizzle/0035_add_admin_configuration_revisions.sql'),
    'utf8',
  )
  const modelSettingsRevisionUi = await readFile(path.resolve(root, 'src/pages/ModelSettingsPage.tsx'), 'utf8')
  const capabilitySettingsRevisionUi = await readFile(path.resolve(root, 'src/pages/CapabilitySettingsPage.tsx'), 'utf8')
  const imBotsRevisionUi = await readFile(path.resolve(root, 'src/pages/ImBotsPage.tsx'), 'utf8')
  const configurationRevisionUi = await readFile(path.resolve(root, 'src/components/ConfigurationRevisionPanel.tsx'), 'utf8')
  const configurationRevisionChecklist = await readFile(path.resolve(root, 'docs/迁移计划/JW底座与MySQL迁移执行清单.md'), 'utf8')
  const imIntegrationRepositoryContract = await readFile(
    path.resolve(root, 'server/src/repositories/imIntegrationRepository.ts'),
    'utf8',
  )
  const mysqlImIntegrationRepository = await readFile(
    path.resolve(root, 'server/src/repositories/mysql/mysqlImIntegrationRepository.ts'),
    'utf8',
  )
  const imIntegrationRepositoryService = await readFile(
    path.resolve(root, 'server/src/services/imIntegrationService.ts'),
    'utf8',
  )
  const imIntegrationRepositoryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/imIntegrationRepositoryAcceptance.ts'),
    'utf8',
  )
  const aiTaskTemplateMetaRoute = await readFile(
    path.resolve(root, 'server/src/routes/meta.ts'),
    'utf8',
  )
  const identityRepositorySpecification = await readFile(
    path.resolve(root, 'docs/迁移计划/MySQL Repository接口与事务规范-20260810.md'),
    'utf8',
  )
  const repositoryMigrationExecutionChecklist = await readFile(
    path.resolve(root, 'docs/迁移计划/JW底座与MySQL迁移执行清单.md'),
    'utf8',
  )
  const identityAuthService = await readFile(
    path.resolve(root, 'server/src/services/authService.ts'),
    'utf8',
  )
  const projectAccessService = await readFile(
    path.resolve(root, 'server/src/services/projectAccessService.ts'),
    'utf8',
  )
  const identityAdministrationRoutes = await readFile(
    path.resolve(root, 'server/src/routes/projects.ts'),
    'utf8',
  )
  const identityResolutionFile = JSON.parse(await readFile(
    path.resolve(root, 'docs/迁移计划/identity-source-resolutions-20260809.json'),
    'utf8',
  )) as { schemaVersion?: string; resolutions?: unknown[] }
  requireCondition(
    packageJson.scripts?.['migrate:identity-resolutions']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/applyIdentitySourceResolutions.ts'
    && packageJson.scripts?.['migrate:identity-resolutions:apply']
      === 'npm run migrate:identity-resolutions -- --apply',
    'source-evidence identity resolution commands are missing',
  )
  requireCondition(
    identityResolutionFile.schemaVersion === '1.0'
    && identityResolutionFile.resolutions?.length === 1
    && /source dump hash changed/.test(identityResolutionApply)
    && /creation audit does not bind the same user\/project/.test(identityResolutionApply)
    && /project file uploader evidence mismatch/.test(identityResolutionApply)
    && /meeting host evidence mismatch/.test(identityResolutionApply)
    && /todo owner evidence mismatch/.test(identityResolutionApply)
    && /FOR UPDATE/.test(identityResolutionApply)
    && /syncProjectIdentityBindings/.test(identityResolutionApply)
    && /identity resolution did not persist through normal binding synchronization/.test(identityResolutionApply)
    && /identityResolutionIssues\.status, 'resolved'/.test(identityResolutionService)
    && /explicit-source-resolution-persists-through-resync/.test(identityResolutionAcceptance),
    'explicit identity resolution must be source-hash-bound, transaction-locked, evidence-checked and persistent through resync',
  )
  requireCondition(
    /requireCurrentAdministrator/.test(identityAdministrationService)
    && /validateNewPassword/.test(identityAdministrationService)
    && /identityRepositories\.transaction/.test(identityAdministrationService)
    && /users\.revokeActiveSessions/.test(identityAdministrationService)
    && /emitAuthInvalidation/.test(identityAdministrationService)
    && /audits\.append/.test(identityAdministrationService)
    && /permissions\.replaceProjectMembers/.test(identityAdministrationService)
    && !/from ['"]drizzle-orm['"]/.test(identityAdministrationService)
    && !/from ['"]\.\.\/db\/(client|schema)\.js['"]/.test(identityAdministrationService)
    && /PROJECT_MEMBERSHIP_FORBIDDEN/.test(identityAdministrationRoutes)
    && /PROJECT_MEMBERSHIP_ENDPOINT_REQUIRED/.test(identityAdministrationRoutes)
    && /owner: req\.user!\.name/.test(identityAdministrationRoutes)
    && /affectedUserIds/.test(identityAdministrationService)
    && /current-admin-revalidation/.test(identityAdministrationAcceptance)
    && /non-admin-user-mutation-denial/.test(identityAdministrationAcceptance)
    && /role-department-status-update/.test(identityAdministrationAcceptance)
    && /identity-change-session-revocation/.test(identityAdministrationAcceptance)
    && /stable-project-member-replacement/.test(identityAdministrationAcceptance)
    && /actor-target-request-audit/.test(identityAdministrationAcceptance)
    && /audit-secret-exclusion/.test(identityAdministrationAcceptance)
    && packageJson.scripts?.['accept:identity-administration']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/identityAdministrationAcceptance.ts'
    && releaseGatePolicyCovers('accept:identity-administration'),
    'identity and project membership administration must be admin-only, session-invalidating, transactional and audit-complete',
  )
  requireCondition(
    /CREATE TABLE `sbl_departments`/.test(systemAdministrationMigration)
    && /CREATE TABLE `sbl_roles`/.test(systemAdministrationMigration)
    && /CREATE TABLE `sbl_permissions`/.test(systemAdministrationMigration)
    && /CREATE TABLE `sbl_dictionary_groups`/.test(systemAdministrationMigration)
    && /INSERT INTO `sbl_user_roles`/.test(systemAdministrationMigration)
    && /'system\.manage'/.test(systemAdministrationMigration)
    && /'ai\.configure'/.test(systemPermissionActivationMigration)
    && /'im\.manage'/.test(systemPermissionActivationMigration)
    && /createMySqlIdentityRepositoryContext\(tx\)/.test(systemAdministrationService)
    && /users\.lockById/.test(systemAdministrationService)
    && /users\.listPermissionCodes/.test(systemAdministrationService)
    && /identity\.audits/.test(systemAdministrationService)
    && /requireSystemAdmin/.test(systemAdministrationRoutes)
    && /synchronizeAdministrationBindings/.test(identityAdministrationService)
    && /listPermissionCodes/.test(mysqlIdentityRepository)
    && /roleHasPermission/.test(mysqlIdentityRepository)
    && /identityRepositories\.users\.listPermissionCodes/.test(systemAuthorizationService)
    && !/legacyRolePermissions|系统管理员:\s*\[/.test(systemAuthorizationService)
    && /database-system-permission-grant-authorizes-admin-write/.test(systemAdministrationAcceptance)
    && /database-permission-revocation-denies-admin-write/.test(systemAdministrationAcceptance)
    && /fixture-cleanup-verified/.test(systemAdministrationAcceptance)
    && packageJson.scripts?.['accept:system-administration']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/systemAdministrationAcceptance.ts'
    && releaseGatePolicyCovers('accept:system-administration'),
    'system organization, role, permission and dictionary administration must use MySQL authority, atomic identity bindings, revocable permissions and audited writes',
  )
  requireCondition(
    /export class RepositoryError/.test(repositoryContracts)
    && /'NOT_FOUND'/.test(repositoryContracts)
    && /'CONFLICT'/.test(repositoryContracts)
    && /'INTEGRITY'/.test(repositoryContracts)
    && /'TRANSIENT'/.test(repositoryContracts)
    && /findMySqlDriverError/.test(repositoryContracts)
    && /export interface UserRepository/.test(identityRepositoryContract)
    && /export interface PermissionRepository/.test(identityRepositoryContract)
    && /export interface IdentityRepositoryProvider/.test(identityRepositoryContract)
    && /transaction<T>/.test(identityRepositoryContract)
    && /class MySqlUserRepository implements UserRepository/.test(mysqlIdentityRepository)
    && /class MySqlPermissionRepository implements PermissionRepository/.test(mysqlIdentityRepository)
    && /class MySqlAuditRepository implements AuditRepository/.test(mysqlIdentityRepository)
    && /FOR UPDATE/.test(mysqlIdentityRepository)
    && /db\.transaction/.test(mysqlIdentityRepository)
    && /createMySqlIdentityRepositoryContext/.test(identityAuthService)
    && /identityRepositories\.users\.findByEmail/.test(identityAuthService)
    && !/\bauditLogs\b|\busers\b/.test((identityAuthService.match(/from ['"]\.\.\/db\/schema\.js['"][^\n]*/g) || []).join('\n'))
    && /identityRepositories\.users\.findById/.test(projectAccessService)
    && /concurrent-user-unique-conflict/.test(identityRepositoryAcceptance)
    && /user-transaction-rollback/.test(identityRepositoryAcceptance)
    && /permission-atomic-replacement/.test(identityRepositoryAcceptance)
    && /permission-transaction-rollback/.test(identityRepositoryAcceptance)
    && /repository-session-revocation/.test(identityRepositoryAcceptance)
    && /Route → Service → Repository 接口\/组合根 → MySQL 实现 → db\/schema/.test(identityRepositorySpecification)
    && /`DEL-002` 已完成/.test(identityRepositorySpecification)
    && /- \[x\] `MIG-0130`/.test(repositoryMigrationExecutionChecklist)
    && /- \[x\] `MIG-0131`/.test(repositoryMigrationExecutionChecklist)
    && /- \[x\] `MIG-0133`/.test(repositoryMigrationExecutionChecklist)
    && /- \[x\] `MIG-0134`/.test(repositoryMigrationExecutionChecklist)
    && /- \[x\] `MIG-0136`/.test(repositoryMigrationExecutionChecklist)
    && /- \[x\] `MIG-0139`/.test(repositoryMigrationExecutionChecklist)
    && /- \[x\] `DEL-002`/.test(repositoryMigrationExecutionChecklist)
    && packageJson.scripts?.['accept:identity-repository']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/identityRepositoryAcceptance.ts'
    && releaseGatePolicyCovers('accept:identity-repository'),
    'user and permission repositories must enforce stable errors, transaction scope, concurrency and real service integration',
  )
  requireCondition(
    /physical-users-table-is-the-iam-authority/.test(identityAuthorityAcceptance)
    && /all-users-foreign-key-references-have-authority-records/.test(identityAuthorityAcceptance)
    && /browser-restores-user-from-server-session-without-local-authority/.test(identityAuthorityAcceptance)
    && /runtime-user-table-access-is-repository-only/.test(identityAuthorityAcceptance)
    && /noFixturesOrBusinessWrites: true/.test(identityAuthorityAcceptance)
    && packageJson.scripts?.['accept:identity-authority']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/identityAuthorityAcceptance.ts'
    && releaseGatePolicyCovers('accept:identity-authority')
    && /- \[x\] `MIG-0801`/.test(repositoryMigrationExecutionChecklist),
    'conceptual iam_users must resolve to the single physical users authority across login, session, socket, project permissions and browser recovery',
  )
  requireCondition(
    /export interface AgentConversationRepository/.test(agentConversationRepositoryContract)
    && /saveMessage\(input: SaveAgentMessageInput\)/.test(agentConversationRepositoryContract)
    && /recoverStreamingSessions/.test(agentConversationRepositoryContract)
    && /class MySqlAgentConversationRepository implements AgentConversationRepository/.test(mysqlAgentConversationRepository)
    && /FOR UPDATE/.test(mysqlAgentConversationRepository)
    && /preserveTerminalStatus/.test(mysqlAgentConversationRepository)
    && /interruptRunningTools/.test(mysqlAgentConversationRepository)
    && /recoverStreamingSessions/.test(mysqlAgentConversationRepository)
    && /agentConversationRepository\.createConversationPair/.test(agentRepositoryConversationService)
    && !/from ['"](?:drizzle-orm|\.\.\/db\/)/.test(agentRepositoryConversationService)
    && /agentConversationRepository\.saveMessage/.test(jwAgentRepositoryRuntime)
    && /agentConversationRepository\.listMessagesWithParts/.test(jwAgentRepositoryRuntime)
    && /agentConversationRepository\.recoverStreamingSessions/.test(jwAgentRepositoryRuntime)
    && !/from ['"](?:drizzle-orm|\.\.\/db\/)/.test(jwAgentRepositoryRuntime)
    && /parallel-message-sequence-serialization/.test(agentConversationRepositoryAcceptance)
    && /parallel-chat-index-append-no-lost-update/.test(agentConversationRepositoryAcceptance)
    && /external-message-idempotent-terminal-replay/.test(agentConversationRepositoryAcceptance)
    && /concurrent-metadata-merge-no-lost-update/.test(agentConversationRepositoryAcceptance)
    && /tool-message-part-atomic-interruption/.test(agentConversationRepositoryAcceptance)
    && packageJson.scripts?.['accept:agent-conversation-repository']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/agentConversationRepositoryAcceptance.ts'
    && releaseGatePolicyCovers('accept:agent-conversation-repository')
    && /- \[x\] `MIG-0133`/.test(repositoryMigrationExecutionChecklist),
    'Agent conversation repository must preserve sequence, replay, metadata, tool and restart state boundaries with real MySQL acceptance',
  )
  requireCondition(
    /export interface AiTaskRepository/.test(aiTaskRepositoryContract)
    && /createCustomTemplateWithAudit/.test(aiTaskRepositoryContract)
    && /recoverInterruptedTemplateAnalysisProgress/.test(aiTaskRepositoryContract)
    && /startTemplateAnalysisProgress/.test(aiTaskRepositoryContract)
    && /class MySqlAiTaskRepository implements AiTaskRepository/.test(mysqlAiTaskRepository)
    && /db\.transaction/.test(mysqlAiTaskRepository)
    && /FOR UPDATE/.test(mysqlAiTaskRepository)
    && /GREATEST\(progress/.test(mysqlAiTaskRepository)
    && /aiTaskRepository\.createCustomTemplateWithAudit/.test(aiCustomTemplateRepositoryService)
    && /identityRepositories\.permissions\.findProjectById/.test(aiCustomTemplateRepositoryService)
    && !/from ['"](?:drizzle-orm|\.\.\/db\/)/.test(aiCustomTemplateRepositoryService)
    && /aiTaskRepository\.startTemplateAnalysisProgress/.test(aiTemplateProgressRepositoryService)
    && /aiTaskRepository\.recoverInterruptedTemplateAnalysisProgress/.test(aiTemplateProgressRepositoryService)
    && !/from ['"](?:mysql2|\.\.\/db\/)/.test(aiTemplateProgressRepositoryService)
    && /- \[x\] `MIG-0134`/.test(repositoryMigrationExecutionChecklist),
    'AI task repository must keep custom-template audit and analysis-progress concurrency boundaries with real MySQL acceptance',
  )
  requireCondition(
    /claimTask\(input:/.test(aiTaskRepositoryContract)
    && /completeTaskWithArtifacts\(input:/.test(aiTaskRepositoryContract)
    && /listRecoverableTasks\(input:/.test(aiTaskRepositoryContract)
    && /stopOwnedRunningTasks\(input:/.test(aiTaskRepositoryContract)
    && /async completeTaskWithArtifacts/.test(mysqlAiTaskRepository)
    && /AI_TASK_COMPLETION_CONFLICT/.test(mysqlAiTaskRepository)
    && /async stopOwnedRunningTasks/.test(mysqlAiTaskRepository)
    && /aiTaskRepository\.claimTask/.test(aiTaskCoreRepositoryService)
    && /aiTaskRepository\.completeTaskWithArtifacts/.test(aiTaskCoreRepositoryService)
    && /aiTaskRepository\.listRecoverableTasks/.test(aiTaskCoreRepositoryService)
    && /aiTaskRepository\.stopOwnedRunningTasks/.test(aiTaskCoreRepositoryService)
    && !/\b(?:aiTasks|aiArtifacts|aiTaskSources|aiTaskTemplates)\b/.test(
      (aiTaskCoreRepositoryService.match(/import\s*\{[^}]*\}\s*from\s*['"]\.\.\/db\/schema\.js['"]/s) || [''])[0],
    )
    && /aiTaskRepository\.listTaskTemplates/.test(aiTaskTemplateMetaRoute)
    && /parallel-idempotency-conflict-mapping/.test(aiTaskRepositoryAcceptance)
    && /parallel-lease-claim-single-winner/.test(aiTaskRepositoryAcceptance)
    && /artifact-source-completion-atomic-commit/.test(aiTaskRepositoryAcceptance)
    && /completion-conflict-full-rollback/.test(aiTaskRepositoryAcceptance)
    && /expired-running-task-recovery/.test(aiTaskRepositoryAcceptance)
    && /worker-stop-cancel-and-release-transaction/.test(aiTaskRepositoryAcceptance)
    && packageJson.scripts?.['accept:ai-task-repository']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/aiTaskRepositoryAcceptance.ts'
    && releaseGatePolicyCovers('accept:ai-task-repository')
    && /- \[x\] `MIG-0134`/.test(repositoryMigrationExecutionChecklist),
    'AI task repository must preserve idempotency, lease, artifact/source completion and restart recovery boundaries with real MySQL acceptance',
  )
  requireCondition(
    /export interface AiConfigurationRepository/.test(aiConfigurationRepositoryContract)
    && /updateProviderWithAudit/.test(aiConfigurationRepositoryContract)
    && /upsertRouteWithAudit/.test(aiConfigurationRepositoryContract)
    && /syncBuiltinCapabilitiesWithAudit/.test(aiConfigurationRepositoryContract)
    && /replaceConversationCapabilities/.test(aiConfigurationRepositoryContract)
    && /class MySqlAiConfigurationRepository implements AiConfigurationRepository/.test(mysqlAiConfigurationRepository)
    && /lockDefaultModelDomain/.test(mysqlAiConfigurationRepository)
    && /FOR UPDATE/.test(mysqlAiConfigurationRepository)
    && /db\.transaction/.test(mysqlAiConfigurationRepository)
    && /aiConfigurationRepository\.updateProviderWithAudit/.test(configRepositoryModelService)
    && /aiConfigurationRepository\.upsertRouteWithAudit/.test(configRepositoryModelService)
    && !/from ['"](?:drizzle-orm|\.\.\/db\/)/.test(configRepositoryModelService)
    && /aiConfigurationRepository\.updateCapabilityWithAudit/.test(configRepositoryCapabilityService)
    && /aiConfigurationRepository\.replaceConversationCapabilities/.test(configRepositoryCapabilityService)
    && !/from ['"](?:drizzle-orm|\.\.\/db\/)/.test(configRepositoryCapabilityService)
    && /provider-update-audit-failure-full-rollback/.test(aiConfigurationRepositoryAcceptance)
    && /parallel-default-model-single-winner-state/.test(aiConfigurationRepositoryAcceptance)
    && /capability-binding-optimistic-update-and-audit-transaction/.test(aiConfigurationRepositoryAcceptance)
    && /conversation-capability-atomic-replacement/.test(aiConfigurationRepositoryAcceptance)
    && packageJson.scripts?.['accept:ai-configuration-repository']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/aiConfigurationRepositoryAcceptance.ts'
    && releaseGatePolicyCovers('accept:ai-configuration-repository')
    && /- \[x\] `MIG-0136`/.test(repositoryMigrationExecutionChecklist),
    'AI configuration repository must serialize default models and atomically persist provider, route, capability, binding, selection and audit changes with real MySQL acceptance',
  )
  requireCondition(
    /export interface ImIntegrationRepository/.test(imIntegrationRepositoryContract)
    && /enqueueMessageWithAudit/.test(imIntegrationRepositoryContract)
    && /claimOutboxBatch/.test(imIntegrationRepositoryContract)
    && /completeDelivery/.test(imIntegrationRepositoryContract)
    && /createInboundMessage/.test(imIntegrationRepositoryContract)
    && /class MySqlImIntegrationRepository implements ImIntegrationRepository/.test(mysqlImIntegrationRepository)
    && /FOR UPDATE SKIP LOCKED/.test(mysqlImIntegrationRepository)
    && /lease_expires_at < NOW\(3\)/.test(mysqlImIntegrationRepository)
    && /db\.transaction/.test(mysqlImIntegrationRepository)
    && /imIntegrationRepository\.enqueueMessageWithAudit/.test(imIntegrationRepositoryService)
    && /imIntegrationRepository\.claimOutboxBatch/.test(imIntegrationRepositoryService)
    && /imIntegrationRepository\.createInboundMessage/.test(imIntegrationRepositoryService)
    && !/from ['"](?:drizzle-orm|mysql2|\.\.\/db\/)/.test(imIntegrationRepositoryService)
    && /bot-update-audit-failure-full-rollback/.test(imIntegrationRepositoryAcceptance)
    && /parallel-outbox-idempotency-one-create-one-replay/.test(imIntegrationRepositoryAcceptance)
    && /parallel-outbox-skip-locked-single-claim/.test(imIntegrationRepositoryAcceptance)
    && /delivery-log-and-outbox-atomic-completion/.test(imIntegrationRepositoryAcceptance)
    && /parallel-inbound-message-idempotency-single-record/.test(imIntegrationRepositoryAcceptance)
    && packageJson.scripts?.['accept:im-integration-repository']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/imIntegrationRepositoryAcceptance.ts'
    && releaseGatePolicyCovers('accept:im-integration-repository')
    && /- \[x\] `MIG-0136`/.test(repositoryMigrationExecutionChecklist),
    'IM repository must atomically preserve bot, binding, outbox lease, delivery log, inbound idempotency and audit boundaries with real MySQL acceptance',
  )
  requireCondition(
    /CREATE TABLE `sbl_admin_configuration_revisions`/.test(adminConfigurationRevisionMigration)
    && /snapshot_ciphertext/.test(adminConfigurationRevisionMigration)
    && /uq_admin_config_revision_resource_version/.test(adminConfigurationRevisionMigration)
    && /createCipheriv\('aes-256-gcm'/.test(configurationRevisionCrypto)
    && /setAAD/.test(configurationRevisionCrypto)
    && /snapshotSha256/.test(adminConfigurationRevisionRepository)
    && /impact_confirmation_required/.test(adminConfigurationRevisionRepository)
    && /restoreDeleted/.test(adminConfigurationRevisionRepository)
    && /model-provider-credential-update-encrypted-history-and-exact-rollback/.test(adminConfigurationRollbackAcceptance)
    && /im-binding-update-and-delete-restore/.test(adminConfigurationRollbackAcceptance)
    && /revision-api-excludes-snapshot-ciphertext-and-plaintext-secrets/.test(adminConfigurationRollbackAcceptance)
    && /ConfigurationRevisionPanel/.test(modelSettingsRevisionUi)
    && /ConfigurationRevisionPanel/.test(capabilitySettingsRevisionUi)
    && /ConfigurationRevisionPanel/.test(imBotsRevisionUi)
    && /AES-256-GCM/.test(configurationRevisionUi)
    && /expectedVersion:\s*target\.currentVersion/.test(configurationRevisionUi)
    && /- \[x\] `GATE-M8-03`/.test(configurationRevisionChecklist)
    && packageJson.scripts?.['accept:admin-configuration-rollback']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/adminConfigurationRollbackAcceptance.ts'
    && releaseGatePolicyCovers('accept:admin-configuration-rollback'),
    'model, capability and IM configuration mutations must have encrypted revision history, optimistic rollback, impact confirmation and audit',
  )
  requireCondition(
    /information_schema\.TABLES/.test(mysqlArchitectureContractAcceptance)
    && /information_schema\.COLUMNS/.test(mysqlArchitectureContractAcceptance)
    && /information_schema\.STATISTICS/.test(mysqlArchitectureContractAcceptance)
    && /information_schema\.KEY_COLUMN_USAGE/.test(mysqlArchitectureContractAcceptance)
    && /duplicateAuthoritiesAbsent/.test(mysqlArchitectureContractAcceptance)
    && /configuration-revision-encryption-version-actor-and-append-only-contract/.test(mysqlArchitectureContractAcceptance)
    && /lead-active-name-unique-remains-deferred/.test(mysqlArchitectureContractAcceptance)
    && /no-fixtures-or-business-data-writes/.test(mysqlArchitectureContractAcceptance)
    && /概念域到物理表映射/.test(mysqlArchitectureDecision)
    && /PostgreSQL 部分唯一索引的 MySQL 等价/.test(mysqlArchitectureDecision)
    && /事务、幂等与乐观锁规则/.test(mysqlArchitectureDecision)
    && packageJson.scripts?.['accept:mysql-architecture-contract']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/mysqlArchitectureContractAcceptance.ts'
    && releaseGatePolicyCovers('accept:mysql-architecture-contract'),
    'release must prove the adjudicated MySQL domain mapping, runtime/scheduler/audit schema and partial-unique equivalents without creating duplicate authorities',
  )
  requireCondition(
    /createBackup/.test(mysqlSchemaBackupCommand)
    && /refusing to overwrite/.test(mysqlSchemaBackupCommand)
    && /empty-prefix-first-install/.test(mysqlSchemaBackupCommand)
    && /inspectLogicalBackup/.test(mysqlSchemaRollbackCommand)
    && /restoreLogicalBackupToPrefix/.test(mysqlSchemaRollbackCommand)
    && /configMutationPerformed: false/.test(mysqlSchemaRollbackCommand)
    && /mysql-core-seed-v1/.test(mysqlSeedCommand)
    && /demoUsers: 0/.test(mysqlSeedCommand)
    && /migration_type/.test(mysqlSeedCommand)
    && /repeated seed changed canonical row counts/.test(mysqlSchemaLifecycleAcceptance)
    && /active prefix changed/.test(mysqlSchemaLifecycleAcceptance)
    && /Point of No Return/.test(mysqlSchemaLifecycleHandoff)
    && /不覆盖当前活动前缀/.test(mysqlSchemaLifecycleHandoff)
    && packageJson.scripts?.['db:backup']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/backupMySqlSchema.ts'
    && packageJson.scripts?.['accept:mysql-backup-inventory']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/mysqlBackupInventoryAcceptance.ts'
    && /backup-and-report-owner-only-and-paired/.test(mysqlBackupInventoryAcceptance)
    && /successful-restore-drill-covers-newest-backup-scope/.test(mysqlBackupInventoryAcceptance)
    && /production backup policy requires configured offsite storage and confirmed encryption at rest/.test(mysqlBackupInventoryAcceptance)
    && packageJson.scripts?.['db:seed:preview']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/seedMySql.ts'
    && packageJson.scripts?.['db:seed']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/seedMySql.ts --apply'
    && packageJson.scripts?.['db:rollback:preview']
      === 'node --env-file-if-exists=.env --env-file-if-exists=.runtime/secrets/mysql-migration.env --import tsx server/src/scripts/rollbackMySqlSchema.ts'
    && packageJson.scripts?.['db:rollback']
      === 'node --env-file-if-exists=.env --env-file-if-exists=.runtime/secrets/mysql-migration.env --import tsx server/src/scripts/rollbackMySqlSchema.ts --apply'
    && packageJson.scripts?.['accept:mysql-schema-lifecycle']
      === 'node --env-file-if-exists=.env --env-file-if-exists=.runtime/secrets/mysql-migration.env --import tsx server/src/scripts/mysqlSchemaLifecycleAcceptance.ts'
    && deploy.indexOf('run db:backup') < deploy.indexOf('run db:migrate')
    && deploy.indexOf('run db:migrate') < deploy.indexOf('run db:seed')
    && releaseGatePolicyCovers('accept:mysql-schema-lifecycle'),
    'production schema changes must create a pre-migration backup, apply forward migrations and versioned seeds, and prove non-overwriting isolated-prefix rollback',
  )
  const rootPackages = { ...packageJson.dependencies, ...packageJson.devDependencies }
  const forbiddenPackages = Object.keys(rootPackages).filter((name) => name.startsWith('@flue/') || name === 'hono')
  requireCondition(forbiddenPackages.length === 0, `root package still contains retired runtime packages: ${forbiddenPackages.join(', ')}`)
  const legacyAssistantRoot = path.resolve(root, 'cybernaut-assistant')
  const legacyAssistantPresent = await pathExists(legacyAssistantRoot)
  let retiredAssistantSources: string[] = []
  if (legacyAssistantPresent) {
    const legacyPackage = JSON.parse(await readFile(path.resolve(legacyAssistantRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    for (const script of ['dev', 'dev:local', 'build', 'build:client', 'build:server', 'health', 'start', 'start:local']) {
      requireCondition(
        legacyPackage.scripts?.[script] === 'node scripts/retired-runtime.mjs',
        `legacy assistant script ${script} must be hard-disabled`,
      )
    }
    retiredAssistantSources = await Promise.all([
      '.env.example',
      'src/db.ts',
      'src/tools/investment-tools.ts',
      'src/tools/advisor-tools.ts',
    ].map(async (file) => await readFile(path.resolve(legacyAssistantRoot, file), 'utf8')))
  }
  const retiredAssistantAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/retiredAssistantBoundaryAcceptance.ts'),
    'utf8',
  )
  requireCondition(
    (!legacyAssistantPresent || retiredAssistantSources.every((source) => !/FLUE_BASE_URL|FLUE_DB_PATH|FLUE_AGENT_NAME|RADAR_BASE_URL|INTERNAL_SECRET|x-internal-secret|cybernaut-internal-2026/.test(source)))
    && /retired-assistant-source-directory-absent/.test(retiredAssistantAcceptance)
    && /retired-assistant-absence-does-not-touch-legacy-database/.test(retiredAssistantAcceptance)
    && /retired-start-with-stale-environment-fails-closed-without-touching-legacy-database/.test(retiredAssistantAcceptance)
    && packageJson.scripts?.['accept:retired-assistant-boundary']
      === 'node --import tsx server/src/scripts/retiredAssistantBoundaryAcceptance.ts'
    && releaseGatePolicyCovers('accept:retired-assistant-boundary'),
    'retired Assistant source must be absent or hard-disabled without old runtime variables, and release must prove no legacy database writes',
  )

  const activeFiles = [
    ...(await filesUnder('server/src')),
    ...(await filesUnder('src')),
    'vite.config.ts',
    'start.sh',
  ].filter((file) => file !== 'server/src/scripts/checkSingleServiceBoundary.ts')
  const directRuntimeUserTableFiles: string[] = []
  for (const file of activeFiles.filter((candidate) => /^server\/src\/(?:routes|services|runtime|middleware)\//.test(candidate))) {
    const source = await readFile(path.resolve(root, file), 'utf8')
    const schemaImports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:\.\.\/)+db\/schema\.js['"]/g)]
    if (schemaImports.some((match) => /\busers\b/.test(match[1]))) directRuntimeUserTableFiles.push(file)
  }
  requireCondition(
    directRuntimeUserTableFiles.length === 0,
    `runtime user-table access must go through UserRepository: ${directRuntimeUserTableFiles.join(', ')}`,
  )
  const directRuntimeAgentTableFiles: string[] = []
  for (const file of activeFiles.filter((candidate) => /^server\/src\/(?:routes|services|runtime|middleware)\//.test(candidate))) {
    const source = await readFile(path.resolve(root, file), 'utf8')
    const schemaImports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:\.\.\/)+db\/schema\.js['"]/g)]
    if (schemaImports.some((match) => /\b(?:chatConversations|agentConversations|agentMessages|agentMessageParts)\b/.test(match[1]))) {
      directRuntimeAgentTableFiles.push(file)
    }
  }
  requireCondition(
    directRuntimeAgentTableFiles.length === 0,
    `runtime Agent conversation-table access must go through Repository: ${directRuntimeAgentTableFiles.join(', ')}`,
  )
  const directRuntimeAiTaskTableFiles: string[] = []
  for (const file of activeFiles.filter((candidate) => /^server\/src\/(?:routes|services|runtime|middleware)\//.test(candidate))) {
    const source = await readFile(path.resolve(root, file), 'utf8')
    const schemaImports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:\.\.\/)+db\/schema\.js['"]/g)]
    if (schemaImports.some((match) => /\b(?:aiTasks|aiArtifacts|aiTaskSources|aiTaskTemplates|aiCustomTemplates|aiTemplateAnalysisProgress)\b/.test(match[1]))) {
      directRuntimeAiTaskTableFiles.push(file)
    }
  }
  requireCondition(
    directRuntimeAiTaskTableFiles.length === 0,
    `runtime AI task/artifact/source/template-table access must go through Repository: ${directRuntimeAiTaskTableFiles.join(', ')}`,
  )
  const forbiddenRuntimePatterns = [
    /FLUE_BASE_URL/,
    /FLUE_DB_PATH/,
    /FLUE_AGENT_NAME/,
    /RADAR_BASE_URL/,
    /scoreWithGateway/,
    /\/ai\/api/,
    /(?:127\.0\.0\.1|localhost):(3584|8121)/,
  ]
  const runtimeViolations: string[] = []
  const aipinViolations: string[] = []
  const unsupervisedProcessViolations: string[] = []
  const implicitTimezoneViolations: string[] = []
  const retiredRuntimeReferenceAllowlist = new Set([
    'server/src/scripts/retiredAssistantBoundaryAcceptance.ts',
  ])
  const aipinOfflineAllowlist = new Set([
    'server/src/scripts/migrateFlueSqliteToMySql.ts',
    'server/src/scripts/migrateJwSqliteToMySql.ts',
    'server/src/scripts/jwSqliteMigrationAcceptance.ts',
    'server/src/scripts/mysqlSmoke.ts',
    'server/src/scripts/aipinExclusionAudit.ts',
    'server/src/scripts/migrationSourceAllowlistAcceptance.ts',
    'server/src/scripts/mysqlMigrationReconciliationAudit.ts',
  ])
  for (const file of activeFiles) {
    const content = await readFile(path.resolve(root, file), 'utf8')
    if (
      forbiddenRuntimePatterns.some((pattern) => pattern.test(content))
      && !retiredRuntimeReferenceAllowlist.has(file)
    ) runtimeViolations.push(file)
    if (/aipin/i.test(content) && !aipinOfflineAllowlist.has(file)) aipinViolations.push(file)
    if (
      (file.startsWith('server/src/services/') || file.startsWith('server/src/runtime/'))
      && file !== 'server/src/runtime/supervisedProcessService.ts'
      && /node:child_process/.test(content)
    ) unsupervisedProcessViolations.push(file)
    if (
      (file.startsWith('src/') || /^server\/src\/(?:routes|services|runtime|middleware|utils)\//.test(file))
      && (
        /toISOString\(\)\.slice\(0,\s*10\)|getTimezoneOffset\(\)|toLocale(?:DateString|TimeString|String)\('zh-CN'/.test(content)
        || /new Date\([^\n]*\.replace\(' ',\s*'T'\)\)/.test(content)
      )
    ) implicitTimezoneViolations.push(file)
  }
  requireCondition(runtimeViolations.length === 0, `active runtime still references retired services: ${runtimeViolations.join(', ')}`)
  requireCondition(aipinViolations.length === 0, `active runtime contains Aipin references: ${aipinViolations.join(', ')}`)
  requireCondition(
    unsupervisedProcessViolations.length === 0,
    `production service bypasses child-process supervisor: ${unsupervisedProcessViolations.join(', ')}`,
  )
  requireCondition(
    implicitTimezoneViolations.length === 0,
    `active runtime contains host/UTC-dependent business date formatting: ${implicitTimezoneViolations.join(', ')}`,
  )

  const jwRuntime = await readFile(path.resolve(root, 'server/src/runtime/jwAgentRuntime.ts'), 'utf8')
  const jwRuntimeBoundaryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/jwRuntimeBoundaryAcceptance.ts'), 'utf8',
  )
  const projectKnowledgeTools = await readFile(path.resolve(root, 'server/src/services/projectKnowledgeToolService.ts'), 'utf8')
  requireCondition(
    /permissionMode:\s*'default'/.test(jwRuntime)
    && /defaultMode:\s*'dontAsk'/.test(jwRuntime)
    && /disableBypassPermissionsMode:\s*'disable'/.test(jwRuntime),
    'JW Runtime must route explicit ask rules through the host while keeping all other permissions deny-by-default',
  )
  requireCondition(
    /JW_AGENT_INTERACTIVE_TOOL = 'AskUserQuestion'/.test(jwRuntime)
    && /JW_AGENT_NATIVE_SKILLS = \['skill-creator'\]/.test(jwRuntime)
    && /materializeJwAgentNativeSkills\(cwd\)/.test(jwRuntime)
    && /tools:\s*\[JW_AGENT_INTERACTIVE_TOOL, 'Skill'\]/.test(jwRuntime)
    && /skills:\s*nativeSkillNames/.test(jwRuntime)
    && /toolName === JW_AGENT_INTERACTIVE_TOOL/.test(jwRuntime)
    && /beginJwAgentInteraction/.test(jwRuntime),
    'JW Runtime must expose only the reviewed native Skill allowlist and host-handled AskUserQuestion interaction',
  )
  requireCondition(
    /ask:\s*\[JW_AGENT_INTERACTIVE_TOOL\]/.test(jwRuntime)
    && /settings:\s*jwAgentPermissionSettings\(\)/.test(jwRuntime)
    && /allowedTools:\s*hostInvestmentEnabled\s*\?\s*allowedAgentTools\s*:\s*\[\]/.test(jwRuntime)
    && /allowedAgentToolSet\.has\(toolName\)/.test(jwRuntime),
    'JW AskUserQuestion must be an explicit ask rule and must never be auto-allowed',
  )
  requireCondition(/settingSources:\s*\['project'\]/.test(jwRuntime), 'JW Runtime must load only controlled project Skill settings')
  requireCondition(/maxTurns:\s*config\.maxTurns/.test(jwRuntime), 'JW Runtime must cap model turns')
  requireCondition(/maxBudgetUsd:\s*config\.maxBudgetUsd/.test(jwRuntime), 'JW Runtime must cap model cost')
  requireCondition(!/bypassPermissions/.test(jwRuntime), 'JW Runtime must not bypass tool permissions')
  requireCondition(
    /jwAgentToolAllowed\(toolName\)/.test(jwRuntime),
    'JW Runtime must enforce its host tool allowlist before every tool call',
  )
  requireCondition(
    /denyJwAgentToolCall\(\{ toolName, userId, userName: runtimeUser\.name, conversationId \}\)/.test(jwRuntime)
    && /result: 'denied'/.test(jwRuntime)
    && /env: restrictedJwAgentEnvironment\(config, cwd\)/.test(jwRuntime)
    && /assertJwAgentGatewayAllowed\(config\.baseUrl\)/.test(jwRuntime)
    && /resolveJwAgentWorkspace\(workspaceRoot, conversationId\)/.test(jwRuntime)
    && !/env:\s*\{\s*\.\.\.process\.env/s.test(jwRuntime)
    && /file-subprocess-network-database-dynamic-load-denied/.test(jwRuntimeBoundaryAcceptance)
    && /denials-persist-actor-result-and-request-id/.test(jwRuntimeBoundaryAcceptance)
    && /agent-subprocess-environment-excludes-database-and-internal-secrets/.test(jwRuntimeBoundaryAcceptance)
    && packageJson.scripts?.['accept:jw-runtime-boundary']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/jwRuntimeBoundaryAcceptance.ts'
    && releaseGatePolicyCovers('accept:jw-runtime-boundary'),
    'JW Runtime must deny and audit five boundary classes while excluding host secrets from its SDK environment',
  )
  for (const toolName of [
    'search_project_docs', 'get_project_summary', 'list_project_files', 'read_project_file',
    'create_ai_task', 'get_ai_task_status', 'collect_public_intel',
  ]) {
    requireCondition(jwRuntime.includes(`mcp__investment__${toolName}`), `JW Runtime allowlist is missing: ${toolName}`)
  }
  requireCondition(/createRuntimeSession\(userId, refreshed\.agent\.id/.test(jwRuntime), 'JW Runtime tools must receive the authenticated stable user ID')
  for (const contract of ['server-stable-identity', 'PROJECT_FORBIDDEN', 'sourceId', 'chunkIndex', 'locator']) {
    requireCondition(projectKnowledgeTools.includes(contract), `project knowledge tool contract is missing: ${contract}`)
  }
  requireCondition(/getProjectSummaryForUser/.test(projectKnowledgeTools), 'project summary tool service is missing')
  requireCondition(/assertProjectToolAccess\(input\.userId, input\.projectId\)/.test(projectKnowledgeTools), 'project summary tool must enforce stable project access')
  const agentAiTaskTools = await readFile(path.resolve(root, 'server/src/services/agentAiTaskToolService.ts'), 'utf8')
  const aiTaskService = await readFile(path.resolve(root, 'server/src/services/aiTaskService.ts'), 'utf8')
  requireCondition(/AGENT_CREATABLE_AI_TASK_TYPES/.test(agentAiTaskTools), 'Agent AI task type allowlist is missing')
  requireCondition(/assertBoundTaskContext\(input\.userId, input\.projectId, input\.conversationId\)/.test(agentAiTaskTools), 'Agent AI task tools must bind stable user/project/conversation context')
  requireCondition(/deterministicIdempotencyKey/.test(agentAiTaskTools), 'Agent AI task creation must use a server-generated deterministic idempotency key')
  requireCondition(/task\.projectId !== input\.projectId \|\| task\.conversationId !== input\.conversationId/.test(agentAiTaskTools), 'Agent AI task status must reject cross-project or cross-conversation tasks')
  requireCondition(!/projectId:\s*z\./.test(jwRuntime), 'JW tool schemas must not accept a model-supplied projectId')
  requireCondition(/validateAiTaskCoreReferences/.test(aiTaskService), 'AI task creation reference validator is missing')
  requireCondition(/conversation\.projectId !== input\.projectId/.test(aiTaskService), 'AI tasks must require an exact project conversation binding')
  requireCondition(/TASK_ATTACHMENT_NOT_FOUND/.test(aiTaskService) && /TASK_ATTACHMENT_PARSE_FAILED/.test(aiTaskService), 'AI task attachment references must be validated before insertion')
  requireCondition(/input = \{ \.\.\.input, parameters: references\.parameters \}/.test(aiTaskService), 'AI task insertion must use normalized validated references')
  requireCondition(/findIdempotentAiTask/.test(aiTaskService) && /IDEMPOTENCY_CONFLICT/.test(aiTaskService), 'AI task idempotency must compare request identity on normal and race paths')
  requireCondition(
    /AND \$\{aiTasks\.cancellationRequested\} = false/.test(mysqlAiTaskRepository)
      && /aiTaskRepository\.claimTask/.test(aiTaskService),
    'cancel-requested AI tasks must not be claimed',
  )
  requireCondition(/classifyAiTaskFailure/.test(aiTaskService) && /TASK_ERROR_NOT_RETRYABLE/.test(aiTaskService), 'AI task failures must persist and enforce retryability')
  requireCondition(/cancelled-work-is-not-rescheduled-after-restart/.test(await readFile(path.resolve(root, 'server/src/scripts/aiTaskLifecycleAcceptance.ts'), 'utf8')), 'AI task lifecycle recovery acceptance is missing')
  const templateProgressService = await readFile(path.resolve(root, 'server/src/services/aiTemplateAnalysisProgressService.ts'), 'utf8')
  const templateProgressAcceptance = await readFile(path.resolve(root, 'server/src/scripts/aiTemplateAnalysisProgressAcceptance.ts'), 'utf8')
  const aiTaskRoutesForTemplateProgress = await readFile(path.resolve(root, 'server/src/routes/aiTasks.ts'), 'utf8')
  const serverEntryForTemplateProgress = await readFile(path.resolve(root, 'server/src/index.ts'), 'utf8')
  requireCondition(
    /ai_template_analysis_progress/.test(mysqlAiTaskRepository)
    && /recoverInterruptedTemplateAnalysisProgress/.test(mysqlAiTaskRepository)
    && /status='failed', stage='模板分析已中断'/.test(mysqlAiTaskRepository)
    && /aiTaskRepository\.startTemplateAnalysisProgress/.test(templateProgressService)
    && /aiTaskRepository\.recoverInterruptedTemplateAnalysisProgress/.test(templateProgressService)
    && !/from ['"](?:mysql2|\.\.\/db\/)/.test(templateProgressService)
    && !/node:fs|\.runtime|writeFileSync|readFileSync/.test(templateProgressService)
    && /await startAiTemplateAnalysisProgress/.test(aiTaskRoutesForTemplateProgress)
    && /await updateAiTemplateAnalysisProgress/.test(aiTaskRoutesForTemplateProgress)
    && /recoverInterruptedAiTemplateAnalysisProgress/.test(serverEntryForTemplateProgress),
    'template analysis progress must use MySQL and fail interrupted work explicitly after restart',
  )
  for (const contract of [
    'mysql-start-is-persistent-and-idempotent',
    'progress-is-isolated-by-stable-user-id',
    'same-progress-id-cannot-be-rebound',
    'startup-marks-unresumable-running-analysis-failed',
    'failure-message-is-redacted-before-persistence',
    'user-or-project-delete-cascades-progress',
  ]) {
    requireCondition(templateProgressAcceptance.includes(contract), `template progress acceptance is missing: ${contract}`)
  }
  requireCondition(
    packageJson.scripts?.['accept:ai-template-progress']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/aiTemplateAnalysisProgressAcceptance.ts'
    && releaseGatePolicyCovers('accept:ai-template-progress'),
    'production release must run the MySQL template analysis progress gate',
  )
  const clientAppStore = await readFile(path.resolve(root, 'src/store/useAppStore.ts'), 'utf8')
  const clientStateAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/clientStateAuthorityAcceptance.ts'),
    'utf8',
  )
  const mysqlAuditService = await readFile(path.resolve(root, 'server/src/services/auditService.ts'), 'utf8')
  const clientRoutes = await readFile(path.resolve(root, 'src/App.tsx'), 'utf8')
  const clientSystemPage = await readFile(path.resolve(root, 'src/pages/SystemPage.tsx'), 'utf8')
  const clientLoginPage = await readFile(path.resolve(root, 'src/pages/LoginPage.tsx'), 'utf8')
  const clientLayout = await readFile(path.resolve(root, 'src/layout/AppLayout.tsx'), 'utf8')
  const clientDashboard = await readFile(path.resolve(root, 'src/pages/DashboardPage.tsx'), 'utf8')
  const clientMeetingsPage = await readFile(path.resolve(root, 'src/pages/MeetingsPage.tsx'), 'utf8')
  requireCondition(
    !/(?:\.\.\/mock\/data|src\/mock\/data)/.test(clientAppStore)
    && !/from\s+['"]zustand\/middleware['"]|\bpersist\s*\(\s*\(|\b(?:localStorage|sessionStorage)\s*\./.test(clientAppStore)
    && /projects:\s*\[\]/.test(clientAppStore)
    && /meetings:\s*listOrEmpty\(results\[1\]\)/.test(clientAppStore)
    && /templates:\s*listOrEmpty\(results\[7\]\)/.test(clientAppStore)
    && /auditLogs:\s*listOrEmpty\(results\[8\]\)/.test(clientAppStore)
    && !/auditLogs:\s*\[log,\s*\.\.\.state\.auditLogs\]/.test(clientAppStore)
    && /db\.insert\(auditLogs\)/.test(mysqlAuditService)
    && !/mockAuditLogs/.test(mysqlAuditService),
    'frontend business state must start empty, fail empty and hydrate from MySQL-backed APIs without browser persistence',
  )
  for (const contract of [
    'store-does-not-import-demo-business-data',
    'store-does-not-persist-business-state-in-browser-storage',
    'mysql-hydration-replaces-browser-state-and-fails-empty',
    'logout-clears-cross-user-business-state',
    'unmigrated-local-only-pages-are-not-directly-reachable',
    'system-page-writes-only-through-audited-mysql-admin-apis',
    'login-does-not-prefill-or-publish-weak-demo-credentials',
    'notification-affordance-stays-hidden-without-server-authority',
    'dashboard-metrics-are-derived-from-authoritative-state',
    'meeting-page-fails-closed-without-manufacturing-business-content',
    'formal-ui-uses-authoritative-bp-and-batch-import-jobs',
    'project-and-meeting-creation-do-not-write-manufactured-fallbacks',
    'llm-health-uses-the-same-authenticated-gateway-config-as-runtime',
    'lead-conversion-is-one-server-transaction-without-fake-artifacts',
    'ai-and-risk-pages-fail-closed-without-fake-advice-or-timeline',
    'knowledge-upload-persists-real-bytes-without-fake-parse-success',
    'retired-local-domains-are-removed-from-project-ui-and-store',
    'project-page-awaits-authoritative-writes-and-hides-unimplemented-actions',
  ]) {
    requireCondition(clientStateAcceptance.includes(contract), `client state authority acceptance is missing: ${contract}`)
  }
  requireCondition(
    packageJson.scripts?.['accept:client-state-authority']
      === 'node --import tsx server/src/scripts/clientStateAuthorityAcceptance.ts'
    && releaseGatePolicyCovers('accept:client-state-authority'),
    'production release must reject demo/browser-authoritative business state',
  )
  requireCondition(
    /path="\/materials" element=\{<Navigate to="\/ai" replace \/>\}/.test(clientRoutes)
    && /path="\/post-investment" element=\{<Navigate to="\/projects" replace \/>\}/.test(clientRoutes)
    && /MySQL 权威数据/.test(clientSystemPage)
    && /apiGet<Administration>\('\/system-administration'\)/.test(clientSystemPage)
    && /apiPost\('\/users'/.test(clientSystemPage)
    && /apiPatch\(`\/system-administration\/(?:departments|roles)/.test(clientSystemPage)
    && !/addAudit|toggleUserStatus|演示版本|用户已创建并分配默认权限/.test(clientSystemPage)
    && !/123456|演示账号|lin@cybernaut\.com|admin@cybernaut\.com/.test(clientLoginPage)
    && !/markNotificationsRead|showNotifications|aria-label="通知"/.test(clientLayout),
    'formal UI must not expose local-only writes, fake success controls, empty notifications or demo credentials',
  )
  requireCondition(
    /projectsCreatedThisWeek/.test(clientDashboard)
    && /priorityTodoCount/.test(clientDashboard)
    && /dueToday/.test(clientDashboard)
    && !/\+ 2|本周新增 2 个|本周已生成 5 份|今日到期 2 项|to: '\/materials'/.test(clientDashboard),
    'dashboard metrics and links must be derived from authoritative state without demo offsets or retired routes',
  )
  requireCondition(
    /未保存会议或待办，请重试/.test(clientMeetingsPage)
    && /selected\.rawText/.test(clientMeetingsPage)
    && !/已生成占位纪要|音频模拟转写|项目继续推进，当前不形成最终投资结论|rawText:\s*'会议围绕/.test(clientMeetingsPage),
    'meeting UI must fail closed and display persisted source text instead of manufacturing fallback content',
  )
  const oaSchema = await readFile(path.resolve(root, 'server/src/db/schema.ts'), 'utf8')
  const oaService = await readFile(path.resolve(root, 'server/src/services/oaWorkflowService.ts'), 'utf8')
  const oaRoutes = await readFile(path.resolve(root, 'server/src/routes/oa.ts'), 'utf8')
  const oaAcceptance = await readFile(path.resolve(root, 'server/src/scripts/oaWorkflowAcceptance.ts'), 'utf8')
  for (const table of ['oa_approval_requests', 'oa_approval_nodes', 'oa_approval_records', 'oa_workflow_logs']) {
    requireCondition(oaSchema.includes(`mysqlTable('${table}'`), `OA MySQL schema is missing: ${table}`)
  }
  requireCondition(
    /FOR UPDATE/.test(oaService)
    && /activeKey: project\.id/.test(oaService)
    && /applicantUserId: actor\.id/.test(oaService)
    && /approverUserIds/.test(oaService)
    && /db\.transaction/.test(oaService)
    && /createMySqlIdentityRepositoryContext/.test(oaService)
    && /findEnabledByRoles/.test(oaService)
    && /identity\.audits\.append/.test(oaService)
    && !/\busers\b/.test((oaService.match(/from ['"]\.\.\/db\/schema\.js['"][\s\S]*?\n\}/g) || []).join('\n')),
    'OA workflow must use MySQL transactions, row locks, stable identities, one-active-request and server audit',
  )
  requireCondition(
    /oaRouter\.post\('\/requests'/.test(oaRoutes)
    && /oaRouter\.post\('\/requests\/:id\/actions'/.test(oaRoutes)
    && /apiGet<\{ list: ApprovalRequest\[\] \}>\('\/oa\/requests'\)/.test(clientAppStore)
    && /apiPost<ApprovalRequest>\('\/oa\/requests'/.test(clientAppStore)
    && /\/oa\/requests\/\$\{requestId\}\/actions/.test(clientAppStore),
    'OA page must read and mutate the server-owned workflow instead of a browser-local state machine',
  )
  for (const contract of [
    'one-project-allows-only-one-active-request',
    'project-access-does-not-grant-node-approval-authority',
    'concurrent-final-action-has-one-transaction-winner',
    'final-approval-updates-project-and-appends-one-workflow-log-atomically',
    'refresh-reloads-complete-oa-history-from-mysql',
    'project-with-oa-history-cannot-silently-delete-audit-chain',
  ]) {
    requireCondition(oaAcceptance.includes(contract), `OA workflow acceptance is missing: ${contract}`)
  }
  requireCondition(
    packageJson.scripts?.['accept:oa-workflow']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/oaWorkflowAcceptance.ts'
    && releaseGatePolicyCovers('accept:oa-workflow'),
    'production release must run the MySQL OA workflow gate',
  )
  const meetingService = await readFile(path.resolve(root, 'server/src/services/meetingService.ts'), 'utf8')
  const meetingRoutes = await readFile(path.resolve(root, 'server/src/routes/meetings.ts'), 'utf8')
  const meetingAcceptance = await readFile(path.resolve(root, 'server/src/scripts/meetingPersistenceAcceptance.ts'), 'utf8')
  requireCondition(
    /db\.transaction/.test(meetingService)
    && /tx\.insert\(meetings\)/.test(meetingService)
    && /tx\.insert\(todos\)/.test(meetingService)
    && /tx\.insert\(auditLogs\)/.test(meetingService)
    && /presentMeetings/.test(meetingRoutes)
    && /createdTodos/.test(meetingRoutes)
    && /newTodos/.test(clientAppStore)
    && !/apiPost<Todo>\('\/todos',\s*\{\s*\.\.\.t,\s*meetingId/.test(clientAppStore)
    && /todo\.meetingId === selected\.id/.test(clientMeetingsPage),
    'meeting API must map the UI contract and atomically persist meeting, linked todos and actor audit',
  )
  for (const contract of [
    'meeting-todos-and-actor-audit-persist-together',
    'api-contract-maps-mysql-fields-and-linked-todo-count',
    'refresh-reloads-meeting-and-todo-count-from-mysql',
    'meeting-todo-audit-transaction-rolls-back-on-any-write-failure',
  ]) {
    requireCondition(meetingAcceptance.includes(contract), `meeting persistence acceptance is missing: ${contract}`)
  }
  requireCondition(
    packageJson.scripts?.['accept:meeting-persistence']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/meetingPersistenceAcceptance.ts'
    && releaseGatePolicyCovers('accept:meeting-persistence'),
    'production release must run the MySQL meeting persistence gate',
  )
  const leadConversionService = await readFile(path.resolve(root, 'server/src/services/aiSummaryService.ts'), 'utf8')
  const leadConversionAcceptance = await readFile(path.resolve(root, 'server/src/scripts/leadConversionAcceptance.ts'), 'utf8')
  requireCondition(
    /export async function convertLead\(leadId: string, userId: string\)/.test(leadConversionService)
    && /db\.transaction/.test(leadConversionService)
    && /FOR UPDATE/.test(leadConversionService)
    && /tx\.insert\(projects\)/.test(leadConversionService)
    && /tx\.insert\(projectMembers\)/.test(leadConversionService)
    && /tx\.update\(leads\)/.test(leadConversionService)
    && /tx\.insert\(auditLogs\)/.test(leadConversionService),
    'lead conversion must atomically create the project, stable owner binding, lead link and actor audit',
  )
  for (const contract of [
    'concurrent-lead-conversion-creates-exactly-one-project',
    'lead-project-link-owner-and-factual-fields-persist-atomically',
    'conversion-does-not-manufacture-summary-or-file-records',
    'missing-lead-failure-does-not-create-orphan-project',
  ]) {
    requireCondition(leadConversionAcceptance.includes(contract), `lead conversion acceptance is missing: ${contract}`)
  }
  requireCondition(
    packageJson.scripts?.['accept:lead-conversion']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/leadConversionAcceptance.ts'
    && releaseGatePolicyCovers('accept:lead-conversion'),
    'production release must run the atomic lead conversion gate',
  )
  const riskService = await readFile(path.resolve(root, 'server/src/services/riskService.ts'), 'utf8')
  const riskRoutes = await readFile(path.resolve(root, 'server/src/routes/risks.ts'), 'utf8')
  const riskAcceptance = await readFile(path.resolve(root, 'server/src/scripts/riskPersistenceAcceptance.ts'), 'utf8')
  requireCondition(
    /export function presentRisk/.test(riskService)
    && /db\.transaction/.test(riskService)
    && /tx\.insert\(auditLogs\)/.test(riskService)
    && /presentRisks/.test(riskRoutes)
    && /riskStatus/.test(riskRoutes)
    && /RiskPatchSchema = RiskFieldsSchema\.partial\(\)/.test(riskRoutes)
    && /PATCH must not inject create-time defaults/.test(riskRoutes)
    && /detectedAt: riskDate/.test(riskRoutes),
    'risk API must map the stable UI contract and transactionally persist actor audit',
  )
  for (const contract of [
    'risk-api-contract-maps-mysql-fields-and-legacy-status',
    'risk-create-persists-stable-assignee-and-real-actor-audit',
    'risk-update-and-refresh-use-authoritative-mysql-status',
    'risk-and-audit-transaction-rolls-back-on-audit-failure',
  ]) {
    requireCondition(riskAcceptance.includes(contract), `risk persistence acceptance is missing: ${contract}`)
  }
  requireCondition(
    packageJson.scripts?.['accept:risk-persistence']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/riskPersistenceAcceptance.ts'
    && releaseGatePolicyCovers('accept:risk-persistence'),
    'production release must run the risk persistence gate',
  )
  requireCondition(/const passedArtifacts = artifacts\.filter\(\(artifact\) => artifact\.qualityStatus === 'passed'\)/.test(aiTaskService), 'AI task cards must only expose quality-passed artifacts')
  requireCondition(
    /eq\(aiArtifacts\.qualityStatus, 'passed'\)/.test(mysqlAiTaskRepository)
      && /aiTaskRepository\.listOwnedArtifacts/.test(aiTaskService),
    'AI artifact center must only expose quality-passed artifacts',
  )
  requireCondition(/cross-user-task-artifact-preview-download-template-denied/.test(await readFile(path.resolve(root, 'server/src/scripts/aiTaskPersistenceAcceptance.ts'), 'utf8')), 'AI task persistence and artifact isolation acceptance is missing')
  requireCondition(
    /six-task-types-share-one-mysql-lease-worker/.test(
      await readFile(path.resolve(root, 'server/src/scripts/aiTaskUnifiedIntegrationAcceptance.ts'), 'utf8'),
    ),
    'six AI document task types must have one catalog, API, table and lease-worker acceptance',
  )
  requireCondition(
    /six-task-types-recover-after-expired-worker-lease/.test(
      await readFile(path.resolve(root, 'server/src/scripts/aiTaskUnifiedIntegrationAcceptance.ts'), 'utf8'),
    )
    && /unsafe-template-preparation-interruption-fails-explicitly/.test(
      await readFile(path.resolve(root, 'server/src/scripts/aiTaskUnifiedIntegrationAcceptance.ts'), 'utf8'),
    ),
    'all six AI document task types must recover or fail explicitly after worker interruption',
  )
  const intelService = await readFile(path.resolve(root, 'server/src/services/inProcessAiWorkflowService.ts'), 'utf8')
  const intelCollector = await readFile(path.resolve(root, 'server/assets/ai/collect_intel.py'), 'utf8')
  const metaRoutes = await readFile(path.resolve(root, 'server/src/routes/meta.ts'), 'utf8')
  const leadPublicIntelService = await readFile(path.resolve(root, 'server/src/services/leadPublicIntelService.ts'), 'utf8')
  const leadPublicIntelAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadPublicIntelAcceptance.ts'),
    'utf8',
  )
  const leadFieldProvenanceService = await readFile(
    path.resolve(root, 'server/src/services/leadFieldProvenance.ts'),
    'utf8',
  )
  const leadFieldProvenanceAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadFieldProvenanceAcceptance.ts'),
    'utf8',
  )
  const radarJobService = await readFile(path.resolve(root, 'server/src/services/radarJobService.ts'), 'utf8')
  const radarCollectorService = await readFile(path.resolve(root, 'server/src/services/radarCollectorService.ts'), 'utf8')
  const radarDataMigrationService = await readFile(
    path.resolve(root, 'server/src/services/radarDataMigrationService.ts'),
    'utf8',
  )
  const runtimeJobScheduler = await readFile(path.resolve(root, 'server/src/services/runtimeJobScheduler.ts'), 'utf8')
  const runtimeJobLeaderAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/runtimeJobLeaderAcceptance.ts'),
    'utf8',
  )
  const aiSummaryService = await readFile(path.resolve(root, 'server/src/services/aiSummaryService.ts'), 'utf8')
  const radarIsolationAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/radarJobIsolationAcceptance.ts'),
    'utf8',
  )
  const radarLeadSourceReconciliationAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/radarLeadSourceReconciliationAcceptance.ts'),
    'utf8',
  )
  const radarLeadSourceReconciliationHandoff = await readFile(
    path.resolve(root, 'docs/迁移计划/Radar与线索源核对及生产补证手册-20260811.md'),
    'utf8',
  )
  requireCondition(/writeFile\(requestFile,[\s\S]*mode:\s*0o600/.test(intelService), 'public-intel input must use a private request file')
  requireCondition(/`@\$\{requestFile\}`/.test(intelService), 'public-intel child process must not receive project text in argv')
  requireCondition(/ALLOWED_NETWORK_HOSTS\s*=\s*\{"cn\.bing\.com",\s*"www\.sogou\.com"\}/.test(intelCollector), 'public-intel network hosts must be fixed')
  requireCondition(/open_allowlisted\(url\)/.test(intelCollector), 'public-intel requests must enforce the network allowlist')
  requireCondition(
    /commitLeadPublicIntel\(\{/.test(metaRoutes)
    && !/FLUE_BASE_URL/.test(metaRoutes)
    && !/\/workflows\/intel-collect/.test(metaRoutes)
    && /SELECT GET_LOCK\(\?, 15\) AS acquired/.test(leadPublicIntelService)
    && /recordLeadPipelineRawEvent\(rawInput, connection\)/.test(leadPublicIntelService)
    && /PUBLIC_INTEL_TARGET_SUBJECT_MISMATCH/.test(leadPublicIntelService)
    && /PUBLIC_INTEL_TARGET_TERMINAL/.test(leadPublicIntelService)
    && /PUBLIC_INTEL_ENTITY_AMBIGUOUS/.test(leadPublicIntelService)
    && /transitionLeadPipelineItem\(captured\.event\.id,[\s\S]*}, connection\)/.test(leadPublicIntelService)
    && /await connection\.commit\(\)/.test(leadPublicIntelService)
    && /await connection\.rollback\(\)/.test(leadPublicIntelService),
    'public-intel collection must use the host MySQL transaction and must not call Flue',
  )
  for (const contract of [
    'concurrent-identical-public-intel-creates-one-formal-lead',
    'raw-event-lead-audit-and-ready-link-commit-on-one-host-path',
    'host-cleaning-deduplicates-sources-and-persists-only-sourced-facts',
    'invalid-target-rolls-back-raw-event-lead-and-audit-together',
    'explicit-public-intel-target-must-match-the-requested-subject-with-full-rollback',
    'terminal-public-intel-target-cannot-be-enriched-and-transaction-fully-rolls-back',
    'ambiguous-existing-entity-rolls-back-formal-write-and-stages-auditable-review',
  ]) {
    requireCondition(leadPublicIntelAcceptance.includes(contract), `public-intel acceptance is missing: ${contract}`)
  }
  requireCondition(
    packageJson.scripts?.['accept:lead-public-intel']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/leadPublicIntelAcceptance.ts',
    'public-intel acceptance command must be registered',
  )
  requireCondition(
    /manual_review:\s*100/.test(leadFieldProvenanceService)
    && /legacy_import:\s*90/.test(leadFieldProvenanceService)
    && /public_intel:\s*60/.test(leadFieldProvenanceService)
    && /ai_scoring:\s*40/.test(leadFieldProvenanceService)
    && /linkedFields/.test(leadFieldProvenanceService)
    && /applyLeadFieldPolicy/.test(leadPublicIntelService)
    && /applyLeadFieldPolicy/.test(aiSummaryService)
    && /real-mysql-rescoring-preserves-manual-scalars-and-appends-evidenced-arrays/.test(leadFieldProvenanceAcceptance)
    && /accept:lead-field-provenance/.test(JSON.stringify(packageJson.scripts)),
    'lead enrichment must retain field provenance, linked evidence groups and real MySQL overwrite protection',
  )
  requireCondition(
    !/execFileSupervised\(|child_process|python3|job\.py/.test(radarJobService + runtimeJobScheduler + radarCollectorService)
    && /runRadarPublicCollection\(signal\)/.test(runtimeJobScheduler)
    && /runRadarPaperCollection\(signal\)/.test(runtimeJobScheduler)
    && /ingestRadarCandidates\(retained\)/.test(radarCollectorService),
    'Radar collection must run inside the Node service and persist directly to MySQL without Python',
  )
  requireCondition(
    /runRadarPublicCollectionScope\('auto'/.test(radarCollectorService)
    && /runRadarPublicCollectionScope\('paper_daily'/.test(radarCollectorService)
    && /radarSourceRegistry/.test(radarCollectorService)
    && /radarCandidates/.test(radarCollectorService)
    && /legacy JSONL\/JSON\/Excel files[\s\S]*runtime dependency/.test(radarDataMigrationService),
    'Radar runtime collection must use MySQL for source configuration, state and candidates',
  )
  requireCondition(
    /SELECT \* FROM \$\{jobsTable\}[\s\S]*next_run_at <= NOW\(3\)[\s\S]*lease_expires_at < NOW\(3\)[\s\S]*FOR UPDATE/.test(runtimeJobScheduler)
    && /claimRuntimeJobLease/.test(runtimeJobScheduler)
    && /recoverExpiredRuntimeJobLeases/.test(runtimeJobScheduler)
    && /current_run_id=\?/.test(runtimeJobScheduler)
    && /lease_owner=\?/.test(runtimeJobScheduler)
    && /two-instances-only-one-runtime-job-lease-and-run/.test(runtimeJobLeaderAcceptance)
    && /active-cycle-cannot-create-a-duplicate-run/.test(runtimeJobLeaderAcceptance)
    && /expired-owner-is-abandoned-and-job-becomes-due/.test(runtimeJobLeaderAcceptance)
    && /another-instance-takes-over-with-a-new-audited-run/.test(runtimeJobLeaderAcceptance)
    && packageJson.scripts?.['accept:runtime-job-leader']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/runtimeJobLeaderAcceptance.ts',
    'MySQL runtime scheduler must prove single-lease multi-instance execution and expired-owner takeover',
  )
  requireCondition(
    releaseGatePolicyCovers('accept:runtime-job-leader'),
    'production release must run the MySQL runtime job leader gate',
  )
  requireCondition(
    /SELECT GET_LOCK\(\?, 15\) AS acquired/.test(aiSummaryService)
    && /SELECT RELEASE_LOCK\(\?\)/.test(aiSummaryService)
    && /RADAR_LEAD_ENTITY_AMBIGUOUS/.test(aiSummaryService)
    && /decisionType: 'entity_resolution'/.test(aiSummaryService)
    && /openLeadPipelineReview\(\{/.test(aiSummaryService)
    && /reviewStaged/.test(metaRoutes),
    'Radar lead synchronization must use cross-instance MySQL advisory locks',
  )
  for (const contract of [
    'radar-python-process-entrypoint-is-rejected',
    'radar-collector-health-is-node-in-process',
    'concurrent-radar-source-sync-creates-one-lead',
    'repeated-radar-source-sync-is-idempotent',
  ]) {
    requireCondition(radarIsolationAcceptance.includes(contract), `Radar failure isolation acceptance is missing: ${contract}`)
  }
  requireCondition(
    /reserveRawEventCoverageIsComplete/.test(radarLeadSourceReconciliationAcceptance)
    && /radarProjectionIsRebuildableFromRawEvents/.test(radarLeadSourceReconciliationAcceptance)
    && /radarSourceKeysAndCursorsAreValid/.test(radarLeadSourceReconciliationAcceptance)
    && /radarStatesAndSourcesAreRecoverable/.test(radarLeadSourceReconciliationAcceptance)
    && /radarSchedulesMovedIntoMySqlRuntimeJobs/.test(radarLeadSourceReconciliationAcceptance)
    && /productionAssetReady:\s*productionAssets\.productionAssetReady/.test(radarLeadSourceReconciliationAcceptance)
    && /fullSourceAssetReady/.test(radarLeadSourceReconciliationAcceptance)
    && /reportContainsBusinessPayload:\s*false/.test(radarLeadSourceReconciliationAcceptance)
    && packageJson.scripts?.['accept:radar-lead-source-reconciliation']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/radarLeadSourceReconciliationAcceptance.ts'
    && releaseGatePolicyCovers('accept:radar-lead-source-reconciliation')
    && /localTechnicalReady=true/.test(radarLeadSourceReconciliationHandoff)
    && /productionAssetReady=false/.test(radarLeadSourceReconciliationHandoff)
    && /406 条历史 imported/.test(radarLeadSourceReconciliationHandoff)
    && /不能关闭 `MIG-0507`/.test(radarLeadSourceReconciliationHandoff),
    'Radar/lead-reserve release gate must prove target consistency while preserving the production source-asset blocker',
  )
  const leadScoreJobService = await readFile(path.resolve(root, 'server/src/services/leadScoreJobService.ts'), 'utf8')
  const leadScoreLifecycleAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadScoreJobLifecycleAcceptance.ts'),
    'utf8',
  )
  requireCondition(
    /FOR UPDATE SKIP LOCKED/.test(leadScoreJobService)
    && /dead_lettered_at=IF\(\?='dead_letter'/.test(leadScoreJobService)
    && /人工重试 AI 评分死信/.test(leadScoreJobService),
    'lead score jobs must use mutually exclusive leases, persistent dead letters and audited manual retry',
  )
  for (const contract of [
    'two-workers-only-one-valid-lease',
    'queued-running-retrying-recovery-rules-enforced',
    'retry-exhaustion-enters-persistent-dead-letter',
    'manual-retry-resets-cycle-and-is-audited-atomically',
  ]) {
    requireCondition(leadScoreLifecycleAcceptance.includes(contract), `lead score lifecycle acceptance is missing: ${contract}`)
  }
  const projectScoreJobService = await readFile(path.resolve(root, 'server/src/services/projectScoreJobService.ts'), 'utf8')
  const projectScoreLifecycleAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/projectScoreJobLifecycleAcceptance.ts'),
    'utf8',
  )
  const projectScoreRoutes = await readFile(path.resolve(root, 'server/src/routes/projects.ts'), 'utf8')
  const serverEntryForProjectScore = await readFile(path.resolve(root, 'server/src/index.ts'), 'utf8')
  requireCondition(
    /FOR UPDATE SKIP LOCKED/.test(projectScoreJobService)
    && /recoverExpiredProjectScoreJobLeases/.test(projectScoreJobService)
    && /startProjectScoreJobWorker/.test(serverEntryForProjectScore)
    && /stopProjectScoreJobWorker/.test(serverEntryForProjectScore)
    && /enqueueProjectScoreJob/.test(projectScoreRoutes)
    && /getProjectScoreJob/.test(projectScoreRoutes)
    && !/projScoreStatus|new Map<.*status.*running/.test(projectScoreRoutes),
    'project score status must use a restart-safe MySQL lease worker instead of process memory',
  )
  for (const contract of [
    'enqueue-is-persistent-and-idempotent',
    'two-workers-receive-only-one-valid-lease',
    'restart-recovers-expired-running-lease',
    'explicit-rescore-resets-terminal-attempt-state',
    'project-delete-cascades-score-job',
  ]) {
    requireCondition(projectScoreLifecycleAcceptance.includes(contract), `project score lifecycle acceptance is missing: ${contract}`)
  }
  requireCondition(
    packageJson.scripts?.['accept:project-score-lifecycle']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/projectScoreJobLifecycleAcceptance.ts'
    && releaseGatePolicyCovers('accept:project-score-lifecycle'),
    'production release must run the persistent project score lifecycle gate',
  )
  const leadPipelineEventService = await readFile(path.resolve(root, 'server/src/services/leadPipelineEventService.ts'), 'utf8')
  const leadReserveIntakeService = await readFile(path.resolve(root, 'server/src/services/leadReserveIntakeService.ts'), 'utf8')
  const leadPipelineEventAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadPipelineEventAcceptance.ts'),
    'utf8',
  )
  const leadPipelineSchema = await readFile(path.resolve(root, 'server/src/db/schema.ts'), 'utf8')
  for (const table of ['lead_pipeline_raw_events', 'lead_pipeline_items', 'lead_pipeline_transitions']) {
    requireCondition(leadPipelineSchema.includes(`mysqlTable('${table}'`), `lead pipeline schema is missing: ${table}`)
  }
  requireCondition(
    /lead-pipeline-v1/.test(leadPipelineEventService)
    && /contentHash/.test(leadPipelineEventService)
    && /idempotencyKey/.test(leadPipelineEventService),
    'lead pipeline raw events must derive a source/content idempotency identity',
  )
  requireCondition(
    /recordLeadPipelineRawEvent\(leadReserveRawEventInput\(row\), connection\)/.test(leadReserveIntakeService),
    'lead reserve intake must record a raw event in its host transaction before formal lead commit',
  )
  requireCondition(
    /Every candidate crosses the common immutable event boundary/.test(metaRoutes)
    && /recordLeadPipelineRawEvent\(\{[\s\S]*sourceType: 'radar'/.test(metaRoutes),
    'Radar candidates must cross the common raw-event boundary before review and lead commit',
  )
  requireCondition(
    /commitRadarLeadPipelineReady\(\{/.test(metaRoutes)
    && /await connection\.beginTransaction\(\)/.test(aiSummaryService)
    && /syncRadarLeadByNameUnlocked\(input\.lead, input\.userId, transactionDb, false\)/.test(aiSummaryService)
    && /transitionLeadPipelineItem\(input\.eventId,[\s\S]*}, connection\)/.test(aiSummaryService)
    && /await connection\.commit\(\)/.test(aiSummaryService)
    && /await connection\.rollback\(\)/.test(aiSummaryService)
    && /radar-formal-lead-and-ready-transition-roll-back-together/.test(leadPipelineEventAcceptance)
    && /radar-ambiguous-existing-entity-stages-actionable-review-without-merging-or-creating/.test(leadPipelineEventAcceptance),
    'Radar formal lead write and Pipeline ready transition must commit or roll back in one host transaction',
  )
  for (const contract of [
    'concurrent-identical-source-content-creates-one-raw-event',
    'same-source-changed-content-creates-new-immutable-version',
    'review-to-ready-links-formal-lead-with-history',
    'radar-ambiguous-existing-entity-stages-actionable-review-without-merging-or-creating',
    'out-of-band-raw-payload-tampering-is-detected',
  ]) {
    requireCondition(leadPipelineEventAcceptance.includes(contract), `lead pipeline raw-event acceptance is missing: ${contract}`)
  }
  const leadPipelineAuditService = await readFile(path.resolve(root, 'server/src/services/leadPipelineAuditService.ts'), 'utf8')
  const leadPipelineAuditAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadPipelineAuditAcceptance.ts'),
    'utf8',
  )
  const radarAiReviewService = await readFile(path.resolve(root, 'server/src/services/radarAiReviewService.ts'), 'utf8')
  const leadSubjectAgentService = await readFile(path.resolve(root, 'server/src/services/leadSubjectAgentService.ts'), 'utf8')
  const leadAgentUsageService = await readFile(path.resolve(root, 'server/src/services/leadAgentUsageService.ts'), 'utf8')
  const leadAgentUsageAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadAgentUsageAcceptance.ts'),
    'utf8',
  )
  const leadSubjectAgentAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadSubjectAgentAcceptance.ts'),
    'utf8',
  )
  const leadSubjectGoldAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadSubjectGoldAcceptance.ts'),
    'utf8',
  )
  const leadSubjectGold = await readFile(
    path.resolve(root, 'server/assets/lead-subject-gold-v1.json'),
    'utf8',
  )
  const leadScoringGoldAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadScoringGoldAcceptance.ts'),
    'utf8',
  )
  const leadScoringGold = await readFile(
    path.resolve(root, 'server/assets/lead-scoring-gold-v1.json'),
    'utf8',
  )
  const leadWorkflowGoldAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadWorkflowGoldAcceptance.ts'),
    'utf8',
  )
  const leadWorkflowGold = await readFile(
    path.resolve(root, 'server/assets/lead-workflow-gold-v1.json'),
    'utf8',
  )
  const leadAgentRuntimeGuardService = await readFile(
    path.resolve(root, 'server/src/services/leadAgentRuntimeGuardService.ts'),
    'utf8',
  )
  const leadAgentRuntimeGuardAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadAgentRuntimeGuardAcceptance.ts'),
    'utf8',
  )
  const databaseSchemaForAgentGuard = await readFile(path.resolve(root, 'server/src/db/schema.ts'), 'utf8')
  const leadScoringAgentService = await readFile(path.resolve(root, 'server/src/services/leadScoringAgentService.ts'), 'utf8')
  const leadScoringPipelineService = await readFile(path.resolve(root, 'server/src/services/leadScoringPipelineService.ts'), 'utf8')
  const inProcessAiWorkflowService = await readFile(path.resolve(root, 'server/src/services/inProcessAiWorkflowService.ts'), 'utf8')
  const projectRoutesForScoring = await readFile(path.resolve(root, 'server/src/routes/projects.ts'), 'utf8')
  const projectScoringService = await readFile(path.resolve(root, 'server/src/services/projectScoringService.ts'), 'utf8')
  const leadScoringAgentAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadScoringAgentAcceptance.ts'),
    'utf8',
  )
  const leadScoringAuditAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadScoringAuditAcceptance.ts'),
    'utf8',
  )
  const leadWorkflowAgentService = await readFile(
    path.resolve(root, 'server/src/services/leadWorkflowAgentService.ts'),
    'utf8',
  )
  const leadWorkflowAgentAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadWorkflowAgentAcceptance.ts'),
    'utf8',
  )
  const leadWorkflowPipelineService = await readFile(
    path.resolve(root, 'server/src/services/leadWorkflowPipelineService.ts'),
    'utf8',
  )
  const leadWorkflowPipelineAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadWorkflowPipelineAcceptance.ts'),
    'utf8',
  )
  const leadResearchToolService = await readFile(
    path.resolve(root, 'server/src/services/leadResearchToolService.ts'),
    'utf8',
  )
  const leadOnlineWorkflowService = await readFile(
    path.resolve(root, 'server/src/services/leadOnlineWorkflowService.ts'),
    'utf8',
  )
  const leadOnlineWorkflowAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadOnlineWorkflowAcceptance.ts'),
    'utf8',
  )
  const leadPipelineReviewService = await readFile(
    path.resolve(root, 'server/src/services/leadPipelineReviewService.ts'),
    'utf8',
  )
  const leadPipelineEntityMatchService = await readFile(
    path.resolve(root, 'server/src/services/leadPipelineEntityMatchService.ts'),
    'utf8',
  )
  const leadManualReviewAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadPipelineManualReviewAcceptance.ts'),
    'utf8',
  )
  const sourcingPage = await readFile(path.resolve(root, 'src/pages/SourcingPage.tsx'), 'utf8')
  const mysqlMigration = await readFile(path.resolve(root, 'server/src/db/migrate.ts'), 'utf8')
  for (const table of [
    'lead_pipeline_prompt_versions', 'lead_pipeline_runs', 'lead_pipeline_decisions',
    'lead_pipeline_evidence', 'lead_pipeline_reviews', 'lead_pipeline_entity_matches',
  ]) {
    requireCondition(leadPipelineSchema.includes(`mysqlTable('${table}'`), `lead pipeline audit schema is missing: ${table}`)
  }
  requireCondition(
    /ON DUPLICATE KEY UPDATE match_key=VALUES\(match_key\)/.test(leadPipelineEntityMatchService)
    && /lead-entity-match-v1/.test(leadPipelineEntityMatchService)
    && /recordLeadPipelineEntityMatch/.test(leadPipelineReviewService)
    && /recordLeadPipelineEntityMatch/.test(aiSummaryService)
    && /recordLeadPipelineEntityMatch/.test(leadPublicIntelService),
    'manual review, Radar and public intel must persist idempotent entity match evidence',
  )
  requireCondition(
    /startLeadPipelineRun/.test(radarAiReviewService)
    && /finishLeadPipelineRun/.test(radarAiReviewService)
    && /recordLeadPipelineDecision/.test(radarAiReviewService)
    && /openLeadPipelineReview/.test(radarAiReviewService)
    && /eventIds: reviewableEntries/.test(metaRoutes),
    'Radar model calls must persist event-bound runs, decisions, evidence and review tasks',
  )
  requireCondition(
    /runLeadSubjectAgentBatch/.test(radarAiReviewService)
    && /runtime:\s*'claude-agent-sdk'/.test(radarAiReviewService)
    && !/\/chat\/completions/.test(radarAiReviewService)
    && !/\bfetch\s*\(/.test(radarAiReviewService),
    'Radar subject review must use the Agent SDK and must not call the model gateway over direct HTTP',
  )
  requireCondition(
    /tools:\s*\[\]/.test(leadSubjectAgentService)
    && /skills:\s*\[\]/.test(leadSubjectAgentService)
    && /allowedTools:\s*\[\]/.test(leadSubjectAgentService)
    && /permissionMode:\s*'dontAsk'/.test(leadSubjectAgentService)
    && /settingSources:\s*\[\]/.test(leadSubjectAgentService)
    && /mcpServers:\s*\{\}/.test(leadSubjectAgentService)
    && /persistSession:\s*false/.test(leadSubjectAgentService)
    && /behavior:\s*'deny'/.test(leadSubjectAgentService),
    'lead subject Agent must expose no tools, Skills, MCP, settings or persisted session and deny tool requests',
  )
  requireCondition(
    !/inherited\s*=\s*\[[^\]]*DB_/s.test(leadSubjectAgentService)
    && /agent-environment-whitelists-gateway-and-excludes-database-secrets/.test(leadSubjectAgentAcceptance)
    && /runtime-tool-request-is-denied-and-fails-closed/.test(leadSubjectAgentAcceptance),
    'lead subject Agent must not receive database secrets or obtain a runtime tool',
  )
  requireCondition(
    packageJson.scripts?.['accept:lead-subject-agent']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/leadSubjectAgentAcceptance.ts',
    'lead subject Agent acceptance entrypoint is missing',
  )
  requireCondition(
    /result\.usage/.test(leadAgentUsageService)
    && /result\.modelUsage/.test(leadAgentUsageService)
    && /cache_creation_input_tokens/.test(leadAgentUsageService)
    && /cacheCreationInputTokens/.test(leadAgentUsageService)
    && /cache_read_input_tokens/.test(leadAgentUsageService)
    && /cacheReadInputTokens/.test(leadAgentUsageService)
    && !/\bcost\b/i.test(leadAgentUsageService)
    && /leadAgentUsageMetrics/.test(leadSubjectAgentService)
    && /leadAgentUsageMetrics/.test(leadScoringAgentService)
    && /leadAgentUsageMetrics/.test(leadWorkflowAgentService)
    && /model-usage-fallback-supports-camel-and-snake-case/.test(leadAgentUsageAcceptance)
    && /negative-and-non-finite-usage-is-not-invented/.test(leadAgentUsageAcceptance)
    && packageJson.scripts?.['accept:lead-agent-usage']
      === 'node --import tsx server/src/scripts/leadAgentUsageAcceptance.ts'
    && releaseGatePolicyCovers('accept:lead-agent-usage'),
    'all lead Agents must use aggregate/model token usage fallback without cost-based estimates',
  )
  requireCondition(
    ['lead-research-agent', 'lead-screening-agent', 'lead-enrichment-agent']
      .every((profile) => leadWorkflowAgentService.includes(`'${profile}'`))
    && /tools:\s*\[\]/.test(leadWorkflowAgentService)
    && /skills:\s*\[\]/.test(leadWorkflowAgentService)
    && /allowedTools:\s*\[\]/.test(leadWorkflowAgentService)
    && /permissionMode:\s*'dontAsk'/.test(leadWorkflowAgentService)
    && /settingSources:\s*\[\]/.test(leadWorkflowAgentService)
    && /mcpServers:\s*\{\}/.test(leadWorkflowAgentService)
    && /persistSession:\s*false/.test(leadWorkflowAgentService)
    && /returned evidence quote not found in immutable host input/.test(leadWorkflowAgentService)
    && /returned evidence quote not bound to declared sourceId/.test(leadWorkflowAgentService),
    'research, screening and enrichment Agent profiles must use strict host-evidence-only SDK boundaries',
  )
  for (const contract of [
    'three-profiles-have-distinct-versioned-schema-contracts',
    'all-workflow-profiles-expose-no-built-in-tools-skills-or-subagents',
    'all-workflow-profiles-exclude-database-and-ambient-gateway-secrets',
    'research-profile-rejects-quote-not-found-in-immutable-input',
    'research-profile-rejects-quote-bound-to-wrong-source-id',
    'screening-profile-rejects-accept-without-evidence',
    'enrichment-profile-rejects-non-whitelisted-field',
  ]) {
    requireCondition(leadWorkflowAgentAcceptance.includes(contract), `lead workflow Agent acceptance is missing: ${contract}`)
  }
  requireCondition(
    packageJson.scripts?.['accept:lead-workflow-agents']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/leadWorkflowAgentAcceptance.ts',
    'lead workflow Agent acceptance entrypoint is missing',
  )
  requireCondition(
    /SUBMIT_LEAD_DECISION_TOOL\s*=\s*'submit_lead_decision'/.test(leadWorkflowPipelineService)
    && /registerLeadPipelinePromptVersion/.test(leadWorkflowPipelineService)
    && /startLeadPipelineRun/.test(leadWorkflowPipelineService)
    && /finishLeadPipelineRun/.test(leadWorkflowPipelineService)
    && /submitLeadDecision/.test(leadWorkflowPipelineService)
    && !/insert\(leads\)|update\(leads\)/.test(leadWorkflowPipelineService),
    'workflow Agent host pipeline must stage versioned run, metrics, decision and evidence without formal lead writes',
  )
  for (const contract of [
    'three-workflow-profile-version-contracts-registered-immutably',
    'three-workflow-agent-runs-bind-event-model-metrics-and-zero-tools',
    'submit-lead-decision-stages-three-evidence-bound-outputs-without-formal-write',
    'completed-workflow-run-replay-does-not-call-model-or-duplicate-audit',
    'failed-workflow-run-and-decision-are-redacted-and-preserved',
  ]) {
    requireCondition(leadWorkflowPipelineAcceptance.includes(contract), `lead workflow pipeline acceptance is missing: ${contract}`)
  }
  requireCondition(
    packageJson.scripts?.['accept:lead-workflow-pipeline']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/leadWorkflowPipelineAcceptance.ts',
    'lead workflow pipeline acceptance entrypoint is missing',
  )
  requireCondition(
    /LEAD_RESEARCH_HOST_TOOLSET_VERSION\s*=\s*'lead-research-host-tools-v1'/.test(leadResearchToolService)
    && ['read_immutable_lead_event', 'read_existing_lead', 'search_public_sources', 'read_source_snippets']
      .every((tool) => leadResearchToolService.includes(`'${tool}'`))
    && /verifyLeadPipelineRawEvent/.test(leadResearchToolService)
    && /collectCompanyIntel/.test(leadResearchToolService)
    && !/\bfetch\s*\(/.test(leadResearchToolService),
    'lead research host tools must use fixed immutable-event, existing-lead, public-search and source-snippet services',
  )
  requireCondition(
    /runPublicIntelIntakeAgents/.test(metaRoutes)
    && /screeningOutcome !== 'accept'/.test(metaRoutes)
    && /openLeadPipelineReview/.test(metaRoutes)
    && /runPublicIntelEnrichmentAgents/.test(metaRoutes)
    && /buildLeadResearchHostPackage/.test(leadOnlineWorkflowService)
    && /executeLeadWorkflowStage/.test(leadOnlineWorkflowService),
    'public-intel online routes must pass controlled host evidence through research, screening and enrichment stages',
  )
  requireCondition(
    /runRadarIntakeAgents/.test(leadOnlineWorkflowService)
    && /evaluateRadarIntakeWorkflow/.test(leadOnlineWorkflowService)
    && /transitionLeadPipelineItem/.test(leadOnlineWorkflowService)
    && /openLeadPipelineReview/.test(leadOnlineWorkflowService)
    && /evaluateRadarIntakeWorkflow/.test(metaRoutes)
    && /workflowResult\.status === 'failed'/.test(metaRoutes)
    && /workflowResult\.status !== 'accept'/.test(metaRoutes)
    && /RADAR_WORKFLOW_CONCURRENCY/.test(metaRoutes)
    && /providedPublicIntel:\s*radarCandidateResearchEvidence/.test(metaRoutes)
    && /\['discovered', 'failed'\]\.includes\(pipelineEvents\[index\]\.item\.status\)/.test(metaRoutes)
    && /currentPipelineStatus === 'ready'/.test(metaRoutes)
    && /currentPipelineStatus === 'review'/.test(metaRoutes)
    && /currentPipelineStatus === 'rejected'/.test(metaRoutes)
    && /publicSearchPerformed:\s*input\.providedPublicIntel \? false/.test(leadOnlineWorkflowService)
    && /radar-intake:attempt:\$\{attempt\}:v1/.test(leadOnlineWorkflowService)
    && /retry Radar research and screening with attempt/.test(leadOnlineWorkflowService)
    && /item\.status === 'failed'/.test(metaRoutes)
    && /commitRadarLeadPipelineReady/.test(metaRoutes),
    'Radar automatic intake must use bounded raw-evidence research and screening before the host can commit a formal lead',
  )
  for (const contract of [
    'host-toolset-reads-immutable-event-public-search-and-source-snippets',
    'online-intake-and-enrichment-use-scope-specific-research-runs',
    'online-stages-persist-versioned-runs-host-tool-counts-decisions-and-evidence',
    'radar-intake-uses-scope-specific-research-and-screening-audit-chain',
    'radar-screening-review-reject-invalid-schema-failure-and-audited-retry-never-bypass-formal-lead-host',
  ]) {
    requireCondition(leadOnlineWorkflowAcceptance.includes(contract), `lead online workflow acceptance is missing: ${contract}`)
  }
  requireCondition(
    packageJson.scripts?.['accept:lead-online-workflow']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/leadOnlineWorkflowAcceptance.ts',
    'lead online workflow acceptance entrypoint is missing',
  )
  const collectIntelUiSection = sourcingPage.slice(
    sourcingPage.indexOf('const collectIntel = async'),
    sourcingPage.indexOf('const parseFile'),
  )
  requireCondition(
    !/await addLead\(/.test(collectIntelUiSection)
    && /pipelineStatus === 'rejected'/.test(collectIntelUiSection)
    && /loadPendingReviews\(\)/.test(collectIntelUiSection),
    'public-intel UI must not duplicate the host-created lead and must surface review or rejection',
  )
  const scoringAgentSection = inProcessAiWorkflowService.slice(
    inProcessAiWorkflowService.indexOf('export async function scoreWithAgentDetailed'),
  )
  requireCondition(
    /runLeadScoringAgent/.test(scoringAgentSection)
    && !/gatewayText|gatewayJson|\/chat\/completions|\bfetch\s*\(/.test(scoringAgentSection)
    && /scoreWithAgentDetailed/.test(metaRoutes)
    && /scoreWithAgentDetailed\('score-project'/.test(projectScoringService)
    && /enqueueProjectScoreJob/.test(projectRoutesForScoring),
    'project and paper scoring must use the Agent SDK and must not use direct model HTTP',
  )
  requireCondition(
    /tools:\s*\[\]/.test(leadScoringAgentService)
    && /skills:\s*\[\]/.test(leadScoringAgentService)
    && /allowedTools:\s*\[\]/.test(leadScoringAgentService)
    && /permissionMode:\s*'dontAsk'/.test(leadScoringAgentService)
    && /settingSources:\s*\[\]/.test(leadScoringAgentService)
    && /mcpServers:\s*\{\}/.test(leadScoringAgentService)
    && /persistSession:\s*false/.test(leadScoringAgentService)
    && /behavior:\s*'deny'/.test(leadScoringAgentService),
    'lead scoring Agent must expose no tools, Skills, MCP, settings or persisted session and deny tool requests',
  )
  requireCondition(
    /sourceType:\s*'lead-scoring-input'/.test(leadScoringPipelineService)
    && /transitionLeadPipelineItem/.test(leadScoringPipelineService)
    && /leadId:\s*input\.leadId/.test(leadScoringPipelineService)
    && /recordLeadPipelineDecision/.test(scoringAgentSection)
    && /finishLeadPipelineRun/.test(scoringAgentSection),
    'lead scoring must bind immutable input snapshots to formal leads, Agent runs, decisions and evidence',
  )
  const projectScoringAuditSection = leadScoringPipelineService.slice(
    leadScoringPipelineService.indexOf('export async function prepareProjectScoringAuditContext'),
  )
  requireCondition(
    /sourceType:\s*'project-scoring-input'/.test(projectScoringAuditSection)
    && /projectId:\s*input\.projectId/.test(projectScoringAuditSection)
    && /inputEventId:\s*snapshot\.event\.id/.test(projectScoringAuditSection)
    && !/transitionLeadPipelineItem/.test(projectScoringAuditSection),
    'project scoring must retain an immutable audit input without entering the lead-only ready state',
  )
  for (const contract of [
    'scoring-agent-environment-excludes-database-secrets',
    'scoring-agent-runtime-tool-request-is-denied-and-fails-closed',
  ]) {
    requireCondition(leadScoringAgentAcceptance.includes(contract), `lead scoring Agent acceptance is missing: ${contract}`)
  }
  for (const contract of [
    'project-seven-dimension-score-is-host-normalized-from-standard',
    'paper-five-dimension-score-is-routed-without-company-financing-requirement',
    'successful-scoring-decisions-bind-point-of-decision-input-evidence',
    'project-scoring-input-is-immutable-without-entering-lead-only-ready-state',
  ]) {
    requireCondition(leadScoringAuditAcceptance.includes(contract), `lead scoring audit acceptance is missing: ${contract}`)
  }
  requireCondition(
    packageJson.scripts?.['accept:lead-scoring-agent']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/leadScoringAgentAcceptance.ts'
    && packageJson.scripts?.['accept:lead-scoring-audit']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/leadScoringAuditAcceptance.ts',
    'lead scoring Agent acceptance entrypoints are missing',
  )
  requireCondition(
    /parentDecisionId: review\.trigger_decision_id/.test(leadPipelineAuditService)
    && /prompt version is immutable/.test(leadPipelineAuditService)
    && /accepted lead pipeline decision requires a subject and evidence/.test(leadPipelineAuditService),
    'lead pipeline audit must append manual decisions and preserve version/evidence immutability',
  )
  for (const contract of [
    'agent-run-persists-runtime-token-duration-cost-zero-tools-and-status',
    'each-failed-model-attempt-persists-redacted-error-and-final-decision',
    'manual-resolution-appends-child-decision-and-preserves-agent-history',
    'published-prompt-contract-cannot-mutate-in-place',
    'pipeline-audit-foreign-key-reconciliation-has-no-orphans',
  ]) {
    requireCondition(leadPipelineAuditAcceptance.includes(contract), `lead pipeline audit acceptance is missing: ${contract}`)
  }
  requireCondition(
    /listLeadPipelineReviews/.test(metaRoutes)
    && /resolveAndCommitLeadPipelineReview/.test(metaRoutes)
    && /lead-pipeline\/reviews\/:id\/resolve/.test(metaRoutes)
    && /scoringQueued: false/.test(metaRoutes),
    'lead manual review API must list from MySQL, resolve through the host transaction and avoid automatic shared-pool scoring',
  )
  requireCondition(
    /beginTransaction\(\)/.test(leadPipelineReviewService)
    && /resolveLeadPipelineReview/.test(leadPipelineReviewService)
    && /transitionLeadPipelineItem/.test(leadPipelineReviewService)
    && /LEAD_REVIEW_EVIDENCE_NOT_IN_SOURCE/.test(leadPipelineReviewService)
    && /LEAD_REVIEW_TARGET_SUBJECT_MISMATCH/.test(leadPipelineReviewService)
    && /LEAD_REVIEW_TARGET_TERMINAL/.test(leadPipelineReviewService)
    && /LEAD_REVIEW_DUPLICATE_TARGET_REQUIRED/.test(leadPipelineReviewService)
    && /INSERT INTO \$\{leadsTable\}/.test(leadPipelineReviewService)
    && /INSERT INTO \$\{auditLogsTable\}/.test(leadPipelineReviewService),
    'manual review host must validate immutable evidence and atomically commit decision, lead, state and audit',
  )
  requireCondition(
    /线索类型/.test(sourcingPage)
    && /推荐理由 \/ 信号/.test(sourcingPage)
    && /更新时间/.test(sourcingPage)
    && !/线索人工复核|不可变原始材料|提交不可变结论|批量导入|上传 BP|从雷达同步/.test(sourcingPage)
    && !/\/lead-pipeline\/reviews|\/leads\/imports|\/leads\/bp-uploads|\/leads\/sync-radar/.test(sourcingPage),
    'Sourcing page must expose the shared pool discovery workflow while operational actions stay hidden',
  )
  for (const contract of [
    'assigned-review-visible-only-to-assignee-and-system-admin',
    'invalid-schema-or-evidence-rolls-back-review-and-formal-lead-write',
    'host-transaction-atomically-resolves-review-creates-lead-transitions-ready-and-audits',
    'manual-review-retry-is-idempotent-without-duplicate-lead-decision-or-audit',
    'manual-review-cannot-merge-into-a-different-subject',
    'manual-review-cannot-merge-into-a-terminal-converted-lead',
    'multiple-exact-subject-matches-require-explicit-human-target-with-full-rollback',
    'explicit-human-selection-merges-only-to-the-chosen-exact-subject-without-creating-a-third-lead',
    'manual-reject-preserves-history-without-creating-formal-lead',
  ]) {
    requireCondition(leadManualReviewAcceptance.includes(contract), `lead manual review acceptance is missing: ${contract}`)
  }
  requireCondition(
    packageJson.scripts?.['accept:lead-manual-review']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/leadPipelineManualReviewAcceptance.ts',
    'lead manual review acceptance entrypoint is missing',
  )
  requireCondition(
    /SELECT GET_LOCK\(\?, 60\)/.test(mysqlMigration)
    && /drizzle\(\{ client: connection \}\)/.test(mysqlMigration)
    && /SELECT RELEASE_LOCK\(\?\)/.test(mysqlMigration),
    'schema migrations must be serialized on the same dedicated MySQL connection',
  )

  const resourceIsolationAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/resourceIsolationAcceptance.ts'),
    'utf8',
  )
  const securityBoundaryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/securityBoundaryAcceptance.ts'),
    'utf8',
  )
  for (const contract of [
    'project-keyword-sql-injection-rejection',
    'project-owner-sql-injection-rejection',
    'project-route-sql-injection-rejection',
    'sql-injection-data-integrity',
    'database-error-response-disclosure-rejection',
    'database-failed-write-rollback',
    'malformed-json-response-disclosure-rejection',
    'filesystem-error-response-disclosure-rejection',
    'audit-log-create-mutation-rejection',
    'audit-log-update-mutation-rejection',
    'audit-log-delete-mutation-rejection',
    'audit-log-admin-delete-rejection',
    'audit-log-row-immutability',
    'high-risk-audit-actor-time-target-result-request-id',
    'workspace-traversal-rejection',
    'workspace-symlink-rejection',
    'workspace-absolute-path-rejection',
    'workspace-double-encoded-traversal-rejection',
    'generated-cross-user-rejection',
    'generated-symlink-rejection',
    'generated-traversal-arbitrary-read-rejection',
    'generated-absolute-path-rejection',
    'acceptance-knowledge-fixture-cleanup',
  ]) requireCondition(resourceIsolationAcceptance.includes(contract), `security HTTP acceptance is missing: ${contract}`)
  requireCondition(
    /db\.delete\(knowledgeChunks\)\.where\(inArray\(knowledgeChunks\.refId, projectIds\)\)/.test(resourceIsolationAcceptance),
    'security HTTP acceptance must remove asynchronously indexed file and meeting fixtures',
  )
  const productionAuditMutationFiles: string[] = []
  for (const file of activeFiles.filter((candidate) => /^server\/src\/(?:routes|services|runtime|middleware)\//.test(candidate))) {
    const source = await readFile(path.resolve(root, file), 'utf8')
    if (
      /(?:update|delete)\(auditLogs\)/.test(source)
      || /(?:UPDATE\s+|DELETE\s+FROM\s+)[^\n`]*audit_logs/i.test(source)
    ) productionAuditMutationFiles.push(file)
  }
  requireCondition(
    /metaRouter\.get\('\/audit-logs', requireSystemAdmin/.test(metaRoutes)
    && !/metaRouter\.(?:post|put|patch|delete)\('\/audit-logs/.test(metaRoutes)
    && productionAuditMutationFiles.length === 0,
    `audit logs must be admin-read-only and append-only in production runtime: ${productionAuditMutationFiles.join(', ')}`,
  )
  requireCondition(
    /identityRepositories\.users\.listSafe/.test(metaRoutes)
    && /identityRepositories\.users\.findById/.test(metaRoutes)
    && !/\busers\b/.test((metaRoutes.match(/from ['"]\.\.\/db\/schema\.js['"][^\n]*/g) || []).join('\n')),
    'system user list and status compatibility endpoint must use UserRepository',
  )
  requireCondition(
    /spawn\(process\.execPath/.test(securityBoundaryAcceptance)
    && /server-dist\/index\.js/.test(securityBoundaryAcceptance)
    && /RESOURCE_ACCEPTANCE_URL/.test(securityBoundaryAcceptance)
    && /NODE_ENV: 'production'/.test(securityBoundaryAcceptance)
    && /PROJECT_FILE_ROOT/.test(securityBoundaryAcceptance)
    && /AGENT_WORKSPACE/.test(securityBoundaryAcceptance)
    && /AI_SKILL_ROOT/.test(securityBoundaryAcceptance)
    && packageJson.scripts?.['accept:security-boundary']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/securityBoundaryAcceptance.ts'
    && releaseGatePolicyCovers('accept:security-boundary'),
    'production release must start the built unified service and prove SQL injection, path, authorization and arbitrary-read defenses over HTTP',
  )
  for (const category of ['company', 'project', 'team', 'lab', 'paper', 'noise', 'ambiguous']) {
    requireCondition(leadSubjectGold.includes(`"category": "${category}"`), `lead subject gold set is missing category: ${category}`)
  }
  requireCondition(
    /GOLD_SHA256/.test(leadSubjectGoldAcceptance)
    && /runLeadSubjectAgentBatch/.test(leadSubjectGoldAcceptance)
    && /validateRadarAiDecision/.test(leadSubjectGoldAcceptance)
    && /falseAcceptRate/.test(leadSubjectGoldAcceptance)
    && /averageCostUsd/.test(leadSubjectGoldAcceptance)
    && /usageComplete/.test(leadSubjectGoldAcceptance)
    && packageJson.scripts?.['accept:lead-subject-gold']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/leadSubjectGoldAcceptance.ts'
    && releaseGatePolicyCovers('accept:lead-subject-gold'),
    'production release must run the immutable live subject gold quality/cost gate',
  )
  for (const workflow of ['score-project', 'score-paper']) {
    requireCondition(leadScoringGold.includes(`"workflow": "${workflow}"`), `lead scoring gold set is missing workflow: ${workflow}`)
  }
  for (const quality of ['high', 'low']) {
    requireCondition(leadScoringGold.includes(`"quality": "${quality}"`), `lead scoring gold set is missing quality: ${quality}`)
  }
  requireCondition(
    /GOLD_SHA256/.test(leadScoringGoldAcceptance)
    && /scoreWithAgentDetailed/.test(leadScoringGoldAcceptance)
    && /rangeAccuracy/.test(leadScoringGoldAcceptance)
    && /orderingAccuracy/.test(leadScoringGoldAcceptance)
    && /meanAbsoluteMidpointDeviation/.test(leadScoringGoldAcceptance)
    && /averageCostUsd/.test(leadScoringGoldAcceptance)
    && /usageComplete/.test(leadScoringGoldAcceptance)
    && packageJson.scripts?.['accept:lead-scoring-gold']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/leadScoringGoldAcceptance.ts'
    && releaseGatePolicyCovers('accept:lead-scoring-gold'),
    'production release must run the immutable live project/paper scoring gold quality/cost gate',
  )
  for (const profile of ['lead-research-agent', 'lead-screening-agent', 'lead-enrichment-agent']) {
    requireCondition(leadWorkflowGold.includes(`"profile": "${profile}"`), `lead workflow gold set is missing profile: ${profile}`)
  }
  for (const category of ['verified-fact', 'conflict', 'accept', 'review', 'weak-source-review', 'safe-patch', 'no-overwrite']) {
    requireCondition(leadWorkflowGold.includes(`"category": "${category}"`), `lead workflow gold set is missing category: ${category}`)
  }
  requireCondition(
    /GOLD_SHA256/.test(leadWorkflowGoldAcceptance)
    && /runLeadWorkflowAgent/.test(leadWorkflowGoldAcceptance)
    && /contractAccuracy/.test(leadWorkflowGoldAcceptance)
    && /evidenceBindingAccuracy/.test(leadWorkflowGoldAcceptance)
    && /averageCostUsd/.test(leadWorkflowGoldAcceptance)
    && /usageComplete/.test(leadWorkflowGoldAcceptance)
    && packageJson.scripts?.['accept:lead-workflow-gold']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/leadWorkflowGoldAcceptance.ts'
    && releaseGatePolicyCovers('accept:lead-workflow-gold'),
    'production release must run the immutable live research/screening/enrichment gold quality/cost gate',
  )
  requireCondition(
    /GET_LOCK\(\?, 10\)/.test(leadAgentRuntimeGuardService)
    && /lead_agent_runtime_permits/.test(databaseSchemaForAgentGuard)
    && /LEAD_AGENT_GLOBAL_MAX_CONCURRENCY/.test(leadAgentRuntimeGuardService)
    && /LEAD_AGENT_GLOBAL_MAX_REQUESTS_PER_MINUTE/.test(leadAgentRuntimeGuardService)
    && /LEAD_AGENT_GLOBAL_DAILY_BUDGET_USD/.test(leadAgentRuntimeGuardService)
    && /LEAD_AGENT_CIRCUIT_FAILURE_THRESHOLD/.test(leadAgentRuntimeGuardService)
    && /WHERE agent_profile=\? AND state IN \('succeeded','failed'\)/.test(leadAgentRuntimeGuardService)
    && /permit_expired/.test(leadAgentRuntimeGuardService)
    && /acquireLeadAgentRuntimePermit/.test(leadSubjectAgentService)
    && /finishLeadAgentRuntimePermit/.test(leadSubjectAgentService)
    && /acquireLeadAgentRuntimePermit/.test(leadScoringAgentService)
    && /finishLeadAgentRuntimePermit/.test(leadScoringAgentService)
    && /acquireLeadAgentRuntimePermit/.test(leadWorkflowAgentService)
    && /finishLeadAgentRuntimePermit/.test(leadWorkflowAgentService),
    'all lead Agent profiles must share persistent MySQL concurrency/rate/budget guards while keeping circuit failures profile-scoped',
  )
  for (const contract of [
    'cross-profile-concurrency-is-limited-by-one-mysql-permit-pool',
    'cross-profile-minute-rate-is-persistently-limited',
    'actual-cost-plus-active-reservation-cannot-exceed-global-daily-budget',
    'cross-profile-failures-do-not-open-an-unrelated-profile-circuit',
    'consecutive-same-profile-failures-open-a-profile-scoped-circuit',
    'expired-permit-is-recovered-without-permanent-capacity-leak',
  ]) {
    requireCondition(leadAgentRuntimeGuardAcceptance.includes(contract), `lead Agent runtime guard acceptance is missing: ${contract}`)
  }
  requireCondition(
    packageJson.scripts?.['accept:lead-agent-runtime-guard']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/leadAgentRuntimeGuardAcceptance.ts'
    && releaseGatePolicyCovers('accept:lead-agent-runtime-guard')
    && /init_database\s*\n\s*run_release_gates/.test(deploy),
    'production release must migrate MySQL before persistent lead Agent runtime and live gold gates',
  )
  const serverEntry = await readFile(path.resolve(root, 'server/src/index.ts'), 'utf8')
  const aipinExclusionAudit = await readFile(path.resolve(root, 'server/src/scripts/aipinExclusionAudit.ts'), 'utf8')
  const migrationSourceAllowlistAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/migrationSourceAllowlistAcceptance.ts'), 'utf8',
  )
  const migrationBusinessInvariantAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/migrationBusinessInvariantAcceptance.ts'), 'utf8',
  )
  const migrationIdempotencyAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/migrationIdempotencyAcceptance.ts'), 'utf8',
  )
  const migrationChecklistStatusAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/migrationChecklistStatusAcceptance.ts'), 'utf8',
  )
  const orphanReadyPipelineRepair = await readFile(
    path.resolve(root, 'server/src/scripts/repairOrphanReadyPipelineItems.ts'), 'utf8',
  )
  const singleServiceRuntimeAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/singleServiceRuntimeAcceptance.ts'), 'utf8',
  )
  const migrationExecutionContractAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/migrationExecutionContractAcceptance.ts'), 'utf8',
  )
  const postgresCdcContract = await readFile(
    path.resolve(root, 'server/src/scripts/postgresCdcContract.ts'), 'utf8',
  )
  const postgresCdcInstaller = await readFile(
    path.resolve(root, 'server/src/scripts/installPostgresCdc.ts'), 'utf8',
  )
  const postgresCdcMigrator = await readFile(
    path.resolve(root, 'server/src/scripts/migratePostgresCdcToMySql.ts'), 'utf8',
  )
  const postgresCdcApplyService = await readFile(
    path.resolve(root, 'server/src/services/postgresCdcApplyService.ts'), 'utf8',
  )
  const postgresCdcAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/postgresCdcAcceptance.ts'), 'utf8',
  )
  const postgresCdcMigration = await readFile(
    path.resolve(root, 'server/drizzle/0029_add_postgres_cdc.sql'), 'utf8',
  )
  const migrationLegacyEvolution = await readFile(
    path.resolve(root, 'server/src/scripts/migrationLegacyEvolution.ts'), 'utf8',
  )
  const migrationReconciliationAudit = await readFile(path.resolve(root, 'server/src/scripts/mysqlMigrationReconciliationAudit.ts'), 'utf8')
  const postgresMigration = await readFile(path.resolve(root, 'server/src/scripts/migratePostgresToMySql.ts'), 'utf8')
  const postgresDumpMigration = await readFile(path.resolve(root, 'server/src/scripts/migratePostgresDumpToMySql.ts'), 'utf8')
  const postgresDumpReconciliationPolicy = await readFile(
    path.resolve(root, 'server/src/scripts/postgresDumpReconciliationPolicy.ts'), 'utf8',
  )
  const productionSourceInventory = await readFile(
    path.resolve(root, 'server/src/scripts/productionSourceInventory.ts'), 'utf8',
  )
  const productionSourceInventoryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/productionSourceInventoryAcceptance.ts'), 'utf8',
  )
  const flueMigration = await readFile(path.resolve(root, 'server/src/scripts/migrateFlueSqliteToMySql.ts'), 'utf8')
  const flueMigrationSmoke = await readFile(path.resolve(root, 'server/src/scripts/flueMigrationSmoke.ts'), 'utf8')
  const conversationMigrationContentAudit = await readFile(
    path.resolve(root, 'server/src/scripts/conversationMigrationContentAudit.ts'), 'utf8',
  )
  const jwSqliteMigration = await readFile(path.resolve(root, 'server/src/scripts/migrateJwSqliteToMySql.ts'), 'utf8')
  const jwSqliteMigrationAcceptance = await readFile(path.resolve(root, 'server/src/scripts/jwSqliteMigrationAcceptance.ts'), 'utf8')
  const orphanAiTaskConversationNormalization = await readFile(
    path.resolve(root, 'server/src/scripts/normalizeOrphanAiTaskConversations.ts'), 'utf8',
  )
  const legacyConversationScopeNormalization = await readFile(
    path.resolve(root, 'server/src/scripts/normalizeLegacyConversationScopes.ts'), 'utf8',
  )
  const missingLeadReserveDetailQuarantine = await readFile(
    path.resolve(root, 'server/src/scripts/quarantineMissingLeadReserveDetails.ts'), 'utf8',
  )
  const missingFileAssetQuarantine = await readFile(
    path.resolve(root, 'server/src/scripts/quarantineMissingFileAssets.ts'), 'utf8',
  )
  const missingProjectFileDisposition = await readFile(
    path.resolve(root, 'server/src/scripts/applyMissingProjectFileDispositions.ts'), 'utf8',
  )
  const missingProjectFileDecision = await readFile(
    path.resolve(root, 'server/migration/project-file-missing-dispositions-20260811.json'), 'utf8',
  )
  const quarantinedAiArtifactMetadataRepair = await readFile(
    path.resolve(root, 'server/src/scripts/repairQuarantinedAiArtifactMetadata.ts'), 'utf8',
  )
  const aiArtifactSourceDiscovery = await readFile(
    path.resolve(root, 'server/src/scripts/discoverAiArtifactSources.ts'), 'utf8',
  )
  const migrationEvidenceSafetyAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/migrationEvidenceSafetyAcceptance.ts'), 'utf8',
  )
  const migrationJsonSafety = await readFile(
    path.resolve(root, 'server/src/scripts/migrationJsonSafety.ts'), 'utf8',
  )
  const migrationJsonSafetyAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/migrationJsonSafetyAcceptance.ts'), 'utf8',
  )
  const migrationEntityMappingAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/migrationEntityMappingAcceptance.ts'), 'utf8',
  )
  const legacyScoringClassification = await readFile(
    path.resolve(root, 'server/src/scripts/classifyLegacyScoring.ts'), 'utf8',
  )
  const legacyScoringAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/legacyScoringAcceptance.ts'), 'utf8',
  )
  const migrationEntityMappingMigration = await readFile(
    path.resolve(root, 'server/drizzle/0028_add_migration_entity_mappings.sql'), 'utf8',
  )
  const runtimeSafety = await readFile(path.resolve(root, 'server/src/config/runtimeSafety.ts'), 'utf8')
  const migrationWriteFreezePolicy = await readFile(
    path.resolve(root, 'server/src/config/migrationWriteFreezePolicy.ts'), 'utf8',
  )
  const databaseClient = await readFile(path.resolve(root, 'server/src/db/client.ts'), 'utf8')
  const migrationWriteFreezeAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/migrationWriteFreezeAcceptance.ts'), 'utf8',
  )
  const migrationWriteFreezeEnv = await readFile(
    path.resolve(root, 'server/src/scripts/migrationWriteFreezeEnv.ts'), 'utf8',
  )
  const migrationWriteFreezeEnvAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/migrationWriteFreezeEnvAcceptance.ts'), 'utf8',
  )
  const cutoverRollbackThresholdAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/cutoverRollbackThresholdAcceptance.ts'), 'utf8',
  )
  const cutoverRollbackThresholds = JSON.parse(await readFile(
    path.resolve(root, 'server/migration/cutover-rollback-thresholds.v1.json'), 'utf8',
  )) as { domains?: Array<{ id?: string }>; globalRules?: Record<string, unknown> }
  const extensionFeatureFlags = await readFile(path.resolve(root, 'server/src/config/extensionFeatureFlags.ts'), 'utf8')
  const extensionFeatureFlagsAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/extensionFeatureFlagsAcceptance.ts'), 'utf8',
  )
  const architectureHandoff = await readFile(path.resolve(root, 'docs/项目架构与技术交接文档.md'), 'utf8')
  const readme = await readFile(path.resolve(root, 'README.md'), 'utf8')
  const singleServiceOperationsManual = await readFile(
    path.resolve(root, 'docs/迁移计划/单服务部署启动与故障手册-20260810.md'), 'utf8',
  )
  const mysqlSchemaErDocument = await readFile(
    path.resolve(root, 'docs/迁移计划/MySQL-Schema与ER说明-20260810.md'), 'utf8',
  )
  const stagedDeliverableEvidence = await readFile(
    path.resolve(root, 'docs/迁移计划/阶段性交付物实现证据索引-20260810.md'), 'utf8',
  )
  const postgresCdcCutoverManual = await readFile(
    path.resolve(root, 'docs/迁移计划/PostgreSQL增量CDC与切换手册.md'), 'utf8',
  )
  const adjacentDomainMigrationRetirementReport = await readFile(
    path.resolve(root, 'docs/迁移计划/附属业务域迁移与退场报告-20260810.md'), 'utf8',
  )
  const heterogeneousSourceMigrationReport = await readFile(
    path.resolve(root, 'docs/迁移计划/异构源数据迁移程序与执行报告-20260810.md'), 'utf8',
  )
  const jwAipinExclusionHandoff = await readFile(
    path.resolve(root, 'docs/迁移计划/JW迁移白名单与Aipin拒绝清单.md'), 'utf8',
  )
  const migrationExecutionChecklist = await readFile(
    path.resolve(root, 'docs/迁移计划/JW底座与MySQL迁移执行清单.md'), 'utf8',
  )
  const migrationAcceptanceChecklist = await readFile(
    path.resolve(root, 'docs/迁移计划/JW底座与MySQL迁移验收清单.md'), 'utf8',
  )
  const aiMessageSafety = await readFile(path.resolve(root, 'src/lib/aiMessageSafety.ts'), 'utf8')
  const leadResearchTools = await readFile(path.resolve(root, 'server/src/services/leadResearchToolService.ts'), 'utf8')
  const drizzleMigrationFiles = (await readdir(path.resolve(root, 'server/drizzle')))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort()
  const jwConversationRolloutPolicy = await readFile(
    path.resolve(root, 'server/src/config/jwConversationRolloutPolicy.ts'), 'utf8',
  )
  const jwConversationRolloutAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/jwConversationRolloutAcceptance.ts'), 'utf8',
  )
  const authService = await readFile(path.resolve(root, 'server/src/services/authService.ts'), 'utf8')
  const sessionAuthService = await readFile(path.resolve(root, 'server/src/services/sessionAuthService.ts'), 'utf8')
  const authSessionPolicy = await readFile(path.resolve(root, 'server/src/config/authSessionPolicy.ts'), 'utf8')
  const authSessionPolicyAcceptance = await readFile(path.resolve(root, 'server/src/scripts/authSessionPolicyAcceptance.ts'), 'utf8')
  const authSessionKeyTelemetry = await readFile(
    path.resolve(root, 'server/src/runtime/authSessionKeyTelemetry.ts'), 'utf8',
  )
  const authSessionKeyTelemetryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/authSessionKeyRotationTelemetryAcceptance.ts'), 'utf8',
  )
  const legacyBearerPolicy = await readFile(path.resolve(root, 'server/src/config/legacyBearerPolicy.ts'), 'utf8')
  const legacyBearerPolicyAcceptance = await readFile(path.resolve(root, 'server/src/scripts/legacyBearerPolicyAcceptance.ts'), 'utf8')
  const legacyBearerHttpSocketAcceptance = await readFile(path.resolve(root, 'server/src/scripts/legacyBearerHttpSocketAcceptance.ts'), 'utf8')
  const legacyBearerInvalidation = await readFile(path.resolve(root, 'server/src/scripts/invalidateLegacyBearerTokens.ts'), 'utf8')
  const legacyBearerMigration = await readFile(path.resolve(root, 'server/drizzle/0032_add_legacy_bearer_kill_switch.sql'), 'utf8')
  const errorHandler = await readFile(path.resolve(root, 'server/src/middleware/errorHandler.ts'), 'utf8')
  const structuredLogger = await readFile(path.resolve(root, 'server/src/runtime/structuredLogger.ts'), 'utf8')
  const mysqlClient = await readFile(path.resolve(root, 'server/src/db/client.ts'), 'utf8')
  const serverShanghaiTime = await readFile(path.resolve(root, 'server/src/utils/shanghaiTime.ts'), 'utf8')
  const clientShanghaiTime = await readFile(path.resolve(root, 'src/lib/dateTime.ts'), 'utf8')
  const timezoneAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/timezoneAcceptance.ts'), 'utf8',
  )
  const migrationScalarConstraintAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/migrationScalarConstraintAcceptance.ts'), 'utf8',
  )
  const stablePaginationAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/stablePaginationAcceptance.ts'), 'utf8',
  )
  const mysqlResilienceAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/mysqlResilienceAcceptance.ts'),
    'utf8',
  )
  const mysqlOperationalConfigAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/mysqlOperationalConfigAcceptance.ts'),
    'utf8',
  )
  const ragService = await readFile(path.resolve(root, 'server/src/services/ragService.ts'), 'utf8')
  const chineseRetrievalAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/chineseRetrievalAcceptance.ts'),
    'utf8',
  )
  const knowledgeIngestionAtomicityAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/knowledgeIngestionAtomicityAcceptance.ts'),
    'utf8',
  )
  const knowledgeSourceChunkMigration = await readFile(
    path.resolve(root, 'server/drizzle/0030_add_knowledge_source_chunk_unique.sql'),
    'utf8',
  )
  const leadPipelineEntityMatchMigration = await readFile(
    path.resolve(root, 'server/drizzle/0031_add_lead_pipeline_entity_matches.sql'),
    'utf8',
  )
  const projectRoutes = await readFile(path.resolve(root, 'server/src/routes/projects.ts'), 'utf8')
  const workspaceRoutes = await readFile(path.resolve(root, 'server/src/routes/workspace.ts'), 'utf8')
  const projectFileValidation = await readFile(path.resolve(root, 'server/src/security/projectFileValidation.ts'), 'utf8')
  const projectFileStorage = await readFile(path.resolve(root, 'server/src/services/projectFileStorageService.ts'), 'utf8')
  const projectFileTempCleanupAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/projectFileTempCleanupAcceptance.ts'),
    'utf8',
  )
  const projectFileDeletionIsolationAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/projectFileDeletionIsolationAcceptance.ts'),
    'utf8',
  )
  const migrationFixtureReadinessAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/migrationFixtureReadinessAcceptance.ts'),
    'utf8',
  )
  const migrationTestDataSafetyAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/migrationTestDataSafetyAcceptance.ts'),
    'utf8',
  )
  const aiTaskApiAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/aiTaskApiAcceptance.ts'),
    'utf8',
  )
  const socketAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/socketAcceptance.ts'),
    'utf8',
  )
  const jwMultiTurnLiveAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/jwMultiTurnLiveAcceptance.ts'),
    'utf8',
  )
  const jwUsageCompactionAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/jwUsageCompactionAcceptance.ts'),
    'utf8',
  )
  const jwInteractionAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/jwInteractionAcceptance.ts'),
    'utf8',
  )
  const jwInteractionLiveAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/jwInteractionLiveAcceptance.ts'),
    'utf8',
  )
  const jwMessageRenderingAcceptance = await readFile(
    path.resolve(root, 'server/scripts/jwMessageRenderingAcceptance.tsx'),
    'utf8',
  )
  const jwToolLifecycleAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/jwToolLifecycleAcceptance.ts'),
    'utf8',
  )
  const jwModelSwitchAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/jwModelSwitchAcceptance.ts'),
    'utf8',
  )
  const agentSocketService = await readFile(
    path.resolve(root, 'server/src/runtime/agentSocketService.ts'),
    'utf8',
  )
  const errorContractAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/errorContractAcceptance.ts'),
    'utf8',
  )
  const apiErrorContract = await readFile(
    path.resolve(root, 'server/src/contracts/apiErrorContract.ts'),
    'utf8',
  )
  const clientApi = await readFile(path.resolve(root, 'src/lib/api.ts'), 'utf8')
  const conversationRoutes = await readFile(path.resolve(root, 'server/src/routes/conversations.ts'), 'utf8')
  const projectService = await readFile(path.resolve(root, 'server/src/services/projectService.ts'), 'utf8')
  const databaseSchema = await readFile(path.resolve(root, 'server/src/db/schema.ts'), 'utf8')
  const auditRequestResultMigration = await readFile(path.resolve(root, 'server/drizzle/0027_add_audit_request_result.sql'), 'utf8')
  const aiModelMigration = await readFile(path.resolve(root, 'server/drizzle/0025_add_ai_model_settings.sql'), 'utf8')
  const aiModelCredentialCrypto = await readFile(path.resolve(root, 'server/src/security/modelCredentialCrypto.ts'), 'utf8')
  const aiModelSettingsService = await readFile(path.resolve(root, 'server/src/services/aiModelSettingsService.ts'), 'utf8')
  const aiModelSettingsRoutes = await readFile(path.resolve(root, 'server/src/routes/aiModelSettings.ts'), 'utf8')
  const routeIndex = await readFile(path.resolve(root, 'server/src/routes/index.ts'), 'utf8')
  const operationsRoutes = await readFile(path.resolve(root, 'server/src/routes/operations.ts'), 'utf8')
  const httpTelemetry = await readFile(path.resolve(root, 'server/src/runtime/httpTelemetry.ts'), 'utf8')
  const operationalTelemetryService = await readFile(
    path.resolve(root, 'server/src/services/operationalTelemetryService.ts'),
    'utf8',
  )
  const aiRuntimeTelemetry = await readFile(
    path.resolve(root, 'server/src/runtime/aiRuntimeTelemetry.ts'),
    'utf8',
  )
  const aiRuntimeTelemetryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/aiRuntimeTelemetryAcceptance.ts'),
    'utf8',
  )
  const documentNativeRuntimeTelemetry = await readFile(
    path.resolve(root, 'server/src/services/documentNativeRuntimeTelemetryService.ts'),
    'utf8',
  )
  const documentRuntimeDependencyManifest = await readFile(
    path.resolve(root, 'server/document-runtime-dependencies.json'),
    'utf8',
  )
  const documentRuntimePythonLock = await readFile(
    path.resolve(root, 'server/requirements-pdf-to-ppt.lock.txt'),
    'utf8',
  )
  const documentRuntimeDependencyVerifier = await readFile(
    path.resolve(root, 'server/src/scripts/verifyDocumentRuntimeDependencies.ts'),
    'utf8',
  )
  const documentRuntimeSetup = await readFile(
    path.resolve(root, 'server/scripts/setup-pdf-to-ppt-runtime.mjs'),
    'utf8',
  )
  const fileStorageCapacityTelemetry = await readFile(
    path.resolve(root, 'server/src/services/fileStorageCapacityTelemetryService.ts'),
    'utf8',
  )
  const fileStorageCapacityHistoryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/fileStorageCapacityHistoryAcceptance.ts'),
    'utf8',
  )
  const operationalTelemetryRepository = await readFile(
    path.resolve(root, 'server/src/repositories/mysql/mysqlOperationalTelemetryRepository.ts'),
    'utf8',
  )
  const operationalTelemetryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/operationalTelemetryAcceptance.ts'),
    'utf8',
  )
  const migrationReadinessTelemetry = await readFile(
    path.resolve(root, 'server/src/services/migrationReadinessTelemetryService.ts'),
    'utf8',
  )
  const operationsOverview = await readFile(
    path.resolve(root, 'src/components/OperationsOverview.tsx'),
    'utf8',
  )
  const fileAssetInventory = await readFile(
    path.resolve(root, 'server/src/scripts/fileAssetInventory.ts'),
    'utf8',
  )
  const quarantineAiTemplateAcceptanceFixtures = await readFile(
    path.resolve(root, 'server/src/scripts/quarantineAiTemplateAcceptanceFixtures.ts'),
    'utf8',
  )
  const quarantineResourceAcceptanceArtifacts = await readFile(
    path.resolve(root, 'server/src/scripts/quarantineResourceAcceptanceArtifacts.ts'),
    'utf8',
  )
  const quarantineOrphanAgentWorkspaces = await readFile(
    path.resolve(root, 'server/src/scripts/quarantineOrphanAgentWorkspaces.ts'),
    'utf8',
  )
  const agentWorkspaceLifecycleService = await readFile(
    path.resolve(root, 'server/src/services/agentWorkspaceLifecycleService.ts'),
    'utf8',
  )
  const agentWorkspaceLifecycleAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/agentWorkspaceLifecycleAcceptance.ts'),
    'utf8',
  )
  const browserUiAcceptanceFixture = await readFile(
    path.resolve(root, 'server/src/scripts/browserUiAcceptanceFixture.ts'),
    'utf8',
  )
  const mysqlServerTelemetryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/mysqlServerTelemetryAcceptance.ts'),
    'utf8',
  )
  const leadReviewTelemetryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadReviewTelemetryAcceptance.ts'),
    'utf8',
  )
  const leadDuplicateTelemetryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/leadDuplicateTelemetryAcceptance.ts'),
    'utf8',
  )
  const supervisedProcessService = await readFile(
    path.resolve(root, 'server/src/runtime/supervisedProcessService.ts'),
    'utf8',
  )
  const supervisedProcessTelemetry = await readFile(
    path.resolve(root, 'server/src/runtime/supervisedProcessTelemetry.ts'),
    'utf8',
  )
  const supervisedProcessAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/supervisedProcessAcceptance.ts'),
    'utf8',
  )
  const supervisedProcessTelemetryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/supervisedProcessTelemetryAcceptance.ts'),
    'utf8',
  )
  const jobCoordinationTelemetry = await readFile(
    path.resolve(root, 'server/src/runtime/jobCoordinationTelemetry.ts'),
    'utf8',
  )
  const jobCoordinationTelemetryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/jobCoordinationTelemetryAcceptance.ts'),
    'utf8',
  )
  const operationalAlertPolicy = await readFile(
    path.resolve(root, 'server/src/config/operationalAlertPolicy.ts'),
    'utf8',
  )
  const operationalAlertDeliveryService = await readFile(
    path.resolve(root, 'server/src/services/operationalAlertDeliveryService.ts'),
    'utf8',
  )
  const operationalAlertDeliveryAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/operationalAlertDeliveryAcceptance.ts'),
    'utf8',
  )
  const operationalTelemetryHandoff = await readFile(
    path.resolve(root, 'docs/迁移计划/单服务运维指标与告警手册-20260811.md'),
    'utf8',
  )
  const documentRuntimeDependencyHandoff = await readFile(
    path.resolve(root, 'docs/迁移计划/文档原生运行时依赖锁定手册-20260811.md'),
    'utf8',
  )
  const jwAgentRoutes = await readFile(path.resolve(root, 'server/src/routes/jwAgent.ts'), 'utf8')
  const aiModelSettingsAcceptance = await readFile(path.resolve(root, 'server/src/scripts/aiModelSettingsAcceptance.ts'), 'utf8')
  const modelSettingsPage = await readFile(path.resolve(root, 'src/pages/ModelSettingsPage.tsx'), 'utf8')
  const aiCapabilityMigration = await readFile(path.resolve(root, 'server/drizzle/0026_add_ai_capability_management.sql'), 'utf8')
  const aiCapabilityService = await readFile(path.resolve(root, 'server/src/services/aiCapabilityService.ts'), 'utf8')
  const aiCapabilityRoutes = await readFile(path.resolve(root, 'server/src/routes/aiCapabilities.ts'), 'utf8')
  const aiCapabilityAcceptance = await readFile(path.resolve(root, 'server/src/scripts/aiCapabilityAcceptance.ts'), 'utf8')
  const capabilitySettingsPage = await readFile(path.resolve(root, 'src/pages/CapabilitySettingsPage.tsx'), 'utf8')
  const imIntegrationMigration = await readFile(path.resolve(root, 'server/drizzle/0033_add_im_integrations.sql'), 'utf8')
  const imLeadPushRuleMigration = await readFile(path.resolve(root, 'server/drizzle/0034_add_im_lead_push_rules.sql'), 'utf8')
  const imIntegrationCrypto = await readFile(path.resolve(root, 'server/src/security/integrationCredentialCrypto.ts'), 'utf8')
  const imIntegrationService = await readFile(path.resolve(root, 'server/src/services/imIntegrationService.ts'), 'utf8')
  const imIntegrationRoutes = await readFile(path.resolve(root, 'server/src/routes/imIntegrations.ts'), 'utf8')
  const leadPushTargetsRoutes = await readFile(path.resolve(root, 'server/src/routes/leadPushTargets.ts'), 'utf8')
  const imIntegrationAcceptance = await readFile(path.resolve(root, 'server/src/scripts/imIntegrationAcceptance.ts'), 'utf8')
  const imBotsPage = await readFile(path.resolve(root, 'src/pages/ImBotsPage.tsx'), 'utf8')
  const mysqlBackupRestoreAcceptance = await readFile(path.resolve(root, 'server/src/scripts/mysqlBackupRestoreAcceptance.ts'), 'utf8')
  const aiAssistantPage = await readFile(path.resolve(root, 'src/pages/AIAssistantPage.tsx'), 'utf8')
  const jwAgentHook = await readFile(path.resolve(root, 'src/hooks/useJwAgent.ts'), 'utf8')
  const conversationService = await readFile(path.resolve(root, 'server/src/services/conversationService.ts'), 'utf8')
  requireCondition(/safeErrorLog\(error\)/.test(errorHandler), '500 logs must use centralized secret redaction')
  requireCondition(
    /targetTextColumnsScanned/.test(aipinExclusionAudit)
    && /reviewedSourceConversationsRejected/.test(aipinExclusionAudit)
    && /targetRowsWrittenFromExcludedSource/.test(aipinExclusionAudit)
    && /AIPIN_SOURCE_REJECTED/.test(aipinExclusionAudit)
    && /JW_BACKUP_MISSING_OR_CHANGED/.test(aipinExclusionAudit)
    && packageJson.scripts?.['check:aipin-exclusion']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/aipinExclusionAudit.ts --strict'
    && /postgres-online-and-dump-importers-read-only-explicit-table-allowlists/.test(migrationSourceAllowlistAcceptance)
    && /checksum-bound-dump-has-no-aipin-table-or-record-identity/.test(migrationSourceAllowlistAcceptance)
    && /flue-aipin-path-is-rejected-and-reported-without-target-write/.test(migrationSourceAllowlistAcceptance)
    && /flue-aipin-table-is-rejected-and-reported-without-target-write/.test(migrationSourceAllowlistAcceptance)
    && packageJson.scripts?.['accept:migration-source-allowlist']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/migrationSourceAllowlistAcceptance.ts'
    && /aipinExclusionAudit\.ts/.test(migrationSourceAllowlistAcceptance)
    && /--strict/.test(migrationSourceAllowlistAcceptance)
    && releaseGatePolicyCovers('accept:migration-source-allowlist'),
    'Aipin source/code/environment/target exclusion report and strict command are missing',
  )
  requireCondition(
    /const APPROVED_CONVERSATION_SOURCES = \[\] as const/.test(jwSqliteMigration)
    && /const REJECTED_CONVERSATION_SOURCES = \['aipin-data-processing'\] as const/.test(jwSqliteMigration)
    && /JW_SOURCE_CHECKSUM_CHANGED/.test(jwSqliteMigration)
    && /JW_UNREVIEWED_SOURCE_PRESENT/.test(jwSqliteMigration)
    && /JW_REJECTED_SOURCE_EXCLUDED/.test(jwSqliteMigration)
    && /targetBusinessRowsChanged: 0/.test(jwSqliteMigration)
    && /repeatedApplyIdempotent: true/.test(jwSqliteMigrationAcceptance)
    && /strictExcludedSourceAudit: true/.test(jwSqliteMigrationAcceptance)
    && packageJson.scripts?.['migrate:jw-sqlite:preview']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/migrateJwSqliteToMySql.ts'
    && packageJson.scripts?.['migrate:jw-sqlite']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/migrateJwSqliteToMySql.ts --apply'
    && packageJson.scripts?.['accept:jw-sqlite-migration']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/jwSqliteMigrationAcceptance.ts'
    && releaseGatePolicyCovers('accept:jw-sqlite-migration'),
    'JW SQLite checksum-bound allowlist migration and zero-write exclusion gate are missing',
  )
  requireCondition(
    /targetStructuralIntegrityReady/.test(migrationReconciliationAudit)
    && /sourceReconciliationReady/.test(migrationReconciliationAudit)
    && /dumpPostgresReconciliationReady/.test(migrationReconciliationAudit)
    && /flueReconciliationReady/.test(migrationReconciliationAudit)
    && /jwExclusionReady/.test(migrationReconciliationAudit)
    && /productionSourceInventoryReady/.test(migrationReconciliationAudit)
    && /PRODUCTION_SOURCE_INVENTORY_NOT_APPROVED/.test(migrationReconciliationAudit)
    && /INVARIANT_\$\{item\.id\.replaceAll/.test(migrationReconciliationAudit)
    && /当前阻断与下一动作/.test(migrationReconciliationAudit)
    && /ownerRole/.test(migrationReconciliationAudit)
    && /production-source-inventory\/report\.json/.test(migrationReconciliationAudit)
    && /approvedBy/.test(migrationReconciliationAudit)
    && /perTableReadWriteSkipFailComplete/.test(migrationReconciliationAudit)
    && /BEGIN READ ONLY/.test(migrationReconciliationAudit)
    && /mysqlTableName\('migration_runs'\)/.test(postgresMigration)
    && /readRows/.test(postgresMigration)
    && /writtenRows/.test(postgresMigration)
    && /skippedRows/.test(postgresMigration)
    && /failedRows/.test(postgresMigration)
    && /mysqlTableName\('migration_runs'\)/.test(postgresDumpMigration)
    && /'postgres-dump'/.test(postgresDumpMigration)
    && /readRows/.test(postgresDumpMigration)
    && /writtenRows/.test(postgresDumpMigration)
    && /skippedRows/.test(postgresDumpMigration)
    && /failedRows/.test(postgresDumpMigration)
    && /writeDefaultEvidence/.test(flueMigration)
    && /migration-evidence\/flue-sources/.test(flueMigration)
    && packageJson.scripts?.['check:migration-integrity']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/mysqlMigrationReconciliationAudit.ts --strict-target'
    && packageJson.scripts?.['check:migration-reconciliation']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/mysqlMigrationReconciliationAudit.ts --strict-full'
    && releaseGatePolicyCovers('check:migration-integrity'),
    'production release must preserve the read-only target integrity and full source reconciliation contracts',
  )
  requireCondition(
    /ORDER BY created_at,sequence,id/.test(flueMigration)
    && /INSERT INTO \$\{table\('chat_conversations'\)\}/.test(flueMigration)
    && /Target conversation index\/agent pair verification failed/.test(flueMigration)
    && /target\.externalSessionId\.length <= 64/.test(flueMigration)
    && /Never truncate an external identity/.test(flueMigration)
    && /sourceTargetContentChecksumsEqual: true/.test(flueMigrationSmoke)
    && /contentChecksumStableAcrossRepeatedApply: true/.test(flueMigrationSmoke)
    && /messageSequenceVerified: true/.test(flueMigrationSmoke)
    && /visibleTextVerified: true/.test(flueMigrationSmoke)
    && /messagePartOrderAndTypesVerified: true/.test(flueMigrationSmoke)
    && /chatIndexVisibleVerified: true/.test(flueMigrationSmoke)
    && /chatAgentPairCoherent: true/.test(flueMigrationSmoke)
    && /generatedChildChatIndexVerified: true/.test(flueMigrationSmoke)
    && /Seed only the normalized agent half/.test(flueMigrationSmoke)
    && /attachmentReferenceAndDigestVerified: true/.test(flueMigrationSmoke)
    && /toolInputOutputVerified: true/.test(flueMigrationSmoke)
    && /interruptedStateVerified: true/.test(flueMigrationSmoke)
    && /migration-evidence\/flue-content-verification/.test(flueMigrationSmoke)
    && /DELETE m FROM \$\{table\('migration_entity_mappings'\)\} m/.test(flueMigrationSmoke)
    && /m\.source_system='flue'/.test(flueMigrationSmoke)
    && packageJson.scripts?.['check:flue-migration']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/flueMigrationSmoke.ts'
    && releaseGatePolicyCovers('check:flue-migration'),
    'Flue content migration must atomically restore the visible chat index and verify order, text, Part, attachment, tool and interrupted state',
  )
  requireCondition(
    /messageSequenceViolations/.test(conversationMigrationContentAudit)
    && /partSequenceViolations/.test(conversationMigrationContentAudit)
    && /activeMigratedConversations/.test(conversationMigrationContentAudit)
    && /taskConversationBindingViolations/.test(conversationMigrationContentAudit)
    && /crossSourceMergedConversations/.test(conversationMigrationContentAudit)
    && /targetContentSha256/.test(conversationMigrationContentAudit)
    && /productionContentReconciliationReady/.test(conversationMigrationContentAudit)
    && /productionInventory\?\.environment === 'production'/.test(conversationMigrationContentAudit)
    && /reportContainsMessageBody: false/.test(conversationMigrationContentAudit)
    && /reportContainsConversationOrMessageId: false/.test(conversationMigrationContentAudit)
    && /reportContainsSourcePath: false/.test(conversationMigrationContentAudit)
    && /databaseWrites: 0/.test(conversationMigrationContentAudit)
    && packageJson.scripts?.['audit:conversation-migration-content']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/conversationMigrationContentAudit.ts'
    && packageJson.scripts?.['audit:conversation-migration-content:strict']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/conversationMigrationContentAudit.ts --strict-production'
    && releaseGatePolicyCovers('audit:conversation-migration-content'),
    'conversation migration must reconcile visible indexes, message/Part order, source dispositions, cross-source mappings and production approval without persisting content',
  )
  requireCondition(
    /checksum-bound-dump-has-normalized-source-and-target-hash-per-table/.test(migrationBusinessInvariantAcceptance)
    && /all-target-tables-have-normalized-key-checksums/.test(migrationBusinessInvariantAcceptance)
    && /all-mysql-foreign-keys-have-zero-orphans/.test(migrationBusinessInvariantAcceptance)
    && /target-cross-table-business-invariants-exclude-only-explicit-source-asset-gaps/.test(migrationBusinessInvariantAcceptance)
    && /lead-project-ai-runtime-oa-state-machines-are-coherent/.test(migrationBusinessInvariantAcceptance)
    && /mysqlMigrationReconciliationAudit\.ts/.test(migrationBusinessInvariantAcceptance)
    && /--strict-target/.test(migrationBusinessInvariantAcceptance)
    && /source_sha256=\?/.test(migrationBusinessInvariantAcceptance)
    && packageJson.scripts?.['accept:migration-business-invariants']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/migrationBusinessInvariantAcceptance.ts'
    && releaseGatePolicyCovers('accept:migration-business-invariants'),
    'normalized migration checksums, orphan checks and state/cross-table invariants require a checksum-bound release gate',
  )
  requireCondition(
    /active-prefix-consistent-backup-restored-to-isolated-prefix/.test(migrationIdempotencyAcceptance)
    && /DB_FREFIX: targetPrefix/.test(migrationIdempotencyAcceptance)
    && /activePrefixWrites: 0/.test(migrationIdempotencyAcceptance)
    && /isolated-prefix-cleanup-verified/.test(migrationIdempotencyAcceptance)
    && packageJson.scripts?.['accept:migration-idempotency']
      === 'node --env-file-if-exists=.env --env-file-if-exists=.runtime/secrets/mysql-migration.env --import tsx server/src/scripts/migrationIdempotencyAcceptance.ts',
    'migration idempotency must be proven on a disposable isolated prefix without racing or mutating the active runtime prefix',
  )
  requireCondition(
    /derived pending document is stale/.test(migrationChecklistStatusAcceptance)
    && /completedIdsStillListed/.test(migrationChecklistStatusAcceptance)
    && /mismatchedStatuses/.test(migrationChecklistStatusAcceptance)
    && /every pending core item must state current evidence or an explicit blocker/.test(migrationChecklistStatusAcceptance)
    && /databaseWrites: 0/.test(migrationChecklistStatusAcceptance)
    && packageJson.scripts?.['check:migration-checklist-status']
      === 'node --import tsx server/src/scripts/migrationChecklistStatusAcceptance.ts'
    && packageJson.scripts?.['check:platform']?.includes('npm run check:migration-checklist-status')
    && releaseGatePolicyCovers('check:migration-checklist-status'),
    'the derived pending-migration document must stay synchronized with every checklist completion and priority count',
  )
  requireCondition(
    /fromStatus: 'ready'/.test(orphanReadyPipelineRepair)
    && /toStatus: 'review'/.test(orphanReadyPipelineRepair)
    && /fromStatus: 'review'/.test(orphanReadyPipelineRepair)
    && /toStatus: 'rejected'/.test(orphanReadyPipelineRepair)
    && /physicalDeletes: 0/.test(orphanReadyPipelineRepair)
    && /migrationIssues/.test(orphanReadyPipelineRepair)
    && /migrationRuns/.test(orphanReadyPipelineRepair)
    && /auditLogs/.test(orphanReadyPipelineRepair)
    && packageJson.scripts?.['repair:orphan-ready-pipeline:preview']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/repairOrphanReadyPipelineItems.ts'
    && packageJson.scripts?.['repair:orphan-ready-pipeline']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/repairOrphanReadyPipelineItems.ts --apply',
    'orphan ready pipeline repair must be previewable, preserve evidence, follow valid transitions and perform zero physical deletes',
  )
  requireCondition(
    /process\.argv\.includes\('--observe-existing'\)/.test(singleServiceRuntimeAcceptance)
    && /execFileAsync\('lsof'/.test(singleServiceRuntimeAcceptance)
    && /mode: 'observe-existing'/.test(singleServiceRuntimeAcceptance)
    && /processMutation: false/.test(singleServiceRuntimeAcceptance)
    && packageJson.scripts?.['accept:single-service-runtime:observe']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/singleServiceRuntimeAcceptance.ts --observe-existing',
    'single-service acceptance must support a read-only observation mode for an already-running 4100 service without process mutation',
  )
  requireCondition(
    /--reconcile-existing/.test(postgresDumpMigration)
    && /postgres-dump-baseline-reconciliation/.test(postgresDumpMigration)
    && /SET TRANSACTION ISOLATION LEVEL REPEATABLE READ/.test(postgresDumpMigration)
    && /writtenRows/.test(postgresDumpMigration)
    && /skippedRows/.test(postgresDumpMigration)
    && /source_checksum=\? AND target_checksum=\?/.test(postgresDumpMigration)
    && /evaluateDumpTargetEvolution/.test(postgresDumpMigration)
    && /sourceMissingInTarget === 0/.test(postgresDumpReconciliationPolicy)
    && /sourceOrphanNormalizationReady/.test(postgresDumpReconciliationPolicy)
    && /missingFileAssetQuarantineReady/.test(postgresDumpReconciliationPolicy)
    && /missing-file-asset-quarantine/.test(postgresDumpMigration)
    && /legacy-conversation-scope-normalization/.test(postgresDumpMigration)
    && /chat_conversations/.test(postgresDumpReconciliationPolicy)
    && /legacyConversationScopeNormalizationReady/.test(postgresDumpReconciliationPolicy)
    && /missingFileAssetQuarantineReady/.test(migrationReconciliationAudit)
    && packageJson.scripts?.['migrate:dump:reconcile-existing']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/migratePostgresDumpToMySql.ts --reconcile-existing',
    'existing MySQL baseline adoption must be checksum-locked, read-only for business rows, idempotent, and preserve approved target evolution',
  )
  requireCondition(
    /--checkpointed-apply/.test(postgresDumpMigration)
    && /GET_LOCK/.test(postgresDumpMigration)
    && /completedCheckpointTables/.test(postgresDumpMigration)
    && /status='running'/.test(postgresDumpMigration)
    && /status='succeeded'/.test(postgresDumpMigration)
    && /MIGRATION_TEST_FAIL_AT_TABLE is restricted to isolated acceptance databases/.test(postgresDumpMigration)
    && /audit_logs\.request_id/.test(migrationLegacyEvolution)
    && /legacySyntheticColumnValue/.test(postgresMigration)
    && /legacySyntheticColumnValue/.test(postgresDumpMigration)
    && /persistentCheckpointResumeImplemented:\s*true/.test(migrationExecutionContractAcceptance)
    && /checkpointRunIdsAddedOnResume:\s*0/.test(migrationExecutionContractAcceptance)
    && packageJson.scripts?.['migrate:dump:checkpointed']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/migratePostgresDumpToMySql.ts --checkpointed-apply'
    && packageJson.scripts?.['accept:migration-execution-contract']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/migrationExecutionContractAcceptance.ts',
    'dump migration must provide a locked, persistent MySQL checkpoint/resume mode and deterministic legacy schema evolution',
  )
  requireCondition(
    /AFTER INSERT OR UPDATE OR DELETE/.test(postgresCdcContract)
    && /pg_trigger_depth\(\) > 1/.test(postgresCdcContract)
    && /txid_current\(\)/.test(postgresCdcContract)
    && /actor/.test(postgresCdcContract)
    && /migration_batch/.test(postgresCdcContract)
    && /tombstone/.test(postgresCdcContract)
    && /capture_config/.test(postgresCdcInstaller)
    && /PG_CDC_AUTHORITY_MODE=legacy-postgres-authoritative/.test(postgresCdcMigrator)
    && /txid_snapshot_xmin\(txid_current_snapshot\(\)\)/.test(postgresCdcMigrator)
    && /unsafeOpenTransactionEvents/.test(postgresCdcMigrator)
    && /GET_LOCK/.test(postgresCdcMigrator)
    && /eventComponents/.test(postgresCdcApplyService)
    && /CDC checkpoint gap/.test(postgresCdcApplyService)
    && /migration_cdc_events/.test(postgresCdcApplyService)
    && /sourceCaptureRuntimeVerified:\s*false/.test(postgresCdcAcceptance)
    && /\^pca_\[0-9a-f\]\{8\}_\$/.test(postgresCdcAcceptance)
    && /DB_MIGRATION_USERNAME/.test(postgresCdcAcceptance)
    && /information_schema\.TABLES/.test(postgresCdcAcceptance)
    && /SET FOREIGN_KEY_CHECKS=0/.test(postgresCdcAcceptance)
    && /DROP TABLE \$\{identifier\(table\.tableName\)\}/.test(postgresCdcAcceptance)
    && /isolatedTablePrefix:\s*true/.test(postgresCdcAcceptance)
    && !/CREATE DATABASE|DROP DATABASE/.test(postgresCdcAcceptance)
    && /parent-delete-cascades-child-and-later-child-tombstone-is-audited-noop/.test(postgresCdcAcceptance)
    && /CREATE TABLE `sbl_migration_cdc_checkpoints`/.test(postgresCdcMigration)
    && /CREATE TABLE `sbl_migration_cdc_events`/.test(postgresCdcMigration)
    && packageJson.scripts?.['accept:postgres-cdc']
      === 'node --env-file-if-exists=.env --env-file-if-exists=.runtime/secrets/mysql-migration.env --import tsx server/src/scripts/postgresCdcAcceptance.ts',
    'PostgreSQL CDC must capture deletes and safe watermarks, enforce one-way authority, and persist replayable MySQL checkpoints',
  )
  requireCondition(
    /--scan-root/.test(productionSourceInventory)
    && /--postgres-dump/.test(productionSourceInventory)
    && /--flue-source/.test(productionSourceInventory)
    && /entry\.isSymbolicLink\(\)/.test(productionSourceInventory)
    && /metadata\.isSymbolicLink\(\)/.test(productionSourceInventory)
    && /looksLikePostgresDump/.test(productionSourceInventory)
    && /dumpInputs\.length !== 1/.test(productionSourceInventory)
    && /visitedDirectories/.test(productionSourceInventory)
    && /MIGRATION_SOURCE_INVENTORY_OUTPUT_DIR is allowed only for non-approval test runs/.test(productionSourceInventory)
    && /MIGRATION_SOURCE_SCAN_MAX_FILES/.test(productionSourceInventory)
    && /unexpectedSources/.test(productionSourceInventory)
    && /--approve requires --environment production/.test(productionSourceInventory)
    && /mode: 0o600/.test(productionSourceInventory)
    && packageJson.scripts?.['inventory:production-sources']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/productionSourceInventory.ts'
    && /renamed-postgres-dump-is-detected-and-rejected/.test(productionSourceInventoryAcceptance)
    && /symbolic-link-scan-root-is-rejected/.test(productionSourceInventoryAcceptance)
    && /exactly-one-postgres-dump-argument-is-enforced/.test(productionSourceInventoryAcceptance)
    && /approval-report-cannot-use-test-output-redirection/.test(productionSourceInventoryAcceptance)
    && /databaseWrites: 0/.test(productionSourceInventoryAcceptance)
    && packageJson.scripts?.['accept:production-source-inventory']
      === 'node --import tsx server/src/scripts/productionSourceInventoryAcceptance.ts'
    && releaseGatePolicyCovers('accept:production-source-inventory'),
    'production source inventory must scan explicit roots, reject unreviewed sources and symlinks, and require production approval',
  )
  requireCondition(
    /SOURCE_ORPHAN_CONVERSATION_REFERENCE/.test(orphanAiTaskConversationNormalization)
    && /UPDATE \$\{table\('ai_tasks'\)\} SET conversation_id=NULL/.test(orphanAiTaskConversationNormalization)
    && /UPDATE \$\{table\('ai_artifacts'\)\} SET conversation_id=NULL/.test(orphanAiTaskConversationNormalization)
    && /INSERT INTO \$\{table\('migration_issues'\)\}/.test(orphanAiTaskConversationNormalization)
    && /dumpSha256/.test(orphanAiTaskConversationNormalization)
    && packageJson.scripts?.['migrate:ai-task-orphan-conversations:preview']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/normalizeOrphanAiTaskConversations.ts'
    && packageJson.scripts?.['migrate:ai-task-orphan-conversations']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/normalizeOrphanAiTaskConversations.ts --apply',
    'source-orphan AI task conversation references must be normalized without manufacturing conversations and retain a durable issue ledger',
  )
  requireCondition(
    /LEGACY_CONVERSATION_PROJECT_SCOPE_MISSING/.test(legacyConversationScopeNormalization)
    && /legacySource === 'legacy_postgres'/.test(legacyConversationScopeNormalization)
    && /Number\(row\.messageCount\) === 0/.test(legacyConversationScopeNormalization)
    && /Number\(row\.taskCount\) === 0/.test(legacyConversationScopeNormalization)
    && /SET scope='global'/.test(legacyConversationScopeNormalization)
    && /INSERT INTO \$\{table\('migration_issues'\)\}/.test(legacyConversationScopeNormalization)
    && /originalChatScope/.test(legacyConversationScopeNormalization)
    && /reversible: true/.test(legacyConversationScopeNormalization)
    && packageJson.scripts?.['normalize:legacy-conversation-scopes:preview']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/normalizeLegacyConversationScopes.ts'
    && packageJson.scripts?.['normalize:legacy-conversation-scopes']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/normalizeLegacyConversationScopes.ts --apply',
    'projectless legacy empty conversations must normalize both indexes without guessing a project and retain a reversible migration issue ledger',
  )
  requireCondition(
    /LEAD_RESERVE_SOURCE_DETAIL_MISSING/.test(missingLeadReserveDetailQuarantine)
    && /score_status='source_missing'/.test(missingLeadReserveDetailQuarantine)
    && /INSERT INTO \$\{table\('migration_issues'\)\}/.test(missingLeadReserveDetailQuarantine)
    && /lead-reserve-missing-detail-quarantine/.test(missingLeadReserveDetailQuarantine)
    && /sourceSha256/.test(missingLeadReserveDetailQuarantine)
    && packageJson.scripts?.['migrate:lead-reserve-missing-detail:preview']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/quarantineMissingLeadReserveDetails.ts'
    && packageJson.scripts?.['migrate:lead-reserve-missing-detail']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/quarantineMissingLeadReserveDetails.ts --apply',
    'lead reserve rows with missing source detail must be quarantined without deletion and retain a durable issue ledger',
  )
  requireCondition(
    /PROJECT_FILE_SOURCE_FILE_MISSING/.test(missingFileAssetQuarantine)
    && /AI_ARTIFACT_SOURCE_FILE_MISSING/.test(missingFileAssetQuarantine)
    && /SET archived=1,quality_status='failed'/.test(missingFileAssetQuarantine)
    && /JSON_SET\(/.test(missingFileAssetQuarantine)
    && /INSERT INTO \$\{table\('migration_issues'\)\}/.test(missingFileAssetQuarantine)
    && /missing-file-asset-quarantine/.test(missingFileAssetQuarantine)
    && /project-file-missing-quarantine/.test(migrationReconciliationAudit)
    && /ai-artifact-missing-quarantine/.test(migrationReconciliationAudit)
    && packageJson.scripts?.['migrate:missing-file-assets:preview']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/quarantineMissingFileAssets.ts'
    && packageJson.scripts?.['migrate:missing-file-assets']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/quarantineMissingFileAssets.ts --apply',
    'missing project files and legacy AI artifacts must be retained or hidden safely with a durable issue ledger',
  )
  requireCondition(
    /PROJECT_FILE_SOURCE_FILE_MISSING_APPROVED/.test(missingProjectFileDisposition)
    && /project-file-missing-disposition/.test(missingProjectFileDisposition)
    && /validateExactScope\(decision, locked\)/.test(missingProjectFileDisposition)
    && /FOR UPDATE/.test(missingProjectFileDisposition)
    && /metadataRetained: true/.test(missingProjectFileDisposition)
    && /originalBytesManufactured: false/.test(missingProjectFileDisposition)
    && /reattachmentCapabilityRetained: true/.test(missingProjectFileDisposition)
    && /fileIdsExcludedFromEvidence: true/.test(missingProjectFileDisposition)
    && /fileNamesExcludedFromEvidence: true/.test(missingProjectFileDisposition)
    && /permanently-missing-approved/.test(missingProjectFileDecision)
    && /"retainMetadata": true/.test(missingProjectFileDecision)
    && /"manufactureOriginalBytes": false/.test(missingProjectFileDecision)
    && /"deleteBusinessRecord": false/.test(missingProjectFileDecision)
    && /PROJECT_FILE_SOURCE_FILE_MISSING_APPROVED/.test(migrationReconciliationAudit)
    && packageJson.scripts?.['migrate:approve-missing-project-files:preview']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/applyMissingProjectFileDispositions.ts'
    && packageJson.scripts?.['migrate:approve-missing-project-files']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/applyMissingProjectFileDispositions.ts --apply',
    'approved missing project files must match the exact locked inventory, retain metadata and reattachment, create no bytes, and append a durable business-decision ledger',
  )
  requireCondition(
    /legacyMetadataRestoredAt/.test(quarantinedAiArtifactMetadataRepair)
    && /legacyQualityStatus/.test(quarantinedAiArtifactMetadataRepair)
    && /legacyArchived/.test(quarantinedAiArtifactMetadataRepair)
    && /legacyStoragePathSha256/.test(quarantinedAiArtifactMetadataRepair)
    && /ai-artifact-quarantine-metadata-repair/.test(quarantinedAiArtifactMetadataRepair)
    && /sourceIdentityMatches/.test(aiArtifactSourceDiscovery)
    && /checkCRC32: true/.test(aiArtifactSourceDiscovery)
    && /expectedBytes/.test(aiArtifactSourceDiscovery)
    && /hashes\.size > 1/.test(aiArtifactSourceDiscovery)
    && /COPYFILE_EXCL/.test(aiArtifactSourceDiscovery)
    && /source-file-recovered/.test(aiArtifactSourceDiscovery)
    && /ai-artifact-source-recovery/.test(aiArtifactSourceDiscovery)
    && packageJson.scripts?.['migrate:ai-artifact-metadata:preview']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/repairQuarantinedAiArtifactMetadata.ts'
    && packageJson.scripts?.['migrate:ai-artifact-metadata']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/repairQuarantinedAiArtifactMetadata.ts --apply'
    && packageJson.scripts?.['discover:ai-artifact-sources']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/discoverAiArtifactSources.ts'
    && packageJson.scripts?.['migrate:ai-artifact-sources']
      === 'npm run discover:ai-artifact-sources -- --apply',
    'quarantined AI artifact metadata and source bytes must be recoverable only through dump/path identity, exact size, format signature and unique content hash',
  )
  requireCondition(
    /status >= 500 \? '服务器内部错误'/.test(errorHandler)
    && /status >= 500 \? 'INTERNAL_ERROR'/.test(errorHandler),
    '500 responses must not expose upstream error messages or implementation-specific error codes',
  )
  requireCondition(
    /configuredSecrets\(\)/.test(migrationEvidenceSafetyAcceptance)
    && /credentialPatterns/.test(migrationEvidenceSafetyAcceptance)
    && /sensitiveBodyKeys/.test(migrationEvidenceSafetyAcceptance)
    && /unsafe-permission/.test(migrationEvidenceSafetyAcceptance)
    && /isSymbolicLink\(\)/.test(migrationEvidenceSafetyAcceptance)
    && packageJson.scripts?.['accept:migration-evidence-safety']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/migrationEvidenceSafetyAcceptance.ts'
    && releaseGatePolicyCovers('accept:migration-evidence-safety'),
    'migration reports, manifests and quarantine reports must reject secrets, unnecessary body text and unsafe files',
  )
  requireCondition(
    /MIGRATION_INVALID_JSON/.test(migrationJsonSafety)
    && /without retaining its raw body/.test(migrationJsonSafety)
    && /parseMigrationJson\(raw/.test(postgresDumpMigration)
    && /migration_issues/.test(postgresDumpMigration)
    && /parseMigrationJson\(row\.identity_json/.test(flueMigration)
    && /parseMigrationJson\(batch\.data/.test(flueMigration)
    && /migrationJsonIssue\(error\)/.test(flueMigration)
    && /all-target-mysql-json-columns-valid/.test(migrationJsonSafetyAcceptance)
    && /invalid-json-run-and-issue-persist-atomically/.test(migrationJsonSafetyAcceptance)
    && /invalid-json-issue-excludes-raw-body/.test(migrationJsonSafetyAcceptance)
    && packageJson.scripts?.['accept:migration-json-safety']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/migrationJsonSafetyAcceptance.ts'
    && releaseGatePolicyCovers('accept:migration-json-safety'),
    'all target JSON must be valid and invalid source JSON must enter a safe migration issue ledger',
  )
  requireCondition(
    /mysqlTable\('migration_entity_mappings'/.test(databaseSchema)
    && /uq_migration_entity_source/.test(migrationEntityMappingMigration)
    && /fk_migration_entity_run/.test(migrationEntityMappingMigration)
    && /upsertEntityMappings/.test(postgresDumpMigration)
    && /sourceRowChecksum/.test(postgresDumpMigration)
    && /migration_entity_mappings/.test(flueMigration)
    && /locked-source-counts-equal-entity-mapping-counts/.test(migrationEntityMappingAcceptance)
    && /every-mapped-target-row-exists/.test(migrationEntityMappingAcceptance)
    && /flue-generic-and-specialized-mappings-agree/.test(migrationEntityMappingAcceptance)
    && packageJson.scripts?.['accept:migration-entity-mappings']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/migrationEntityMappingAcceptance.ts'
    && releaseGatePolicyCovers('accept:migration-entity-mappings'),
    'every migrated source entity must have one checksum-bound and run-linked target id mapping',
  )
  requireCondition(
    /legacy-scoring-classification/.test(legacyScoringClassification)
    && /originalScoringChecksum/.test(legacyScoringClassification)
    && /evidenceReconstructable',false/.test(legacyScoringClassification)
    && /sourceSha256/.test(legacyScoringClassification)
    && !/rawBody|requestBody|responseBody/.test(legacyScoringClassification)
    && /legacyScoringReady/.test(postgresDumpReconciliationPolicy)
    && /legacy-scoring-classification/.test(postgresDumpMigration)
    && /legacyScoringReady/.test(migrationReconciliationAudit)
    && /provenance:\s*'agent-run'/.test(projectScoringService)
    && /evidenceChain:\s*detailed\.audit/.test(projectScoringService)
    && /provenance:\s*'agent-run'/.test(metaRoutes)
    && /evidenceChain:\s*detailed\.audit/.test(metaRoutes)
    && /all-historical-scores-explicitly-marked-legacy-import/.test(legacyScoringAcceptance)
    && /agent-run-scores-bind-succeeded-run-decision-input-and-verified-evidence/.test(legacyScoringAcceptance)
    && packageJson.scripts?.['migrate:legacy-scoring']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/classifyLegacyScoring.ts --apply'
    && packageJson.scripts?.['accept:legacy-scoring']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/legacyScoringAcceptance.ts'
    && releaseGatePolicyCovers('accept:legacy-scoring'),
    'legacy scores must be classified without fabricated evidence and every new score must bind an Agent audit chain',
  )
  requireCondition(
    /timezone: '\+08:00'/.test(mysqlClient)
    && /customType<\{ data: Date; driverData: string \}>/.test(databaseSchema)
    && /value\.replace\(' ', 'T'\)\}\+08:00/.test(databaseSchema)
    && /SHANGHAI_TIME_ZONE = 'Asia\/Shanghai'/.test(serverShanghaiTime)
    && /SHANGHAI_OFFSET = '\+08:00'/.test(serverShanghaiTime)
    && /parseShanghaiDateTime/.test(serverShanghaiTime)
    && /BUSINESS_TIME_ZONE = 'Asia\/Shanghai'/.test(clientShanghaiTime)
    && /timeZone: BUSINESS_TIME_ZONE/.test(clientShanghaiTime)
    && /application-mysql-session-timezone-plus-eight/.test(timezoneAcceptance)
    && /mysql-driver-round-trip-preserves-utc-instant/.test(timezoneAcceptance)
    && /api-json-serializes-utc-iso-8601/.test(timezoneAcceptance)
    && packageJson.scripts?.['accept:timezone']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/timezoneAcceptance.ts'
    && releaseGatePolicyCovers('accept:timezone'),
    'MySQL, API and UI must use an explicit UTC-instant/Asia-Shanghai business-time boundary',
  )
  requireCondition(
    /source-and-target-controlled-enum-values-within-versioned-contracts/.test(migrationScalarConstraintAcceptance)
    && /all-schema-booleans-are-mysql-tinyint-one-with-zero-one-values/.test(migrationScalarConstraintAcceptance)
    && /all-schema-uuid-columns-are-varchar-36-with-valid-rfc4122-values/.test(migrationScalarConstraintAcceptance)
    && /all-code-unique-indexes-match-mysql-column-order-and-have-no-duplicate-groups/.test(migrationScalarConstraintAcceptance)
    && /postgres-dump-baseline-reconciliation/.test(migrationScalarConstraintAcceptance)
    && /sourceSha256/.test(migrationScalarConstraintAcceptance)
    && /information_schema\.STATISTICS/.test(migrationScalarConstraintAcceptance)
    && packageJson.scripts?.['accept:migration-scalar-constraints']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/migrationScalarConstraintAcceptance.ts'
    && releaseGatePolicyCovers('accept:migration-scalar-constraints'),
    'source and target enum, boolean, UUID and unique-index conversions require a checksum-bound MySQL release gate',
  )
  requireCondition(
    /desc\(projects\.pinned\),\s*desc\(projects\.updatedAt\),\s*desc\(projects\.id\)/s.test(projectService)
    && /options\.sort === 'funding'[\s\S]*?: desc\(leads\.createdAt\),\s*desc\(leads\.id\)/s.test(aiSummaryService)
    && /project-pagination-tied-sort-values-use-unique-id-without-duplicates-or-omissions/.test(stablePaginationAcceptance)
    && /lead-created-time-pagination-ties-use-unique-id-and-repeat-stably/.test(stablePaginationAcceptance)
    && /lead-review-pagination-order-ends-in-unique-id/.test(stablePaginationAcceptance)
    && packageJson.scripts?.['accept:stable-pagination']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/stablePaginationAcceptance.ts'
    && releaseGatePolicyCovers('accept:stable-pagination'),
    'offset-paginated project, lead and review lists must end in a unique ordering key and pass a real MySQL tie fixture',
  )
  requireCondition(
    /result: varchar\('result'/.test(databaseSchema)
    && /requestId: varchar\('request_id'/.test(databaseSchema)
    && /currentRequestId\(\) \?\? randomUUID\(\)/.test(databaseSchema)
    && /ADD COLUMN `result` varchar\(16\)/.test(auditRequestResultMigration)
    && /ADD COLUMN `request_id` varchar\(64\)/.test(auditRequestResultMigration)
    && /CONCAT\('legacy-', `id`\)/.test(auditRequestResultMigration)
    && /MODIFY COLUMN `request_id` varchar\(64\) NOT NULL/.test(auditRequestResultMigration)
    && /idx_audit_request/.test(auditRequestResultMigration)
    && /result, request_id, created_at/.test(leadScoreJobService)
    && /currentRequestId\(\) \?\? randomUUID\(\)/.test(leadScoreJobService)
    && /result, request_id, created_at/.test(leadPipelineReviewService)
    && /currentRequestId\(\) \?\? randomUUID\(\)/.test(leadPipelineReviewService)
    && /high-risk-audit-actor-time-target-result-request-id/.test(resourceIsolationAcceptance),
    'audit records must persist actor, time, target, result and request correlation for HTTP and non-HTTP operations',
  )
  requireCondition(/safeErrorLog\(reason\)/.test(serverEntry), 'unhandled rejections must use centralized secret redaction')
  requireCondition(/installStructuredLogging\(\)/.test(serverEntry), 'unified entry must install structured logging')
  requireCondition(/runWithRequestLogContext\(requestId, next\)/.test(serverEntry), 'HTTP requests must propagate request IDs through async log context')
  for (const field of ['time', 'level', 'service', 'requestId']) {
    requireCondition(structuredLogger.includes(field), `structured log base field is missing: ${field}`)
  }
  requireCondition(/queueLimit:\s*mysqlConfig\.queueLimit/.test(mysqlClient), 'MySQL pool must use a bounded wait queue')
  requireCondition(/connectTimeout:\s*mysqlConfig\.connectTimeoutMs/.test(mysqlClient), 'MySQL pool must use an explicit connection timeout')
  requireCondition(
    /charset:\s*MYSQL_CONNECTION_COLLATION/.test(mysqlClient),
    'MySQL pool must explicitly use the approved connection collation instead of the utf8mb4_general_ci driver default',
  )
  for (const contract of [
    'simulated-network-outage-fails-closed',
    'same-pool-reconnects-after-network-recovery',
    'confirmed-commit-survives-disconnect',
    'uncommitted-transaction-rolls-back-on-disconnect',
  ]) {
    requireCondition(mysqlResilienceAcceptance.includes(contract), `MySQL outage recovery acceptance is missing: ${contract}`)
  }
  requireCondition(
    /createServer\(/.test(mysqlResilienceAcceptance)
    && /proxy\.setAvailable\(false\)/.test(mysqlResilienceAcceptance)
    && packageJson.scripts?.['accept:mysql-resilience']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/mysqlResilienceAcceptance.ts'
    && releaseGatePolicyCovers('accept:mysql-resilience'),
    'production release must prove MySQL network outage recovery and transaction durability without stopping the database',
  )
  for (const contract of [
    '@@character_set_database',
    '@@collation_connection',
    '@@global.time_zone',
    '@@max_connections',
    '@@slow_query_log',
    '@@long_query_time',
    'connectionIdentityExcluded',
    'mode: 0o600',
  ]) requireCondition(mysqlOperationalConfigAcceptance.includes(contract), `MySQL operational configuration acceptance is missing: ${contract}`)
  requireCondition(
    packageJson.scripts?.['accept:mysql-operational-config']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/mysqlOperationalConfigAcceptance.ts'
    && releaseGatePolicyCovers('accept:mysql-operational-config'),
    'production release must prove MySQL charset, collation, time zone, capacity and slow-query configuration',
  )
  requireCondition(
    /normalize\('NFKC'\)/.test(ragService)
    && /function compareRetrievalRows/.test(ragService)
    && /exactPhraseBonus/.test(ragService)
    && /sourceName/.test(ragService),
    'Chinese retrieval must normalize Unicode, score source names and use deterministic tie ordering',
  )
  for (const contract of [
    'recallAt3 >= 0.875',
    'top1Accuracy >= 0.75',
    'meanReciprocalRank >= 0.8',
    'project-reference-isolation',
    'scope-isolation',
    'three-run-stable-ordering',
    'fixture cleanup left knowledge chunks behind',
    'mode: 0o600',
  ]) requireCondition(chineseRetrievalAcceptance.includes(contract), `Chinese retrieval acceptance is missing: ${contract}`)
  requireCondition(
    packageJson.scripts?.['accept:chinese-retrieval']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/chineseRetrievalAcceptance.ts'
    && releaseGatePolicyCovers('accept:chinese-retrieval'),
    'production release must prove Chinese retrieval recall, isolation and stable ordering',
  )
  requireCondition(
    (ragService.match(/await db\.transaction\(async \(tx\)/g) || []).length >= 2
    && /tx\.delete\(fileChunks\)/.test(ragService)
    && /tx\.insert\(knowledgeChunks\)/.test(ragService)
    && /tx\.update\(projectFiles\)/.test(ragService)
    && !/知识库双写失败\(不阻断\)/.test(ragService),
    'file parse status, file chunks and searchable knowledge projection must commit in one MySQL transaction',
  )
  requireCondition(
    /ADD CONSTRAINT `uq_kc_source_chunk`/.test(knowledgeSourceChunkMigration)
    && /UNIQUE \(`scope`, `ref_id`, `source_id`, `chunk_index`\)/.test(knowledgeSourceChunkMigration),
    'knowledge source chunks must have a database-enforced idempotency constraint',
  )
  requireCondition(
    /CREATE TABLE `sbl_lead_pipeline_entity_matches`/.test(leadPipelineEntityMatchMigration)
    && /uq_lp_entity_matches_key/.test(leadPipelineEntityMatchMigration)
    && /sbl_lp_entity_matches_event_fk/.test(leadPipelineEntityMatchMigration)
    && /sbl_lp_entity_matches_candidate_fk/.test(leadPipelineEntityMatchMigration)
    && /ck_lp_entity_matches_status/.test(leadPipelineEntityMatchMigration),
    'entity match migration must preserve idempotency, event binding, lead binding and closed statuses',
  )
  for (const contract of [
    'failed-replacement-rolls-back-delete',
    'previous-searchable-projection-remains-byte-equal',
    'idempotent-replay-does-not-duplicate',
    'database-unique-source-chunk-constraint',
    'fixture cleanup left knowledge chunks behind',
    'mode: 0o600',
  ]) requireCondition(knowledgeIngestionAtomicityAcceptance.includes(contract), `Knowledge ingestion atomicity acceptance is missing: ${contract}`)
  requireCondition(
    packageJson.scripts?.['accept:knowledge-ingestion-atomicity']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/knowledgeIngestionAtomicityAcceptance.ts'
    && releaseGatePolicyCovers('accept:knowledge-ingestion-atomicity'),
    'production release must prove atomic knowledge replacement, rollback and idempotency',
  )
  requireCondition(
    (projectRoutes.match(/await decodeAndValidateProjectFile\(/g) || []).length === 2,
    'both new uploads and historical-file repair must validate file bytes before storage',
  )
  for (const boundary of ['PROJECT_FILE_MAX_BYTES', 'FILE_SIGNATURE_MISMATCH', 'PROJECT_FILE_ARCHIVE_MAX_ENTRIES', 'PROJECT_FILE_ARCHIVE_MAX_UNCOMPRESSED_BYTES']) {
    requireCondition(projectFileValidation.includes(boundary), `project-file content boundary is missing: ${boundary}`)
  }
  requireCondition(/function isCanonicalBase64\(payload: string\)/.test(projectFileValidation) && /payload\.charCodeAt\(index\)/.test(projectFileValidation), 'large Base64 validation must use bounded-stack scanning')
  requireCondition(!/\[\.\.\.buffer\]/.test(projectFileValidation), 'large text validation must not copy the complete byte array')
  requireCondition(
    /PROJECT_FILE_TEMP_PATTERN/.test(projectFileStorage)
    && /PROJECT_FILE_TEMP_MAX_AGE_MS/.test(projectFileStorage)
    && /info\.isSymbolicLink\(\)/.test(projectFileStorage)
    && /current\.dev !== info\.dev/.test(projectFileStorage)
    && /current\.ino !== info\.ino/.test(projectFileStorage)
    && /cleanupStaleProjectFileTemps\(\)/.test(serverEntry),
    'project-file startup must safely clean only stale service-owned temporary files with symlink and race protection',
  )
  for (const contract of [
    'stale-owned-temporary-files-removed',
    'fresh-temporary-file-retained',
    'formal-file-retained',
    'ordinary-dot-tmp-file-retained',
    'symlink-and-outside-target-retained',
    'second-run-idempotent',
    'mode: 0o600',
  ]) requireCondition(projectFileTempCleanupAcceptance.includes(contract), `Project-file temporary cleanup acceptance is missing: ${contract}`)
  requireCondition(
    packageJson.scripts?.['accept:project-file-temp-cleanup']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/projectFileTempCleanupAcceptance.ts'
    && releaseGatePolicyCovers('accept:project-file-temp-cleanup'),
    'production release must prove project-file temporary cleanup retention and safety boundaries',
  )
  requireCondition(
    /assertOwnedStoragePath/.test(projectFileStorage)
    && /target === PROJECT_FILE_ROOT/.test(projectFileStorage)
    && /initial\.isSymbolicLink\(\)/.test(projectFileStorage)
    && /current\.dev !== initial\.dev/.test(projectFileStorage)
    && /current\.ino !== initial\.ino/.test(projectFileStorage)
    && /removeOwnedProjectFile\(storagePath, f\.projectId, fileId\)/.test(projectService),
    'project-file deletion must bind every stored path to its project/file lineage and reject root, symlink and replacement targets',
  )
  for (const contract of [
    'owned-current-and-history-bytes-removed',
    'cross-project-poisoned-storage-path-rejected',
    'other-project-file-byte-equal',
    'historical-ai-artifact-byte-equal',
    'shared-template-byte-equal',
    'off-root-rollback-source-byte-equal',
    'mode: 0o600',
  ]) requireCondition(projectFileDeletionIsolationAcceptance.includes(contract), `Project-file deletion isolation acceptance is missing: ${contract}`)
  requireCondition(
    packageJson.scripts?.['accept:project-file-deletion-isolation']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/projectFileDeletionIsolationAcceptance.ts'
    && releaseGatePolicyCovers('accept:project-file-deletion-isolation'),
    'production release must prove project-file deletion cannot affect other projects, shared assets or rollback sources',
  )
  for (const format of ['pdf', 'docx', 'pptx', 'xlsx', 'image']) {
    requireCondition(migrationFileSampleAcceptance.includes(`kind: '${format}'`), `Migration file sample acceptance is missing: ${format}`)
  }
  requireCondition(
    /decodeAndValidateProjectFile/.test(migrationFileSampleAcceptance)
    && /new PDFParse/.test(migrationFileSampleAcceptance)
    && /mammoth\.extractRawText/.test(migrationFileSampleAcceptance)
    && /JSZip\.loadAsync/.test(migrationFileSampleAcceptance)
    && /slideNames/.test(migrationFileSampleAcceptance)
    && /new ExcelJS\.Workbook/.test(migrationFileSampleAcceptance)
    && /XLSX\.read/.test(migrationFileSampleAcceptance)
    && /imageSize\(buffer\)/.test(migrationFileSampleAcceptance)
    && /pathsAndFileNamesExcluded: true/.test(migrationFileSampleAcceptance)
    && /extractedContentExcluded: true/.test(migrationFileSampleAcceptance)
    && /productionMissingAssetsProvenComplete: false/.test(migrationFileSampleAcceptance)
    && /mode: 0o600/.test(migrationFileSampleAcceptance)
    && packageJson.scripts?.['accept:migration-file-samples']
      === 'node --import tsx server/src/scripts/migrationFileSampleAcceptance.ts'
    && releaseGatePolicyCovers('accept:migration-file-samples'),
    'release must structurally open safe PDF, DOCX, PPTX, XLSX and image samples without leaking content or claiming missing production assets are complete',
  )
  for (const contract of [
    'five-required-role-fixtures',
    'two-department-two-project-isolation',
    'six-file-kinds-per-project-private-roundtrip',
    'duplicate-multi-weak-conflict-invalid-lead-fixtures',
    'success-timeout-rate-tool-model-execution-fixtures',
    'synthetic-invalid-domain-random-credential-policy',
    'fixtureCleanupPending = false',
    'mode: 0o600',
  ]) requireCondition(migrationFixtureReadinessAcceptance.includes(contract), `Migration fixture readiness acceptance is missing: ${contract}`)
  requireCondition(
    packageJson.scripts?.['accept:migration-fixture-readiness']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/migrationFixtureReadinessAcceptance.ts'
    && releaseGatePolicyCovers('accept:migration-fixture-readiness'),
    'production release must prove migration roles, isolated projects, representative files, lead cases and failure simulations are prepared without real data',
  )
  for (const contract of [
    'configured-secret-values-absent-from-test-sources',
    'credential-and-private-key-literals-absent',
    'phone-and-mainland-id-literals-absent',
    'only-reserved-test-email-domains',
    'known-weak-login-passwords-absent',
    'ai-api-random-identity-exact-cleanup',
    'socket-random-identity-exact-cleanup',
    'jw-multiturn-random-identity-exact-cleanup',
    'synthetic-fixture-zero-residue-contract',
    'mode: 0o600',
  ]) requireCondition(migrationTestDataSafetyAcceptance.includes(contract), `Migration test-data safety acceptance is missing: ${contract}`)
  requireCondition(
    /createAcceptanceUsers/.test(aiTaskApiAcceptance)
    && /cleanupAcceptanceUsers/.test(aiTaskApiAcceptance)
    && /@example\.invalid/.test(aiTaskApiAcceptance)
    && !/admin@cybernaut\.com|lin@cybernaut\.com|password:\s*['"]123456/.test(aiTaskApiAcceptance),
    'AI task API acceptance must use random reserved-domain identities and exact cleanup instead of fixed demo accounts or weak passwords',
  )
  requireCondition(
    packageJson.scripts?.['accept:migration-test-data-safety']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/migrationTestDataSafetyAcceptance.ts'
    && /await rename\(temporary, target\)/.test(migrationTestDataSafetyAcceptance)
    && releaseGatePolicyCovers('accept:migration-test-data-safety'),
    'production release must atomically scan migration tests and gold fixtures for configured secrets, credentials, PII, real email domains and weak login passwords',
  )
  for (const contract of [
    'concurrent-multi-connection-subscriptions',
    'concurrent-multi-conversation-room-isolation',
    'concurrent-snapshot-broadcast',
    'multi-round-full-reconnect',
    'server-reconnect-counter-and-recovery-rate',
    'reconnect-telemetry-excludes-identities',
    'disconnect-window-confirmed-messages-restored-exactly-once',
    'bounded-connect-retry-after-overload',
    'bounded-subscription-retry-after-overload',
    'synthetic-identity-exact-cleanup',
    'mode: 0o600',
  ]) requireCondition(socketAcceptance.includes(contract), `Socket pressure acceptance is missing: ${contract}`)
  requireCondition(
    /@example\.invalid/.test(socketAcceptance)
    && /cleanupAcceptanceState/.test(socketAcceptance)
    && !/accountRows|ne\(users\.role/.test(socketAcceptance),
    'Socket acceptance must use random reserved-domain identities with exact cleanup and never select existing business users',
  )
  requireCondition(
    packageJson.scripts?.['accept:socket']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/socketAcceptance.ts'
    && releaseGatePolicyCovers('accept:socket'),
    'production start must prove Socket multi-connection, multi-conversation broadcast, reconnect and identity cleanup boundaries',
  )
  requireCondition(
    /SOCKET_DB_CONCURRENCY/.test(agentSocketService)
    && /SOCKET_RECONNECT_WINDOW_MS/.test(agentSocketService)
    && /reconnectedTotal/.test(agentSocketService)
    && /disconnectRecoveryRate/.test(agentSocketService)
    && /identitiesExcluded: true/.test(agentSocketService)
    && (agentSocketService.match(/withSocketDbPermit/g) || []).length >= 5
    && /ensure_env_value "\$ENV_FILE" "SOCKET_DB_CONCURRENCY" "8"/.test(deploy)
    && /ensure_env_value "\$ENV_FILE" "SOCKET_RECONNECT_WINDOW_MS" "300000"/.test(deploy)
    && !/broadcast failed conversation=/.test(agentSocketService),
    'Socket handshake, subscription, broadcast and reauthentication must share bounded MySQL backpressure and identity-free reconnect telemetry',
  )
  for (const contract of [
    'real-model-two-turn-global-conversation',
    'second-turn-remembers-random-first-turn-challenge',
    'same-sdk-session-resumed',
    'mysql-message-and-part-persistence',
    'model-turn-duration-and-cost-state-persisted',
    'model-token-cache-cost-and-compaction-state-restored-through-snapshot',
    'real-model-project-summary-tool-call',
    'server-bound-project-context-no-model-project-id',
    'project-tool-input-output-associated-in-mysql',
    'streaming-partial-observed-before-user-stop',
    'sdk-interrupt-no-post-stop-late-write-or-active-state',
    'stopped-conversation-resumes-with-new-turn',
    'fresh-authentication-restores-mysql-conversation-list-and-history',
    'conversation-rename-keeps-chat-and-agent-index-in-sync',
    'conversation-switch-restores-correct-history',
    'conversation-delete-removes-exactly-one-conversation',
    'no-sqlite-flue-or-retired-port-runtime-dependency',
    'conversation-runtime-session-disposed-before-delete',
    'project-conversation-and-membership-cleanup',
    'synthetic-identity-session-audit-and-workspace-cleanup',
    'mode: 0o600',
  ]) requireCondition(jwMultiTurnLiveAcceptance.includes(contract), `JW live multi-turn acceptance is missing: ${contract}`)
  requireCondition(
    packageJson.scripts?.['accept:jw-multiturn-live']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/jwMultiTurnLiveAcceptance.ts'
    && releaseGatePolicyCovers('accept:jw-multiturn-live')
    && /disposeJwAgentConversation/.test(jwRuntime)
    && /await disposeJwAgentConversation/.test(conversationRoutes),
    'production update must prove real multi-turn JW context and dispose the SDK Runtime session before deleting MySQL conversation state',
  )
  requireCondition(
    /raw\.subtype === 'compact_boundary' \|\| raw\.subtype === 'status'/.test(jwRuntime)
    && /normalizedTokenUsage\(raw\.usage\)/.test(jwRuntime)
    && /duplicate \? 0 : 1/.test(jwRuntime)
    && /contextCompaction: normalizedContextCompaction/.test(jwRuntime)
    && /runtime: JwRuntimeState/.test(jwAgentHook)
    && /模型用量与上下文压缩状态/.test(aiAssistantPage)
    && /compact-boundary-replay-counted-exactly-once/.test(jwUsageCompactionAcceptance)
    && /mysql-snapshot-restores-runtime-state-without-memory-session/.test(jwUsageCompactionAcceptance)
    && /mode: 0o600/.test(jwUsageCompactionAcceptance)
    && packageJson.scripts?.['accept:jw-usage-compaction']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/jwUsageCompactionAcceptance.ts'
    && releaseGatePolicyCovers('accept:jw-usage-compaction'),
    'JW model, token usage, cost and context compaction state must persist in MySQL and recover through snapshots',
  )
  requireCondition(
    /tools:\s*\[JW_AGENT_INTERACTIVE_TOOL, 'Skill'\]/.test(jwRuntime)
    && /permissionMode: 'default'/.test(jwRuntime)
    && /ask:\s*\[JW_AGENT_INTERACTIVE_TOOL\]/.test(jwRuntime)
    && /ask-user-question-visible-but-not-auto-allowed/.test(jwInteractionAcceptance)
    && /explicit-ask-rule-routes-interaction-to-sdk-permission-callback/.test(jwInteractionAcceptance)
    && /beginJwAgentInteraction\(/.test(jwRuntime)
    && /respondJwAgentInteraction/.test(jwRuntime)
    && /pendingInteraction: null/.test(jwRuntime)
    && /AGENT_INTERACTION_NOT_ACTIVE/.test(jwRuntime)
    && /AGENT_INTERACTION_PENDING/.test(jwRuntime)
    && /JW_AGENT_INTERACTION_TIMEOUT_MS/.test(jwRuntime)
    && /interactions\/:interactionId\/respond/.test(jwAgentRoutes)
    && /respondInteraction/.test(jwAgentHook)
    && /aria-label="AI 交互问题"/.test(aiAssistantPage)
    && /取消并继续/.test(aiAssistantPage)
    && /cross-user-and-stale-interaction-response-rejected/.test(jwInteractionAcceptance)
    && /service-restart-clears-unresumable-interaction/.test(jwInteractionAcceptance)
    && /interaction-timeout-prevents-unbounded-runtime-wait/.test(jwInteractionAcceptance)
    && /persistedAnswerBodies: 0/.test(jwInteractionAcceptance)
    && /mode: 0o600/.test(jwInteractionAcceptance)
    && /external-model-actively-requested-ask-user-question/.test(jwInteractionLiveAcceptance)
    && /authorized-answer-resumed-the-same-sdk-turn/.test(jwInteractionLiveAcceptance)
    && /external-model-continued-with-the-expected-post-answer-result/.test(jwInteractionLiveAcceptance)
    && /external-result-model-token-cache-cost-turn-and-duration-persisted/.test(jwInteractionLiveAcceptance)
    && /providerResponseBodiesPersisted: 0/.test(jwInteractionLiveAcceptance)
    && /mode: 0o600/.test(jwInteractionLiveAcceptance)
    && packageJson.scripts?.['accept:jw-interaction']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/jwInteractionAcceptance.ts'
    && packageJson.scripts?.['accept:jw-interaction-live']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/jwInteractionLiveAcceptance.ts'
    && releaseGatePolicyCovers('accept:jw-interaction')
    && releaseGatePolicyCovers('accept:jw-interaction-live')
    && /ensure_env_value "\$ENV_FILE" "JW_AGENT_INTERACTION_TIMEOUT_MS" "900000"/.test(deploy),
    'JW AskUserQuestion must support authorized answer/cancel, MySQL snapshots and restart-safe cleanup without enabling other built-in tools',
  )
  requireCondition(
    /export function Markdown/.test(aiAssistantPage)
    && /export function MessagePart/.test(aiAssistantPage)
    && /remarkPlugins=\{\[remarkGfm\]\}/.test(aiAssistantPage)
    && /target="_blank" rel="noreferrer"/.test(aiAssistantPage)
    && /<details className=/.test(aiAssistantPage)
    && /<summary className="cursor-pointer select-none">💭 思考过程<\/summary>/.test(aiAssistantPage)
    && /unsafe-javascript-link-href-neutralized/.test(jwMessageRenderingAcceptance)
    && /reasoning-defaults-to-closed-details/.test(jwMessageRenderingAcceptance)
    && /reasoning-remains-separate-from-final-answer/.test(jwMessageRenderingAcceptance)
    && /mode: 0o600/.test(jwMessageRenderingAcceptance)
    && packageJson.scripts?.['accept:jw-message-rendering']
      === 'node --import tsx server/scripts/jwMessageRenderingAcceptance.tsx'
    && releaseGatePolicyCovers('accept:jw-message-rendering'),
    'JW text, GFM table, code, link and reasoning rendering must remain safe and separately testable',
  )
  requireCondition(
    /switchJwAgentModel/.test(jwRuntime)
    && /withJwConversationOperation\(resolved\.agent\.id/.test(jwRuntime)
    && /closeJwRuntimeSession\(refreshed\.agent\.id, 'dispose'\)/.test(jwRuntime)
    && /fresh\?\.modelId/.test(jwRuntime)
    && /agentConversationRepository\.updateModelForOwner/.test(jwRuntime)
    && /AGENT_MODEL_SWITCH_BUSY/.test(jwRuntime)
    && /modelChangedFrom: previousModelId/.test(jwRuntime)
    && /conversations\/:agentId\/model/.test(jwAgentRoutes)
    && /aria-label="切换当前会话模型"/.test(aiAssistantPage)
    && /switchCurrentSessionModel/.test(aiAssistantPage)
    && /selected-model-id-persists-for-next-runtime-session/.test(jwModelSwitchAcceptance)
    && /sdk-session-id-and-mysql-message-history-preserved/.test(jwModelSwitchAcceptance)
    && /cross-user-invalid-and-busy-switches-rejected/.test(jwModelSwitchAcceptance)
    && /mode: 0o600/.test(jwModelSwitchAcceptance)
    && packageJson.scripts?.['accept:jw-model-switch']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/jwModelSwitchAcceptance.ts'
    && releaseGatePolicyCovers('accept:jw-model-switch'),
    'JW model switching must serialize with message submission, validate authorization, preserve MySQL history and recreate the next SDK query from the selected model',
  )
  requireCondition(
    /export async function persistJwAgentProtocolMessage/.test(jwRuntime)
    && /type: 'dynamic-tool'/.test(jwRuntime)
    && /\['complete', 'error', 'interrupted'\]\.includes\(existingTool\.status\)/.test(jwRuntime)
    && /aria-label=\{`工具步骤 \$\{label\} \$\{statusLabel\}`\}/.test(aiAssistantPage)
    && /sdk-shaped-tool-use-persists-input-available-running-state/.test(jwToolLifecycleAcceptance)
    && /sdk-shaped-natural-error-persists-output-error-and-readable-error-text/.test(jwToolLifecycleAcceptance)
    && /tool-input-output-and-error-remain-associated-after-runtime-restart/.test(jwToolLifecycleAcceptance)
    && /duplicate-tool-events-are-idempotent-and-terminal-state-does-not-regress/.test(jwToolLifecycleAcceptance)
    && /persistedToolInputOutputBodies: 0/.test(jwToolLifecycleAcceptance)
    && /mode: 0o600/.test(jwToolLifecycleAcceptance)
    && packageJson.scripts?.['accept:jw-tool-lifecycle']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/jwToolLifecycleAcceptance.ts'
    && releaseGatePolicyCovers('accept:jw-tool-lifecycle'),
    'JW tool calls must retain typed input, progress, success and natural failure states in MySQL without terminal-state regression',
  )
  requireCondition(
    /stoppingReason: 'abort' \| 'dispose' \| 'shutdown' \| null/.test(jwRuntime)
      && /session\.queue\.end\(\)/.test(jwRuntime)
      && /await session\.outputLoop/.test(jwRuntime)
      && /markRunningJwToolsInterrupted\(resolved\.agent\.id, 'user_stop'/.test(jwRuntime)
      && /interruptionReason: 'user_stop'/.test(jwRuntime),
    'JW stop must settle and close the SDK query before returning idle, suppress late output and persist interrupted tool state',
  )
  requireCondition(
    /apiPatch<\{ title: string \}>\(`\/conversations\/\$\{rowId\}`/.test(aiAssistantPage)
      && /aria-label="重命名会话"/.test(aiAssistantPage)
      && /await apiDelete\(`\/conversations\/\$\{rowId\}`\)/.test(aiAssistantPage)
      && /删除会话失败/.test(aiAssistantPage),
    'AI conversation rename and delete controls must wait for MySQL API success and expose failures instead of mutating browser state optimistically',
  )
  requireCondition(
    /const lastConv = localStorage\.getItem\(LS_LAST_CONV\)/.test(aiAssistantPage)
      && /mapped\.some\(\(m\) => m\.agentId === lastConv\)/.test(aiAssistantPage)
      && /activateSession\(restoredSession\)/.test(aiAssistantPage)
      && /\/agent\/conversations\/\$\{encodeURIComponent\(agentId\)\}/.test(jwAgentHook),
    'AI page refresh must restore the selected stable Agent conversation from the MySQL list and load its snapshot from the unified JW endpoint',
  )
  for (const contract of [
    'uniform-400-401-403-404-409-500-error-shape',
    'internal-500-message-and-detail-redaction',
    'manual-route-error-request-id-enrichment',
    'frontend-header-body-request-id-match',
    'frontend-request-id-format-rejection',
    'visible-safe-message-retains-trace-id',
    'ai-task-and-render-error-id-visible',
    'mode: 0o600',
  ]) requireCondition(errorContractAcceptance.includes(contract), `Error contract acceptance is missing: ${contract}`)
  requireCondition(
    /baseMessage: string/.test(apiErrorContract)
    && /bodyRequestId === headerRequestId/.test(apiErrorContract)
    && /server\/src\/contracts\/apiErrorContract/.test(clientApi)
    && /error\.withContext/.test(await readFile(path.resolve(root, 'src/pages/AIAssistantPage.tsx'), 'utf8')),
    'frontend errors must retain a safe base message and only display a server trace ID after header/body validation',
  )
  requireCondition(
    packageJson.scripts?.['accept:error-contract']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/errorContractAcceptance.ts'
    && releaseGatePolicyCovers('accept:error-contract'),
    'production release must prove consistent safe and traceable API/Agent error contracts',
  )
  requireCondition(
    /project-file-expired-session-download-rejection/.test(resourceIsolationAcceptance)
    && /set\(\{ expiresAt: new Date\(Date\.now\(\) - 60_000\) \}\)/.test(resourceIsolationAcceptance)
    && /project-file download after session expiry/.test(resourceIsolationAcceptance),
    'authorized project-file download must be rejected after the backing server session expires',
  )
  for (const boundary of ['PROJECT_FILE_MAX_COUNT_PER_PROJECT', 'PROJECT_FILE_MAX_BYTES_PER_PROJECT', 'PROJECT_FILE_MAX_BYTES_PER_USER', 'DUPLICATE_CONTENT']) {
    requireCondition(projectService.includes(boundary), `project-file integrity/quota boundary is missing: ${boundary}`)
  }
  requireCondition(/lockProjectFileQuotaScope\(tx, userId, input\.projectId\)/.test(projectService), 'project-file quota and dedup checks must run under a project lock')
  requireCondition(/projectFileVersions = mysqlTable\('project_file_versions'/.test(databaseSchema), 'immutable project-file version schema is missing')
  requireCondition(/aiTaskTemplates = mysqlTable\('ai_task_templates'/.test(databaseSchema), 'MySQL AI task template registry is missing')
  requireCondition(/errorCode: varchar\('error_code'/.test(databaseSchema) && /retryable: boolean\('retryable'/.test(databaseSchema), 'AI task failure contract columns are missing')
  requireCondition(/projectsRouter\.get\('\/files\/:id\/preview'/.test(projectRoutes), 'authorized project-file preview route is missing')
  requireCondition(/projectsRouter\.get\('\/files\/:id\/versions\/:version\/download'/.test(projectRoutes), 'authorized historical version download route is missing')
  requireCondition(/Content-Security-Policy/.test(projectRoutes) && /X-Content-Type-Options/.test(projectRoutes), 'project-file preview must disable sniffing and sandbox active content')
  requireCondition(
    /action: '下载项目资料'/.test(projectRoutes)
    && /action: '下载项目资料历史版本'/.test(projectRoutes)
    && /action: '下载AI产物'/.test(aiTaskRoutesForTemplateProgress)
    && /workspace-file:\$\{pathHash\}/.test(workspaceRoutes)
    && /generated-file:\$\{fileKey\}/.test(routeIndex)
    && /project-workspace-generated-access-audit-without-storage-path/.test(resourceIsolationAcceptance)
    && /AI 产物下载写入无路径审计并绑定请求 ID/.test(aiTaskApiAcceptance),
    'project files, AI artifacts, workspace/generated artifacts and IM sends must retain request-correlated audits without storage paths',
  )
  requireCondition(
    /failure-code-retryability-classification/.test(
      await readFile(path.resolve(root, 'server/src/scripts/aiTaskLifecycleAcceptance.ts'), 'utf8'),
    )
    && /retry-exhaustion-enters-persistent-dead-letter/.test(leadScoreLifecycleAcceptance)
    && /retryable-primary-agent-failure-runs-one-configured-fallback-model/.test(leadScoringAuditAcceptance)
    && /controller\.abort\(\)/.test(
      await readFile(path.resolve(root, 'server/src/scripts/jwRestartRecoveryAcceptance.ts'), 'utf8'),
    ),
    'Agent provider timeouts and rate failures must have bounded abort, retry classification, one fallback and persistent dead-letter contracts',
  )
  requireCondition(/assertRuntimeConfiguration\(\)/.test(serverEntry), 'unified entry must enforce runtime configuration before listening')
  for (const requiredProductionGuard of [
    'AUTH_SESSION_SECRET', 'JWT_SECRET', 'AUTH_COOKIE_SECURE', 'AUTH_ALLOWED_ORIGINS',
    'SEED_DEMO_USERS',
    'MODEL_CREDENTIAL_ENCRYPTION_KEY', 'MODEL_PROVIDER_ALLOWED_HOSTS',
  ]) {
    requireCondition(runtimeSafety.includes(requiredProductionGuard), `production config guard is missing: ${requiredProductionGuard}`)
  }
  requireCondition(
    /JW_GLOBAL_NEW_CONVERSATIONS_ENABLED/.test(jwConversationRolloutPolicy)
    && /JW_PROJECT_NEW_CONVERSATIONS_ENABLED/.test(jwConversationRolloutPolicy)
    && /fallbackRuntime: null/.test(jwConversationRolloutPolicy)
    && /JW_GLOBAL_NEW_CONVERSATIONS_DISABLED/.test(jwConversationRolloutPolicy)
    && /JW_PROJECT_NEW_CONVERSATIONS_DISABLED/.test(jwConversationRolloutPolicy)
    && /assertNewJwConversationAllowed\(scope\)/.test(conversationService)
    && /existing-mysql-conversation-readable-and-writable-after-new-admission-disabled/.test(jwConversationRolloutAcceptance)
    && /conversation-create-path-has-no-retired-runtime-import-or-proxy/.test(jwConversationRolloutAcceptance)
    && packageJson.scripts?.['accept:jw-conversation-rollout']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/jwConversationRolloutAcceptance.ts'
    && releaseGatePolicyCovers('accept:jw-conversation-rollout')
    && /ensure_env_value "\$ENV_FILE" "JW_GLOBAL_NEW_CONVERSATIONS_ENABLED"/.test(deploy)
    && /ensure_env_value "\$ENV_FILE" "JW_PROJECT_NEW_CONVERSATIONS_ENABLED"/.test(deploy),
    'JW global/project new-conversation rollout must be independent, fail closed and have no retired runtime fallback',
  )
  requireCondition(
    /AI_CAPABILITIES_ENABLED/.test(extensionFeatureFlags)
    && /IM_INTEGRATIONS_ENABLED/.test(extensionFeatureFlags)
    && /must be true or false/.test(extensionFeatureFlags)
    && /requireAiCapabilitiesEnabled/.test(aiCapabilityRoutes)
    && /requireImIntegrationsEnabled/.test(imIntegrationRoutes)
    && /requireImIntegrationsEnabled/.test(leadPushTargetsRoutes)
    && /resolveExtensionFeatureFlags\(\)\.imIntegrationsEnabled/.test(runtimeJobScheduler)
    && /builtin:agent:interactive-assistant/.test(aiCapabilityService)
    && /toolNames:\s*\[\]/.test(aiCapabilityService)
    && /disabled-capabilities-fall-back-to-tool-free-core-agent/.test(extensionFeatureFlagsAcceptance)
    && /disabled-im-management-inbound-and-lead-push-apis-fail-closed/.test(extensionFeatureFlagsAcceptance)
    && packageJson.scripts?.['accept:extension-feature-flags']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/extensionFeatureFlagsAcceptance.ts'
    && releaseGatePolicyCovers('accept:extension-feature-flags')
    && /ensure_env_value "\$ENV_FILE" "AI_CAPABILITIES_ENABLED"/.test(deploy)
    && /ensure_env_value "\$ENV_FILE" "IM_INTEGRATIONS_ENABLED"/.test(deploy),
    'AI capability and IM extensions must have independent strict rollback flags with fail-closed APIs and safe core fallback',
  )
  requireCondition(
    /cybernaut-app\.service/.test(architectureHandoff)
    && /server\/src\/runtime\/jwAgentRuntime\.ts/.test(architectureHandoff)
    && /server\/src\/services\/runtimeJobScheduler\.ts/.test(architectureHandoff)
    && !/cybernaut-assistant\/src\/agents\/assistant\.ts/.test(architectureHandoff)
    && !/runtimeSchedulerService\.ts|agentConversationService\.ts|PostInvestmentPage\.tsx/.test(architectureHandoff)
    && /项目业务部署单元只有 `cybernaut-app\.service`/.test(singleServiceOperationsManual)
    && /AI_CAPABILITIES_ENABLED=false/.test(singleServiceOperationsManual)
    && /IM_INTEGRATIONS_ENABLED=false/.test(singleServiceOperationsManual)
    && /不启动 `cybernaut-flue`/.test(singleServiceOperationsManual)
    && /3584\/8121 无输出/.test(singleServiceOperationsManual),
    'single-service architecture handoff and fault manual must match the current runtime, rollback flags and retired ports',
  )
  requireCondition(
    !/密码均为 `123456`|演示账号（密码/.test(readme)
    && /rotate:user-password/.test(readme)
    && /audit:password-hashes/.test(readme),
    'README must not publish shared weak credentials and must point to the controlled password release gate',
  )
  const schemaTableNames = [...databaseSchema.matchAll(/mysqlTable\('([a-z0-9_]+)'/g)]
    .map((match) => match[1])
    .sort()
  const erDomainCatalog = mysqlSchemaErDocument.match(/## 2\. 领域表目录([\s\S]+?)上述目录共 87 张业务表/)
  requireCondition(erDomainCatalog, 'MySQL ER document must contain the complete 87-table domain catalog')
  const erTableNames = [...erDomainCatalog[1].matchAll(/`([a-z][a-z0-9_]*)`/g)]
    .map((match) => match[1])
    .sort()
  requireCondition(
    schemaTableNames.length === 87
    && erTableNames.length === 87
    && schemaTableNames.every((table, index) => table === erTableNames[index]),
    'MySQL ER domain catalog must exactly match all 86 logical tables in server/src/db/schema.ts',
  )
  requireCondition(
    drizzleMigrationFiles.length === 44
    && drizzleMigrationFiles[0] === '0000_mysql_baseline.sql'
    && drizzleMigrationFiles.at(-1) === '0043_add_radar_dingtalk_settings.sql'
    && ['sbl_projects', 'sbl_meetings', 'sbl_todos', 'sbl_risks']
      .every((table) => businessOptimisticVersionMigration.includes(`ALTER TABLE \`${table}\` ADD COLUMN \`version\``))
    && /ADD COLUMN `field_provenance` json NOT NULL/.test(leadFieldProvenanceMigration)
    && /'legacy_import'/.test(leadFieldProvenanceMigration)
    && (mysqlSchemaErDocument.match(/```mermaid\s+erDiagram/g) || []).length >= 2
    && /87 张业务表 \+ 1 张迁移台账、143 个物理外键、44 条迁移日志/.test(mysqlSchemaErDocument)
    && /生产源盘点、在线 PostgreSQL/.test(mysqlSchemaErDocument)
    && /MySQL-Schema与ER说明-20260810\.md/.test(architectureHandoff),
    'MySQL schema/ER handoff must bind the live migration range, relationship diagrams, current structural evidence and unresolved external blockers',
  )
  for (const deliverable of ['DEL-003', 'DEL-004', 'DEL-005', 'DEL-006', 'DEL-007', 'DEL-009', 'DEL-010', 'DEL-013', 'DEL-015', 'DEL-016', 'DEL-017']) {
    requireCondition(
      stagedDeliverableEvidence.includes(`## ${deliverable}`),
      `staged delivery evidence index is missing: ${deliverable}`,
    )
  }
  requireCondition(
    /migratePostgresToMySql\.ts/.test(heterogeneousSourceMigrationReport)
    && /migratePostgresDumpToMySql\.ts/.test(heterogeneousSourceMigrationReport)
    && /migratePostgresCdcToMySql\.ts/.test(heterogeneousSourceMigrationReport)
    && /migrateJwSqliteToMySql\.ts/.test(heterogeneousSourceMigrationReport)
    && /migrateFlueSqliteToMySql\.ts/.test(heterogeneousSourceMigrationReport)
    && /16 表、16,574 行/.test(heterogeneousSourceMigrationReport)
    && /37 个 Aipin 会话\/2,168 条消息全部拒绝/.test(heterogeneousSourceMigrationReport)
    && /fullMigrationReady=false/.test(heterogeneousSourceMigrationReport)
    && /在线 PostgreSQL 仍不可连接/.test(heterogeneousSourceMigrationReport)
    && /- \[ \] `MIG-0702`/.test(migrationExecutionChecklist)
    && /- \[ \] `MIG-0715`/.test(migrationExecutionChecklist)
    && /- \[ \] `MIG-0716`/.test(migrationExecutionChecklist)
    && /- \[ \] `MIG-0717`/.test(migrationExecutionChecklist)
    && /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/.test(postgresMigration)
    && /--checkpointed-apply/.test(postgresDumpMigration)
    && /const APPROVED_CONVERSATION_SOURCES = \[\] as const/.test(jwSqliteMigration)
    && /writeDefaultEvidence/.test(flueMigration)
    && packageJson.scripts?.['accept:legacy-source-backups']
    && packageJson.scripts?.['accept:migration-source-allowlist']
    && packageJson.scripts?.['accept:jw-sqlite-migration']
    && packageJson.scripts?.['check:flue-migration']
    && packageJson.scripts?.['accept:postgres-cdc'],
    'DEL-003 heterogeneous migration handoff must bind every importer and current report while preserving incomplete production source gates',
  )
  requireCondition(
    /sendJwAgentMessage/.test(jwRuntime)
    && /getJwAgentSnapshot/.test(jwRuntime)
    && /recoverInterruptedJwAgentSessions/.test(jwRuntime)
    && /shutdownJwAgentRuntime/.test(jwRuntime)
    && packageJson.scripts?.['accept:jw-runtime-boundary']
    && packageJson.scripts?.['accept:jw-restart']
    && packageJson.scripts?.['accept:jw-tool-lifecycle'],
    'DEL-004 modular JW Runtime must retain message, snapshot, recovery, shutdown and acceptance boundaries',
  )
  requireCondition(
    /export function useJwAgent/.test(jwAgentHook)
    && /socket\.on\('agent:snapshot'/.test(jwAgentHook)
    && /setInterval/.test(jwAgentHook)
    && /normalizeAgentMessages/.test(aiMessageSafety)
    && /normalizeAgentPart/.test(aiMessageSafety)
    && /normalizeAgentMessages\(agent\.messages\)/.test(aiAssistantPage)
    && /正式 Hook 名称是 `useJwAgent`/.test(stagedDeliverableEvidence),
    'DEL-005 React JW hook and untrusted message conversion layer must remain connected under the canonical name',
  )
  for (const profile of [
    'lead-subject-agent', 'lead-research-agent', 'lead-screening-agent', 'lead-scoring-agent', 'lead-enrichment-agent',
  ]) {
    requireCondition(
      stagedDeliverableEvidence.includes(`\`${profile}\``)
      && (leadSubjectAgentService.includes(profile) || leadScoringAgentService.includes(profile) || leadWorkflowAgentService.includes(profile)),
      `DEL-006 is missing approved lead Agent profile: ${profile}`,
    )
  }
  requireCondition(
    packageJson.scripts?.['accept:lead-subject-agent']
    && packageJson.scripts?.['accept:lead-scoring-agent']
    && packageJson.scripts?.['accept:lead-workflow-agents']
    && packageJson.scripts?.['accept:lead-agent-runtime-guard'],
    'DEL-006 five lead Agent profiles must retain specialist and shared runtime-guard acceptance entrypoints',
  )
  requireCondition(
    /server-stable-identity/.test(projectKnowledgeTools)
    && /LEAD_RESEARCH_HOST_TOOLS/.test(leadResearchTools)
    && /verifyLeadPipelineRawEvent/.test(leadResearchTools)
    && /AGENT_CREATABLE_AI_TASK_TYPES/.test(agentAiTaskTools)
    && /deterministicIdempotencyKey/.test(agentAiTaskTools)
    && packageJson.scripts?.['accept:project-knowledge-tools']
    && packageJson.scripts?.['accept:lead-public-intel']
    && packageJson.scripts?.['accept:agent-ai-task-tools'],
    'DEL-007 project knowledge, lead research and professional task tools must retain host authorization and acceptance boundaries',
  )
  requireCondition(
    /writeAudit/.test(await readFile(path.resolve(root, 'server/src/services/auditService.ts'), 'utf8'))
    && /createCipheriv\('aes-256-gcm'/.test(aiModelCredentialCrypto)
    && /createCipheriv\('aes-256-gcm'/.test(imIntegrationCrypto)
    && /authenticateHttpRequest/.test(sessionAuthService)
    && packageJson.scripts?.['accept:auth']
    && packageJson.scripts?.['accept:identity-administration']
    && packageJson.scripts?.['accept:log-redaction']
    && /5 个真实弱密码/.test(stagedDeliverableEvidence),
    'DEL-009 unified identity, encrypted credentials and immutable audit delivery must stay implemented without hiding pending real password rotation',
  )
  requireCondition(
    /saveProjectFile/.test(projectFileStorage)
    && /openProjectFile/.test(projectFileStorage)
    && /assertSafeOoxml/.test(projectFileValidation)
    && /FILE_SIGNATURE_MISMATCH/.test(projectFileValidation)
    && /code: 'BAD_PATH'/.test(workspaceRoutes)
    && packageJson.scripts?.['accept:project-file-integrity']
    && packageJson.scripts?.['accept:resources']
    && packageJson.scripts?.['accept:security-boundary']
    && /17 个项目原件已按精确 ID 批准永久缺失/.test(stagedDeliverableEvidence)
    && /7 个 AI 产物源文件及生产全量 manifest 仍未闭环/.test(stagedDeliverableEvidence),
    'DEL-010 file workspace security delivery must retain content, path, archive, authorization and historical-gap boundaries',
  )
  requireCondition(
    /当前严格排除结果/.test(jwAipinExclusionHandoff)
    && aipinEvidenceCounts(jwAipinExclusionHandoff) !== null
    && aipinEvidenceCounts(jwAipinExclusionHandoff) === aipinEvidenceCounts(stagedDeliverableEvidence)
    && /37 个拒绝会话\/2,168 条消息/.test(jwAipinExclusionHandoff)
    && /不替代尚未完成的生产源资产盘点/.test(jwAipinExclusionHandoff)
    && /targetRowsWrittenFromExcludedSource/.test(aipinExclusionAudit)
    && /AIPIN_SOURCE_REJECTED/.test(migrationSourceAllowlistAcceptance)
    && /AIPIN_TABLE_REJECTED/.test(migrationSourceAllowlistAcceptance)
    && /targetBusinessRowsChanged:\s*0/.test(jwSqliteMigrationAcceptance)
    && /- \[ \] `MIG-0017`/.test(migrationExecutionChecklist)
    && /- \[ \] `MIG-0018`/.test(migrationExecutionChecklist)
    && /- \[ \] `MIG-0019`/.test(migrationExecutionChecklist)
    && packageJson.scripts?.['check:aipin-exclusion']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/aipinExclusionAudit.ts --strict'
    && packageJson.scripts?.['accept:migration-source-allowlist']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/migrationSourceAllowlistAcceptance.ts',
    'DEL-013 JW allowlist and Aipin exclusion handoff must bind strict code/source/target evidence without claiming unknown production sources are absent',
  )
  requireCondition(
    /没有实现 MySQL→PostgreSQL 反向 CDC/.test(postgresCdcCutoverManual)
    && /反向变更与回滚窗口矩阵/.test(postgresCdcCutoverManual)
    && /身份与权限/.test(postgresCdcCutoverManual)
    && /项目与 OA/.test(postgresCdcCutoverManual)
    && /线索与 Radar/.test(postgresCdcCutoverManual)
    && /会话与消息/.test(postgresCdcCutoverManual)
    && /AI 任务与模板/.test(postgresCdcCutoverManual)
    && /文件与产物/.test(postgresCdcCutoverManual)
    && /Point of No Return/.test(postgresCdcCutoverManual)
    && /前向修复/.test(postgresCdcCutoverManual)
    && /check:migration-reconciliation/.test(postgresCdcCutoverManual)
    && /sourceCaptureRuntimeVerified=false/.test(stagedDeliverableEvidence)
    && /- \[ \] `MIG-0702`/.test(migrationExecutionChecklist)
    && /\| \[ \] \| CUT-014/.test(migrationAcceptanceChecklist)
    && /\| \[ \] \| CUT-015/.test(migrationAcceptanceChecklist)
    && /\| \[ \] \| CUT-016/.test(migrationAcceptanceChecklist)
    && packageJson.scripts?.['accept:postgres-cdc']
    && packageJson.scripts?.['migrate:postgres-cdc:preview']
    && packageJson.scripts?.['migrate:postgres-cdc'],
    'DEL-015 CDC handoff must document one-way authority, six-domain write freeze, drift reconciliation and forward repair without closing production cutover gates',
  )
  requireCondition(
    /OA 审批 \| 已正式迁移/.test(adjacentDomainMigrationRetirementReport)
    && /投后更新 \| 明确退场/.test(adjacentDomainMigrationRetirementReport)
    && /通知\/已读 \| 明确退场/.test(adjacentDomainMigrationRetirementReport)
    && /旧材料记录\/页面 \| 页面退场，材料能力合并/.test(adjacentDomainMigrationRetirementReport)
    && /组织\/角色\/字典 \| 已正式迁移（后续批准取代原退场结论）/.test(adjacentDomainMigrationRetirementReport)
    && /0036_add_system_administration/.test(adjacentDomainMigrationRetirementReport)
    && /0037_activate_system_permissions/.test(adjacentDomainMigrationRetirementReport)
    && /内置 AI 模板 \| 已正式迁移，系统页只读/.test(adjacentDomainMigrationRetirementReport)
    && /Radar 服务 \| 已并入主服务，独立服务退场/.test(adjacentDomainMigrationRetirementReport)
    && /Radar 非库资产 \| 技术盘点完成，四方批准待完成/.test(adjacentDomainMigrationRetirementReport)
    && /6,176 条候选、6,975 条原始事件和 1,312 个来源注册/.test(adjacentDomainMigrationRetirementReport)
    && /产品、研发、运维、数据四方稳定身份批准仍未完成/.test(adjacentDomainMigrationRetirementReport)
    && /9,903[^\n]*不可变事件/.test(adjacentDomainMigrationRetirementReport)
    && /97[^\n]*`source_missing`/.test(adjacentDomainMigrationRetirementReport)
    && /MIG-0719\/0728.*保持未通过/.test(adjacentDomainMigrationRetirementReport)
    && /path="\/materials" element=\{<Navigate to="\/ai" replace \/>\}/.test(clientRoutes)
    && /path="\/post-investment" element=\{<Navigate to="\/projects" replace \/>\}/.test(clientRoutes)
    && /unmigrated-local-only-pages-are-not-directly-reachable/.test(clientStateAcceptance)
    && /one-project-allows-only-one-active-request/.test(oaAcceptance)
    && /recordLeadPipelineRawEvent\(leadReserveRawEventInput\(row\), connection\)/.test(leadReserveIntakeService)
    && /- \[ \] `MIG-0719`/.test(migrationExecutionChecklist)
    && /- \[ \] `MIG-0728`/.test(migrationExecutionChecklist),
    'DEL-016 adjacent-domain handoff must bind each migration/retirement decision to live code and preserve production asset blockers',
  )
  requireCondition(
    /双提交 Token 与 Origin\/Referer/.test(stagedDeliverableEvidence)
    && /previous-secret/.test(stagedDeliverableEvidence)
    && /数据库 kill switch/.test(stagedDeliverableEvidence)
    && /AUTH_SESSION_PREVIOUS_SECRETS/.test(authSessionPolicy)
    && /CSRF_INVALID/.test(sessionAuthService)
    && packageJson.scripts?.['accept:auth-session-policy']
    && packageJson.scripts?.['accept:legacy-bearer-policy']
    && packageJson.scripts?.['accept:legacy-bearer-http-socket']
    && packageJson.scripts?.['accept:password-rotation'],
    'DEL-017 Cookie, CSRF, session lifecycle and key-rotation design must remain evidence-backed and production-rotation scoped',
  )
  for (const table of ['ai_model_providers', 'ai_models', 'ai_model_routes']) {
    requireCondition(databaseSchema.includes(`mysqlTable('${table}'`), `AI model settings schema is missing: ${table}`)
    requireCondition(aiModelMigration.includes(`sbl_${table}`), `AI model settings migration is missing: sbl_${table}`)
  }
  requireCondition(
    /credential_ciphertext/.test(aiModelMigration)
    && /fk_ai_models_provider/.test(aiModelMigration)
    && /fk_ai_model_routes_model/.test(aiModelMigration)
    && /fk_ai_model_routes_fallback/.test(aiModelMigration),
    'AI model credentials and routing must be persisted with encrypted fields and foreign keys',
  )
  requireCondition(
    /createCipheriv\('aes-256-gcm'/.test(aiModelCredentialCrypto)
    && /cipher\.setAAD\(Buffer\.from\(context/.test(aiModelCredentialCrypto)
    && /createDecipheriv\('aes-256-gcm'/.test(aiModelCredentialCrypto)
    && /MODEL_CREDENTIAL_ENCRYPTION_KEY/.test(aiModelCredentialCrypto),
    'AI model credentials must use environment-keyed AES-256-GCM with provider-bound AAD',
  )
  requireCondition(
    /credentialCiphertext: _ciphertext/.test(aiModelSettingsService)
    && /credentialFingerprint: _fingerprint/.test(aiModelSettingsService)
    && /credentialMasked/.test(aiModelSettingsService)
    && /aiConfigurationRepository\.updateProviderWithAudit/.test(aiModelSettingsService)
    && /aiConfigurationRepository\.updateModelWithAudit/.test(aiModelSettingsService)
    && /aiConfigurationRepository\.upsertRouteWithAudit/.test(aiModelSettingsService)
    && !/from ['"](?:drizzle-orm|\.\.\/db\/)/.test(aiModelSettingsService)
    && /assertAiModelAdmin/.test(aiModelSettingsService)
    && /normalizeModelProviderUrl/.test(aiModelSettingsService)
    && /MODEL_PROVIDER_ALLOWED_HOSTS/.test(aiModelSettingsService)
    && /resolveAiModelRoute/.test(aiModelSettingsService)
    && /测试 Provider 连接/.test(aiModelSettingsService),
    'AI model management must mask credentials, authorize administrators, version writes, restrict providers, route models, and audit tests',
  )
  requireCondition(
    /get\('\/available'/.test(aiModelSettingsRoutes)
    && /use\(requireAiPlatformAdmin\)/.test(aiModelSettingsRoutes)
    && /post\('\/providers\/:id\/test'/.test(aiModelSettingsRoutes)
    && /aiModelSettingsRouter/.test(routeIndex),
    'AI model settings API must expose role-filtered models and protect every management endpoint',
  )
  requireCondition(
    /path="\/system\/ai\/models"/.test(clientRoutes)
    && /AiPlatformAdminOnly/.test(clientRoutes)
    && /to: '\/system\/ai\/models'/.test(clientLayout)
    && /roles: \['系统管理员', 'AI平台管理员', 'AI 平台管理员'\]/.test(clientLayout)
    && /管理模型提供商、访问凭据、可用模型与任务路由/.test(modelSettingsPage)
    && /模型提供商/.test(modelSettingsPage)
    && /任务模型路由/.test(modelSettingsPage)
    && /不替换当前密钥/.test(modelSettingsPage),
    'React model settings route, role-scoped navigation, provider, credential, model and profile controls are missing',
  )
  requireCondition(
    /\/ai\/model-settings\/available/.test(aiAssistantPage)
    && /modelId: newSessionModelId \|\| null/.test(aiAssistantPage)
    && /listAvailableModels\(input\.userRole/.test(conversationService)
    && /modelId: input\.modelId \|\| null/.test(conversationService),
    'AI assistant must list only authorized enabled models and persist a validated model selection',
  )
  requireCondition(
    /selected \|\| await resolveAiModelRoute\(modelRouteKey, userRole\)/.test(jwRuntime)
    && /resolveAiModelById\(modelId, userRole\)/.test(jwRuntime)
    && /resolveAiModelRoute\(policy\.modelRouteKey\)/.test(inProcessAiWorkflowService)
    && /resolveAiModelRoute\(policy\.modelRouteKey\)/.test(leadSubjectAgentService)
    && /resolveAiModelRoute\(policy\.modelRouteKey\)/.test(leadScoringAgentService)
    && /resolveAiModelRoute\(policy\.modelRouteKey\)/.test(leadWorkflowAgentService),
    'interactive, document and all lead Agent runtimes must resolve MySQL model routes',
  )
  for (const contract of [
    'aes-256-gcm-credential-roundtrip-and-aad-binding',
    'production-provider-https-and-host-allowlist-enforced',
    'mysql-ciphertext-never-contains-plaintext-api-key',
    'provider-list-returns-mask-not-ciphertext-or-fingerprint',
    'credential-is-replace-only-with-optimistic-versioning',
    'system-or-ai-platform-admin-required',
    'enabled-model-role-filtering',
    'mysql-profile-route-resolves-server-side-credential',
    'document-runtime-uses-mysql-model-route',
    'server-side-provider-connection-test-is-traceable',
    'disabled-model-is-not-listed-and-route-falls-back',
    'model-provider-route-and-test-changes-are-audited-without-secrets',
  ]) {
    requireCondition(aiModelSettingsAcceptance.includes(contract), `AI model settings acceptance is missing: ${contract}`)
  }
  requireCondition(
    packageJson.scripts?.['accept:ai-model-settings']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/aiModelSettingsAcceptance.ts'
    && releaseGatePolicyCovers('accept:ai-model-settings')
    && /ensure_env_value "\$ENV_FILE" "MODEL_CREDENTIAL_ENCRYPTION_KEY"/.test(deploy)
    && /ensure_env_value "\$ENV_FILE" "MODEL_PROVIDER_ALLOWED_HOSTS"/.test(deploy),
    'production release must run the encrypted model settings, authorization, routing and connection gate',
  )
  for (const table of ['ai_capabilities', 'ai_capability_bindings', 'ai_conversation_capabilities']) {
    requireCondition(databaseSchema.includes(`mysqlTable('${table}'`), `AI capability schema is missing: ${table}`)
    requireCondition(aiCapabilityMigration.includes(`sbl_${table}`), `AI capability migration is missing: sbl_${table}`)
  }
  requireCondition(
    /assertAiCapabilityAdmin/.test(aiCapabilityService)
    && /requireAccessibleProject/.test(aiCapabilityService)
    && /CAPABILITY_FORBIDDEN/.test(aiCapabilityService)
    && /AI_CAPABILITY_CATALOG/.test(aiCapabilityService)
    && /deleteCapability/.test(aiCapabilityService)
    && /deleteSkill/.test(aiCapabilityService)
    && /updateAgentCapabilityPolicy/.test(aiCapabilityService)
    && /resolveAgentRuntimePolicy/.test(aiCapabilityService)
    && /AGENT_TOOL_NOT_APPROVED/.test(aiCapabilityService)
    && /PLUGIN_NOT_APPROVED/.test(aiCapabilityService)
    && /installUploadedPlugin/.test(aiCapabilityService)
    && /PLUGIN_TOOL_NOT_APPROVED/.test(aiCapabilityService)
    && /pluginInventory/.test(aiCapabilityService)
    && /dynamicInstallEnabled:\s*true/.test(aiCapabilityService)
    && /Math\.min\(policy\.maxBudgetUsd/.test(leadScoringAgentService)
    && /Math\.min\(policy\.timeoutMs/.test(inProcessAiWorkflowService)
    && /return selected\.filter\(\(item\) => AI_CAPABILITY_CATALOG\.some/.test(aiCapabilityService)
    && /item\.kind === 'plugin' && item\.source === 'uploaded'/.test(aiCapabilityService)
    && /resolveSelectedRuntimeCapabilities/.test(jwRuntime)
    && /hostInvestmentEnabled \? \{ investment: investmentTools \} : \{\}/.test(jwRuntime)
    && /selectedSkillsAllowAiTask\(selectedSkillNames, type\)/.test(jwRuntime),
    'capability service must enforce admin, role/project scope, non-escalating conversation selection and runtime code whitelist',
  )
  requireCondition(
    /get\('\/available'/.test(aiCapabilityRoutes)
    && /put\('\/conversations\/:conversationId'/.test(aiCapabilityRoutes)
    && /patch\('\/agents\/:id\/policy'/.test(aiCapabilityRoutes)
    && /delete\('\/skills\/:id'/.test(aiCapabilityRoutes)
    && /delete\('\/:id'/.test(aiCapabilityRoutes)
    && /z\.enum\(AI_MODEL_PROFILE_KEYS\)/.test(aiCapabilityRoutes)
    && /use\(requireAiPlatformAdmin\)/.test(aiCapabilityRoutes)
    && /aiCapabilitiesRouter/.test(routeIndex),
    'capability API must expose scoped reads/selections and protect management endpoints',
  )
  requireCondition(
    /path="\/system\/ai\/capabilities"/.test(clientRoutes)
    && /to: '\/system\/ai\/capabilities'/.test(clientLayout)
    && /Skills/.test(capabilitySettingsPage)
    && /Agents/.test(capabilitySettingsPage)
    && /MCP/.test(capabilitySettingsPage)
    && /Plugins/.test(capabilitySettingsPage)
    && /动态安装已开放/.test(capabilitySettingsPage)
    && /可安装/.test(capabilitySettingsPage)
    && /item\.dependencyNames/.test(capabilitySettingsPage)
    && /Agent 运行策略/.test(capabilitySettingsPage)
    && /approvedToolNamesByCapability/.test(capabilitySettingsPage)
    && /确认删除 \$\{pendingDelete \? capabilityKindLabels\[pendingDelete\.kind\] : '能力'\}/.test(capabilitySettingsPage)
    && /apiDelete\(`\/ai\/capabilities\/\$\{pendingDelete\.id\}/.test(capabilitySettingsPage)
    && /\/ai\/capabilities\/conversations\//.test(aiAssistantPage)
    && /data-ai-capability-trigger="true"/.test(aiAssistantPage)
    && /选择当前会话持续使用的技能/.test(aiAssistantPage)
    && /saveConversationCapabilities/.test(aiAssistantPage),
    'React capability management and authorized conversation capability selector are missing',
  )
  for (const contract of [
    'builtin-catalog-idempotent-and-no-invented-plugin',
    'admin-service-boundary',
    'unapproved-plugin-is-visible-as-uninstalled-but-cannot-enable-bind-or-run',
    'uploaded-plugin-is-installed-and-runtime-selectable',
    'structured-agent-policy-is-admin-only-and-code-bounded',
    'builtin-sync-preserves-structured-agent-policy',
    'global-department-project-bindings',
    'department-and-project-isolation',
    'conversation-selection-cannot-grant',
    'runtime-selection-is-approved-code-only',
    'all-capability-kinds-delete-is-admin-only-versioned-and-cascades-selections',
    'document-task-requires-selected-skill',
    'disable-capability-effective-immediately',
    'approved-skill-server-test-and-trace',
    'deleted-builtin-capability-kinds-stay-hidden-on-startup-ensure-and-can-be-manually-synced',
    'audit-recorded-without-runtime-secret',
  ]) requireCondition(aiCapabilityAcceptance.includes(contract), `AI capability acceptance is missing: ${contract}`)
  requireCondition(
    packageJson.scripts?.['accept:ai-capabilities']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/aiCapabilityAcceptance.ts'
    && releaseGatePolicyCovers('accept:ai-capabilities'),
    'production release must run the AI capability authorization and runtime gate',
  )
  for (const table of ['im_bots', 'im_bot_bindings', 'im_outbox', 'im_delivery_logs', 'im_inbound_messages']) {
    requireCondition(databaseSchema.includes(`mysqlTable('${table}'`), `IM integration schema is missing: ${table}`)
    requireCondition(imIntegrationMigration.includes(`sbl_${table}`), `IM integration migration is missing: sbl_${table}`)
  }
  requireCondition(
    databaseSchema.includes("mysqlTable('im_lead_push_rules'")
    && imLeadPushRuleMigration.includes('sbl_im_lead_push_rules')
    && /fk_im_lead_push_rules_binding/.test(imLeadPushRuleMigration)
    && /fk_im_lead_push_rules_project/.test(imLeadPushRuleMigration),
    'lead push rules must be MySQL-authoritative and foreign-keyed to an authorized IM binding and stable project',
  )
  requireCondition(
    /createCipheriv\('aes-256-gcm'/.test(imIntegrationCrypto)
    && /cipher\.setAAD\(Buffer\.from\(context/.test(imIntegrationCrypto)
    && /INTEGRATION_CREDENTIAL_ENCRYPTION_KEY/.test(imIntegrationCrypto)
    && /credentialCiphertext: _ciphertext/.test(imIntegrationService)
    && /credentialFingerprint: _fingerprint/.test(imIntegrationService),
    'IM credentials must use environment-keyed AES-256-GCM with bot-bound AAD and masked responses',
  )
  requireCondition(
    /FOR UPDATE SKIP LOCKED/.test(mysqlImIntegrationRepository)
    && /o\.status='sending'/.test(mysqlImIntegrationRepository)
    && /lease_expires_at < NOW\(3\)/.test(mysqlImIntegrationRepository)
    && /dead_letter/.test(mysqlImIntegrationRepository)
    && /rateLimitPerMinute/.test(imIntegrationService)
    && /redirect: 'error'/.test(imIntegrationService)
    && /timingSafeEqual/.test(imIntegrationService),
    'IM outbox must use bounded lease recovery, retry/dead-letter/rate limiting, redirect-safe webhooks and constant-time inbound secrets',
  )
  requireCondition(
    /imIntegrationsRouter\.get\('\/'/.test(imIntegrationRoutes)
    && /requireImAdmin/.test(imIntegrationRoutes)
    && /imInboundRouter\.post\('\/:botId'/.test(imIntegrationRoutes)
    && /apiRouter\.use\('\/integrations\/im'/.test(routeIndex)
    && /processImOutboxBatch/.test(runtimeJobScheduler),
    'IM management, public signed inbound callback and in-process outbox scheduler must share the unified service',
  )
  requireCondition(
    /leadPushTargetsRouter\.use\(requireImAdmin\)/.test(leadPushTargetsRoutes)
    && /dispatchLeadPushRule/.test(leadPushTargetsRoutes)
    && /apiRouter\.use\('\/investment\/leads\/push-targets'/.test(routeIndex)
    && /listLeadPushSettings/.test(imIntegrationService)
    && /credentialCiphertext: _ciphertext/.test(imIntegrationService),
    'lead-pool push rules must expose only an admin API over safe target metadata and dispatch through the unified IM outbox',
  )
  requireCondition(
    /path="\/system\/integrations\/im-bots"/.test(clientRoutes)
    && /ImAdminOnly/.test(clientRoutes)
    && /to: '\/system\/integrations\/im-bots'/.test(clientLayout)
    && /roles: \['系统管理员', '运营管理员'\]/.test(clientLayout)
    && /Outbox 与投递日志/.test(imBotsPage)
    && /替换凭据/.test(imBotsPage)
    && !/渠道与推送配置/.test(sourcingPage)
    && !/\/investment\/leads\/push-targets/.test(sourcingPage),
    'React IM management route, scoped navigation, encrypted credential replacement, binding and delivery controls are missing or the lead-pool push entry was not removed',
  )
  for (const contract of [
    'system-or-operations-admin-required-at-service-boundary',
    'safe-mock-is-explicitly-production-gated',
    'credentials-encrypted-with-aad-and-list-is-masked',
    'binding-requires-stable-user-project-and-conversation-match',
    'authorized-outbox-and-idempotency-conflict-boundary',
    'outbox-success-log-rate-limit-and-finite-retry',
    'expired-sending-lease-is-recovered',
    'im-delivery-failure-isolated-from-core-and-subsequent-work',
    'inbound-secret-route-and-replay-are-authorized-and-idempotent',
    'lead-pool-rules-reference-only-enabled-authorized-targets-and-dispatch-matched-leads',
    'connection-credential-replacement-disable-impact-and-history-protection',
    'configuration-connection-binding-and-send-actions-are-audited-without-secrets',
  ]) requireCondition(imIntegrationAcceptance.includes(contract), `IM integration acceptance is missing: ${contract}`)
  requireCondition(
    packageJson.scripts?.['accept:im-integrations']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/imIntegrationAcceptance.ts'
    && releaseGatePolicyCovers('accept:im-integrations')
    && /ensure_env_value "\$ENV_FILE" "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY"/.test(deploy)
    && /INTEGRATION_CREDENTIAL_ENCRYPTION_KEY/.test(runtimeSafety),
    'production release must configure and run the encrypted IM authorization, routing and delivery gate',
  )
  requireCondition(
    /START TRANSACTION WITH CONSISTENT SNAPSHOT/.test(mysqlBackupRestoreAcceptance)
    && /GET_LOCK/.test(mysqlBackupRestoreAcceptance)
    && /cybernaut-mysql-logical-backup/.test(mysqlBackupRestoreAcceptance)
    && /mode: 0o600/.test(mysqlBackupRestoreAcceptance)
    && /rb_accept_/.test(mysqlBackupRestoreAcceptance)
    && /normalizeDdl/.test(mysqlBackupRestoreAcceptance)
    && /tableRowChecksum/.test(mysqlBackupRestoreAcceptance)
    && /restoreLogicalBackupToPrefix/.test(mysqlBackupRestoreAcceptance)
    && /dropRollbackPrefix/.test(mysqlBackupRestoreAcceptance)
    && /isolatedPrefixRemoved/.test(mysqlBackupRestoreAcceptance)
    && /backupRemovedAfterAcceptance/.test(mysqlBackupRestoreAcceptance)
    && /restore exceeded/.test(mysqlBackupRestoreAcceptance)
    && /同一数据库的随机隔离前缀/.test(mysqlBackupRestoreHandoff)
    && /Migration 账号/.test(mysqlBackupRestoreHandoff)
    && /不需要 `CREATE\/DROP DATABASE`/.test(mysqlBackupRestoreHandoff)
    && !/DB_RESTORE_USERNAME/.test(mysqlBackupRestoreHandoff)
    && packageJson.scripts?.['accept:mysql-backup-restore']
      === 'node --env-file-if-exists=.env --env-file-if-exists=.runtime/secrets/mysql-migration.env --import tsx server/src/scripts/mysqlBackupRestoreAcceptance.ts',
    'MySQL backup/restore drill must use a consistent snapshot, protected artifact, isolated schema, content verification and exact cleanup',
  )
  requireCondition(
    /AUTH_SESSION_PREVIOUS_SECRETS/.test(authSessionPolicy)
    && /AUTH_SESSION_MAX_ACTIVE/.test(authSessionPolicy)
    && /AUTH_SESSION_RENEW_WINDOW_PERCENT/.test(authSessionPolicy)
    && /FOR UPDATE/.test(authService)
    && /authSessionNeedsRenewal/.test(authService)
    && /renewAuthSession/.test(authService),
    'MySQL session policy must enforce serialized concurrency, bounded renewal and previous-secret rotation',
  )
  for (const contract of [
    'concurrent-session-limit-revokes-oldest-under-user-lock',
    'revoked-session-token-is-rejected',
    'previous-session-secret-remains-valid-during-rotation-window',
    'old-secret-session-renews-to-current-secret-and-rotates-csrf',
    'near-expiry-session-renews-with-configured-ttl',
  ]) {
    requireCondition(authSessionPolicyAcceptance.includes(contract), `auth session policy acceptance is missing: ${contract}`)
  }
  requireCondition(
    packageJson.scripts?.['accept:auth-session-policy']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/authSessionPolicyAcceptance.ts'
    && releaseGatePolicyCovers('accept:auth-session-policy'),
    'production release must run the MySQL auth session concurrency, renewal and secret rotation gate',
  )
  requireCondition(
    /AUTH_SESSION_KEY_ROTATION_STARTED_AT/.test(authSessionPolicy)
    && /currentSecretExplicitlyConfigured/.test(authSessionPolicy)
    && /recordPreviousAuthSessionKeyUseSafely/.test(authService)
    && /createHash\('sha256'\)/.test(authSessionKeyTelemetry)
    && /INSERT IGNORE INTO/.test(authSessionKeyTelemetry)
    && /user_id,user_name/.test(authSessionKeyTelemetry)
    && /NULL,'（系统）'/.test(authSessionKeyTelemetry)
    && !/sessionToken|csrfToken|currentSecret|previousSecrets/.test(authSessionKeyTelemetry)
    && /previousKeyMatches24h/.test(sessionAuthService)
    && /previousKeyMatchesSinceStart/.test(sessionAuthService)
    && /readyToRetirePreviousSecrets/.test(sessionAuthService)
    && /secretsExcluded: true/.test(sessionAuthService)
    && /tokensExcluded: true/.test(sessionAuthService)
    && /identitiesExcluded: true/.test(sessionAuthService)
    && /AUTH_SESSION_CURRENT_KEY_UNCONFIGURED/.test(operationalTelemetryService)
    && /AUTH_SESSION_KEY_ROTATION_UNTRACKED/.test(operationalTelemetryService)
    && /AUTH_SESSION_LEGACY_KEY_ACTIVITY/.test(operationalTelemetryService)
    && /AUTH_SESSION_PREVIOUS_KEYS_OVERDUE/.test(operationalTelemetryService)
    && /previous-key-match-increments-exactly-once-per-session-day/.test(authSessionKeyTelemetryAcceptance)
    && /previous-key-event-excludes-session-token-csrf-and-secrets/.test(authSessionKeyTelemetryAcceptance)
    && /session-key-telemetry-fixture-residue-is-zero/.test(authSessionKeyTelemetryAcceptance)
    && /mode: 0o600/.test(authSessionKeyTelemetryAcceptance)
    && /previousAuthSessionKeyTarget/.test(authSessionPolicyAcceptance)
    && /AUTH_SESSION_KEY_ROTATION_STARTED_AT=/.test(environmentExample)
    && /OPS_AUTH_PREVIOUS_KEY_MATCHES_24H_WARN=1/.test(environmentExample)
    && /ensure_env_value "\$ENV_FILE" "AUTH_SESSION_KEY_ROTATION_STARTED_AT"/.test(deploy)
    && /ensure_env_value "\$ENV_FILE" "OPS_AUTH_PREVIOUS_KEY_MATCHES_24H_WARN"/.test(deploy)
    && packageJson.scripts?.['accept:auth-session-key-telemetry']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/authSessionKeyRotationTelemetryAcceptance.ts'
    && releaseGatePolicyCovers('accept:auth-session-key-telemetry'),
    'session-key rotation telemetry must persist deduplicated hashed previous-key activity, expose lifecycle readiness and exclude all secrets, tokens and identities',
  )
  requireCondition(
    /beginHttpTelemetry/.test(serverEntry)
    && /pathLabelsExcluded: true/.test(httpTelemetry)
    && /p95Ms: percentile/.test(httpTelemetry)
    && /p99Ms: percentile/.test(httpTelemetry)
    && /get\('\/metrics', requireSystemAdmin/.test(operationsRoutes)
    && /use\('\/operations', operationsRouter\)/.test(routeIndex)
    && /operationalTelemetryRepository\.snapshot/.test(operationalTelemetryService)
    && /agentSocketHealth/.test(operationalTelemetryService)
    && /runtimeJobSchedulerHealth/.test(operationalTelemetryService)
    && /aiTaskWorkerHealth/.test(operationalTelemetryService)
    && /sensitiveValuesExcluded: true/.test(operationalTelemetryService)
    && /businessContentExcluded: true/.test(operationalTelemetryService)
    && /im_outbox/.test(operationalTelemetryRepository)
    && /lead_pipeline_runs/.test(operationalTelemetryRepository)
    && /migration_cdc_checkpoints/.test(operationalTelemetryRepository)
    && /lead_reserve/.test(operationalTelemetryRepository)
    && /radar_raw_events/.test(operationalTelemetryRepository)
    && /radar_candidates/.test(operationalTelemetryRepository)
    && /radar_collector_states/.test(operationalTelemetryRepository)
    && /radar_source_registry/.test(operationalTelemetryRepository)
    && /raw_event_missing/.test(operationalTelemetryRepository)
    && /migrationReadinessHealth/.test(operationalTelemetryService)
    && /file-assets\/status\.json/.test(migrationReadinessTelemetry)
    && /production-source-inventory\/report\.json/.test(migrationReadinessTelemetry)
    && /radar-lead-source-reconciliation\/report\.json/.test(migrationReadinessTelemetry)
    && /mysql-reconciliation\/report\.json/.test(migrationReadinessTelemetry)
    && /pathsExcluded: true/.test(migrationReadinessTelemetry)
    && /fileNamesExcluded: true/.test(migrationReadinessTelemetry)
    && /identitiesExcluded: true/.test(migrationReadinessTelemetry)
    && /businessContentExcluded: true/.test(migrationReadinessTelemetry)
    && /secretsExcluded: true/.test(migrationReadinessTelemetry)
    && /technicalReady: manifest\.technicalReady/.test(fileAssetInventory)
    && /--approve requires --strict/.test(fileAssetInventory)
    && /apiGet<OperationsSnapshot>\('\/operations\/metrics'\)/.test(operationsOverview)
    && /CDC watermark gap/.test(operationsOverview)
    && /Radar 候选 \/ 原始事件/.test(operationsOverview)
    && /文件 manifest/.test(operationsOverview)
    && /统一服务组件健康/.test(operationsOverview)
    && /'MySQL'/.test(operationsOverview)
    && /'Worker'/.test(operationsOverview)
    && /'Socket'/.test(operationsOverview)
    && /'Agent'/.test(operationsOverview)
    && /'IM'/.test(operationsOverview)
    && /workers\.length === 4/.test(operationsOverview)
    && /deliveryFailures15m/.test(operationsOverview)
    && /全量迁移未就绪/.test(operationsOverview)
    && /apiPost<[^>]+>\('\/leads\/sync-radar'/.test(operationsOverview)
    && /apiPost<[^>]+>\('\/operations\/radar\/wechat-accounts\/import'/.test(operationsOverview)
    && /apiPatch\(`\/operations\/radar\/(?:sources|jobs)\//.test(operationsOverview)
    && !/apiPut|apiDelete|setInterval/.test(operationsOverview)
    && /authenticationFailuresTotal/.test(agentSocketService)
    && /disconnectedTotal/.test(agentSocketService)
    && /operations-api-requires-system-admin/.test(operationalTelemetryAcceptance)
    && /migration-readiness-view-covers-file-source-radar-and-reconciliation-without-sensitive-evidence/.test(operationalTelemetryAcceptance)
    && /threshold-alert-/.test(operationalTelemetryAcceptance)
    && /当前本机未配置通知渠道和升级策略/.test(operationalTelemetryHandoff)
    && /不创建第二个服务、端口、cron、timer 或子进程/.test(operationalTelemetryHandoff)
    && packageJson.scripts?.['accept:operations-telemetry']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/operationalTelemetryAcceptance.ts'
    && releaseGatePolicyCovers('accept:operations-telemetry'),
    'single service must expose an admin-only content-free HTTP, Socket, MySQL, queue, IM, file, security and CDC telemetry snapshot with threshold acceptance',
  )
  requireCondition(
    /const apply = process\.argv\.slice\(2\)\.includes\('--apply'\)/.test(quarantineAiTemplateAcceptanceFixtures)
    && /expectedSlideText/.test(quarantineAiTemplateAcceptanceFixtures)
    && /sourceIdsAbsentFromTargetMysql: true/.test(quarantineAiTemplateAcceptanceFixtures)
    && /originalBytesRetainedInPrivateQuarantine: apply/.test(quarantineAiTemplateAcceptanceFixtures)
    && /checkCRC32: true/.test(quarantineAiTemplateAcceptanceFixtures)
    && /const apply = process\.argv\.slice\(2\)\.includes\('--apply'\)/.test(quarantineResourceAcceptanceArtifacts)
    && /ai-artifact-secret-/.test(quarantineResourceAcceptanceArtifacts)
    && /ownerAbsentFromTargetMysql: true/.test(quarantineResourceAcceptanceArtifacts)
    && /originalBytesRetainedInPrivateQuarantine: apply/.test(quarantineResourceAcceptanceArtifacts)
    && /shouldScanReportContent/.test(migrationEvidenceSafetyAcceptance)
    && /quarantineControlReports/.test(migrationEvidenceSafetyAcceptance)
    && /quarantine-originals-permission-only-and-control-reports-content-scanned/.test(migrationEvidenceSafetyAcceptance)
    && /templateDirectories: string\[\]/.test(aiTaskApiAcceptance)
    && /artifactStoragePath\) await rm\(path\.dirname\(artifactStoragePath\)/.test(resourceIsolationAcceptance)
    && packageJson.scripts?.['quarantine:ai-template-acceptance-fixtures']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/quarantineAiTemplateAcceptanceFixtures.ts'
    && packageJson.scripts?.['quarantine:resource-acceptance-artifacts']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/quarantineResourceAcceptanceArtifacts.ts',
    'known AI template and resource acceptance residues must be identified by exact content and absent MySQL ownership, remain dry-run by default, and move only to private recoverable quarantine',
  )
  requireCondition(
    /import \{ deleteProject \} from '\.\.\/services\/projectService\.js'/.test(browserUiAcceptanceFixture)
    && /for \(const project of ownedProjects\) await deleteProject\(project\.id, fixture\.adminId\)/.test(browserUiAcceptanceFixture)
    && /await db\.delete\(leads\)\.where\(eq\(leads\.id, fixture\.leadId\)\)/.test(browserUiAcceptanceFixture)
    && /transitionLeadPipelineItem/.test(browserUiAcceptanceFixture)
    && /browser acceptance fixture source removed after isolated UI verification/.test(browserUiAcceptanceFixture)
    && /db\.delete\(knowledgeChunks\)/.test(browserUiAcceptanceFixture)
    && /db\.delete\(identityResolutionIssues\)/.test(browserUiAcceptanceFixture)
    && /identityEntityIds/.test(browserUiAcceptanceFixture)
    && /db\.delete\(todos\)/.test(browserUiAcceptanceFixture)
    && /db\.delete\(meetings\)/.test(browserUiAcceptanceFixture)
    && /db\.delete\(risks\)/.test(browserUiAcceptanceFixture)
    && /remainingMeetings\.length/.test(browserUiAcceptanceFixture)
    && /remainingTodos\.length/.test(browserUiAcceptanceFixture)
    && /remainingRisks\.length/.test(browserUiAcceptanceFixture)
    && /remainingIdentityIssues\.length/.test(browserUiAcceptanceFixture)
    && /浏览器验收线索-/.test(browserUiAcceptanceFixture)
    && /remainingLeads\.length/.test(browserUiAcceptanceFixture)
    && /browser-ui-smoke-upload\.txt/.test(browserUiAcceptanceFixture)
    && /mode: 0o600, flag: 'wx'/.test(browserUiAcceptanceFixture)
    && /uploadFixtureRemoved: true/.test(browserUiAcceptanceFixture)
    && packageJson.scripts?.['fixture:browser-ui:setup']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/browserUiAcceptanceFixture.ts --setup'
    && packageJson.scripts?.['fixture:browser-ui:cleanup']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/browserUiAcceptanceFixture.ts --cleanup',
    'browser UI smoke fixtures must use production project deletion, close retained pipeline history, and exactly clean meeting, todo, risk, knowledge, lead, and private upload residues',
  )
  requireCondition(
    /const apply = process\.argv\.slice\(2\)\.includes\('--apply'\)/.test(quarantineOrphanAgentWorkspaces)
    && /chat_conversations/.test(quarantineOrphanAgentWorkspaces)
    && /agent_conversations/.test(quarantineOrphanAgentWorkspaces)
    && /conversationAbsentFromChatAndAgentMysql: true/.test(quarantineOrphanAgentWorkspaces)
    && /maximumFiles = 10_000/.test(quarantineOrphanAgentWorkspaces)
    && /maximumBytes = 1024 \* 1024 \* 1024/.test(quarantineOrphanAgentWorkspaces)
    && /originalBytesRetainedInPrivateQuarantine: apply/.test(quarantineOrphanAgentWorkspaces)
    && /fileNamesExcluded: true/.test(quarantineOrphanAgentWorkspaces)
    && /resolveJwAgentWorkspace/.test(agentWorkspaceLifecycleService)
    && /realpath\(workspaceRoot\)/.test(agentWorkspaceLifecycleService)
    && /rm\(workspace, \{ recursive: true, force: false/.test(agentWorkspaceLifecycleService)
    && /removeAgentConversationWorkspace\(id\)/.test(conversationService)
    && /real-mysql-conversation-delete-removes-exact-workspace/.test(agentWorkspaceLifecycleAcceptance)
    && /symlink-workspace-root-rejected/.test(agentWorkspaceLifecycleAcceptance)
    && /symlink-conversation-workspace-rejected/.test(agentWorkspaceLifecycleAcceptance)
    && packageJson.scripts?.['quarantine:orphan-agent-workspaces']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/quarantineOrphanAgentWorkspaces.ts'
    && packageJson.scripts?.['accept:agent-workspace-lifecycle']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/agentWorkspaceLifecycleAcceptance.ts'
    && releaseGatePolicyCovers('accept:agent-workspace-lifecycle'),
    'orphan Agent workspaces must be recoverably quarantined only when absent from both MySQL conversation authorities, while normal conversation deletion removes only its exact safe workspace',
  )
  requireCondition(
    /maximumEvents = 5_000/.test(aiRuntimeTelemetry)
    && /first-non-empty-sdk-text-or-thinking-delta/.test(aiRuntimeTelemetry)
    && /nonStreamingGatewayFirstTokenUnavailable: true/.test(aiRuntimeTelemetry)
    && /processLocalWindow: true/.test(aiRuntimeTelemetry)
    && /secretsExcluded: true/.test(aiRuntimeTelemetry)
    && /identitiesExcluded: true/.test(aiRuntimeTelemetry)
    && /businessContentExcluded: true/.test(aiRuntimeTelemetry)
    && /observeNonStreamingAiRuntimeRequest\('gateway-text'/.test(aiGatewayService)
    && /observeNonStreamingAiRuntimeRequest\('gateway-vision'/.test(aiGatewayService)
    && /beginAiRuntimeRequest\('jw-agent'/.test(jwRuntime)
    && /markAiRuntimeFirstTokenFromSdkMessage/.test(jwRuntime)
    && /finishAiRuntimeRequest/.test(jwRuntime)
    && [leadSubjectAgentService, leadScoringAgentService, leadWorkflowAgentService].every((source) => (
      /includePartialMessages: true/.test(source)
      && /markAiRuntimeFirstTokenFromSdkMessage/.test(source)
      && /finishAiRuntimeRequest/.test(source)
    ))
    && /subject-agent-records-real-partial-message-first-token/.test(leadSubjectAgentAcceptance)
    && /scoring-agent-records-real-partial-message-first-token/.test(leadScoringAgentAcceptance)
    && /three-workflow-agents-record-real-partial-message-first-token/.test(leadWorkflowAgentAcceptance)
    && /aiRuntimeTelemetrySnapshot/.test(operationalTelemetryService)
    && /aiRuntimeTelemetrySnapshot\(\)/.test(serverEntry)
    && /AI_FIRST_TOKEN_P95_LATENCY/.test(operationalTelemetryService)
    && /AI_FIRST_TOKEN_OBSERVATION_INCOMPLETE/.test(operationalTelemetryService)
    && /streaming-coverage-does-not-fake-non-streaming-first-token/.test(aiRuntimeTelemetryAcceptance)
    && /snapshot-exposes-no-request-content-identity-or-secret-fields/.test(aiRuntimeTelemetryAcceptance)
    && /acceptance-telemetry-is-reset-with-zero-residue/.test(aiRuntimeTelemetryAcceptance)
    && /mode: 0o600/.test(aiRuntimeTelemetryAcceptance)
    && /ai-runtime-first-token-total-error-cancel-and-coverage-exclude-sensitive-content/.test(operationalTelemetryAcceptance)
    && /OPS_AI_FIRST_TOKEN_MIN_REQUESTS=5/.test(environmentExample)
    && /OPS_AI_FIRST_TOKEN_P95_MS_WARN=5000/.test(environmentExample)
    && /OPS_AI_FIRST_TOKEN_OBSERVATION_COVERAGE_WARN=0.8/.test(environmentExample)
    && /ensure_env_value "\$ENV_FILE" "OPS_AI_FIRST_TOKEN_MIN_REQUESTS"/.test(deploy)
    && /ensure_env_value "\$ENV_FILE" "OPS_AI_FIRST_TOKEN_P95_MS_WARN"/.test(deploy)
    && /ensure_env_value "\$ENV_FILE" "OPS_AI_FIRST_TOKEN_OBSERVATION_COVERAGE_WARN"/.test(deploy)
    && packageJson.scripts?.['accept:ai-runtime-telemetry']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/aiRuntimeTelemetryAcceptance.ts'
    && releaseGatePolicyCovers('accept:ai-runtime-telemetry'),
    'AI runtime telemetry must measure real SDK first-token latency, expose non-streaming coverage gaps and exclude content, identity and secrets',
  )
  requireCondition(
    /documentNativeRuntimeHealth/.test(operationalTelemetryService)
    && /DOCUMENT_NATIVE_RUNTIME_MISSING/.test(operationalTelemetryService)
    && /DOCUMENT_RENDER_FAILURE/.test(operationalTelemetryService)
    && /DOCUMENT_ARTIFACT_QUALITY_FAILURE/.test(operationalTelemetryService)
    && /DOCUMENT_FONT_FAILURE/.test(operationalTelemetryService)
    && /cacheTtlMs = 5 \* 60_000/.test(documentNativeRuntimeTelemetry)
    && /constants\.X_OK/.test(documentNativeRuntimeTelemetry)
    && /pathsExcluded: true/.test(documentNativeRuntimeTelemetry)
    && /versionsExcluded: true/.test(documentNativeRuntimeTelemetry)
    && !/execFile|spawn\(|fork\(/.test(documentNativeRuntimeTelemetry)
    && /native_dependency_failures/.test(operationalTelemetryRepository)
    && /quality_failed/.test(operationalTelemetryRepository)
    && /font_failures/.test(operationalTelemetryRepository)
    && /document-native-runtime-readiness-excludes-paths-and-versions/.test(operationalTelemetryAcceptance)
    && /DOCUMENT_NATIVE_RUNTIME_MISSING/.test(operationalTelemetryAcceptance)
    && /DOCUMENT_ARTIFACT_QUALITY_FAILURE/.test(operationalTelemetryAcceptance)
    && /OPS_DOCUMENT_RENDER_FAILURES_WARN=1/.test(environmentExample)
    && /OPS_DOCUMENT_QUALITY_FAILURES_WARN=1/.test(environmentExample)
    && /OPS_DOCUMENT_FONT_FAILURES_WARN=1/.test(environmentExample)
    && /ensure_env_value "\$ENV_FILE" "OPS_DOCUMENT_RENDER_FAILURES_WARN"/.test(deploy)
    && /ensure_env_value "\$ENV_FILE" "OPS_DOCUMENT_QUALITY_FAILURES_WARN"/.test(deploy)
    && /ensure_env_value "\$ENV_FILE" "OPS_DOCUMENT_FONT_FAILURES_WARN"/.test(deploy)
    && /不启动 Office\/Python\/OCR/.test(operationalTelemetryHandoff),
    'document runtime dependency, render, font and artifact quality telemetry must be content-free and must not launch generation processes',
  )
  const documentRuntimePins = documentRuntimePythonLock.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  requireCondition(
    documentRuntimePins.length === 11
    && documentRuntimePins.every((pin) => /^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+!-]+$/.test(pin))
    && !documentRuntimePins.some((pin) => /(?:>=|<=|~=|!=|===|>|<)/.test(pin))
    && /"lockSha256": "[0-9a-f]{64}"/.test(documentRuntimeDependencyManifest)
    && /"packageCount": 19/.test(documentRuntimeDependencyManifest)
    && /"linux": \["python", "libreOffice", "popplerRasterizer", "popplerText", "popplerFonts", "tesseract", "fontconfig", "legacyWordExtractor"\]/.test(documentRuntimeDependencyManifest)
    && /"linuxRequiredTesseractLanguages": \["chi_sim", "eng"\]/.test(documentRuntimeDependencyManifest)
    && /"linuxRequiredFontFamilies": \["Noto Sans CJK SC", "Noto Serif CJK SC"\]/.test(documentRuntimeDependencyManifest)
    && /requirements-pdf-to-ppt\.lock\.txt/.test(documentRuntimeSetup)
    && /verifyDocumentRuntimeDependencies\.ts/.test(documentRuntimeSetup)
    && /Python dependency lock SHA-256 differs from manifest/.test(documentRuntimeDependencyVerifier)
    && /exactPythonEnvironment/.test(documentRuntimeDependencyVerifier)
    && /requiredNativeCompatible/.test(documentRuntimeDependencyVerifier)
    && /versionOutputSha256/.test(documentRuntimeDependencyVerifier)
    && /linuxRequiredTesseractLanguages/.test(documentRuntimeDependencyVerifier)
    && /linuxRequiredFontFamilies/.test(documentRuntimeDependencyVerifier)
    && /pathsExcluded: true/.test(documentRuntimeDependencyVerifier)
    && /businessContentExcluded: true/.test(documentRuntimeDependencyVerifier)
    && /server\/document-runtime-dependencies\.json/.test(migrationEnvironmentBaseline)
    && /server\/requirements-pdf-to-ppt\.lock\.txt/.test(migrationEnvironmentBaseline)
    && /server\/scripts\/setup-pdf-to-ppt-runtime\.mjs/.test(migrationEnvironmentBaseline)
    && /server\/src\/scripts\/verifyDocumentRuntimeDependencies\.ts/.test(migrationEnvironmentBaseline)
    && /server\/src\/scripts\/targetSingleServiceEvidence\.ts/.test(migrationEnvironmentBaseline)
    && /server\/src\/scripts\/radarLeadSourceReconciliationAcceptance\.ts/.test(migrationEnvironmentBaseline)
    && packageJson.scripts?.['accept:document-runtime-dependencies']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/verifyDocumentRuntimeDependencies.ts --static'
    && packageJson.scripts?.['verify:document-runtime-dependencies']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/verifyDocumentRuntimeDependencies.ts --live'
    && releaseGatePolicyCovers('verify:document-runtime-dependencies')
    && /不执行 PPT、尽调、提案、Q&A 或合规性说明生成/.test(documentRuntimeDependencyHandoff)
    && /完整版本输出只保存 SHA-256/.test(documentRuntimeDependencyHandoff)
    && /apt snapshot 或基础镜像 digest/.test(documentRuntimeDependencyHandoff),
    'document runtime must use an exact Python transitive lock plus fail-closed native version, OCR language and Linux CJK font contracts without exposing paths',
  )
  requireCondition(
    /SHOW GLOBAL STATUS/.test(operationalTelemetryRepository)
    && /Innodb_row_lock_current_waits/.test(operationalTelemetryRepository)
    && /Innodb_row_lock_waits/.test(operationalTelemetryRepository)
    && /Innodb_row_lock_time/.test(operationalTelemetryRepository)
    && /Innodb_deadlocks/.test(operationalTelemetryRepository)
    && /SHOW REPLICA STATUS/.test(operationalTelemetryRepository)
    && /statusObservationAvailable/.test(operationalTelemetryRepository)
    && /deadlockObservationAvailable/.test(operationalTelemetryRepository)
    && /replicationObservationAvailable/.test(operationalTelemetryRepository)
    && /MYSQL_ROW_LOCK_WAITING/.test(operationalTelemetryService)
    && /MYSQL_DEADLOCK_OBSERVATION_UNAVAILABLE/.test(operationalTelemetryService)
    && /MYSQL_REPLICATION_OBSERVATION_UNAVAILABLE/.test(operationalTelemetryService)
    && /MYSQL_REPLICA_NOT_RUNNING/.test(operationalTelemetryService)
    && /MYSQL_REPLICATION_LAG/.test(operationalTelemetryService)
    && /runtime-account-can-read-required-global-status/.test(mysqlServerTelemetryAcceptance)
    && /deadlock-observation-availability-is-not-reported-as-zero/.test(mysqlServerTelemetryAcceptance)
    && /replication-observation-availability-matches-runtime-authority/.test(mysqlServerTelemetryAcceptance)
    && /server-telemetry-excludes-connection-and-replication-identities/.test(mysqlServerTelemetryAcceptance)
    && /mode: 0o600/.test(mysqlServerTelemetryAcceptance)
    && /OPS_MYSQL_ROW_LOCK_CURRENT_WAITS_WARN=1/.test(environmentExample)
    && /OPS_MYSQL_REPLICATION_LAG_SECONDS_WARN=300/.test(environmentExample)
    && /ensure_env_value "\$ENV_FILE" "OPS_MYSQL_ROW_LOCK_CURRENT_WAITS_WARN"/.test(deploy)
    && /ensure_env_value "\$ENV_FILE" "OPS_MYSQL_REPLICATION_LAG_SECONDS_WARN"/.test(deploy)
    && packageJson.scripts?.['accept:mysql-server-telemetry']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/mysqlServerTelemetryAcceptance.ts'
    && releaseGatePolicyCovers('accept:mysql-server-telemetry'),
    'runtime MySQL server telemetry must expose slow-query and row-lock counters while reporting unavailable deadlock or replication authority honestly and without identities',
  )
  requireCondition(
    /lead_pipeline_reviews/.test(operationalTelemetryRepository)
    && /pending_reviews/.test(operationalTelemetryRepository)
    && /opened_reviews/.test(operationalTelemetryRepository)
    && /resolved_reviews/.test(operationalTelemetryRepository)
    && /average_resolution_ms/.test(operationalTelemetryRepository)
    && /oldest_pending_age_ms/.test(operationalTelemetryRepository)
    && /LEAD_REVIEW_BACKLOG/.test(operationalTelemetryService)
    && /LEAD_REVIEW_STALE/.test(operationalTelemetryService)
    && /LEAD_REVIEW_BACKLOG/.test(operationalTelemetryAcceptance)
    && /LEAD_REVIEW_STALE/.test(operationalTelemetryAcceptance)
    && /OPS_LEAD_REVIEW_PENDING_WARN=20/.test(environmentExample)
    && /OPS_LEAD_REVIEW_OLDEST_AGE_MS_WARN=86400000/.test(environmentExample)
    && /ensure_env_value "\$ENV_FILE" "OPS_LEAD_REVIEW_PENDING_WARN"/.test(deploy)
    && /ensure_env_value "\$ENV_FILE" "OPS_LEAD_REVIEW_OLDEST_AGE_MS_WARN"/.test(deploy)
    && /pending-review-backlog-increments-exactly/.test(leadReviewTelemetryAcceptance)
    && /resolved-review-throughput-increments-exactly/.test(leadReviewTelemetryAcceptance)
    && /review-telemetry-fixture-residue-is-zero/.test(leadReviewTelemetryAcceptance)
    && packageJson.scripts?.['accept:lead-review-telemetry']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/leadReviewTelemetryAcceptance.ts'
    && releaseGatePolicyCovers('accept:lead-review-telemetry'),
    'lead review backlog, throughput, resolution duration and exact fixture cleanup must be operationally observable',
  )
  requireCondition(
    /GROUP BY BINARY name HAVING COUNT\(\*\)>1/.test(operationalTelemetryRepository)
    && /GROUP BY BINARY company_name HAVING COUNT\(\*\)>1/.test(operationalTelemetryRepository)
    && /duplicateEntityGroups/.test(operationalTelemetryRepository)
    && /LEAD_ENTITY_DUPLICATE_GROUPS/.test(operationalTelemetryService)
    && /LEAD_ENTITY_DUPLICATE_GROUPS/.test(operationalTelemetryAcceptance)
    && /duplicate-name-group-increments-exactly/.test(leadDuplicateTelemetryAcceptance)
    && /duplicate-company-group-increments-exactly/.test(leadDuplicateTelemetryAcceptance)
    && /duplicate-telemetry-fixture-residue-is-zero/.test(leadDuplicateTelemetryAcceptance)
    && /OPS_LEAD_ENTITY_DUPLICATE_GROUPS_WARN=1/.test(environmentExample)
    && /ensure_env_value "\$ENV_FILE" "OPS_LEAD_ENTITY_DUPLICATE_GROUPS_WARN"/.test(deploy)
    && packageJson.scripts?.['accept:lead-duplicate-telemetry']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/leadDuplicateTelemetryAcceptance.ts'
    && releaseGatePolicyCovers('accept:lead-duplicate-telemetry'),
    'lead exact-name and company duplicate groups must be measurable, alertable and acceptance-cleaned without automatic merging',
  )
  requireCondition(
    /fileStorageCapacityHealth/.test(operationalTelemetryService)
    && /FILE_STORAGE_ROOT_UNAVAILABLE/.test(operationalTelemetryService)
    && /FILE_STORAGE_FREE_BYTES_LOW/.test(operationalTelemetryService)
    && /FILE_STORAGE_USED_RATIO_HIGH/.test(operationalTelemetryService)
    && /cacheTtlMs = 5 \* 60_000/.test(fileStorageCapacityTelemetry)
    && /statfs\(root\.value\)/.test(fileStorageCapacityTelemetry)
    && /constants\.R_OK \| constants\.W_OK/.test(fileStorageCapacityTelemetry)
    && /pathsExcluded: true/.test(fileStorageCapacityTelemetry)
    && !/execFile|spawn\(|fork\(/.test(fileStorageCapacityTelemetry)
    && /file_downloads/.test(operationalTelemetryRepository)
    && /file_previews/.test(operationalTelemetryRepository)
    && /file-storage-capacity-excludes-root-paths/.test(operationalTelemetryAcceptance)
    && /FILE_STORAGE_FREE_BYTES_LOW/.test(operationalTelemetryAcceptance)
    && /OPS_FILE_DISK_FREE_BYTES_WARN=5368709120/.test(environmentExample)
    && /OPS_FILE_DISK_USED_RATIO_WARN=0.9/.test(environmentExample)
    && /ensure_env_value "\$ENV_FILE" "OPS_FILE_DISK_FREE_BYTES_WARN"/.test(deploy)
    && /只调用 `statfs`/.test(operationalTelemetryHandoff),
    'file access volume and storage capacity telemetry must be path-free, cached and must not launch helper processes',
  )
  requireCondition(
    /credential_changes/.test(operationalTelemetryRepository)
    && /high_risk_tool_denied/.test(operationalTelemetryRepository)
    && /替换 Provider 凭据/.test(operationalTelemetryRepository)
    && /替换机器人凭据/.test(operationalTelemetryRepository)
    && /拒绝 Agent Runtime 越界访问/.test(operationalTelemetryRepository)
    && /SECURITY_CREDENTIAL_CHANGED/.test(operationalTelemetryService)
    && /SECURITY_HIGH_RISK_TOOL_DENIED/.test(operationalTelemetryService)
    && /SECURITY_CREDENTIAL_CHANGED/.test(operationalTelemetryAcceptance)
    && /SECURITY_HIGH_RISK_TOOL_DENIED/.test(operationalTelemetryAcceptance)
    && /OPS_CREDENTIAL_CHANGES_15M_WARN=1/.test(environmentExample)
    && /OPS_HIGH_RISK_TOOL_DENIED_15M_WARN=1/.test(environmentExample)
    && /ensure_env_value "\$ENV_FILE" "OPS_CREDENTIAL_CHANGES_15M_WARN"/.test(deploy)
    && /模型\/IM 凭据替换量/.test(operationalTelemetryHandoff),
    'credential changes and high-risk agent tool denials must be independently aggregated and routed as operational alerts',
  )
  requireCondition(
    /recordFileStorageCapacitySnapshot/.test(fileStorageCapacityTelemetry)
    && /fileStorageCapacityHistory/.test(fileStorageCapacityTelemetry)
    && /file-capacity-v1/.test(fileStorageCapacityTelemetry)
    && /createHash\('sha256'\)/.test(fileStorageCapacityTelemetry)
    && /INSERT IGNORE INTO/.test(fileStorageCapacityTelemetry)
    && /JSON_VALID\(target\)/.test(fileStorageCapacityTelemetry)
    && /pathsExcluded: true/.test(fileStorageCapacityTelemetry)
    && /created_at <= \? AND created_at >= \?/.test(fileStorageCapacityTelemetry)
    && /id: 'file-storage-capacity-snapshot'/.test(runtimeJobScheduler)
    && /OPS_FILE_CAPACITY_SNAPSHOT_INTERVAL_SECONDS/.test(runtimeJobScheduler)
    && /FILE_STORAGE_HISTORY_UNAVAILABLE/.test(operationalTelemetryService)
    && /FILE_STORAGE_GROWTH_BASELINE_UNAVAILABLE/.test(operationalTelemetryService)
    && /FILE_STORAGE_USED_RATIO_GROWTH_24H/.test(operationalTelemetryService)
    && /cross-day-capacity-baseline-is-selected/.test(fileStorageCapacityHistoryAcceptance)
    && /cross-day-free-byte-decline-is-exact/.test(fileStorageCapacityHistoryAcceptance)
    && /cross-day-used-ratio-increase-is-exact/.test(fileStorageCapacityHistoryAcceptance)
    && /hourly-capacity-snapshot-is-idempotent/.test(fileStorageCapacityHistoryAcceptance)
    && /capacity-snapshot-targets-exclude-root-paths/.test(fileStorageCapacityHistoryAcceptance)
    && /capacity-history-fixture-residue-is-zero/.test(fileStorageCapacityHistoryAcceptance)
    && /mode: 0o600/.test(fileStorageCapacityHistoryAcceptance)
    && /OPS_FILE_DISK_USED_RATIO_GROWTH_24H_WARN=0.05/.test(environmentExample)
    && /OPS_FILE_CAPACITY_SNAPSHOT_INTERVAL_SECONDS=3600/.test(environmentExample)
    && /ensure_env_value "\$ENV_FILE" "OPS_FILE_DISK_USED_RATIO_GROWTH_24H_WARN"/.test(deploy)
    && /ensure_env_value "\$ENV_FILE" "OPS_FILE_CAPACITY_SNAPSHOT_INTERVAL_SECONDS"/.test(deploy)
    && packageJson.scripts?.['accept:file-storage-capacity-history']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/fileStorageCapacityHistoryAcceptance.ts'
    && releaseGatePolicyCovers('accept:file-storage-capacity-history'),
    'file capacity snapshots must be hourly, idempotent, path-free and cross-day comparable with honest baseline and growth alerts',
  )
  requireCondition(
    /runtime_job_runs/.test(operationalTelemetryRepository)
    && /lead_score_jobs/.test(operationalTelemetryRepository)
    && /project_score_jobs/.test(operationalTelemetryRepository)
    && /lease_recoveries/.test(operationalTelemetryRepository)
    && /timeout_failures/.test(operationalTelemetryRepository)
    && /retried_records/.test(operationalTelemetryRepository)
    && /JOB_FAILURE_24H/.test(operationalTelemetryService)
    && /JOB_DEAD_LETTER_24H/.test(operationalTelemetryService)
    && /JOB_RETRY_ACTIVITY_24H/.test(operationalTelemetryService)
    && /JOB_TIMEOUT_FAILURE_24H/.test(operationalTelemetryService)
    && /JOB_LEASE_RECOVERY_24H/.test(operationalTelemetryService)
    && /JOB_EXPIRED_LEASE/.test(operationalTelemetryService)
    && /job-lifecycle-and-lease-recovery-counts-are-coherent/.test(operationalTelemetryAcceptance)
    && /JOB_TIMEOUT_FAILURE_24H/.test(operationalTelemetryAcceptance)
    && /OPS_JOB_TIMEOUT_FAILURES_24H_WARN=1/.test(environmentExample)
    && /OPS_JOB_EXPIRED_LEASES_WARN=1/.test(environmentExample)
    && /ensure_env_value "\$ENV_FILE" "OPS_JOB_TIMEOUT_FAILURES_24H_WARN"/.test(deploy)
    && /不冒充每次争抢的事件序列|生命周期记录/.test(operationalTelemetryHandoff),
    'worker lifecycle, failure, timeout, retry and lease-recovery telemetry must preserve honest event-versus-lifecycle semantics',
  )
  requireCondition(
    /recordSupervisedProcessExitSafely/.test(supervisedProcessService)
    && /telemetryKey/.test(supervisedProcessService)
    && /escalated = true/.test(supervisedProcessService)
    && /createHash\('sha256'\)/.test(supervisedProcessTelemetry)
    && /userId: null/.test(supervisedProcessTelemetry)
    && /execution=/.test(supervisedProcessTelemetry)
    && /executable=/.test(supervisedProcessTelemetry)
    && !/stdout|stderr|args/.test(supervisedProcessTelemetry)
    && /module='进程监督'/.test(operationalTelemetryRepository)
    && /non_zero_exit/.test(operationalTelemetryRepository)
    && /force_killed/.test(operationalTelemetryRepository)
    && /SUPERVISED_PROCESS_FAILURE_24H/.test(operationalTelemetryService)
    && /SUPERVISED_PROCESS_TIMEOUT_24H/.test(operationalTelemetryService)
    && /SUPERVISED_PROCESS_FORCE_KILL_24H/.test(operationalTelemetryService)
    && /six-exit-events-are-persisted/.test(supervisedProcessTelemetryAcceptance)
    && /all-stable-exit-actions-are-persisted/.test(supervisedProcessTelemetryAcceptance)
    && /exit-targets-exclude-raw-execution-keys-and-paths/.test(supervisedProcessTelemetryAcceptance)
    && /process-history-returns-to-baseline-after-cleanup/.test(supervisedProcessTelemetryAcceptance)
    && /supervisedProcessTelemetryExecutionKey/.test(supervisedProcessAcceptance)
    && /DELETE FROM/.test(supervisedProcessAcceptance)
    && /OPS_SUPERVISED_PROCESS_FAILURES_24H_WARN=1/.test(environmentExample)
    && /OPS_SUPERVISED_PROCESS_TIMEOUTS_24H_WARN=1/.test(environmentExample)
    && /OPS_SUPERVISED_PROCESS_FORCE_KILLS_24H_WARN=1/.test(environmentExample)
    && /ensure_env_value "\$ENV_FILE" "OPS_SUPERVISED_PROCESS_FAILURES_24H_WARN"/.test(deploy)
    && packageJson.scripts?.['accept:process-supervisor-telemetry']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/supervisedProcessTelemetryAcceptance.ts'
    && releaseGatePolicyCovers('accept:process-supervisor-telemetry'),
    'supervised process exits must persist hashed reason/code/signal/duration/escalation events with alerts and exact fixture cleanup',
  )
  requireCondition(
    /createHash\('sha256'\)/.test(jobCoordinationTelemetry)
    && /userId: null/.test(jobCoordinationTelemetry)
    && /INTERVAL 1 MINUTE/.test(jobCoordinationTelemetry)
    && /leaseContention: '租约领取争抢未获'/.test(jobCoordinationTelemetry)
    && /duplicateSuppressed: '重复任务入队已抑制'/.test(jobCoordinationTelemetry)
    && /leaseRecovered: '过期租约已恢复'/.test(jobCoordinationTelemetry)
    && /staleCompletionRejected: '过期执行结果已拒绝'/.test(jobCoordinationTelemetry)
    && /recordJobCoordinationEventSafely/.test(runtimeJobScheduler)
    && /recordJobCoordinationEventSafely/.test(leadScoreJobService)
    && /recordJobCoordinationEventSafely/.test(projectScoreJobService)
    && /recordJobCoordinationEventSafely/.test(mysqlAiTaskRepository)
    && /recordJobCoordinationEventSafely/.test(aiTaskService)
    && /lease_contentions/.test(operationalTelemetryRepository)
    && /duplicate_suppressed/.test(operationalTelemetryRepository)
    && /stale_completion_rejected/.test(operationalTelemetryRepository)
    && /JOB_LEASE_CONTENTION_24H/.test(operationalTelemetryService)
    && /JOB_DUPLICATE_SUPPRESSED_24H/.test(operationalTelemetryService)
    && /JOB_STALE_COMPLETION_REJECTED_24H/.test(operationalTelemetryService)
    && /entity-identifiers-are-sha256-protected/.test(jobCoordinationTelemetryAcceptance)
    && /coordination acceptance fixture residue remains/.test(jobCoordinationTelemetryAcceptance)
    && /mode: 0o600/.test(jobCoordinationTelemetryAcceptance)
    && /OPS_JOB_LEASE_CONTENTIONS_24H_WARN=10/.test(environmentExample)
    && /OPS_JOB_DUPLICATE_SUPPRESSED_24H_WARN=20/.test(environmentExample)
    && /OPS_JOB_STALE_COMPLETIONS_24H_WARN=1/.test(environmentExample)
    && /ensure_env_value "\$ENV_FILE" "OPS_JOB_LEASE_CONTENTIONS_24H_WARN"/.test(deploy)
    && packageJson.scripts?.['accept:job-coordination-telemetry']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/jobCoordinationTelemetryAcceptance.ts'
    && releaseGatePolicyCovers('accept:job-coordination-telemetry')
    && /- \[x\] `OPS-016`/.test(repositoryMigrationExecutionChecklist)
    && /事件写入失败只产生无标识错误日志/.test(operationalTelemetryHandoff),
    'job lease contention, duplicate suppression, recovery and stale completion rejection must be durable, hashed and operationally aggregated',
  )
  requireCondition(
    /must be an enabled IM binding UUID/.test(operationalAlertPolicy)
    && /OPS_ALERT_REMINDER_MINUTES/.test(operationalAlertPolicy)
    && /findLatestOperationalAlert/.test(imIntegrationRepositoryContract)
    && /enqueueOperationalAlert/.test(imIntegrationRepositoryContract)
    && /JSON_EXTRACT/.test(mysqlImIntegrationRepository)
    && /kind: 'operational-alert'/.test(operationalAlertDeliveryService)
    && /status: 'deduplicated'/.test(operationalAlertDeliveryService)
    && /state: 'recovered'/.test(operationalAlertDeliveryService)
    && /dispatchOperationalAlerts/.test(runtimeJobScheduler)
    && /id: 'im-outbox-dispatch'/.test(runtimeJobScheduler)
    && /active-alert-delivered-through-existing-im-outbox/.test(operationalAlertDeliveryAcceptance)
    && /recovery-notification-deduplicated/.test(operationalAlertDeliveryAcceptance)
    && /acceptance-fixture-cleaned-with-zero-residue/.test(operationalAlertDeliveryAcceptance)
    && /mode: 0o600/.test(operationalAlertDeliveryAcceptance)
    && /OPS_ALERT_REMINDER_MINUTES=60/.test(environmentExample)
    && /OPS_ALERT_REMINDER_MINUTES=\$\{OPS_ALERT_REMINDER_MINUTES:-60\}/.test(deploy)
    && packageJson.scripts?.['accept:operational-alert-delivery']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/operationalAlertDeliveryAcceptance.ts'
    && releaseGatePolicyCovers('accept:operational-alert-delivery')
    && /不增加第二个服务、端口、cron 或 timer/.test(operationalTelemetryHandoff),
    'operational alerts must reuse the in-process IM outbox with durable deduplication, retries, delivery logs and recovery notifications',
  )
  requireCondition(
    /AUTH_LEGACY_BEARER_CUTOFF/.test(legacyBearerPolicy)
    && /AUTH_LEGACY_BEARER_ALLOWED_USER_IDS/.test(legacyBearerPolicy)
    && /cannot exceed 30 days/.test(legacyBearerPolicy)
    && /authLegacyBearerPolicy = mysqlTable\('auth_legacy_bearer_policy'/.test(databaseSchema)
    && /CREATE TABLE IF NOT EXISTS `sbl_auth_legacy_bearer_policy`/.test(legacyBearerMigration)
    && /INSERT IGNORE INTO `sbl_auth_legacy_bearer_policy`/.test(legacyBearerMigration)
    && /payload\.iat/.test(authService)
    && /control\.revokedBefore/.test(authService)
    && /invalidateAllLegacyBearerTokens/.test(authService)
    && /旧 JWT 迁移窗口使用/.test(authService)
    && /auditLegacyBearerUse/.test(sessionAuthService)
    && /auditLegacyBearerUse/.test(agentSocketService)
    && /--approved-user-id/.test(legacyBearerInvalidation)
    && /--reason-file/.test(legacyBearerInvalidation),
    'legacy JWT migration access must have a bounded allowlist, UTC cutoff, use audit and database kill switch',
  )
  for (const contract of [
    'legacy-window-requires-future-utc-cutoff-and-stable-user-allowlist',
    'out-of-scope-user-token-is-denied',
    'accepted-rest-use-is-audited-without-token-content',
    'expired-window-rejects-legacy-token-with-explicit-auth-code',
    'database-watermark-invalidates-all-earlier-tokens-immediately',
    'invalidation-requires-enabled-system-admin-and-is-audited',
  ]) requireCondition(legacyBearerPolicyAcceptance.includes(contract), `legacy bearer acceptance is missing: ${contract}`)
  for (const contract of [
    'allowlisted-legacy-jwt-authenticates-rest-only-before-cutoff',
    'allowlisted-legacy-jwt-authenticates-socket-only-before-cutoff',
    'rest-and-socket-legacy-use-create-separate-token-free-audit-records',
    'database-watermark-immediately-rejects-rest-token',
    'connected-socket-is-disconnected-on-next-bounded-revalidation',
  ]) requireCondition(legacyBearerHttpSocketAcceptance.includes(contract), `legacy bearer HTTP/Socket acceptance is missing: ${contract}`)
  requireCondition(
    /\^lba_\[0-9a-f\]\{8\}_\$/.test(legacyBearerHttpSocketAcceptance)
    && /applyIsolatedMigrations\(environment\)/.test(legacyBearerHttpSocketAcceptance)
    && /DB_MIGRATION_USERNAME/.test(legacyBearerHttpSocketAcceptance)
    && /information_schema\.TABLES/.test(legacyBearerHttpSocketAcceptance)
    && /SET FOREIGN_KEY_CHECKS=0/.test(legacyBearerHttpSocketAcceptance)
    && /DROP TABLE \$\{identifier\(table\.tableName\)\}/.test(legacyBearerHttpSocketAcceptance)
    && /isolatedTablePrefix: true/.test(legacyBearerHttpSocketAcceptance)
    && !/CREATE DATABASE|DROP DATABASE/.test(legacyBearerHttpSocketAcceptance),
    'legacy bearer runtime acceptance must use separated migration/runtime accounts and exactly remove a validated isolated table prefix without database-level DDL',
  )
  requireCondition(
    packageJson.scripts?.['accept:legacy-bearer-policy']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/legacyBearerPolicyAcceptance.ts'
    && packageJson.scripts?.['accept:legacy-bearer-http-socket']
      === 'node --env-file-if-exists=.env --env-file-if-exists=.runtime/secrets/mysql-migration.env --import tsx server/src/scripts/legacyBearerHttpSocketAcceptance.ts'
    && packageJson.scripts?.['invalidate:legacy-bearer']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/invalidateLegacyBearerTokens.ts --apply'
    && releaseGatePolicyCovers('accept:legacy-bearer-policy'),
    'production release must run the legacy bearer retirement gate and expose an explicit invalidation command',
  )
  requireCondition(/listen 443 ssl http2/.test(deploy), 'production Nginx must terminate TLS')
  requireCondition(/return 301 https:\/\/\$host\$request_uri/.test(deploy), 'production Nginx must redirect HTTP to HTTPS')
  requireCondition(/AUTH_COOKIE_SECURE" "true"/.test(deploy), 'deploy must force Secure session cookies')
  requireCondition(/TLS_CERT_FILE/.test(deploy) && /TLS_KEY_FILE/.test(deploy), 'deploy must require explicit TLS certificate files')
  requireCondition(
    /process\.env\.NODE_ENV === 'production'\) await assertSchemaReady\(\)/.test(serverEntry),
    'production runtime must verify schema without applying DDL migrations',
  )
  requireCondition(
    /MIGRATION_WRITE_FREEZE_MODE = 'rollback-window'/.test(migrationWriteFreezePolicy)
    && /MIGRATION_WRITE_FREEZE_MODE must be empty/.test(migrationWriteFreezePolicy)
    && /resolveMigrationWriteFreezePolicy/.test(runtimeSafety)
    && /SET SESSION TRANSACTION READ ONLY/.test(databaseClient)
    && /MIGRATION_WRITE_FROZEN/.test(serverEntry)
    && /migrationWriteFreezePolicy\.enabled\) \{\s*initializeAgentSocket/.test(serverEntry)
    && /migrationWriteFreezePolicy\.enabled\s*\? \{ active: 0, releasedLeases: 0/.test(serverEntry)
    && /!migrationWriteFreezePolicy\.enabled && Date\.now/.test(authService)
    && /migrationWriteFreezeDatabaseProbe/.test(migrationWriteFreezeAcceptance)
    && /rowsWritten: database\.rowsWritten/.test(migrationWriteFreezeAcceptance)
    && packageJson.scripts?.['accept:migration-write-freeze']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/migrationWriteFreezeAcceptance.ts'
    && packageJson.scripts?.['cutover:freeze-writes']
      === 'node --import tsx server/src/scripts/migrationWriteFreezeEnv.ts --enable --apply'
    && packageJson.scripts?.['cutover:cross-ponr']
      === 'node --import tsx server/src/scripts/migrationWriteFreezeEnv.ts --disable --apply'
    && packageJson.scripts?.['accept:migration-write-freeze-env']
      === 'node --import tsx server/src/scripts/migrationWriteFreezeEnvAcceptance.ts'
    && /PONR approval requires five distinct approver identities/.test(migrationWriteFreezeEnv)
    && /environment file changed after preview/.test(migrationWriteFreezeEnv)
    && /must be owner-only \(0600 or stricter\)/.test(migrationWriteFreezeEnv)
    && /duplicate MIGRATION_WRITE_FREEZE/.test(migrationWriteFreezeEnvAcceptance)
    && releaseGatePolicyCovers('accept:migration-write-freeze-env')
    && releaseGatePolicyCovers('accept:migration-write-freeze'),
    'rollback-window runtime must fail closed at HTTP, startup, auth renewal, worker shutdown and MySQL session layers',
  )
  requireCondition(
    new Set(cutoverRollbackThresholds.domains?.map((domain) => domain.id)).size === 6
    && cutoverRollbackThresholds.globalRules?.safeRollbackRequiresAllTargetWriteDeltasEqualZero === true
    && cutoverRollbackThresholds.globalRules?.anyTargetWriteMakesAutomaticRollbackIneligible === true
    && cutoverRollbackThresholds.globalRules?.afterPonrAction === 'forward-repair-only'
    && /pending-production-window-approval/.test(cutoverRollbackThresholdAcceptance)
    && packageJson.scripts?.['accept:cutover-rollback-thresholds']
      === 'node --import tsx server/src/scripts/cutoverRollbackThresholdAcceptance.ts'
    && releaseGatePolicyCovers('accept:cutover-rollback-thresholds'),
    'six-domain cutover thresholds must require zero-write rollback eligibility and forward repair after PONR',
  )
  requireCondition(
    /DB_MIGRATION_ENV_FILE/.test(deploy),
    'deploy must support root-only migration credentials separate from runtime DB_USERNAME',
  )
  requireCondition(
    /LLM_BASE_URL=\$\{LLM_BASE_URL:-https:\/\/skill\.zeelin\.cn\/api\/v9\}/.test(deploy)
    && /SCORE_MODEL=\$\{SCORE_MODEL:-gpt-5\.6-sol\}/.test(deploy),
    'deploy must preserve the verified Agent SDK gateway and scoring model defaults',
  )
  for (const scoringAgentLimit of [
    'LEAD_SUBJECT_AGENT_MAX_TURNS', 'LEAD_SUBJECT_AGENT_MAX_BUDGET_USD',
    'LEAD_SCORING_AGENT_MAX_TURNS', 'LEAD_SCORING_AGENT_MAX_BUDGET_USD',
  ]) {
    requireCondition(deploy.includes(scoringAgentLimit), `deploy is missing Agent bound: ${scoringAgentLimit}`)
  }
  requireCondition(
    releaseGatePolicyCovers('audit:mysql-privileges')
    && /GRANT USAGE ON \*\.\*/.test(mysqlPrivilegeAudit)
    && /grant parser self-test failed/.test(mysqlPrivilegeAudit)
    && /WITH\\s\+GRANT\\s\+OPTION/.test(mysqlPrivilegeAudit)
    && /principalSha256: identityHash\(principal\)/.test(mysqlPrivilegeAudit)
    && /principalExcluded: true/.test(mysqlPrivilegeAudit)
    && !/\n\s*principal,\n/.test(mysqlPrivilegeAudit),
    'deploy must reject an over-privileged runtime database account without rejecting harmless global USAGE or matching privilege words in account names',
  )
  requireCondition(
    releaseGatePolicyCovers('audit:password-hashes')
    && /pathsExcluded: true/.test(passwordHashAudit)
    && /identitiesExcluded: true/.test(passwordHashAudit)
    && /passwordsExcluded: true/.test(passwordHashAudit)
    && /bcryptHashesExcluded: true/.test(passwordHashAudit)
    && /databaseWrites: 0/.test(passwordHashAudit)
    && !/\n\s+dumpPath,\n/.test(passwordHashAudit)
    && !/\n\s+warnings,\n|\n\s+violations,\n/.test(passwordHashAudit),
    'deploy must reject invalid, plaintext or known-insecure migrated passwords using path- and identity-free aggregate evidence',
  )
  requireCondition(
    /historical fixed demo-account bootstrap is permanently retired/.test(authService)
    && /return \{ seeded: 0, skipped: true as const, retired: true as const \}/.test(authService)
    && !/\bconst\s+DEMO_USERS\b|password:\s*['"]|@cybernaut\.com/.test(authService)
    && /历史演示账号生成器已永久退役/.test(environmentExample)
    && /SEED_DEMO_USERS=0/.test(environmentExample)
    && /ensure_env_value "\$ENV_FILE" "SEED_DEMO_USERS" "0"/.test(deploy),
    'fixed demo-account generation must remain permanently retired even when a stale environment requests it',
  )
  const passwordRotationScript = await readFile(path.resolve(root, 'server/src/scripts/rotateUserPassword.ts'), 'utf8')
  const passwordRotationService = await readFile(path.resolve(root, 'server/src/services/passwordRotationService.ts'), 'utf8')
  const weakPasswordRotationRoster = await readFile(path.resolve(root, 'server/src/scripts/weakPasswordRotationRoster.ts'), 'utf8')
  const demoUserSeedRetirementAcceptance = await readFile(
    path.resolve(root, 'server/src/scripts/demoUserSeedRetirementAcceptance.ts'), 'utf8',
  )
  requireCondition(
    /stale-seed-enable-request-is-ignored/.test(demoUserSeedRetirementAcceptance)
    && /mysql-user-authority-count-remains-unchanged/.test(demoUserSeedRetirementAcceptance)
    && /databaseWrites: 0/.test(demoUserSeedRetirementAcceptance)
    && packageJson.scripts?.['accept:demo-user-seed-retirement']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/demoUserSeedRetirementAcceptance.ts'
    && releaseGatePolicyCovers('accept:demo-user-seed-retirement'),
    'retired demo-account generation must have a live MySQL zero-write acceptance gate',
  )
  requireCondition(
    packageJson.scripts?.['rotate:user-password'] === 'node --env-file-if-exists=.env --import tsx server/src/scripts/rotateUserPassword.ts',
    'password rotation must use the approved offline entrypoint',
  )
  requireCondition(/禁止通过 argv 传入密码/.test(passwordRotationScript), 'password rotation must reject password argv input')
  requireCondition(!/process\.env\.(?:NEW_)?PASSWORD\b/.test(passwordRotationScript), 'password rotation must not read a password from environment variables')
  requireCondition(/setRawMode\(true\)/.test(passwordRotationScript) && /readPasswordPair\(\)/.test(passwordRotationScript), 'password rotation must use hidden confirmed stdin input')
  requireCondition(
    packageJson.scripts?.['prepare:weak-password-rotation-roster']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/weakPasswordRotationRoster.ts'
    && packageJson.scripts?.['check:weak-password-rotation-roster']
      === 'node --env-file-if-exists=.env --import tsx server/src/scripts/weakPasswordRotationRoster.ts --strict'
    && /passwordHashFingerprint/.test(weakPasswordRotationRoster)
    && /fullBcryptHashesStored: false/.test(weakPasswordRotationRoster)
    && /passwordsStored: false/.test(weakPasswordRotationRoster)
    && /WEAK_PASSWORD_ROSTER_TARGET_MUST_BE_OWNER_ONLY_REGULAR_FILE/.test(weakPasswordRotationRoster)
    && /databaseWrites: 0/.test(weakPasswordRotationRoster)
    && !/^\s+passwordHash,\s*$/m.test(weakPasswordRotationRoster),
    'weak-password rotation roster must be owner-only, contain no password or full bcrypt hash, expose no account identity in console evidence, and remain read-only',
  )
  requireCondition(
    /identityRepositories\.transaction/.test(passwordRotationService)
    && /users\.lockById/.test(passwordRotationService)
    && /users\.updatePasswordHash/.test(passwordRotationService)
    && /users\.revokeActiveSessions/.test(passwordRotationService),
    'password rotation must lock the user and revoke active sessions through one repository transaction',
  )
  requireCondition(
    /audits\.append/.test(passwordRotationService)
    && !/from ['"](?:\.\.\/db\/|drizzle-orm)/.test(passwordRotationService),
    'password rotation must create its audit through Repository without direct database imports',
  )
  requireCondition(/APP_SERVICE="cybernaut-app"/.test(deploy), 'deploy service must be cybernaut-app')
  requireCondition((deploy.match(/^ExecStart=/gm) || []).length === 1, 'deploy must generate exactly one ExecStart')
  requireCondition(/ExecStart=\$\{node_exec\} \$\{DEPLOY_DIR\}\/server-dist\/index\.js/.test(deploy), 'deploy ExecStart must use unified Node entry')
  requireCondition(!/^User=root$/m.test(deploy), 'unified service must not run as root')
  requireCondition(/^User=\$\{APP_RUN_USER\}$/m.test(deploy), 'unified service must use the dedicated runtime account')
  requireCondition(/^Group=\$\{APP_RUN_GROUP\}$/m.test(deploy), 'unified service must use the dedicated runtime group')
  requireCondition(/ensure_runtime_user\(\)/.test(deploy), 'deploy must provision the dedicated runtime account')
  requireCondition(/prepare_runtime_permissions\(\)/.test(deploy), 'deploy must prepare explicit writable runtime directories')
  requireCondition(/^KillMode=control-group$/m.test(deploy), 'systemd must terminate the complete application cgroup')
  requireCondition(
    /^ExecStartPre=\$\{node_exec\} \$\{DEPLOY_DIR\}\/server-dist\/scripts\/singleServicePrestart\.js$/m.test(deploy)
    && /^Environment=SINGLE_SERVICE_PRESTART_EVIDENCE_DIR=\$\{APP_STATE_DIR\}\/prestart$/m.test(deploy)
    && /^RestartPreventExitStatus=2 78$/m.test(deploy)
    && /^StartLimitIntervalSec=300$/m.test(deploy)
    && /^StartLimitBurst=5$/m.test(deploy),
    'systemd cold starts must run the offline prestart gate and suppress configuration-error restart loops',
  )
  requireCondition(/^TimeoutStopSec=90$/m.test(deploy), 'systemd must allow bounded graceful shutdown')
  for (const directive of [
    'MemoryMax=${APP_MEMORY_MAX}',
    'CPUQuota=${APP_CPU_QUOTA}',
    'TasksMax=${APP_TASKS_MAX}',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=strict',
    'ProtectHome=true',
    'CapabilityBoundingSet=',
    'AmbientCapabilities=',
  ]) {
    requireCondition(deploy.includes(directive), `systemd hardening directive is missing: ${directive}`)
  }
  requireCondition(/^ReadWritePaths=.*\$\{FLUE_STATE_DIR\}.*\$\{RADAR_STATE_DIR\}$/m.test(deploy), 'systemd writable paths must be explicit')
  requireCondition(!/proxy_pass[^\n]*(3584|8121)/.test(deploy), 'Nginx must not proxy retired 3584/8121 services')
  requireCondition(!/^\[Timer\]/m.test(deploy), 'deploy must not generate a project systemd timer')
  requireCondition(
    packageJson.scripts?.['accept:target-single-service-evidence']
      === 'node --import tsx server/src/scripts/targetSingleServiceEvidence.ts --static'
    && packageJson.scripts?.['capture:target-single-service-evidence']
      === 'node --import tsx server/src/scripts/targetSingleServiceEvidence.ts --live'
    && /"\$NPM_BIN" run capture:target-single-service-evidence/.test(deploy)
    && /cybernaut-app\.service/.test(targetSingleServiceEvidence)
    && /ControlGroup/.test(targetSingleServiceEvidence)
    && /loopbackListener/.test(targetSingleServiceEvidence)
    && /3584/.test(targetSingleServiceEvidence)
    && /8121/.test(targetSingleServiceEvidence)
    && /list-timers/.test(targetSingleServiceEvidence)
    && /list-unit-files/.test(targetSingleServiceEvidence)
    && /projectUnitPattern/.test(targetSingleServiceEvidence)
    && /projectProcessPattern/.test(targetSingleServiceEvidence)
    && /rogueProjectProcessCount/.test(targetSingleServiceEvidence)
    && /retire_legacy_systemd_unit_files/.test(deploy)
    && /inspectContainerRuntime/.test(targetSingleServiceEvidence)
    && /ssl_protocols/.test(targetSingleServiceEvidence)
    && /identifiersExcluded: true/.test(targetSingleServiceEvidence)
    && /capture:target-single-service-evidence/.test(targetSingleServiceHandoff),
    'target Linux deployment must persist redacted single-service cgroup, port, legacy unit, timer, cron and TLS evidence',
  )

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'single-production-entry',
      'staged-build-stopped-activation-and-previous-release-rollback-boundary',
      'offline-single-service-prestart-build-config-port-schema-and-read-only-mysql-boundary',
      'read-only-cutover-go-no-go-aggregate-and-stable-blocker-boundary',
      'gorden-responses-vision-and-python-ca-boundary',
      'shared-responses-gateway-and-portable-qa-render-boundary',
      'single-service-current-architecture-deployment-and-fault-handoff',
      'readme-no-shared-weak-credential-release-gate',
      'mysql-schema-migrations-and-er-handoff-sync',
      'del-003-postgres-jw-flue-migration-program-and-report-delivery',
      'del-004-modular-jw-runtime-delivery',
      'del-005-react-jw-hook-and-message-conversion-delivery',
      'del-006-five-lead-agent-profile-pipeline-delivery',
      'del-007-project-lead-research-and-ai-task-tool-delivery',
      'del-009-unified-auth-permission-secret-and-audit-delivery',
      'del-010-file-workspace-security-delivery',
      'del-013-jw-allowlist-aipin-rejection-and-exclusion-report-delivery',
      'del-015-cdc-cutover-forward-repair-handoff',
      'del-016-adjacent-domain-migration-retirement-handoff',
      'del-017-cookie-csrf-session-and-key-rotation-evidence-delivery',
      'mysql-user-permission-repository-contract-and-transaction-boundary',
      'runtime-user-table-access-through-repository',
      'single-physical-users-identity-authority-boundary',
      'agent-conversation-message-part-repository-boundary',
      'ai-custom-template-and-analysis-progress-repository-boundary',
      'ai-task-artifact-source-repository-boundary',
      'ai-provider-model-route-capability-repository-boundary',
      'model-capability-im-encrypted-revision-and-exact-rollback-boundary',
      'im-bot-binding-outbox-inbound-repository-boundary',
      'mysql-domain-mapping-runtime-scheduler-audit-and-partial-unique-contract',
      'mysql-pre-migration-backup-versioned-seed-and-isolated-prefix-rollback-lifecycle',
      'migration-git-baseline-and-dirty-worktree-preservation',
      'migration-environment-version-and-configuration-archive-baseline',
      'migration-decision-issue-and-change-ledger',
      'page-api-authority-audit-and-acceptance-traceability-matrix',
      'isolated-route-rest-ai-lead-and-known-issue-contract-baseline',
      'legacy-api-preservation-and-explicit-retirement-boundary',
      'legacy-postgres-jw-and-flue-backup-integrity-baseline',
      'local-file-asset-backup-and-content-identity-restore',
      'mysql-runtime-and-migration-account-provisioning-and-live-separation',
      'mysql-exact-host-drift-detection-and-safe-rotation',
      'development-api-web-only',
      'no-root-flue-runtime-packages',
      'legacy-flue-entrypoints-disabled',
      'no-active-retired-service-reference',
      'no-active-aipin-reference',
      'aipin-source-target-exclusion-report',
      'jw-sqlite-checksum-bound-empty-allowlist-and-excluded-source-zero-write',
      'flue-message-order-text-part-attachment-tool-and-stop-content-verification',
      'mysql-target-integrity-and-source-reconciliation-report',
      'checksum-orphan-state-machine-and-cross-table-business-invariant-gate',
      'postgres-dump-existing-baseline-reconciliation',
      'postgres-dump-dry-run-batch-checkpoint-resume-and-idempotency-boundary',
      'postgres-cdc-insert-update-delete-cascade-watermark-and-resume-boundary',
      'production-source-inventory-evidence',
      'source-orphan-ai-task-conversation-normalization',
      'lead-reserve-missing-detail-quarantine',
      'missing-file-asset-quarantine',
      'quarantined-ai-artifact-metadata-and-source-recovery-boundary',
      'source-evidence-identity-resolution-and-resync-persistence',
      'admin-only-user-role-session-and-project-membership-audit-boundary',
      'no-unsupervised-production-child-process',
      'jw-runtime-deny-by-default-tool-boundary',
      'jw-global-project-new-conversation-rollout-without-retired-runtime-fallback',
      'jw-runtime-five-surface-denial-audit-and-secret-isolation-boundary',
      'jw-public-intel-network-and-argv-boundary',
      'public-intel-no-flue-idempotent-host-transaction-boundary',
      'radar-node-in-process-collection-and-cross-instance-lead-idempotency-boundary',
      'radar-mysql-authority-and-legacy-file-import-boundary',
      'mysql-runtime-job-multi-instance-lease-and-takeover-boundary',
      'lead-score-lease-recovery-dead-letter-and-manual-retry-boundary',
      'project-score-mysql-lease-restart-recovery-and-idempotency-boundary',
      'lead-pipeline-immutable-raw-event-idempotency-and-state-history-boundary',
      'radar-formal-lead-and-pipeline-ready-single-transaction-boundary',
      'lead-pipeline-run-decision-evidence-review-version-audit-boundary',
      'lead-subject-agent-sdk-no-tool-no-secret-boundary',
      'lead-agent-aggregate-and-model-usage-fallback-boundary',
      'lead-subject-live-gold-quality-release-gate',
      'lead-scoring-live-gold-quality-release-gate',
      'lead-research-screening-enrichment-live-gold-quality-release-gate',
      'lead-agent-global-mysql-concurrency-rate-budget-circuit-gate',
      'lead-research-screening-enrichment-agent-profile-contract-boundary',
      'lead-workflow-agent-run-decision-evidence-staging-boundary',
      'lead-controlled-research-tools-and-online-intake-enrichment-boundary',
      'radar-research-screening-online-gate',
      'lead-scoring-agent-sdk-routing-audit-and-no-tool-boundary',
      'lead-manual-review-mysql-authority-host-transaction-and-ui-boundary',
      'cross-process-mysql-schema-migration-lock',
      'single-systemd-execstart',
      'runtime-and-migration-database-account-separation',
      'migrated-password-release-gate',
      'secure-offline-password-rotation',
      'centralized-error-secret-redaction',
      'migration-evidence-secret-body-and-permission-boundary',
      'mysql-json-validity-and-invalid-source-isolation-boundary',
      'migration-source-entity-to-target-id-completeness-boundary',
      'project-file-approved-missing-exact-scope-ledger-boundary',
      'legacy-scoring-explicit-provenance-and-agent-evidence-boundary',
      'mysql-utc-api-iso-and-shanghai-ui-time-boundary',
      'mysql-enum-boolean-uuid-and-unique-index-conversion-boundary',
      'audit-log-admin-read-only-and-runtime-append-only-boundary',
      'mysql-audit-actor-time-target-result-and-request-correlation-boundary',
      'structured-request-correlated-logging',
      'bounded-mysql-pool-resilience',
      'mysql-network-outage-commit-and-rollback-recovery-boundary',
      'mysql-operational-charset-timezone-capacity-and-slow-query-boundary',
      'chinese-knowledge-retrieval-gold-recall-isolation-and-stability-boundary',
      'knowledge-file-chunk-projection-atomic-replacement-and-idempotency-boundary',
      'http-sql-injection-path-authorization-and-arbitrary-file-read-boundary',
      'project-file-size-mime-signature-and-archive-boundary',
      'project-file-quota-sha256-dedup-version-and-preview-boundary',
      'project-file-lifecycle-deletion-and-expired-session-boundary',
      'pdf-docx-pptx-xlsx-image-migration-sample-open-boundary',
      'ai-task-idempotency-cancellation-retry-and-recovery-boundary',
      'ai-template-analysis-progress-mysql-isolation-and-restart-boundary',
      'frontend-business-state-mysql-authority-fail-empty-and-cross-user-clear-boundary',
      'mysql-encrypted-ai-model-settings-routing-and-admin-boundary',
      'mysql-ai-capability-scope-runtime-and-admin-boundary',
      'independent-ai-capability-and-im-extension-rollback-flags',
      'mysql-im-encrypted-binding-outbox-inbound-and-admin-boundary',
      'protected-file-artifact-and-im-delivery-audit-boundary',
      'bounded-agent-provider-failure-retry-fallback-and-dead-letter-boundary',
      'mysql-consistent-backup-isolated-restore-and-content-verification-boundary',
      'single-service-admin-operational-telemetry-and-threshold-boundary',
      'acceptance-fixture-file-residue-recoverable-quarantine-boundary',
      'browser-ui-smoke-fixture-project-file-and-lead-lifecycle-boundary',
      'agent-workspace-orphan-quarantine-and-delete-lifecycle-boundary',
      'ai-runtime-real-first-token-total-error-cancel-and-observation-coverage-boundary',
      'mysql-runtime-slow-query-row-lock-deadlock-and-replication-observability-boundary',
      'lead-review-backlog-throughput-and-resolution-observability-boundary',
      'lead-entity-duplicate-groups-observability-boundary',
      'exact-lead-reserve-and-ai-artifact-source-gap-disposition-boundary',
      'document-native-runtime-render-font-and-quality-observability-boundary',
      'document-runtime-exact-python-lock-native-version-ocr-language-and-cjk-font-contract-boundary',
      'file-access-volume-and-storage-capacity-observability-boundary',
      'file-storage-hourly-history-and-cross-day-growth-observability-boundary',
      'credential-change-and-high-risk-tool-denial-observability-boundary',
      'worker-job-history-timeout-retry-and-lease-recovery-observability-boundary',
      'supervised-process-persistent-exit-history-observability-boundary',
      'job-coordination-contention-duplicate-recovery-and-stale-result-observability-boundary',
      'single-service-operational-alert-outbox-delivery-and-recovery-boundary',
      'oa-workflow-mysql-transaction-stable-identity-and-refresh-boundary',
      'ai-task-mysql-persistence-quality-and-artifact-isolation-boundary',
      'six-ai-document-task-types-unified-entry-and-worker-boundary',
      'six-ai-document-task-types-worker-interruption-recovery-boundary',
      'target-linux-single-service-cgroup-port-timer-cron-and-tls-evidence-boundary',
      'production-tls-and-runtime-config',
      'rollback-window-http-startup-auth-worker-and-mysql-write-freeze-boundary',
      'atomic-owner-only-write-freeze-env-and-five-party-ponr-approval-boundary',
      'six-domain-zero-write-rollback-threshold-and-forward-repair-boundary',
      'mysql-auth-session-concurrency-renewal-and-secret-rotation',
      'auth-session-key-rotation-lifecycle-and-legacy-key-activity-observability-boundary',
      'non-root-systemd-runtime',
      'systemd-process-group-shutdown',
      'systemd-resource-limits',
      'systemd-filesystem-and-privilege-sandbox',
      'no-retired-nginx-upstream',
      'no-project-systemd-timer',
    ],
    scannedActiveFiles: activeFiles.length,
    aipinOfflineAllowlist: [...aipinOfflineAllowlist],
  }))
}

await main()
