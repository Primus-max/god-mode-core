import { customElement as litCustomElement } from "lit/decorators.js";

/**
 * Like Lit's `@customElement`, but skips registration when the tag is already
 * defined. Vitest's non-isolated runner resets evaluated ESM modules between
 * files while keeping the same jsdom `customElements` registry, so a plain
 * `@customElement` would throw on the second import of the same tag.
 */
export function safeCustomElement(tagName: string) {
  return (cls: CustomElementConstructor & { prototype: HTMLElement }) => {
    if (customElements.get(tagName)) {
      return cls;
    }
    return litCustomElement(tagName)(cls);
  };
}
