// Renders ```mermaid fences (see `markdown.config` in config.mts) into inline SVG.
//
// Mermaid is a docs-only devDependency, loaded lazily in the browser by the first
// diagram that scrolls near the viewport — pages without one never fetch it.
// Renders are serialized: mermaid's config is global, and a theme switch must not
// interleave with a render still using the other palette.

import type { Mermaid, MermaidConfig } from 'mermaid';

type Palette = {
  bg: string;
  text: string;
  muted: string;
  node: string;
  nodeBorder: string;
  cluster: string;
  clusterBorder: string;
  line: string;
  note: string;
  noteBorder: string;
  activation: string;
  classes: Record<string, string>;
};

// Semantic node classes, usable in flowcharts and state diagrams as `A:::core`:
//   core  — migronaut's own parts      store — MongoDB collections
//   ext   — your code, Redis, people   warn  — a refusal or a failure path
//   muted — optional or background detail
const LIGHT: Palette = {
  bg: '#ffffff',
  text: '#3c3c43',
  muted: '#67676c',
  node: '#ffffff',
  nodeBorder: '#c2c2c4',
  cluster: '#f6f6f7',
  clusterBorder: '#e2e2e3',
  line: '#8e8e93',
  note: '#f6f6f7',
  noteBorder: '#d0d0d3',
  activation: '#e6f6ee',
  classes: {
    core: 'fill:#e6f6ee,stroke:#00a36c,stroke-width:1.5px,color:#14382b',
    store: 'fill:#eef0ff,stroke:#5672cd,stroke-width:1.5px,color:#26346e',
    ext: 'fill:#ffffff,stroke:#a8a8ad,stroke-width:1.2px,stroke-dasharray:5 3,color:#3c3c43',
    warn: 'fill:#fff4e5,stroke:#d97706,stroke-width:1.5px,color:#6b3a00',
    muted: 'fill:#f6f6f7,stroke:#d0d0d3,stroke-width:1px,color:#67676c',
  },
};

const DARK: Palette = {
  bg: '#1b1b1f',
  text: '#dfdfd6',
  muted: '#98989f',
  node: '#202127',
  nodeBorder: '#46464d',
  cluster: '#161618',
  clusterBorder: '#2e2e32',
  line: '#8b8b93',
  note: '#202127',
  noteBorder: '#3c3f44',
  activation: '#0f2a1e',
  classes: {
    core: 'fill:#0f2a1e,stroke:#00ED64,stroke-width:1.5px,color:#dfdfd6',
    store: 'fill:#1c2140,stroke:#7c8ff0,stroke-width:1.5px,color:#e3e7ff',
    ext: 'fill:#1b1b1f,stroke:#6b6b72,stroke-width:1.2px,stroke-dasharray:5 3,color:#dfdfd6',
    warn: 'fill:#33230d,stroke:#f9b44e,stroke-width:1.5px,color:#fbe3bd',
    muted: 'fill:#202127,stroke:#3c3f44,stroke-width:1px,color:#98989f',
  },
};

function fontFamily(): string {
  const font = getComputedStyle(document.documentElement)
    .getPropertyValue('--vp-font-family-base')
    .trim();
  return font || 'Inter, ui-sans-serif, system-ui, sans-serif';
}

function configFor(dark: boolean): MermaidConfig {
  const p = dark ? DARK : LIGHT;
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    darkMode: dark,
    fontFamily: fontFamily(),
    themeVariables: {
      fontSize: '14px',
      background: p.bg,
      textColor: p.text,
      primaryColor: p.node,
      primaryTextColor: p.text,
      primaryBorderColor: p.nodeBorder,
      secondaryColor: p.cluster,
      tertiaryColor: p.cluster,
      mainBkg: p.node,
      nodeBorder: p.nodeBorder,
      clusterBkg: p.cluster,
      clusterBorder: p.clusterBorder,
      titleColor: p.text,
      lineColor: p.line,
      edgeLabelBackground: p.bg,
      noteBkgColor: p.note,
      noteTextColor: p.text,
      noteBorderColor: p.noteBorder,
      actorBkg: p.node,
      actorBorder: p.nodeBorder,
      actorTextColor: p.text,
      actorLineColor: p.nodeBorder,
      signalColor: p.text,
      signalTextColor: p.text,
      labelBoxBkgColor: p.cluster,
      labelBoxBorderColor: p.nodeBorder,
      labelTextColor: p.text,
      loopTextColor: p.muted,
      activationBkgColor: p.activation,
      activationBorderColor: p.nodeBorder,
      sequenceNumberColor: p.bg,
      transitionColor: p.line,
      transitionLabelColor: p.muted,
      stateLabelColor: p.text,
      compositeBackground: p.cluster,
      compositeTitleBackground: p.cluster,
      altBackground: p.cluster,
      specialStateColor: p.line,
      innerEndBackground: p.line,
    },
    flowchart: {
      curve: 'basis',
      padding: 12,
      nodeSpacing: 36,
      rankSpacing: 44,
      subGraphTitleMargin: { top: 6, bottom: 6 },
    },
    sequence: {
      mirrorActors: false,
      width: 120,
      height: 48,
      actorMargin: 36,
      messageMargin: 32,
      noteMargin: 10,
      boxMargin: 8,
    },
    state: { padding: 10 },
  };
}

/** Appends the semantic `classDef`s to the diagram types that understand them. */
function withClasses(code: string, dark: boolean): string {
  const header = code.split('\n').find((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('%%');
  });
  if (!header || !/^(flowchart|graph|stateDiagram)/.test(header.trim())) return code;
  const { classes } = dark ? DARK : LIGHT;
  const defs = Object.entries(classes).map(([name, style]) => `  classDef ${name} ${style}`);
  return `${code.trimEnd()}\n${defs.join('\n')}\n`;
}

let mermaid: Promise<Mermaid> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let renders = 0;

/**
 * Renders `code` to an SVG string. Mermaid lays the diagram out inside `container`, so the labels
 * are measured under the same CSS they are shown with.
 */
export function renderMermaid(code: string, dark: boolean, container: Element): Promise<string> {
  const job = queue.then(async () => {
    const api = await (mermaid ??= import('mermaid').then((module) => module.default));
    // Text is measured while laying out: wait for the theme's web font.
    await document.fonts?.ready;
    api.initialize(configFor(dark));
    renders += 1;
    const { svg } = await api.render(`mermaid-${renders}`, withClasses(code, dark), container);
    return svg;
  });
  queue = job.catch(() => undefined);
  return job;
}
