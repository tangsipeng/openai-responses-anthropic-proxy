import { parseProxyConfigFromArgs } from './config.js'
import { startOpenAIResponsesCompatProxy } from './server.js'

try {
  const config = parseProxyConfigFromArgs(process.argv.slice(2))
  const proxy = startOpenAIResponsesCompatProxy({
    ...config,
    logger: line => console.log(line),
  })

  // CLI entrypoint intentionally prints startup information.
  console.log(
    `[openai-responses-proxy] listening on http://${proxy.host}:${proxy.port} -> ${config.upstreamURL}`,
  )
} catch (error) {
  // CLI entrypoint intentionally prints startup errors.
  console.error(
    `[openai-responses-proxy] ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exit(1)
}
