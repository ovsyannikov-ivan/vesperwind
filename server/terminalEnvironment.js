const NVM_CONFLICTING_VARIABLES = [
  'npm_config_prefix',
  'NPM_CONFIG_PREFIX',
  'PREFIX',
]

export const sanitizeTerminalEnvironment = (sourceEnvironment = {}) => {
  const environment = { ...sourceEnvironment }

  for (const variableName of NVM_CONFLICTING_VARIABLES) {
    delete environment[variableName]
  }

  return environment
}
