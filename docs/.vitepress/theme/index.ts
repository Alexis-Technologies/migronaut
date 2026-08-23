import DefaultTheme from 'vitepress/theme';
import type { EnhanceAppContext, Theme } from 'vitepress';
import { inBrowser } from 'vitepress';
import { inject as injectAnalytics } from '@vercel/analytics';
import { injectSpeedInsights } from '@vercel/speed-insights';
import './custom.css';

// Extends the default VitePress theme with our brand styling (see custom.css).
// This is exactly the pattern Pinia / Vite / Vue use to brand their docs —
// the layout/components stay the default theme, the look comes from CSS variables.
export default {
  extends: DefaultTheme,

  // Vercel Web Analytics + Speed Insights. Docs-only: these are devDependencies,
  // bundled into the VitePress site, never into the published npm package.
  enhanceApp({ router }: EnhanceAppContext) {
    // enhanceApp also runs during the static SSR render — both scripts are
    // browser-only (they append a <script> to document.head).
    if (!inBrowser) return;

    // `mode` is explicit rather than 'auto': auto reads process.env.NODE_ENV,
    // which is not reliably defined in the browser, and falls back to
    // 'production' — which would send real events from `pnpm run docs:dev`.
    injectAnalytics({
      framework: 'vitepress',
      mode: import.meta.env.PROD ? 'production' : 'development',
    });
    // Page views are picked up automatically: the analytics script hooks
    // history.pushState, which is how VitePress' router navigates.

    const speedInsights = injectSpeedInsights({
      framework: 'vitepress',
      route: router.route.path,
    });

    // Chain instead of overwrite — the default theme (and any future plugin)
    // may already have registered a handler here.
    const onAfterRouteChange = router.onAfterRouteChange;
    router.onAfterRouteChange = (to) => {
      speedInsights?.setRoute(router.route.path);
      return onAfterRouteChange?.(to);
    };
  },
} satisfies Theme;
