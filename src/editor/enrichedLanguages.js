import { language as javascriptLanguage } from 'monaco-editor/languages/definitions/javascript/javascript.js'
import { language as typescriptLanguage } from 'monaco-editor/languages/definitions/typescript/typescript.js'
import { language as pythonLanguage } from 'monaco-editor/languages/definitions/python/python.js'

const javascriptRules = [
  [/\b(?:import|export|from|as|default)\b/, 'keyword.import'],
  [/\b(?:const|let|var|function|class|interface|enum|extends|implements|new)\b/, 'keyword.declaration'],
  [/\b(?:true|false|null|undefined)\b/, 'constant'],
  [/[a-zA-Z_$][\w$]*(?=\s*\()/, { cases: { '@keywords': 'keyword', '@default': 'function' } }],
  [/[a-zA-Z_$][\w$]*(?=\s*=)/, { cases: { '@keywords': 'keyword', '@default': 'variable' } }],
  [/[a-zA-Z_$][\w$]*(?=\s*\.)/, { cases: { '@keywords': 'keyword', '@default': 'variable' } }],
]

const pythonRules = [
  [/(\bdef\b)(\s+)([a-zA-Z_]\w*)/, ['keyword.declaration', 'white', 'function']],
  [/(\bclass\b)(\s+)([a-zA-Z_]\w*)/, ['keyword.declaration', 'white', 'type']],
  [/\b(?:from|import)\b/, 'keyword.import', '@importLine'],
  [/\bself\b/, 'identifier'],
  [/[a-zA-Z_]\w*(?=\s*\()/, { cases: { '@keywords': 'keyword', '@default': 'function' } }],
  [/[A-Z][a-zA-Z_0-9]*/, 'type'],
]

export const enrichedLanguages = [
  ...[
    ['javascript', javascriptLanguage],
    ['typescript', typescriptLanguage],
  ].map(([id, base]) => ({
    id,
    language: {
      ...base,
      tokenizer: {
        ...base.tokenizer,
        common: [...javascriptRules, ...base.tokenizer.common],
      },
    },
  })),
  {
    id: 'python',
    language: {
      ...pythonLanguage,
      tokenizer: {
        ...pythonLanguage.tokenizer,
        root: [...pythonRules, ...pythonLanguage.tokenizer.root],
        importLine: [
          [/\s+/, 'white'],
          [/\bas\b/, 'keyword'],
          [/[a-zA-Z_]\w*/, 'namespace'],
          [/[.,]/, 'delimiter'],
          [/$/, '', '@pop'],
        ],
      },
    },
  },
]

export const registerEnrichedLanguages = (monaco) => {
  for (const { id, language } of enrichedLanguages) {
    monaco.languages.setMonarchTokensProvider(id, language)
  }
}
