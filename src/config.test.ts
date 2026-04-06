import { describe, expect, test } from 'bun:test'
import { parseProxyConfigFromArgs } from './config.js'

describe('proxy config parsing', () => {
  test('parses CLI args into proxy runtime config', () => {
    const config = parseProxyConfigFromArgs([
      '--listen-host',
      '0.0.0.0',
      '--listen-port',
      '4141',
      '--upstream-url',
      'https://api.openai.com',
      '--upstream-key',
      'sk-test',
      '--upstream-model',
      'gpt-4.1',
      '--state-file',
      '/tmp/proxy-state.json',
      '--upstream-header',
      'X-Test=1',
      '--upstream-header',
      'OpenAI-Organization=org_123',
    ])

    expect(config).toEqual({
      listenHost: '0.0.0.0',
      listenPort: 4141,
      upstreamURL: 'https://api.openai.com',
      upstreamKey: 'sk-test',
      upstreamModel: 'gpt-4.1',
      stateFilePath: '/tmp/proxy-state.json',
      upstreamHeaders: {
        'X-Test': '1',
        'OpenAI-Organization': 'org_123',
      },
    })
  })
})
