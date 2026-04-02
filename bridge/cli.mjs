import { runAgent } from './agent.mjs'

async function readStdin() {
  let data = ''
  for await (const chunk of process.stdin) {
    data += chunk.toString()
  }
  return data
}

async function main() {
  const raw = await readStdin()
  const payload = JSON.parse(raw)
  const response = await runAgent(payload)
  process.stdout.write(JSON.stringify(response))
}

main().catch(error => {
  process.stdout.write(
    JSON.stringify({
      message: error instanceof Error ? error.message : String(error),
      toolEvents: [],
    }),
  )
  process.exitCode = 1
})
