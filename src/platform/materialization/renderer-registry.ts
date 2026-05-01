import type { BootstrapReason } from "../bootstrap/contracts.js";
import type {
  MaterializationOutputTarget,
  MaterializationRenderKind,
  MaterializationRendererTarget,
} from "./contracts.js";

export type RendererDefinition = {
  id: string;
  renderKind: MaterializationRenderKind;
  rendererTarget: MaterializationRendererTarget;
  outputTarget: MaterializationOutputTarget;
  requiredCapabilityId?: string;
  bootstrapReason?: BootstrapReason;
  unavailableWarning?: string;
  fallbackRendererId?: string;
};

export const DEFAULT_RENDERER_REGISTRY: RendererDefinition[] = [
  {
    id: "markdown-file",
    renderKind: "markdown",
    rendererTarget: "markdown",
    outputTarget: "file",
  },
  {
    id: "html-file",
    renderKind: "html",
    rendererTarget: "html",
    outputTarget: "file",
  },
  {
    id: "html-preview",
    renderKind: "site_preview",
    rendererTarget: "preview",
    outputTarget: "preview",
  },
  {
    id: "pdf-from-html",
    renderKind: "pdf",
    rendererTarget: "pdf",
    outputTarget: "file",
    requiredCapabilityId: "pdf-renderer",
    bootstrapReason: "renderer_unavailable",
    unavailableWarning: "pdf renderer unavailable; fell back to html output",
    fallbackRendererId: "html-file",
  },
];

export function resolveRendererDefinition(params: {
  rendererTarget: MaterializationRendererTarget;
  outputTarget: MaterializationOutputTarget;
  registry?: RendererDefinition[];
}): RendererDefinition {
  const registry = params.registry ?? DEFAULT_RENDERER_REGISTRY;
  const definition = registry.find(
    (candidate) =>
      candidate.rendererTarget === params.rendererTarget &&
      candidate.outputTarget === params.outputTarget,
  );
  if (!definition) {
    throw new Error(
      `No materialization renderer registered for ${params.rendererTarget}:${params.outputTarget}`,
    );
  }
  return definition;
}

export function resolveFallbackRenderer(params: {
  renderer: RendererDefinition;
  registry?: RendererDefinition[];
}): RendererDefinition {
  const registry = params.registry ?? DEFAULT_RENDERER_REGISTRY;
  const fallback =
    (params.renderer.fallbackRendererId
      ? registry.find((candidate) => candidate.id === params.renderer.fallbackRendererId)
      : undefined) ?? registry.find((candidate) => candidate.id === "html-file");
  if (!fallback) {
    throw new Error(`Fallback renderer is missing for "${params.renderer.id}"`);
  }
  return fallback;
}
