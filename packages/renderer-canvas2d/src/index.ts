import type { RenderCommand } from "@particle-studio/runtime";

/** The minimal Canvas2D operations required by the first-slice command sink. */
export interface Canvas2DContextLike {
  globalAlpha: number;
  font: string;
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  transform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  drawImage(
    source: unknown,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void;
}

function assertCanvasImageHandle(handle: unknown): asserts handle is object {
  if (typeof handle !== "object" || handle === null) {
    throw new Error("CANVAS_IMAGE_HANDLE_INVALID");
  }
}

/** Draws ordered runtime commands without accessing documents, time, or the DOM. */
export function renderCommands(
  context: Canvas2DContextLike,
  commands: readonly RenderCommand[],
) {
  for (const command of commands) {
    if (command.kind === "draw-image") {
      assertCanvasImageHandle(command.resolved);
    }
    context.save();
    context.globalAlpha = command.opacity;
    if (command.transform) {
      context.transform(...command.transform);
    }

    if (command.kind === "draw-shape") {
      context.fillRect(command.x, command.y, command.width, command.height);
    } else if (command.kind === "draw-text") {
      context.font = `${command.fontSize}px sans-serif`;
      context.fillText(command.text, command.x, command.y);
    } else if (command.kind === "draw-image") {
      context.drawImage(
        command.resolved,
        command.x,
        command.y,
        command.width,
        command.height,
      );
    } else if (command.kind === "draw-particles") {
      for (const point of command.points)
        context.fillRect(point.x, point.y, command.size, command.size);
    } else {
      context.beginPath();
      context.moveTo(command.x1, command.y1);
      context.lineTo(command.x2, command.y2);
      context.stroke();
    }

    context.restore();
  }
}
