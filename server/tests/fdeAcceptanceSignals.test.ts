import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'

const signalModule = new URL('../src/scripts/fdeAcceptanceSignals.js', import.meta.url).href

async function processCase(guarded: boolean, interrupt: boolean, failure = false) {
  const program = `
    import { setTimeout as wait } from 'node:timers/promises';
    import { withFdeAcceptanceSignals } from ${JSON.stringify(signalModule)};
    const work = async () => {
      // A signal listener alone does not keep Node's event loop alive. Keep a
      // real handle until the parent sends the first signal; otherwise Node may
      // exit with unsettled top-level await before the signal test even starts.
      ${interrupt ? "const waiting = setInterval(() => {}, 1000); try { await new Promise(resolve => { process.once('SIGINT', resolve); console.log('ready'); }); } finally { clearInterval(waiting); }" : ''}
      try { ${failure ? "throw new Error('synthetic-child-failure');" : ''} }
      finally { console.log('cleanup-ready'); await wait(150); console.log('cleanup-done'); }
    };
    try { ${guarded ? 'await withFdeAcceptanceSignals(work);' : 'await work();'} }
    catch (error) { console.log(error.message); process.exitCode = 1; }
  `
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', signaled = false, cleanupSignal = false
  child.stdout.on('data', data => {
    output += String(data)
    if (interrupt && output.includes('ready\n') && !signaled) { signaled = true; child.kill('SIGINT') }
    if (interrupt && output.includes('cleanup-ready\n') && !cleanupSignal) {
      cleanupSignal = true; child.kill('SIGTERM')
      // The negative control tests one late TERM. Sending another INT can
      // race OS delivery under load and obscure which signal ended it.
      // The protected case still exercises repeated mixed termination signals.
      if (guarded) setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT') }, 20)
    }
  })
  child.stderr.on('data', data => { output += String(data) })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
  try { const [code, signal] = await once(child, 'exit'); return { code, signal, output } }
  finally { clearTimeout(timeout) }
}

test('regression demonstrates a late termination signal interrupts unguarded asynchronous cleanup', async () => {
  const result = await processCase(false, true)
  assert.equal(result.signal, 'SIGTERM'); assert.match(result.output, /cleanup-ready/); assert.doesNotMatch(result.output, /cleanup-done/)
})
test('persistent signal guards survive repeated mixed signals until real subprocess cleanup completes', async () => {
  const result = await processCase(true, true)
  assert.equal(result.code, 0, result.output); assert.equal(result.signal, null); assert.match(result.output, /cleanup-done/)
  assert.match(result.output, /acceptanceSignal/)
})
test('normal exit and original work failures both await cleanup, without converting failure to success', async () => {
  for (const failure of [false, true]) {
    const result = await processCase(true, false, failure)
    assert.equal(result.code, failure ? 1 : 0, result.output); assert.match(result.output, /cleanup-done/)
    if (failure) assert.match(result.output, /synthetic-child-failure/)
  }
})

test('tracked unresponsive children are stopped by exact handle before cleanup can proceed', async () => {
  const program = `
    import { spawn } from 'node:child_process'; import { once } from 'node:events';
    import { withFdeAcceptanceSignals } from ${JSON.stringify(signalModule)};
    await withFdeAcceptanceSignals(async control => {
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore','pipe','ignore'] });
      control.track(child); child.stdout.once('data', () => { process.kill(process.pid,'SIGTERM'); process.kill(process.pid,'SIGINT'); });
      const [code,signal] = await once(child,'exit'); console.log(JSON.stringify({code,signal,cleanupAfterConfirmedExit:true}));
    }, 50);
  `
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
  try { const [code] = await once(child, 'exit'); assert.equal(code, 0, output); assert.match(output, /"signal":"SIGKILL"/); assert.match(output, /cleanupAfterConfirmedExit/); assert.match(output, /acceptanceChildDrainTimedOut/) }
  finally { clearTimeout(timeout) }
})
