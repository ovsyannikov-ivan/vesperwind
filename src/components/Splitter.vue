<script setup>
const props = defineProps({
  orientation: {
    type: String,
    default: 'vertical',
    validator: (value) => ['vertical', 'horizontal'].includes(value),
  },
})

const emit = defineEmits(['resize'])

const onPointerDown = (event) => {
  event.preventDefault()

  let previousPosition =
    props.orientation === 'vertical' ? event.clientX : event.clientY

  const onPointerMove = (moveEvent) => {
    const position =
      props.orientation === 'vertical' ? moveEvent.clientX : moveEvent.clientY
    emit('resize', position - previousPosition)
    previousPosition = position
  }

  const stopDragging = () => {
    document.body.classList.remove('is-resizing', `is-resizing-${props.orientation}`)
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', stopDragging)
    window.removeEventListener('pointercancel', stopDragging)
  }

  document.body.classList.add('is-resizing', `is-resizing-${props.orientation}`)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', stopDragging)
  window.addEventListener('pointercancel', stopDragging)
}

const onKeydown = (event) => {
  const deltaByKey = {
    ArrowLeft: -12,
    ArrowRight: 12,
    ArrowUp: -12,
    ArrowDown: 12,
  }
  const delta = deltaByKey[event.key]

  if (delta === undefined) {
    return
  }

  const allowedKeys =
    props.orientation === 'vertical'
      ? ['ArrowLeft', 'ArrowRight']
      : ['ArrowUp', 'ArrowDown']

  if (!allowedKeys.includes(event.key)) {
    return
  }

  event.preventDefault()
  emit('resize', delta)
}
</script>

<template>
  <div
    class="splitter"
    :class="`splitter-${orientation}`"
    role="separator"
    :aria-orientation="orientation"
    tabindex="0"
    @pointerdown="onPointerDown"
    @keydown="onKeydown"
  >
    <span class="splitter-handle" />
  </div>
</template>
