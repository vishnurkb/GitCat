import React from "react";
import htm from "htm";

// htm gives JSX-like templates without a build step: html`<${Box}>…<//>`
export const html = htm.bind(React.createElement);

// Dracula-ish palette — readable on dark and light terminals.
export const C = {
  accent: "#ff79c6", // pink: brand, the cat, user prompt marker
  purple: "#bd93f9",
  cyan: "#8be9fd",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  orange: "#ffb86c",
  red: "#ff5555",
  text: "#f8f8f2",
  dim: "gray",
};

export const RISK_COLOR = { read: C.green, write: C.cyan, danger: C.red };

export const MODES = {
  auto: { label: "auto", icon: "⏵", hint: "asks only before dangerous commands", color: C.cyan },
  confirm: { label: "confirm", icon: "⏵⏵", hint: "asks before every change", color: C.yellow },
  yolo: { label: "yolo", icon: "⚡", hint: "never asks — careful", color: C.red },
};
export const MODE_ORDER = ["auto", "confirm", "yolo"];
