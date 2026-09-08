import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Invoked only by the trusted candidate builder inside an isolated execution environment.
const [sourceRoot, outputRoot] = process.argv.slice(2)
if (!sourceRoot || !outputRoot || !path.isAbsolute(sourceRoot) || !path.isAbsolute(outputRoot)) {
  throw new Error('absolute source and output roots required')
}
const require = createRequire(path.join(sourceRoot, 'package.json'))
const { build } = await import(pathToFileURL(path.join(path.dirname(require.resolve('vite/package.json')), 'dist/node/index.js')).href)
const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)
const envDir = path.join(outputRoot, '.empty-env')
await mkdir(envDir)
await build({
  root: sourceRoot,
  configFile: false,
  envDir,
  plugins: [react()],
  build: { outDir: path.join(outputRoot, 'dist'), emptyOutDir: false },
})
