import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadArtifactDetail,
  loadArtifacts,
  transitionArtifact,
  type ArtifactsState,
} from "./artifacts.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

if (!("window" in globalThis)) {
  Object.assign(globalThis, {
    window: {
      confirm: () => false,
    },
  });
}

function createState(request: RequestFn, overrides: Partial<ArtifactsState> = {}): ArtifactsState {
  return {
    client: { request } as unknown as ArtifactsState["client"],
    connected: true,
    artifactsLoading: false,
    artifactsError: null,
    artifactsList: [],
    artifactsFilterQuery: "",
    artifactsSelectedId: null,
    artifactDetailLoading: false,
    artifactDetail: null,
    artifactDetailError: null,
    artifactTransitionBusy: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadArtifacts", () => {
  it("loads the list and then the selected artifact detail", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "platform.artifacts.list") {
        return {
          artifacts: [
            {
              id: "artifact-1",
              kind: "document",
              label: "Invoice Report",
              lifecycle: "draft",
              previewAvailable: true,
              contentAvailable: true,
              hasMaterialization: true,
            },
          ],
        };
      }
      if (method === "platform.artifacts.get") {
        expect(params).toEqual({ artifactId: "artifact-1" });
        return {
          detail: {
            descriptor: {
              id: "artifact-1",
              kind: "document",
              label: "Invoice Report",
              lifecycle: "draft",
            },
            previewAvailable: true,
            contentAvailable: true,
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);

    await loadArtifacts(state);

    expect(request).toHaveBeenNthCalledWith(1, "platform.artifacts.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "platform.artifacts.get", {
      artifactId: "artifact-1",
    });
    expect(state.artifactsSelectedId).toBe("artifact-1");
    expect(state.artifactDetail?.descriptor.id).toBe("artifact-1");
  });

  it("preserves a deep-linked selected artifact when the list reloads", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "platform.artifacts.list") {
        return {
          artifacts: [
            {
              id: "artifact-1",
              kind: "document",
              label: "Invoice Report",
              lifecycle: "draft",
              previewAvailable: true,
              contentAvailable: true,
              hasMaterialization: true,
            },
            {
              id: "artifact-2",
              kind: "document",
              label: "Release Notes",
              lifecycle: "preview",
              previewAvailable: true,
              contentAvailable: true,
              hasMaterialization: true,
            },
          ],
        };
      }
      if (method === "platform.artifacts.get") {
        expect(params).toEqual({ artifactId: "artifact-2" });
        return {
          detail: {
            descriptor: {
              id: "artifact-2",
              kind: "document",
              label: "Release Notes",
              lifecycle: "preview",
            },
            previewAvailable: true,
            contentAvailable: true,
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request, { artifactsSelectedId: "artifact-2" });

    await loadArtifacts(state);

    expect(state.artifactsSelectedId).toBe("artifact-2");
    expect(state.artifactDetail?.descriptor.id).toBe("artifact-2");
  });
});

describe("loadArtifactDetail", () => {
  it("stores detail errors without throwing", async () => {
    const request = vi.fn(async () => {
      throw new Error("detail failed");
    });
    const state = createState(request, { artifactsSelectedId: "artifact-1" });

    await loadArtifactDetail(state);

    expect(state.artifactDetail).toBeNull();
    expect(state.artifactDetailError).toContain("detail failed");
  });
});

describe("transitionArtifact", () => {
  it("skips delete when the user cancels confirmation", async () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request, { artifactsSelectedId: "artifact-1" });
    vi.spyOn(window, "confirm").mockReturnValue(false);

    await transitionArtifact(state, "artifact-1", "delete");

    expect(request).not.toHaveBeenCalled();
  });

  it("transitions and refreshes the artifact list", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "platform.artifacts.transition") {
        expect(params).toEqual({ artifactId: "artifact-1", operation: "approve" });
        return {
          detail: {
            descriptor: {
              id: "artifact-1",
              kind: "document",
              label: "Invoice Report",
              lifecycle: "approved",
            },
            previewAvailable: true,
            contentAvailable: true,
          },
        };
      }
      if (method === "platform.artifacts.list") {
        return {
          artifacts: [
            {
              id: "artifact-1",
              kind: "document",
              label: "Invoice Report",
              lifecycle: "approved",
              previewAvailable: true,
              contentAvailable: true,
              hasMaterialization: true,
            },
          ],
        };
      }
      if (method === "platform.artifacts.get") {
        return {
          detail: {
            descriptor: {
              id: "artifact-1",
              kind: "document",
              label: "Invoice Report",
              lifecycle: "approved",
            },
            previewAvailable: true,
            contentAvailable: true,
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request, { artifactsSelectedId: "artifact-1" });

    await transitionArtifact(state, "artifact-1", "approve");

    expect(request).toHaveBeenNthCalledWith(1, "platform.artifacts.transition", {
      artifactId: "artifact-1",
      operation: "approve",
    });
    expect(request).toHaveBeenNthCalledWith(2, "platform.artifacts.list", {});
    expect(request).toHaveBeenNthCalledWith(3, "platform.artifacts.get", {
      artifactId: "artifact-1",
    });
    expect(state.artifactDetail?.descriptor.lifecycle).toBe("approved");
  });
});
