/** Sample stylesheet used by the Font Optimizer. Clearly labelled as sample data. */
export const SAMPLE_CSS = `/* Sample: three families, one rule with a src problem */
@font-face {
  font-family: "Inter";
  src: url("/fonts/inter-roman.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
}

@font-face {
  font-family: "Inter";
  src: url("/fonts/inter-italic.woff2") format("woff2");
  font-weight: 400;
  font-style: italic;
  font-display: swap;
}

@font-face {
  font-family: "JetBrains Mono";
  src: url("/fonts/jetbrains-mono.woff2") format("woff2"),
       url("/fonts/jetbrains-mono.woff") format("woff");
  font-weight: 400 700;
}

/* This rule is intentionally malformed: no src descriptor */
@font-face {
  font-family: "Display Serif";
  font-weight: 700;
  unicode-range: U+0000-00FF;
}

body {
  font-family: "Inter", system-ui, sans-serif;
  font-size: 1rem;
  line-height: 1.6;
}

code, pre {
  font-family: "JetBrains Mono", ui-monospace, monospace;
}
`;
