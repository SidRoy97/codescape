// The shared data contract for the whole code graph feature.
// This file has zero logic and zero imports on purpose: every other
// graph file depends only on these shapes, never on each other's code.

export interface CodeNode {
  id: string;
  name: string;
  kind: 'function' | 'class' | 'method' | 'variable';
  file: string;
  line: number;
  nameColumn: number;
  // Variable-specific: raw value excerpt and export status.
  value?: string;
  exported?: boolean;
}

export interface CodeEdge {
  from: string;
  to: string;
  relation: 'calls' | 'imports';
}

export interface CodeGraph {
  nodes: CodeNode[];
  edges: CodeEdge[];
}

export interface ImpactResult {
  target: CodeNode;
  directCallers: CodeNode[];
  directCallees: CodeNode[];
  affected: CodeNode[];
}