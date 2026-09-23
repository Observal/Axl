// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { ActivityRasterImage } from "@axl/extension-api";

import type { ChessPiece } from "./chess.ts";

export const CHESS_BOARD_PIXELS = 384;
export const CHESS_BOARD_COLUMNS = 32;
export const CHESS_BOARD_ROWS = 16;
const TILE = CHESS_BOARD_PIXELS / 8;

export type ChessBoardMarker =
  | "cursor"
  | "selected"
  | "move"
  | "capture"
  | "last-from"
  | "last-to"
  | "hint-from"
  | "hint-to"
  | "error"
  | "selected-error"
  | "check";

export interface ChessBoardArtSquare {
  readonly piece: ChessPiece | null;
  readonly marker?: ChessBoardMarker;
}

export interface ChessBoardArtScene {
  readonly squares: readonly ChessBoardArtSquare[];
  readonly orientation: "white" | "black";
}

const PALETTE = Object.freeze([
  Object.freeze({ red: 64, green: 60, blue: 58 }),
  Object.freeze({ red: 117, green: 109, blue: 101 }),
  Object.freeze({ red: 58, green: 53, blue: 49 }),
  Object.freeze({ red: 244, green: 234, blue: 208 }),
  Object.freeze({ red: 215, green: 199, blue: 166 }),
  Object.freeze({ red: 23, green: 23, blue: 23 }),
  Object.freeze({ red: 255, green: 128, blue: 25 }),
  Object.freeze({ red: 247, green: 189, blue: 47 }),
  Object.freeze({ red: 239, green: 83, blue: 80 }),
]);

interface Point {
  readonly x: number;
  readonly y: number;
}

type PieceKind = "p" | "n" | "b" | "r" | "q" | "k";
type Mask = Uint8Array;

function set(mask: Mask, x: number, y: number, value = 1): void {
  if (x >= 0 && x < TILE && y >= 0 && y < TILE) mask[y * TILE + x] = value;
}

function rectangle(mask: Mask, left: number, top: number, right: number, bottom: number): void {
  for (let y = Math.max(0, top); y <= Math.min(TILE - 1, bottom); y += 1) {
    for (let x = Math.max(0, left); x <= Math.min(TILE - 1, right); x += 1) set(mask, x, y);
  }
}

function ellipse(
  mask: Mask,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  value = 1,
): void {
  const left = Math.floor(centerX - radiusX);
  const right = Math.ceil(centerX + radiusX);
  const top = Math.floor(centerY - radiusY);
  const bottom = Math.ceil(centerY + radiusY);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const dx = (x + 0.5 - centerX) / radiusX;
      const dy = (y + 0.5 - centerY) / radiusY;
      if (dx * dx + dy * dy <= 1) set(mask, x, y, value);
    }
  }
}

function polygon(mask: Mask, points: readonly Point[], value = 1): void {
  const left = Math.floor(Math.min(...points.map(({ x }) => x)));
  const right = Math.ceil(Math.max(...points.map(({ x }) => x)));
  const top = Math.floor(Math.min(...points.map(({ y }) => y)));
  const bottom = Math.ceil(Math.max(...points.map(({ y }) => y)));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      let inside = false;
      for (let index = 0, prior = points.length - 1; index < points.length; prior = index++) {
        const a = points[index] as Point;
        const b = points[prior] as Point;
        if (
          a.y > y + 0.5 !== b.y > y + 0.5 &&
          x + 0.5 < ((b.x - a.x) * (y + 0.5 - a.y)) / (b.y - a.y) + a.x
        )
          inside = !inside;
      }
      if (inside) set(mask, x, y, value);
    }
  }
}

function base(mask: Mask): void {
  polygon(mask, [
    { x: 14, y: 35 },
    { x: 34, y: 35 },
    { x: 38, y: 40 },
    { x: 10, y: 40 },
  ]);
  rectangle(mask, 8, 40, 39, 43);
  rectangle(mask, 11, 44, 36, 45);
}

function pieceMask(kind: PieceKind): Mask {
  const mask = new Uint8Array(TILE * TILE);
  if (kind === "p") {
    ellipse(mask, 24, 12, 7, 7);
    polygon(mask, [
      { x: 19, y: 18 },
      { x: 29, y: 18 },
      { x: 33, y: 34 },
      { x: 15, y: 34 },
    ]);
  } else if (kind === "r") {
    rectangle(mask, 11, 7, 16, 14);
    rectangle(mask, 21, 7, 26, 14);
    rectangle(mask, 31, 7, 36, 14);
    rectangle(mask, 11, 12, 36, 17);
    polygon(mask, [
      { x: 15, y: 17 },
      { x: 33, y: 17 },
      { x: 31, y: 35 },
      { x: 17, y: 35 },
    ]);
  } else if (kind === "b") {
    ellipse(mask, 24, 15, 8, 11);
    polygon(mask, [
      { x: 18, y: 23 },
      { x: 30, y: 23 },
      { x: 34, y: 35 },
      { x: 14, y: 35 },
    ]);
    polygon(
      mask,
      [
        { x: 25, y: 5 },
        { x: 29, y: 9 },
        { x: 20, y: 23 },
        { x: 18, y: 20 },
      ],
      0,
    );
  } else if (kind === "n") {
    polygon(mask, [
      { x: 14, y: 35 },
      { x: 16, y: 27 },
      { x: 21, y: 20 },
      { x: 17, y: 17 },
      { x: 20, y: 8 },
      { x: 24, y: 12 },
      { x: 32, y: 10 },
      { x: 37, y: 17 },
      { x: 34, y: 27 },
      { x: 29, y: 34 },
    ]);
    polygon(mask, [
      { x: 17, y: 17 },
      { x: 12, y: 22 },
      { x: 24, y: 20 },
    ]);
    ellipse(mask, 29, 17, 1.5, 1.5, 0);
  } else if (kind === "q") {
    for (const point of [
      { x: 11, y: 10 },
      { x: 18, y: 6 },
      { x: 24, y: 10 },
      { x: 30, y: 6 },
      { x: 37, y: 10 },
    ]) {
      ellipse(mask, point.x, point.y, 3, 3);
    }
    polygon(mask, [
      { x: 10, y: 11 },
      { x: 17, y: 20 },
      { x: 18, y: 9 },
      { x: 24, y: 21 },
      { x: 30, y: 9 },
      { x: 31, y: 20 },
      { x: 38, y: 11 },
      { x: 33, y: 32 },
      { x: 15, y: 32 },
    ]);
  } else {
    rectangle(mask, 22, 4, 25, 15);
    rectangle(mask, 18, 8, 29, 11);
    ellipse(mask, 24, 19, 8, 7);
    polygon(mask, [
      { x: 19, y: 23 },
      { x: 29, y: 23 },
      { x: 34, y: 35 },
      { x: 14, y: 35 },
    ]);
  }
  base(mask);
  return mask;
}

const PIECE_MASKS = Object.freeze({
  p: pieceMask("p"),
  n: pieceMask("n"),
  b: pieceMask("b"),
  r: pieceMask("r"),
  q: pieceMask("q"),
  k: pieceMask("k"),
});

function dilated(mask: Mask): Mask {
  const result = new Uint8Array(mask.length);
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      for (let dy = -1; dy <= 1 && result[y * TILE + x] === 0; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const sourceX = x + dx;
          const sourceY = y + dy;
          if (
            sourceX >= 0 &&
            sourceX < TILE &&
            sourceY >= 0 &&
            sourceY < TILE &&
            mask[sourceY * TILE + sourceX] !== 0
          ) {
            result[y * TILE + x] = 1;
            break;
          }
        }
      }
    }
  }
  return result;
}

const PIECE_EDGES = Object.freeze({
  p: dilated(PIECE_MASKS.p),
  n: dilated(PIECE_MASKS.n),
  b: dilated(PIECE_MASKS.b),
  r: dilated(PIECE_MASKS.r),
  q: dilated(PIECE_MASKS.q),
  k: dilated(PIECE_MASKS.k),
});

const SMALL_GLYPHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  a: ["010", "101", "111", "101", "101"],
  b: ["110", "101", "110", "101", "110"],
  c: ["011", "100", "100", "100", "011"],
  d: ["110", "101", "101", "101", "110"],
  e: ["111", "100", "110", "100", "111"],
  f: ["111", "100", "110", "100", "100"],
  g: ["011", "100", "101", "101", "011"],
  h: ["101", "101", "111", "101", "101"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["110", "001", "010", "100", "111"],
  "3": ["110", "001", "010", "001", "110"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "110", "001", "110"],
  "6": ["011", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
});

const MARKERS: Readonly<Record<ChessBoardMarker, readonly string[]>> = Object.freeze({
  cursor: ["101", "010", "101"],
  selected: ["010", "101", "010"],
  move: ["000", "010", "000"],
  capture: ["101", "010", "101"],
  "last-from": ["001", "010", "100"],
  "last-to": ["100", "010", "001"],
  "hint-from": ["010", "110", "010", "010", "111"],
  "hint-to": ["110", "001", "010", "100", "111"],
  error: ["010", "010", "010", "000", "010"],
  "selected-error": ["111", "001", "010", "000", "010"],
  check: ["010", "111", "010", "000", "010"],
});

function drawPiece(pixels: Uint8Array, tileX: number, tileY: number, piece: ChessPiece): void {
  const kind = piece.toLowerCase() as PieceKind;
  const mask = PIECE_MASKS[kind];
  const edge = PIECE_EDGES[kind];
  const white = piece === piece.toUpperCase();
  const edgeColor = white ? 2 : 4;
  const fillColor = white ? 3 : 5;
  const scale = 0.9;
  const center = (TILE - 1) / 2;
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      const sourceX = Math.round((x - center) / scale + center);
      const sourceY = Math.round((y - center) / scale + center);
      if (sourceX < 0 || sourceX >= TILE || sourceY < 0 || sourceY >= TILE) continue;
      const source = sourceY * TILE + sourceX;
      const destination = (tileY + y) * CHESS_BOARD_PIXELS + tileX + x;
      if (edge[source] !== 0) pixels[destination] = edgeColor;
      if (mask[source] !== 0) pixels[destination] = fillColor;
    }
  }
}

function drawSmallGlyph(
  pixels: Uint8Array,
  tileX: number,
  tileY: number,
  glyph: string,
  left: number,
  top: number,
  color: number,
): void {
  const rows = SMALL_GLYPHS[glyph];
  if (rows === undefined) return;
  for (const [row, bits] of rows.entries()) {
    for (const [column, bit] of [...bits].entries()) {
      if (bit === "1") {
        const x = tileX + left + column;
        const y = tileY + top + row;
        pixels[y * CHESS_BOARD_PIXELS + x] = color;
        pixels[y * CHESS_BOARD_PIXELS + x + 1] = color;
        pixels[(y + 1) * CHESS_BOARD_PIXELS + x] = color;
      }
    }
  }
}

function drawBorder(
  pixels: Uint8Array,
  tileX: number,
  tileY: number,
  color: number,
  thickness: number,
  inset = 1,
): void {
  for (let offset = 0; offset < thickness; offset += 1) {
    const left = tileX + inset + offset;
    const right = tileX + TILE - inset - offset - 1;
    const top = tileY + inset + offset;
    const bottom = tileY + TILE - inset - offset - 1;
    for (let x = left; x <= right; x += 1) {
      pixels[top * CHESS_BOARD_PIXELS + x] = color;
      pixels[bottom * CHESS_BOARD_PIXELS + x] = color;
    }
    for (let y = top; y <= bottom; y += 1) {
      pixels[y * CHESS_BOARD_PIXELS + left] = color;
      pixels[y * CHESS_BOARD_PIXELS + right] = color;
    }
  }
}

function drawCorners(
  pixels: Uint8Array,
  tileX: number,
  tileY: number,
  color: number,
  thickness = 2,
  length = 10,
): void {
  const inset = 3;
  for (let offset = 0; offset < thickness; offset += 1) {
    const left = tileX + inset + offset;
    const right = tileX + TILE - inset - offset - 1;
    const top = tileY + inset + offset;
    const bottom = tileY + TILE - inset - offset - 1;
    for (let step = 0; step < length; step += 1) {
      pixels[top * CHESS_BOARD_PIXELS + left + step] = color;
      pixels[top * CHESS_BOARD_PIXELS + right - step] = color;
      pixels[bottom * CHESS_BOARD_PIXELS + left + step] = color;
      pixels[bottom * CHESS_BOARD_PIXELS + right - step] = color;
      pixels[(top + step) * CHESS_BOARD_PIXELS + left] = color;
      pixels[(top + step) * CHESS_BOARD_PIXELS + right] = color;
      pixels[(bottom - step) * CHESS_BOARD_PIXELS + left] = color;
      pixels[(bottom - step) * CHESS_BOARD_PIXELS + right] = color;
    }
  }
}

function drawMarkerGlyph(
  pixels: Uint8Array,
  tileX: number,
  tileY: number,
  marker: ChessBoardMarker,
  color: number,
): void {
  const glyph = MARKERS[marker];
  const top = tileY + TILE - glyph.length - 3;
  const left = tileX + TILE - 6;
  for (const [row, bits] of glyph.entries()) {
    for (const [column, bit] of [...bits].entries()) {
      if (bit === "1") pixels[(top + row) * CHESS_BOARD_PIXELS + left + column] = color;
    }
  }
}

function drawMarker(
  pixels: Uint8Array,
  tileX: number,
  tileY: number,
  marker: ChessBoardMarker,
): void {
  if (marker === "selected") {
    drawBorder(pixels, tileX, tileY, 6, 3);
    return;
  }
  if (marker === "selected-error") {
    drawBorder(pixels, tileX, tileY, 6, 3);
    drawMarkerGlyph(pixels, tileX, tileY, marker, 8);
    return;
  }
  if (marker === "cursor") {
    drawCorners(pixels, tileX, tileY, 6);
    return;
  }
  if (marker === "move") {
    for (let y = -5; y <= 5; y += 1) {
      for (let x = -5; x <= 5; x += 1) {
        if (x * x + y * y <= 25) pixels[(tileY + 24 + y) * CHESS_BOARD_PIXELS + tileX + 24 + x] = 6;
      }
    }
    return;
  }
  if (marker === "capture") {
    drawCorners(pixels, tileX, tileY, 7, 3, 11);
    return;
  }
  if (marker === "hint-from" || marker === "hint-to") {
    drawBorder(pixels, tileX, tileY, 7, 2);
    drawMarkerGlyph(pixels, tileX, tileY, marker, 7);
    return;
  }
  if (marker === "error" || marker === "check") {
    drawBorder(pixels, tileX, tileY, 8, 3);
    drawMarkerGlyph(pixels, tileX, tileY, marker, 8);
    return;
  }
  drawMarkerGlyph(pixels, tileX, tileY, marker, 6);
}

export function renderChessBoardRaster(
  scene: ChessBoardArtScene,
  placement: ActivityRasterImage["placement"],
): ActivityRasterImage {
  if (scene.squares.length !== 64) throw new RangeError("Chess board scene requires 64 squares");
  const pixels = new Uint8Array(CHESS_BOARD_PIXELS * CHESS_BOARD_PIXELS);
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const square = scene.squares[row * 8 + column] as ChessBoardArtSquare;
      const background = (row + column) % 2 === 0 ? 1 : 0;
      const tileX = column * TILE;
      const tileY = row * TILE;
      for (let y = tileY; y < tileY + TILE; y += 1) {
        pixels.fill(
          background,
          y * CHESS_BOARD_PIXELS + tileX,
          y * CHESS_BOARD_PIXELS + tileX + TILE,
        );
      }
      if (square.piece !== null) drawPiece(pixels, tileX, tileY, square.piece);
      const coordinateColor = background === 0 ? 4 : 2;
      const rank = scene.orientation === "white" ? `${8 - row}` : `${row + 1}`;
      const file = scene.orientation === "white" ? "abcdefgh"[column] : "hgfedcba"[column];
      if (column === 0) drawSmallGlyph(pixels, tileX, tileY, rank, 3, 3, coordinateColor);
      if (row === 7 && file !== undefined)
        drawSmallGlyph(pixels, tileX, tileY, file, 3, TILE - 8, coordinateColor);
      if (square.marker !== undefined) drawMarker(pixels, tileX, tileY, square.marker);
    }
  }
  return Object.freeze({
    format: "indexed",
    width: CHESS_BOARD_PIXELS,
    height: CHESS_BOARD_PIXELS,
    palette: PALETTE,
    pixels,
    placement: Object.freeze({ ...placement }),
    description: "Chess puzzle board",
  });
}
