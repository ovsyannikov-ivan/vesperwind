import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeTerminalEnvironment } from '../server/terminalEnvironment.js'

test('removes npm prefix variables that conflict with NVM', () => {
  const sourceEnvironment = {
    HOME: '/Users/ivan',
    PATH: '/Users/ivan/.nvm/versions/node/v26.0.0/bin:/usr/bin',
    npm_config_prefix: '/opt/homebrew',
    NPM_CONFIG_PREFIX: '/another/prefix',
    PREFIX: '/legacy/prefix',
  }

  const terminalEnvironment = sanitizeTerminalEnvironment(sourceEnvironment)

  assert.equal(terminalEnvironment.npm_config_prefix, undefined)
  assert.equal(terminalEnvironment.NPM_CONFIG_PREFIX, undefined)
  assert.equal(terminalEnvironment.PREFIX, undefined)
  assert.equal(terminalEnvironment.HOME, sourceEnvironment.HOME)
  assert.equal(terminalEnvironment.PATH, sourceEnvironment.PATH)
  assert.equal(sourceEnvironment.npm_config_prefix, '/opt/homebrew')
})
