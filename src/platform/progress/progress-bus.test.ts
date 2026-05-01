import { afterEach, describe, expect, it } from "vitest";
import {
  PROGRESS_BUS_PER_TURN_LIMIT,
  ProgressBus,
  createTurnProgressEmitter,
  getCurrentTurnProgressEmitter,
  withTurnProgressEmitter,
  type ProgressFrame,
} from "./progress-bus.js";

function makeBus(): ProgressBus {
  return new ProgressBus();
}

afterEach(() => {
  delete process.env.OPENCLAW_PROGRESS_BUS_DISABLED;
});

describe("ProgressBus", () => {
  it("is a no-op when there are no subscribers", () => {
    const bus = makeBus();
    expect(() =>
      bus.publish({
        sessionId: "s1",
        channelId: "telegram",
        turnId: "t1",
        seq: 1,
        phase: "classifying",
        ts: 0,
      }),
    ).not.toThrow();
    expect(bus.hasSubscribers("s1", "telegram")).toBe(false);
  });

  it("delivers frames to a targeted subscriber scoped to (sessionId, channelId)", () => {
    const bus = makeBus();
    const received: ProgressFrame[] = [];
    const unsub = bus.subscribe("s1", "telegram", (frame) => received.push(frame));

    bus.publish({
      sessionId: "s1",
      channelId: "telegram",
      turnId: "t1",
      seq: 1,
      phase: "classifying",
      ts: 0,
    });
    bus.publish({
      sessionId: "s2",
      channelId: "telegram",
      turnId: "t2",
      seq: 1,
      phase: "classifying",
      ts: 0,
    });
    bus.publish({
      sessionId: "s1",
      channelId: "webchat",
      turnId: "t3",
      seq: 1,
      phase: "classifying",
      ts: 0,
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.turnId).toBe("t1");
    unsub();
  });

  it("delivers frames to subscribeAll regardless of session/channel", () => {
    const bus = makeBus();
    const received: ProgressFrame[] = [];
    const unsub = bus.subscribeAll((frame) => received.push(frame));
    bus.publish({
      sessionId: "s1",
      channelId: "telegram",
      turnId: "t1",
      seq: 1,
      phase: "classifying",
      ts: 0,
    });
    bus.publish({
      sessionId: "s2",
      channelId: "webchat",
      turnId: "t2",
      seq: 1,
      phase: "planning",
      ts: 0,
    });
    expect(received).toHaveLength(2);
    unsub();
  });

  it("stops delivering after unsubscribe for targeted subscriber", () => {
    const bus = makeBus();
    const received: ProgressFrame[] = [];
    const unsub = bus.subscribe("s1", "telegram", (frame) => received.push(frame));
    unsub();
    bus.publish({
      sessionId: "s1",
      channelId: "telegram",
      turnId: "t1",
      seq: 1,
      phase: "classifying",
      ts: 0,
    });
    expect(received).toHaveLength(0);
    expect(bus.hasSubscribers("s1", "telegram")).toBe(false);
  });

  it("stops delivering after unsubscribeAll for subscribeAll subscriber", () => {
    const bus = makeBus();
    const received: ProgressFrame[] = [];
    const unsub = bus.subscribeAll((frame) => received.push(frame));
    unsub();
    bus.publish({
      sessionId: "s1",
      channelId: "telegram",
      turnId: "t1",
      seq: 1,
      phase: "classifying",
      ts: 0,
    });
    expect(received).toHaveLength(0);
  });

  it("supports multiple independent subscribers for the same session", () => {
    const bus = makeBus();
    const a: ProgressFrame[] = [];
    const b: ProgressFrame[] = [];
    const unsubA = bus.subscribe("s1", "telegram", (f) => a.push(f));
    const unsubB = bus.subscribe("s1", "telegram", (f) => b.push(f));
    bus.publish({
      sessionId: "s1",
      channelId: "telegram",
      turnId: "t1",
      seq: 1,
      phase: "classifying",
      ts: 0,
    });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    unsubA();
    unsubB();
  });

  it("enforces per-turn rate limit and still passes terminal frames through", () => {
    const bus = makeBus();
    const received: ProgressFrame[] = [];
    bus.subscribeAll((f) => received.push(f));
    for (let i = 0; i < PROGRESS_BUS_PER_TURN_LIMIT + 5; i += 1) {
      bus.publish({
        sessionId: "s1",
        channelId: "telegram",
        turnId: "t1",
        seq: i + 1,
        phase: "tool_call",
        ts: 0,
      });
    }
    expect(received).toHaveLength(PROGRESS_BUS_PER_TURN_LIMIT);
    bus.publish({
      sessionId: "s1",
      channelId: "telegram",
      turnId: "t1",
      seq: 999,
      phase: "done",
      ts: 0,
    });
    expect(received).toHaveLength(PROGRESS_BUS_PER_TURN_LIMIT + 1);
    expect(received[received.length - 1]?.phase).toBe("done");
  });

  it("rate-limits per turnId (new turn gets a fresh budget)", () => {
    const bus = makeBus();
    const received: ProgressFrame[] = [];
    bus.subscribeAll((f) => received.push(f));
    for (let i = 0; i < PROGRESS_BUS_PER_TURN_LIMIT + 3; i += 1) {
      bus.publish({
        sessionId: "s1",
        channelId: "telegram",
        turnId: "t1",
        seq: i + 1,
        phase: "tool_call",
        ts: 0,
      });
    }
    expect(received).toHaveLength(PROGRESS_BUS_PER_TURN_LIMIT);
    bus.publish({
      sessionId: "s1",
      channelId: "telegram",
      turnId: "t1",
      seq: 999,
      phase: "done",
      ts: 0,
    });
    for (let i = 0; i < 3; i += 1) {
      bus.publish({
        sessionId: "s1",
        channelId: "telegram",
        turnId: "t2",
        seq: i + 1,
        phase: "tool_call",
        ts: 0,
      });
    }
    const turn2Frames = received.filter((f) => f.turnId === "t2");
    expect(turn2Frames).toHaveLength(3);
  });

  it("becomes a no-op when OPENCLAW_PROGRESS_BUS_DISABLED=1", () => {
    const bus = makeBus();
    const received: ProgressFrame[] = [];
    bus.subscribeAll((f) => received.push(f));
    process.env.OPENCLAW_PROGRESS_BUS_DISABLED = "1";
    bus.publish({
      sessionId: "s1",
      channelId: "telegram",
      turnId: "t1",
      seq: 1,
      phase: "classifying",
      ts: 0,
    });
    expect(received).toHaveLength(0);
  });

  it("does not propagate subscriber errors to the publisher", () => {
    const bus = makeBus();
    const received: ProgressFrame[] = [];
    bus.subscribeAll(() => {
      throw new Error("boom");
    });
    bus.subscribeAll((f) => received.push(f));
    expect(() =>
      bus.publish({
        sessionId: "s1",
        channelId: "telegram",
        turnId: "t1",
        seq: 1,
        phase: "classifying",
        ts: 0,
      }),
    ).not.toThrow();
    expect(received).toHaveLength(1);
  });
});

describe("createTurnProgressEmitter", () => {
  it("emits monotonically increasing sequence numbers", () => {
    const bus = makeBus();
    const received: ProgressFrame[] = [];
    bus.subscribeAll((f) => received.push(f));
    const emitter = createTurnProgressEmitter({
      sessionId: "s1",
      channelId: "telegram",
      turnId: "turn-1",
      bus,
      now: () => 1000,
    });
    emitter.emit("classifying");
    emitter.emit("planning", "recipe-1");
    emitter.emit("tool_call", "exec", { toolName: "exec" });
    emitter.done();
    const seqs = received.map((f) => f.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(received.map((f) => f.phase)).toEqual([
      "classifying",
      "planning",
      "tool_call",
      "done",
    ]);
    expect(received[1]?.detail).toBe("recipe-1");
    expect(received[2]?.meta?.toolName).toBe("exec");
  });

  it("stops emitting after done() is called (idempotent finalize)", () => {
    const bus = makeBus();
    const received: ProgressFrame[] = [];
    bus.subscribeAll((f) => received.push(f));
    const emitter = createTurnProgressEmitter({
      sessionId: "s1",
      channelId: "telegram",
      turnId: "turn-1",
      bus,
    });
    emitter.emit("classifying");
    emitter.done();
    emitter.emit("tool_call", "exec", { toolName: "exec" });
    emitter.done();
    expect(received).toHaveLength(2);
    expect(emitter.finalized).toBe(true);
  });

  it("error(err) finalizes with phase=error and passes along the message", () => {
    const bus = makeBus();
    const received: ProgressFrame[] = [];
    bus.subscribeAll((f) => received.push(f));
    const emitter = createTurnProgressEmitter({
      sessionId: "s1",
      channelId: "telegram",
      turnId: "turn-1",
      bus,
    });
    emitter.emit("classifying");
    emitter.error(new Error("kaboom"));
    emitter.emit("done");
    expect(received).toHaveLength(2);
    expect(received[1]?.phase).toBe("error");
    expect(received[1]?.detail).toBe("kaboom");
    expect(emitter.finalized).toBe(true);
  });

  it("truncates very long detail strings", () => {
    const bus = makeBus();
    const received: ProgressFrame[] = [];
    bus.subscribeAll((f) => received.push(f));
    const emitter = createTurnProgressEmitter({
      sessionId: "s1",
      channelId: "telegram",
      turnId: "turn-1",
      bus,
    });
    const long = "x".repeat(1000);
    emitter.emit("tool_call", long);
    expect(received[0]?.detail?.length ?? 0).toBeLessThanOrEqual(200);
    expect(received[0]?.detail?.endsWith("…")).toBe(true);
  });
});

describe("withTurnProgressEmitter / getCurrentTurnProgressEmitter", () => {
  it("exposes the emitter through AsyncLocalStorage inside the callback", () => {
    const bus = makeBus();
    const emitter = createTurnProgressEmitter({
      sessionId: "s1",
      channelId: "telegram",
      turnId: "turn-1",
      bus,
    });
    let seen: unknown;
    withTurnProgressEmitter(emitter, () => {
      seen = getCurrentTurnProgressEmitter();
    });
    expect(seen).toBe(emitter);
    expect(getCurrentTurnProgressEmitter()).toBeUndefined();
  });
});
