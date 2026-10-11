// A small element tree for mounting real Vue components in Node tests with
// Vue's own renderer (runtime-core `createRenderer`). It implements only what
// the file tree uses: attributes, classes, inline styles, events, focus, a
// scroll container with fixed geometry and `[data-*="value"]` queries.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRenderer } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
const cacheDirectory = path.join(projectRoot, 'node_modules', '.cache', 'vesperwind-test-sfc')

export class FakeElement {
  constructor (tag) {
    // Elements are never made reactive, like DOM nodes in the browser.
    this.__v_skip = true
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.listeners = new Map()
    this.style = {}
    this.className = ''
    this.textContent = ''
    this.value = ''
    this.scrollTop = 0
    this.clientHeight = 0
    this.selectionStart = 0
    this.selectionEnd = 0
  }

  get parentElement () { return this.parentNode instanceof FakeElement ? this.parentNode : null }
  get dataset () {
    const result = {}
    for (const [name, value] of this.attributes) {
      if (name.startsWith('data-')) result[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value
    }
    return result
  }

  get classList () {
    const element = this
    return { contains: (name) => element.className.split(/\s+/).includes(name) }
  }

  setAttribute (name, value) { this.attributes.set(name, String(value)) }
  getAttribute (name) { return this.attributes.get(name) ?? null }
  removeAttribute (name) { this.attributes.delete(name) }
  addEventListener (type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }

  removeEventListener (type, listener) { this.listeners.get(type)?.delete(listener) }
  dispatchEvent (event) {
    if (!event.target) Object.defineProperty(event, 'target', { value: this, configurable: true })
    for (let node = this; node; node = node.parentNode) {
      Object.defineProperty(event, 'currentTarget', { value: node, configurable: true })
      for (const listener of [...(node.listeners?.get(event.type) || [])]) listener(event)
      if (event.cancelBubble || !event.bubbles) break
    }
    return !event.defaultPrevented
  }

  focus () { globalThis.document.activeElement = this }
  blur () { if (globalThis.document.activeElement === this) globalThis.document.activeElement = null }
  setSelectionRange (start, end) { this.selectionStart = start; this.selectionEnd = end }
  contains (other) { for (let node = other; node; node = node.parentNode) if (node === this) return true; return false }
  closest (selector) {
    for (let node = this; node; node = node.parentNode) if (node.matches?.(selector)) return node
    return null
  }

  matches (selector) {
    return selector.split(',').some((part) => {
      const value = part.trim()
      const attribute = value.match(/^\[([\w-]+)(?:="(.*)")?\]$/)
      if (attribute) return attribute[2] === undefined ? this.attributes.has(attribute[1]) : this.attributes.get(attribute[1]) === attribute[2]
      if (value.startsWith('.')) return value.slice(1).split('.').every((name) => this.classList.contains(name))
      return this.tagName === value.toUpperCase()
    })
  }

  querySelectorAll (selector) {
    const found = []
    const visit = (node) => { for (const child of node.children || []) { if (child.matches?.(selector)) found.push(child); visit(child) } }
    visit(this)
    return found
  }

  querySelector (selector) { return this.querySelectorAll(selector)[0] || null }
  getClientRects () { return [{}] }
  // Rows are laid out by index; only the scroll container and list need boxes.
  getBoundingClientRect () {
    return this.box?.() || this.parentNode?.childBox?.(this) || { top: 0, bottom: 0, left: 0, right: 0, height: 0 }
  }
  get offsetHeight () { return 0 }
}

class FakeText {
  constructor (text) { this.textContent = text; this.parentNode = null }
}

const insert = (child, parent, anchor) => {
  if (child.parentNode) remove(child)
  const index = anchor ? parent.children.indexOf(anchor) : -1
  if (index >= 0) parent.children.splice(index, 0, child)
  else parent.children.push(child)
  child.parentNode = parent
}
const remove = (child) => {
  const parent = child.parentNode
  if (!parent) return
  parent.children.splice(parent.children.indexOf(child), 1)
  child.parentNode = null
}

export const testRenderer = createRenderer({
  createElement: (tag) => new FakeElement(tag),
  createText: (text) => new FakeText(text),
  // Comments (v-if anchors) carry no text.
  createComment: (text) => Object.assign(new FakeText(''), { comment: text }),
  setText: (node, text) => { node.textContent = text },
  setElementText: (element, text) => { element.children = []; element.textContent = text },
  insert,
  remove,
  parentNode: (node) => node.parentNode,
  nextSibling: (node) => {
    const siblings = node.parentNode?.children || []
    return siblings[siblings.indexOf(node) + 1] || null
  },
  patchProp: (element, key, previous, next) => {
    if (key === 'class') element.className = next || ''
    else if (key === 'style') element.style = { ...(next || {}) }
    else if (/^on[A-Z]/.test(key)) {
      const type = key.slice(2).toLowerCase()
      if (previous) element.removeEventListener(type, previous)
      if (next) element.addEventListener(type, next)
    } else if (key === 'value') element.value = next ?? ''
    // As in runtime-dom: false stays "false" except for boolean attributes.
    else if (next === undefined || next === null || (next === false && ['draggable', 'disabled'].includes(key) === false && !key.startsWith('aria-') && !key.startsWith('data-') && key !== 'tabindex')) element.removeAttribute(key)
    else element.setAttribute(key, next === true && key === 'disabled' ? '' : String(next))
  },
})

export const installDomGlobals = () => {
  globalThis.document = { activeElement: null, documentElement: new FakeElement('html'),
    addEventListener () {}, removeEventListener () {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null }
  const storage = new Map()
  const localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) }
  Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true, writable: true })
  globalThis.window = { addEventListener () {}, removeEventListener () {}, dispatchEvent () { return true }, localStorage,
    matchMedia: () => ({ matches: false, addEventListener () {}, removeEventListener () {} }) }
  globalThis.CSS = { escape: (value) => value }
  globalThis.CustomEvent ??= class extends Event { constructor (type, options) { super(type, options); this.detail = options?.detail } }
  globalThis.getComputedStyle = (element) => ({
    overflowY: element.scrollContainer ? 'auto' : 'visible',
    position: element.sticky ? 'sticky' : 'static',
    getPropertyValue: (name) => (name === '--file-tree-row-height' ? '22px' : ''),
  })
  globalThis.ResizeObserver = class { observe () {} disconnect () {} }
}

/** Compile a single-file component to a module that imports the real sources. */
export const compileComponent = async (relative, replacements = {}) => {
  const filename = path.join(projectRoot, relative)
  const { descriptor } = parse(await fs.readFile(filename, 'utf8'), { filename })
  const { content } = compileScript(descriptor, { id: path.basename(relative), inlineTemplate: true })
  const code = content.replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g, (_, quote, specifier) =>
    `from ${quote}${replacements[specifier] || pathToFileURL(path.resolve(path.dirname(filename), specifier)).href}${quote}`)
  await fs.mkdir(cacheDirectory, { recursive: true })
  // One file per component, overwritten on each run.
  const target = path.join(cacheDirectory, `${relative.replaceAll(/[\\/]/g, '_')}.mjs`)
  await fs.writeFile(target, code)
  return pathToFileURL(target).href
}
