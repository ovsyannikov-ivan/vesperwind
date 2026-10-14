import assert from 'node:assert/strict'
import test from 'node:test'
import { observeScrollShadows, scrollEdges } from '../src/utils/scrollShadows.js'

test('scroll edges distinguish fit, top, middle and bottom with fractional/elastic scrolling', () => {
  const edges = (scrollTop, scrollHeight = 800, clientHeight = 300) => scrollEdges({ scrollTop, scrollHeight, clientHeight })
  assert.deepEqual(edges(0), { top: false, bottom: true })
  assert.deepEqual(edges(240.5), { top: true, bottom: true })
  assert.deepEqual(edges(500), { top: true, bottom: false })
  assert.deepEqual(edges(-40), edges(0))
  assert.deepEqual(edges(560), edges(500))
  assert.deepEqual(edges(0, 300.5), { top: false, bottom: false })
  assert.deepEqual(edges(0, 800, 0), { top: false, bottom: false })
})

test('nested preview scrolling, content growth, replacement, resize and disposal update bounded overlays', () => {
  const frames = new Map(), updates = [], observers = []
  let nextFrame = 0
  class Observer {
    constructor(callback) { this.callback = callback; this.elements = new Set(); observers.push(this) }
    observe(element) { this.elements.add(element) }
    unobserve(element) { this.elements.delete(element) }
    disconnect() { this.elements.clear() }
  }
  const content = {}
  const port = { scrollTop: 0, scrollHeight: 800, clientHeight: 300, clientWidth: 600,
    clientLeft: 0, clientTop: 0, children: [content], overflowY: 'auto',
    getBoundingClientRect: () => ({ left: 120, top: 80 }) }
  const root = Object.assign(new EventTarget(), { clientHeight: 400, clientWidth: 800, overflowY: 'hidden',
    children: [port], querySelectorAll: () => root.children,
    getBoundingClientRect: () => ({ left: 100, top: 50 }) })
  const stop = observeScrollShadows(root, (value) => updates.push(value), {
    ResizeObserver: Observer, MutationObserver: Observer,
    requestFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame },
    cancelFrame: (id) => frames.delete(id), computedStyle: (element) => element,
  })
  const flush = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback() }
  flush()
  assert.deepEqual(updates[0], { top: false, bottom: true, style: { left: '20px', top: '30px', width: '600px', height: '300px' } })
  assert.ok(observers[0].elements.has(content), 'observe content growth inside a fixed viewport')
  port.scrollTop = 250
  for (let index = 0; index < 20; index++) root.dispatchEvent(new Event('scroll'))
  assert.equal(frames.size, 1, 'scroll bursts share a single animation frame')
  flush()
  assert.deepEqual([updates.at(-1).top, updates.at(-1).bottom], [true, true])
  port.scrollTop = 500
  observers[0].callback()
  flush()
  assert.equal(updates.at(-1).bottom, false)
  port.scrollHeight = 300
  observers[0].callback()
  flush()
  assert.deepEqual([updates.at(-1).top, updates.at(-1).bottom], [false, false])
  const replacement = { ...port, scrollHeight: 900, clientHeight: 500 }
  root.children = [replacement]
  observers[1].callback()
  flush()
  assert.equal(observers[0].elements.has(port), false)
  assert.ok(observers[0].elements.has(replacement))
  assert.equal(updates.at(-1).style.height, '370px', 'clip the shadow viewport to modal-body')
  root.dispatchEvent(new Event('scroll'))
  stop()
  assert.equal(frames.size, 0)
  root.dispatchEvent(new Event('scroll'))
  observers[0].callback()
  assert.equal(frames.size, 0, 'disposed observers do not reschedule')
  assert.equal(observers[0].elements.size, 0)
})
