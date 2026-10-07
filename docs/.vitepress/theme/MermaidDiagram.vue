<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useData } from 'vitepress';
import { renderMermaid } from './mermaid';

// `code` arrives URI-encoded from the markdown fence, so nothing in a diagram
// can be read as Vue template syntax.
const props = defineProps<{ code: string }>();

const { isDark } = useData();
const source = computed(() => decodeURIComponent(props.code));
const root = ref<HTMLElement>();
// Mermaid lays out (and measures) in here: inside .vp-doc, so labels are measured under the CSS
// they are shown with — and outside anything Vue patches, since mermaid edits it directly.
const stage = ref<HTMLElement>();
const svg = ref('');
const failed = ref(false);
let visible = false;
let observer: IntersectionObserver | undefined;

async function draw() {
  if (!stage.value) return;
  try {
    svg.value = await renderMermaid(source.value, isDark.value, stage.value);
    failed.value = false;
    await nextTick();
    fitToPhone();
  } catch (error) {
    failed.value = true;
    console.error('[mermaid]', error);
  }
}

// A wide diagram keeps a readable minimum width and scrolls sideways on a
// phone, instead of shrinking to unreadable text.
function fitToPhone() {
  const element = root.value?.querySelector('svg');
  if (!element) return;
  const natural = Number.parseFloat(element.style.maxWidth);
  if (Number.isFinite(natural)) element.style.minWidth = `${Math.min(natural * 0.7, 560)}px`;
  // Start a sideways-scrolling diagram at its middle, where the main line usually runs.
  const scroller = element.parentElement;
  if (scroller && scroller.scrollWidth > scroller.clientWidth) {
    scroller.scrollLeft = (scroller.scrollWidth - scroller.clientWidth) / 2;
  }
}

onMounted(() => {
  // A hidden document (a background tab, a renderer taking a snapshot) gets no intersection
  // callbacks: draw at once there.
  if (!('IntersectionObserver' in window) || document.visibilityState === 'hidden') {
    visible = true;
    void draw();
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer?.disconnect();
      visible = true;
      void draw();
    },
    { rootMargin: '400px 0px' },
  );
  if (root.value) observer.observe(root.value);
});

onBeforeUnmount(() => observer?.disconnect());

watch(isDark, () => {
  if (visible) void draw();
});
</script>

<template>
  <div ref="root" class="mermaid-diagram" :class="{ 'is-ready': svg }">
    <div ref="stage" class="mermaid-stage" aria-hidden="true" />
    <div v-if="svg" class="mermaid-svg" v-html="svg" />
    <pre v-else-if="failed" class="mermaid-fallback"><code>{{ source }}</code></pre>
  </div>
</template>
