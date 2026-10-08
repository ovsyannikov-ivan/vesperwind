const brackets = [['{', '}'], ['[', ']'], ['(', ')']]
const quotes = [
  { open: '"', close: '"', notIn: ['string', 'comment'] },
  { open: "'", close: "'", notIn: ['string', 'comment'] },
]
const programming = {
  brackets,
  autoClosingPairs: [...brackets.map(([open, close]) => ({ open, close, notIn: ['string', 'comment'] })), ...quotes],
  surroundingPairs: [...brackets.map(([open, close]) => ({ open, close })), ...quotes],
  indentationRules: {
    increaseIndentPattern: /^.*\{[^}"']*$/,
    decreaseIndentPattern: /^\s*\}/,
  },
}

export const CUSTOM_LANGUAGE_CONFIGURATIONS = {
  vue: {
    ...programming,
    comments: { blockComment: ['<!--', '-->'] },
    autoClosingPairs: [...programming.autoClosingPairs,
      { open: '`', close: '`', notIn: ['string', 'comment'] }],
    surroundingPairs: [...programming.surroundingPairs, { open: '`', close: '`' }],
    indentationRules: {
      increaseIndentPattern: /(?:^.*\{[^}"']*$|^\s*<(?!\/|.*\/\s*>)(?!area\b|base\b|br\b|col\b|embed\b|hr\b|img\b|input\b|link\b|meta\b|param\b|source\b|track\b|wbr\b)[\w:-]+(?:\s[^>]*)?>\s*$)/i,
      decreaseIndentPattern: /^\s*(?:\}|<\/)/,
    },
  },
  toml: { comments: { lineComment: '#' }, brackets: [['[', ']'], ['{', '}']],
    autoClosingPairs: [...programming.autoClosingPairs.filter(pair => pair.open !== '(')],
    surroundingPairs: [...programming.surroundingPairs.filter(pair => pair.open !== '(')] },
  groovy: { ...programming, comments: { lineComment: '//', blockComment: ['/*', '*/'] } },
  nginx: { ...programming, comments: { lineComment: '#' }, brackets: [['{', '}']],
    autoClosingPairs: programming.autoClosingPairs.filter(pair => !['(', '['].includes(pair.open)),
    surroundingPairs: programming.surroundingPairs.filter(pair => !['(', '['].includes(pair.open)) },
  apache: { comments: { lineComment: '#' }, brackets: [['{', '}']],
    autoClosingPairs: quotes, surroundingPairs: quotes,
    indentationRules: { increaseIndentPattern: /^\s*<(?!\/)[\w]+[^>]*>\s*$/,
      decreaseIndentPattern: /^\s*<\// } },
  makefile: { comments: { lineComment: '#' }, brackets: [['(', ')'], ['{', '}']],
    // Recipe lines must retain Make's meaningful literal tabs.
    autoClosingPairs: [{ open: '$(', close: ')' }, { open: '${', close: '}' }],
    surroundingPairs: [{ open: '(', close: ')' }, { open: '{', close: '}' }] },
  ignore: { comments: { lineComment: '#' }, brackets: [], autoClosingPairs: [], surroundingPairs: [] },
}
