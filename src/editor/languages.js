const customLanguageDefinitions = [
  {
    id: 'vue',
    extensions: ['.vue'],
    aliases: ['Vue', 'vue'],
    tokenizer: {
      defaultToken: '',
      tokenPostfix: '.vue',
      ignoreCase: true,
      tokenizer: {
        root: [
          [/<!--/, 'comment', '@comment'],
          [
            /<script(?=[^>]*\blang\s*=\s*["'](?:ts|typescript)["'])[^>]*>/,
            { token: 'tag', next: '@scriptTs', nextEmbedded: 'typescript' },
          ],
          [
            /<script[^>]*>/,
            { token: 'tag', next: '@scriptJs', nextEmbedded: 'javascript' },
          ],
          [
            /<style(?=[^>]*\blang\s*=\s*["']scss["'])[^>]*>/,
            { token: 'tag', next: '@styleScss', nextEmbedded: 'scss' },
          ],
          [
            /<style(?=[^>]*\blang\s*=\s*["']less["'])[^>]*>/,
            { token: 'tag', next: '@styleLess', nextEmbedded: 'less' },
          ],
          [
            /<style[^>]*>/,
            { token: 'tag', next: '@styleCss', nextEmbedded: 'css' },
          ],
          [/<!DOCTYPE/, 'metatag', '@doctype'],
          [/[{}]/, 'delimiter.bracket'],
          [/<\/?[\w:-]+/, 'tag', '@tag'],
          [/[^<{]+/, ''],
          [/</, 'delimiter'],
        ],
        tag: [
          [/\s+/, 'white'],
          [/([\w:-]+)(\s*=\s*)(["'])/, ['attribute.name', '', 'string'], '@attribute'],
          [/[\w:-]+/, 'attribute.name'],
          [/\/>/, 'delimiter', '@pop'],
          [/>/, 'delimiter', '@pop'],
        ],
        attribute: [
          [/[^"']+/, 'string'],
          [/(["'])/, 'string', '@pop'],
        ],
        comment: [
          [/[^<-]+/, 'comment'],
          [/-->/, 'comment', '@pop'],
          [/[<-]/, 'comment'],
        ],
        doctype: [
          [/[^>]+/, 'metatag.content'],
          [/>/, 'metatag', '@pop'],
        ],
        scriptTs: [[/<\/script\s*>/, { token: '@rematch', next: '@pop', nextEmbedded: '@pop' }]],
        scriptJs: [[/<\/script\s*>/, { token: '@rematch', next: '@pop', nextEmbedded: '@pop' }]],
        styleScss: [[/<\/style\s*>/, { token: '@rematch', next: '@pop', nextEmbedded: '@pop' }]],
        styleLess: [[/<\/style\s*>/, { token: '@rematch', next: '@pop', nextEmbedded: '@pop' }]],
        styleCss: [[/<\/style\s*>/, { token: '@rematch', next: '@pop', nextEmbedded: '@pop' }]],
      },
    },
  },
  {
    id: 'toml',
    extensions: ['.toml'],
    aliases: ['TOML', 'toml'],
    tokenizer: {
      tokenizer: {
        root: [
          [/#.*$/, 'comment'],
          [/^\s*\[\[?.*?\]\]?\s*$/, 'type.identifier'],
          [/^[\w.-]+(?=\s*=)/, 'key'],
          [/"""/, 'string', '@multilineString'],
          [/'''/, 'string', '@multilineLiteral'],
          [/"(?:\\.|[^"\\])*"/, 'string'],
          [/'[^']*'/, 'string'],
          [/\b(?:true|false)\b/, 'keyword'],
          [/[-+]?\b\d(?:[\d_]*\d)?(?:\.\d(?:[\d_]*\d)?)?(?:e[-+]?\d+)?\b/i, 'number'],
          [/\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[-+]\d{2}:\d{2})?)?/, 'number.date'],
        ],
        multilineString: [[/"""/, 'string', '@pop'], [/./, 'string']],
        multilineLiteral: [[/'''/, 'string', '@pop'], [/./, 'string']],
      },
    },
  },
  {
    id: 'makefile',
    filenames: ['Makefile', 'makefile', 'GNUmakefile'],
    aliases: ['Makefile', 'makefile'],
    tokenizer: {
      tokenizer: {
        root: [
          [/^\s*#.*$/, 'comment'],
          [/^\t.*$/, 'string'],
          [/\$\([^)]+\)|\$\{[^}]+\}/, 'variable'],
          [/^[^\s:#=]+(?=\s*:)/, 'type.identifier'],
          [/^[A-Za-z_][\w.-]*(?=\s*[:?+]?=)/, 'variable'],
          [/\b(?:include|define|endef|ifdef|ifndef|ifeq|ifneq|else|endif|export|override|private|unexport|vpath)\b/, 'keyword'],
        ],
      },
    },
  },
  {
    id: 'ignore',
    aliases: ['Ignore file', 'ignore'],
    tokenizer: {
      tokenizer: {
        root: [
          [/^\s*#.*$/, 'comment'],
          [/^!.*$/, 'keyword'],
          [/\*\*|\*|\?/, 'operator'],
        ],
      },
    },
  },
  {
    id: 'nginx',
    aliases: ['Nginx', 'nginx'],
    tokenizer: {
      tokenizer: {
        root: [
          [/#.*$/, 'comment'],
          [/\$[\w_]+/, 'variable'],
          [/\b(?:http|server|location|upstream|events|map|if|include|listen|server_name|proxy_pass|root|index|return|rewrite)\b/, 'keyword'],
          [/[{};]/, 'delimiter'],
          [/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/, 'string'],
          [/\b\d+[kKmMgG]?\b/, 'number'],
        ],
      },
    },
  },
  {
    id: 'apache',
    aliases: ['Apache config', 'apache'],
    tokenizer: {
      tokenizer: {
        root: [
          [/#.*$/, 'comment'],
          [/<\/?[A-Za-z][^>]*>/, 'tag'],
          [/^[ \t]*[A-Za-z][\w-]*/, 'keyword'],
          [/"(?:\\.|[^"\\])*"/, 'string'],
          [/\$\{[^}]+\}/, 'variable'],
        ],
      },
    },
  },
  {
    id: 'groovy',
    extensions: ['.gradle'],
    aliases: ['Groovy', 'groovy'],
    tokenizer: {
      defaultToken: '',
      keywords: [
        'as', 'assert', 'break', 'case', 'catch', 'class', 'continue',
        'def', 'default', 'do', 'else', 'enum', 'extends', 'false',
        'finally', 'for', 'if', 'implements', 'import', 'in', 'instanceof',
        'interface', 'new', 'null', 'package', 'return', 'switch', 'this',
        'throw', 'throws', 'trait', 'true', 'try', 'while',
      ],
      tokenizer: {
        root: [
          [/[a-zA-Z_$][\w$]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
          [/\/\*/, 'comment', '@comment'],
          [/\/\/.*$/, 'comment'],
          [/"""/, 'string', '@multilineString'],
          [/'''/, 'string', '@multilineLiteral'],
          [/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/, 'string'],
          [/\b(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?)\b/, 'number'],
          [/[{}()[\]]/, '@brackets'],
        ],
        comment: [[/[^/*]+/, 'comment'], [/\*\//, 'comment', '@pop'], [/[/*]/, 'comment']],
        multilineString: [[/"""/, 'string', '@pop'], [/./, 'string']],
        multilineLiteral: [[/'''/, 'string', '@pop'], [/./, 'string']],
      },
    },
  },
]

let registered = false

export const registerEditorLanguages = (monaco) => {
  if (registered) {
    return
  }

  const existingLanguages = new Set(
    monaco.languages.getLanguages().map((language) => language.id),
  )

  for (const definition of customLanguageDefinitions) {
    if (!existingLanguages.has(definition.id)) {
      monaco.languages.register({
        id: definition.id,
        aliases: definition.aliases,
        extensions: definition.extensions,
        filenames: definition.filenames,
      })
    }

    monaco.languages.setMonarchTokensProvider(
      definition.id,
      definition.tokenizer,
    )
  }

  registered = true
}

export const CUSTOM_EDITOR_LANGUAGE_IDS = customLanguageDefinitions.map(
  ({ id }) => id,
)
