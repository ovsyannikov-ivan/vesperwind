import themes from './editorThemes.json' with { type: 'json' }
export const EDITOR_THEMES = Object.freeze(themes.map((theme) => Object.freeze(theme)))
