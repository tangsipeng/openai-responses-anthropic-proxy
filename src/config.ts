import type { ProxyConfig } from './types.js'

function parseInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer for ${flag}: ${value}`)
  }
  return parsed
}

function parseHeader(raw: string): [string, string] {
  const index = raw.indexOf('=')
  if (index <= 0) {
    throw new Error(
      `Invalid --upstream-header value: ${raw}. Expected Name=Value format.`,
    )
  }

  const name = raw.slice(0, index).trim()
  const value = raw.slice(index + 1).trim()

  if (!name) {
    throw new Error(`Invalid --upstream-header value: ${raw}`)
  }

  return [name, value]
}

export function parseProxyConfigFromArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): ProxyConfig {
  const upstreamHeaders: Record<string, string> = {}
  let listenHost = env.OPENAI_RESPONSES_PROXY_HOST ?? '127.0.0.1'
  let listenPort = env.OPENAI_RESPONSES_PROXY_PORT
    ? parseInteger(env.OPENAI_RESPONSES_PROXY_PORT, 'OPENAI_RESPONSES_PROXY_PORT')
    : 4141
  let upstreamURL = env.OPENAI_RESPONSES_UPSTREAM_URL ?? ''
  let upstreamKey = env.OPENAI_RESPONSES_UPSTREAM_KEY ?? ''
  let upstreamModel = env.OPENAI_RESPONSES_UPSTREAM_MODEL
  let stateFilePath =
    env.OPENAI_RESPONSES_STATE_FILE ?? '.openai-responses-anthropic-proxy-state.json'

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const next = args[index + 1]

    switch (arg) {
      case '--listen-host':
        if (!next) throw new Error('Missing value for --listen-host')
        listenHost = next
        index += 1
        break
      case '--listen-port':
        if (!next) throw new Error('Missing value for --listen-port')
        listenPort = parseInteger(next, '--listen-port')
        index += 1
        break
      case '--upstream-url':
        if (!next) throw new Error('Missing value for --upstream-url')
        upstreamURL = next
        index += 1
        break
      case '--upstream-key':
        if (!next) throw new Error('Missing value for --upstream-key')
        upstreamKey = next
        index += 1
        break
      case '--upstream-model':
        if (!next) throw new Error('Missing value for --upstream-model')
        upstreamModel = next
        index += 1
        break
      case '--state-file':
        if (!next) throw new Error('Missing value for --state-file')
        stateFilePath = next
        index += 1
        break
      case '--upstream-header':
        if (!next) throw new Error('Missing value for --upstream-header')
        {
          const [name, value] = parseHeader(next)
          upstreamHeaders[name] = value
        }
        index += 1
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!upstreamURL) {
    throw new Error(
      'Missing upstream URL. Use --upstream-url or OPENAI_RESPONSES_UPSTREAM_URL.',
    )
  }
  if (!upstreamKey) {
    throw new Error(
      'Missing upstream key. Use --upstream-key or OPENAI_RESPONSES_UPSTREAM_KEY.',
    )
  }

  return {
    listenHost,
    listenPort,
    upstreamURL,
    upstreamKey,
    ...(upstreamModel ? { upstreamModel } : {}),
    ...(stateFilePath ? { stateFilePath } : {}),
    ...(Object.keys(upstreamHeaders).length > 0 ? { upstreamHeaders } : {}),
  }
}
