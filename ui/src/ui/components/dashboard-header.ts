import { LitElement, html } from "lit";
import { property } from "lit/decorators.js";
import { safeCustomElement } from "../lit-custom-element.ts";
import { titleForTab, type Tab } from "../navigation.js";

function isModifiedNavigationClick(event: MouseEvent): boolean {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

@safeCustomElement("dashboard-header")
export class DashboardHeader extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property() tab: Tab = "overview";
  @property() homeHref = "/overview";

  override render() {
    const label = titleForTab(this.tab);

    return html`
      <div class="dashboard-header">
        <div class="dashboard-header__breadcrumb">
          <a
            class="dashboard-header__breadcrumb-link"
            href=${this.homeHref}
            @click=${(event: MouseEvent) => {
              if (isModifiedNavigationClick(event)) {
                return;
              }
              event.preventDefault();
              this.dispatchEvent(
                new CustomEvent("navigate", {
                  detail: "overview",
                  bubbles: true,
                  composed: true,
                }),
              );
            }}
          >
            OpenClaw
          </a>
          <span class="dashboard-header__breadcrumb-sep">›</span>
          <span class="dashboard-header__breadcrumb-current">${label}</span>
        </div>
        <div class="dashboard-header__actions">
          <slot></slot>
        </div>
      </div>
    `;
  }
}
