import { mkdir, rm, cp } from 'node:fs/promises'
import { parseArgs } from 'node:util'

const OUT_DIR = 'dist'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    watch: { type: 'boolean', default: false },
  },
})

async function copyPublic(): Promise<void> {
  await cp('public', OUT_DIR, { recursive: true })
}

async function buildOnce(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })
  await copyPublic()

  const result = await Bun.build({
    entrypoints: [
      'src/background/index.ts',
      'src/content/index.ts',
      'src/popup/index.ts',
      'src/selection/index.ts',
      'src/youtube/main-world-capture.ts',
    ],
    outdir: OUT_DIR,
    target: 'browser',
    format: 'esm',
    minify: false,
    sourcemap: 'external',
    naming: {
      entry: '[dir].[ext]',
      chunk: 'chunks/[name]-[hash].[ext]',
      asset: 'assets/[name]-[hash].[ext]',
    },
  })

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log)
    }
    process.exitCode = 1
    return
  }

  console.info(`Built ${OUT_DIR}/`)
}

await buildOnce()

if (values.watch) {
  const watcher = (await import('node:fs')).watch(
    '.',
    { recursive: true },
    (eventType, filename) => {
      if (!filename || filename.startsWith(OUT_DIR) || filename.startsWith('node_modules')) {
        return
      }

      console.info(`${eventType}: ${filename}`)
      void buildOnce()
    },
  )

  process.on('SIGINT', () => {
    watcher.close()
    process.exit(0)
  })
}
