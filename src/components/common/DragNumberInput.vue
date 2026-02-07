<script setup lang="ts">
import { ref, computed } from 'vue'

interface Props {
  modelValue: number | string
  label?: string
  step?: number
  min?: number
  max?: number
  density?: 'default' | 'comfortable' | 'compact'
  hideDetails?: boolean
  disabled?: boolean
  suffix?: string
  prefix?: string
  variant?: 'filled' | 'outlined' | 'plain' | 'underlined' | 'solo' | 'solo-inverted' | 'solo-filled'
  dragSensitivity?: number // Pixels to move for one step
  decimals?: number // Number of decimal places to round to
}

const props = withDefaults(defineProps<Props>(), {
  step: 0.1,
  density: 'compact',
  hideDetails: true,
  variant: 'outlined',
  dragSensitivity: 2,
  decimals: 5
})

const emit = defineEmits<{
  'update:modelValue': [value: number]
  'focus': [event: FocusEvent]
  'blur': [event: FocusEvent]
}>()

const inputRef = ref<HTMLElement | null>(null)
const isDragging = ref(false)
const startY = ref(0)
const startValue = ref(0)
const hasMoved = ref(false)
const accumulatedDelta = ref(0)

function onDragHandleMouseDown(event: MouseEvent) {
  // Only handle left mouse button
  if (event.button !== 0) return
  
  event.preventDefault()
  event.stopPropagation()
  
  isDragging.value = true
  startY.value = event.clientY
  startValue.value = typeof props.modelValue === 'string' ? parseFloat(props.modelValue) || 0 : props.modelValue
  hasMoved.value = false
  accumulatedDelta.value = 0
  
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
  
  // Add grabbing cursor to body
  document.body.style.cursor = 'ns-resize'
}

function onMouseMove(event: MouseEvent) {
  if (!isDragging.value) return
  
  const deltaY = startY.value - event.clientY // Inverted: drag up = increase
  accumulatedDelta.value += deltaY
  
  if (Math.abs(accumulatedDelta.value) > 3) {
    hasMoved.value = true
  }
  
  // Calculate how many steps we've accumulated
  const steps = Math.floor(accumulatedDelta.value / props.dragSensitivity)
  
  if (steps !== 0) {
    let newValue = startValue.value + (steps * props.step)
    
    // Apply min/max constraints
    if (props.min !== undefined) {
      newValue = Math.max(props.min, newValue)
    }
    if (props.max !== undefined) {
      newValue = Math.min(props.max, newValue)
    }
    
    // Round to specified decimal places
    newValue = Number(newValue.toFixed(props.decimals))
    
    emit('update:modelValue', newValue)
    
    // Update references for next calculation
    startValue.value = newValue
    accumulatedDelta.value = accumulatedDelta.value % props.dragSensitivity
  }
  
  // Update startY for next delta calculation
  startY.value = event.clientY
}

function onMouseUp() {
  isDragging.value = false
  document.removeEventListener('mousemove', onMouseMove)
  document.removeEventListener('mouseup', onMouseUp)
  document.body.style.cursor = ''
  
  // If didn't move significantly, focus the input for typing
  if (!hasMoved.value) {
    const input = inputRef.value?.querySelector('input')
    if (input) {
      input.focus()
      input.select()
    }
  }
  
  hasMoved.value = false
}

function onInputChange(value: string | number) {
  const numValue = typeof value === 'string' ? parseFloat(value) : value
  if (!isNaN(numValue)) {
    // Round to specified decimal places
    const rounded = Number(numValue.toFixed(props.decimals))
    emit('update:modelValue', rounded)
  }
}

function onFocus(event: FocusEvent) {
  emit('focus', event)
}

function onBlur(event: FocusEvent) {
  emit('blur', event)
}

const displayValue = computed({
  get: () => {
    const numValue = typeof props.modelValue === 'string' ? parseFloat(props.modelValue) : props.modelValue
    if (isNaN(numValue)) return props.modelValue
    // Round for display
    return Number(numValue.toFixed(props.decimals))
  },
  set: (val) => onInputChange(val)
})
</script>

<template>
  <div 
    ref="inputRef"
    class="drag-number-input"
    :class="{ 'is-dragging': isDragging, 'is-disabled': disabled }"
  >
    <v-text-field
      v-model="displayValue"
      :label="label"
      :step="step"
      :min="min"
      :max="max"
      :density="density"
      :hide-details="hideDetails"
      :disabled="disabled"
      :suffix="suffix"
      :prefix="prefix"
      :variant="variant"
      type="number"
      class="drag-input-field"
      @focus="onFocus"
      @blur="onBlur"
    />
    <div 
      v-if="!disabled"
      class="drag-handle"
      :class="{ 'is-dragging': isDragging }"
      @mousedown="onDragHandleMouseDown"
      title="Drag up/down to adjust value"
    >
      <div class="drag-dots">
        <span class="dot"></span>
        <span class="dot"></span>
        <span class="dot"></span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.drag-number-input {
  position: relative;
  
  &.is-disabled {
    cursor: not-allowed;
  }
  
  // Hide the spin buttons
  :deep(input) {
    cursor: text !important;
    user-select: text;
    
    &::-webkit-outer-spin-button,
    &::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }
    
    // Firefox
    &[type=number] {
      -moz-appearance: textfield;
      appearance: textfield;
    }
  }
}

.drag-handle {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ns-resize;
  user-select: none;
  z-index: 10;
  background: transparent;
  border-radius: 0 4px 4px 0;
  transition: background 0.2s ease;
  
  &:hover {
    background: rgba(255, 255, 255, 0.05);
    
    .drag-dots .dot {
      background: rgba(255, 255, 255, 0.6);
    }
  }
  
  &.is-dragging {
    background: rgba(107, 138, 255, 0.15);
    
    .drag-dots .dot {
      background: rgba(107, 138, 255, 0.9);
    }
  }
  
  &:active {
    background: rgba(107, 138, 255, 0.2);
  }
}

.drag-dots {
  display: flex;
  flex-direction: column;
  gap: 2px;
  pointer-events: none;
  
  .dot {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.3);
    transition: background 0.2s ease;
  }
}
</style>
