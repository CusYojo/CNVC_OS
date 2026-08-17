console.error([
  'The standalone Flue runtime has retired and must not be started.',
  'Run `npm run build && npm run start:all` from the repository root.',
  'This directory is retained only for migration and recovery evidence.',
].join('\n'))
process.exitCode = 78
