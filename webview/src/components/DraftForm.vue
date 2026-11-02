<script setup lang="ts">
/** 通用表单行：label 与控件通过 for/id 关联。 */
withDefaults(
  defineProps<{
    label: string;
    forId: string;
    hint?: string;
    wide?: boolean;
  }>(),
  { hint: '', wide: false },
);
</script>

<template>
  <div class="field" :class="{ wide }">
    <label :for="forId">{{ label }}</label>
    <slot />
    <p v-if="hint" class="hint">{{ hint }}</p>
  </div>
</template>
