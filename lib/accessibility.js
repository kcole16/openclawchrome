export function summarizeNode(node) {
  return {
    ref: node.ref,
    role: node.role,
    name: node.name,
    value: node.value || null,
    bounds: node.bounds,
    interactive: !!node.interactive
  };
}
