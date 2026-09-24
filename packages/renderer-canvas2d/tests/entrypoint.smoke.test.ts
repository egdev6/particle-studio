import { describe, expect, it } from "vitest";

class RecordingContext {
  readonly calls: string[] = [];

  set globalAlpha(value: number) {
    this.calls.push(`alpha(${value})`);
  }

  set font(value: string) {
    this.calls.push(`font(${value})`);
  }

  save() {
    this.calls.push("save");
  }

  restore() {
    this.calls.push("restore");
  }

  fillRect(x: number, y: number, width: number, height: number) {
    this.calls.push(`fillRect(${x},${y},${width},${height})`);
  }

  fillText(text: string, x: number, y: number) {
    this.calls.push(`fillText(${text},${x},${y})`);
  }

  beginPath() {
    this.calls.push("beginPath");
  }

  moveTo(x: number, y: number) {
    this.calls.push(`moveTo(${x},${y})`);
  }

  lineTo(x: number, y: number) {
    this.calls.push(`lineTo(${x},${y})`);
  }

  stroke() {
    this.calls.push("stroke");
  }

  drawImage(
    source: unknown,
    x: number,
    y: number,
    width: number,
    height: number,
  ) {
    this.calls.push(`drawImage(${x},${y},${width},${height})`);
    this.images.push(source);
  }

  readonly images: unknown[] = [];

  transform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.calls.push(`transform(${a},${b},${c},${d},${e},${f})`);
  }
}

describe("Canvas2D renderer package entrypoint", () => {
  it("draws an evaluated shape command through a minimal recording context", async () => {
    const { renderCommands } = await import("../src/index.js");
    const context = new RecordingContext();

    renderCommands(context, [
      {
        kind: "draw-shape",
        sourceId: "shape-1",
        x: 16,
        y: 24,
        width: 120,
        height: 80,
        opacity: 0.5,
      },
    ]);

    expect(context.calls).toEqual([
      "save",
      "alpha(0.5)",
      "fillRect(16,24,120,80)",
      "restore",
    ]);
  });

  it("draws an evaluated line command through path operations", async () => {
    const { renderCommands } = await import("../src/index.js");
    const context = new RecordingContext();

    renderCommands(context, [
      {
        kind: "draw-line",
        sourceId: "line-1",
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        opacity: 0.75,
      },
    ]);

    expect(context.calls).toEqual([
      "save",
      "alpha(0.75)",
      "beginPath",
      "moveTo(1,2)",
      "lineTo(3,4)",
      "stroke",
      "restore",
    ]);
  });

  it("applies a grouped effective transform before drawing", async () => {
    const { renderCommands } = await import("../src/index.js");
    const context = new RecordingContext();

    renderCommands(context, [
      {
        kind: "draw-shape",
        sourceId: "shape-1",
        x: 16,
        y: 24,
        width: 120,
        height: 80,
        opacity: 0.5,
        transform: [2, 0, 0, 3, 3, 46],
      },
    ]);

    expect(context.calls).toEqual([
      "save",
      "alpha(0.5)",
      "transform(2,0,0,3,3,46)",
      "fillRect(16,24,120,80)",
      "restore",
    ]);
  });

  it("draws ordered particle points with the same transform and alpha boundary", async () => {
    const { renderCommands } = await import("../src/index.js");
    const context = new RecordingContext();

    renderCommands(context, [
      {
        kind: "draw-particles",
        sourceId: "particle-1",
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
        size: 5,
        opacity: 0.25,
        transform: [1, 0, 0, 1, 10, 20],
      } as never,
    ]);

    expect(context.calls).toEqual([
      "save",
      "alpha(0.25)",
      "transform(1,0,0,1,10,20)",
      "fillRect(1,2,5,5)",
      "fillRect(3,4,5,5)",
      "restore",
    ]);
  });

  it("isolates text font and fill calls in command order", async () => {
    const { renderCommands } = await import("../src/index.js");
    const context = new RecordingContext();

    renderCommands(context as never, [
      {
        kind: "draw-text",
        sourceId: "text-1",
        text: "Hello Canvas",
        x: 4,
        y: 12,
        fontSize: 18,
        opacity: 0.5,
        transform: [1, 0, 0, 1, 10, 20],
      } as never,
    ]);

    expect(context.calls).toEqual([
      "save",
      "alpha(0.5)",
      "transform(1,0,0,1,10,20)",
      "font(18px sans-serif)",
      "fillText(Hello Canvas,4,12)",
      "restore",
    ]);
  });

  it("draws a resolved image through the Canvas2D destination geometry", async () => {
    const { renderCommands } = await import("../src/index.js");
    const context = new RecordingContext();
    const image = { fixture: "canvas-image" };

    renderCommands(context as never, [
      {
        kind: "draw-image",
        sourceId: "image-1",
        resolved: image,
        x: 8,
        y: 16,
        width: 32,
        height: 24,
        opacity: 0.5,
      } as never,
    ]);

    expect(context.calls).toEqual([
      "save",
      "alpha(0.5)",
      "drawImage(8,16,32,24)",
      "restore",
    ]);
    expect(context.images).toEqual([image]);
  });

  it("preserves image alpha, affine transform, and Canvas state isolation", async () => {
    const { renderCommands } = await import("../src/index.js");
    const context = new RecordingContext();
    const image = { fixture: "transformed-canvas-image" };

    renderCommands(context as never, [
      {
        kind: "draw-image",
        sourceId: "image-1",
        resolved: image,
        x: 4,
        y: 6,
        width: 12,
        height: 8,
        opacity: 0.25,
        transform: [2, 0, 0, 3, 10, 20],
      } as never,
    ]);

    expect(context.calls).toEqual([
      "save",
      "alpha(0.25)",
      "transform(2,0,0,3,10,20)",
      "drawImage(4,6,12,8)",
      "restore",
    ]);
    expect(context.images).toEqual([image]);
  });

  it("rejects malformed opaque image handles before drawing", async () => {
    const { renderCommands } = await import("../src/index.js");
    const context = new RecordingContext();

    expect(() =>
      renderCommands(context as never, [
        {
          kind: "draw-image",
          sourceId: "image-1",
          resolved: "not-a-canvas-image-source",
          x: 8,
          y: 16,
          width: 32,
          height: 24,
          opacity: 0.5,
        } as never,
      ]),
    ).toThrow("CANVAS_IMAGE_HANDLE_INVALID");
    expect(context.calls).toEqual([]);
  });

  it("preserves shape, line, and particle command order with isolated Canvas state", async () => {
    const { renderCommands } = await import("../src/index.js");
    const context = new RecordingContext();

    renderCommands(context, [
      {
        kind: "draw-shape",
        sourceId: "shape-1",
        x: 16,
        y: 24,
        width: 120,
        height: 80,
        opacity: 0.5,
      },
      {
        kind: "draw-line",
        sourceId: "line-1",
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        opacity: 0.75,
      },
      {
        kind: "draw-particles",
        sourceId: "particle-1",
        points: [{ x: 5, y: 6 }],
        size: 7,
        opacity: 0.25,
      },
    ]);

    expect(context.calls).toEqual([
      "save",
      "alpha(0.5)",
      "fillRect(16,24,120,80)",
      "restore",
      "save",
      "alpha(0.75)",
      "beginPath",
      "moveTo(1,2)",
      "lineTo(3,4)",
      "stroke",
      "restore",
      "save",
      "alpha(0.25)",
      "fillRect(5,6,7,7)",
      "restore",
    ]);
  });
});
