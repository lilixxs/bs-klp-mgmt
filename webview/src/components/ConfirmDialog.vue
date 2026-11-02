<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    message: string;
    detail?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
  }>(),
  { detail: '', confirmLabel: '确定', cancelLabel: '取消', danger: false },
);

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const cancelButton = ref<HTMLButtonElement | null>(null);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    cancelButton.value?.focus();
  },
);

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    emit('cancel');
  }
}
</script>

<template>
  <div v-if="open" class="overlay" role="presentation" @click.self="emit('cancel')" @keydown="onKeydown">
    <div class="dialog" role="alertdialog" aria-modal="true" :aria-label="title">
      <h2 class="dialog-title">{{ title }}</h2>
      <p class="dialog-message">{{ message }}</p>
      <p v-if="detail" class="dialog-detail">{{ detail }}</p>
      <div class="dialog-actions">
        <button ref="cancelButton" type="button" class="btn" @click="emit('cancel')">{{ cancelLabel }}</button>
        <button
          type="button"
          class="btn"
          :class="danger ? 'btn-danger' : 'btn-primary'"
          @click="emit('confirm')"
        >
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
