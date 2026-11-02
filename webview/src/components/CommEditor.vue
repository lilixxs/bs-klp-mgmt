<script setup lang="ts">
import { computed, ref } from 'vue';
import { useEditor } from '../composables/editor';
import CommChannelTab from './CommChannelTab.vue';
import CommDeviceTab from './CommDeviceTab.vue';
import CommMapTab from './CommMapTab.vue';

type SubTab = 'channels' | 'devices' | 'maps';

const { state } = useEditor();
const current = ref<SubTab>('channels');

const tabs = computed(() => {
  const effective = state.value?.plan.effective;
  return [
    { id: 'channels' as const, label: '通道', count: effective?.channels.length ?? 0 },
    { id: 'devices' as const, label: '设备', count: effective?.devices.length ?? 0 },
    { id: 'maps' as const, label: '变量映射', count: effective?.maps.length ?? 0 },
  ];
});
</script>

<template>
  <section class="pane">
    <div class="subtabs" role="tablist" aria-label="通讯配置">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        class="subtab"
        :class="{ active: current === tab.id }"
        :aria-selected="current === tab.id"
        @click="current = tab.id"
      >
        {{ tab.label }}
        <span class="count">{{ tab.count }}</span>
      </button>
    </div>

    <CommChannelTab v-if="current === 'channels'" />
    <CommDeviceTab v-else-if="current === 'devices'" />
    <CommMapTab v-else />
  </section>
</template>
