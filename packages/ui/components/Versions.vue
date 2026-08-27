<script setup lang="ts">
import { IconInfoCircle } from '@tabler/icons-vue'
import { useVersionQuery } from '~/composables/useQueries'

interface Props {
  frontendVersion?: string
  backendVersion?: string
  collapsed?: boolean
  horizontal?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  frontendVersion: '',
  backendVersion: '',
  collapsed: false,
  horizontal: false,
})

const runtimeConfig = useRuntimeConfig()
const { data: queryBackendVersion } = useVersionQuery()

const actualFrontendVersion = computed(
  () =>
    props.frontendVersion || `v${runtimeConfig.public.appVersion || '0.0.0'}`,
)
const actualBackendVersion = computed(
  () => props.backendVersion || queryBackendVersion.value || '',
)

const versionsTitle = computed(
  () =>
    `UI ${actualFrontendVersion.value} · Core ${actualBackendVersion.value}`,
)
</script>

<template>
  <div
    v-if="!collapsed"
    class="mx-2 grid grid-cols-1 gap-2 pt-1 md:mx-0"
    :class="horizontal ? 'grid-cols-2 sm:grid-cols-1' : ''"
  >
    <div class="btn cursor-default btn-sm">
      <span class="flex w-full items-center justify-center gap-2 text-xs">
        {{ actualFrontendVersion }}
      </span>
    </div>

    <div class="btn cursor-default btn-sm">
      <span class="flex w-full items-center justify-center gap-2 text-xs">
        {{ actualBackendVersion }}
      </span>
    </div>
  </div>

  <div v-else class="flex justify-center pt-1">
    <div
      class="relative flex aspect-square w-9 items-center justify-center rounded-lg border border-[color-mix(in_oklab,var(--color-base-content)_10%,transparent)] bg-transparent text-base-content/70"
      :title="versionsTitle"
      :aria-label="versionsTitle"
    >
      <IconInfoCircle class="h-5 w-5" />
    </div>
  </div>
</template>
