let width: i32 = 0;
let height: i32 = 0;
let maxSize: i32 = 0;

const MAX_BOXES: i32 = 4096;
const MAX_DILATE_RADIUS: i32 = 64;

let currentFrame: Uint8Array = new Uint8Array(0);
let previousFrame: Uint8Array = new Uint8Array(0);
let tempBuffer: Uint8Array = new Uint8Array(0);
let dilateBuffer: Uint8Array = new Uint8Array(0);
let visitedBuffer: Uint8Array = new Uint8Array(0);
let queueBuffer: Int32Array = new Int32Array(0);
let boxesBuffer: Int32Array = new Int32Array(0);
let numBoxes: i32 = 0;

let vhLine: Uint8Array = new Uint8Array(0);
let vhG: Uint8Array = new Uint8Array(0);
let vhH: Uint8Array = new Uint8Array(0);

let isPreviousFrameInitialized: boolean = false;

// @ts-ignore: decorator
@inline
function clamp(value: i32, min: i32, max: i32): i32 {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// @ts-ignore: decorator
@inline
function blurFrame(radius: i32): void {
  if (radius < 1) return;

  const divisor: i32 = radius * 2 + 1;
  // Fixed-point reciprocal: (sum * recip) >> 16 == round(sum / divisor),
  // avoids an integer division per pixel.
  const recip: i32 = ((1 << 16) + (divisor >> 1)) / divisor;

  for (let y: i32 = 0; y < height; y++) {
    let sum: i32 = 0;
    for (let i: i32 = -radius; i <= radius; i++) {
      let x = clamp(i, 0, width - 1);
      sum += currentFrame[y * width + x];
    }

    tempBuffer[y * width] = <u8>((sum * recip) >> 16);

    for (let x: i32 = 1; x < width; x++) {
      let removeIdx = x - radius - 1;
      let addIdx = x + radius;

      removeIdx = clamp(removeIdx, 0, width - 1);
      addIdx = clamp(addIdx, 0, width - 1);

      sum = sum - currentFrame[y * width + removeIdx] + currentFrame[y * width + addIdx];
      tempBuffer[y * width + x] = <u8>((sum * recip) >> 16);
    }
  }

  for (let x: i32 = 0; x < width; x++) {
    let sum: i32 = 0;
    for (let i: i32 = -radius; i <= radius; i++) {
      let y = clamp(i, 0, height - 1);
      sum += tempBuffer[y * width + x];
    }

    currentFrame[x] = <u8>((sum * recip) >> 16);

    for (let y: i32 = 1; y < height; y++) {
      let removeIdx = y - radius - 1;
      let addIdx = y + radius;

      removeIdx = clamp(removeIdx, 0, height - 1);
      addIdx = clamp(addIdx, 0, height - 1);

      sum = sum - tempBuffer[removeIdx * width + x] + tempBuffer[addIdx * width + x];
      currentFrame[y * width + x] = <u8>((sum * recip) >> 16);
    }
  }
}

// @ts-ignore: decorator
@inline
function createMotionMask(threshold: i32): void {
  const length = width * height;
  const thr = v128.splat<u8>(<u8>threshold);

  for (let i = 0; i < length; i += 16) {
    let cur = load<v128>(currentFrame.dataStart + i);
    let prev = load<v128>(previousFrame.dataStart + i);
    let diff = i8x16.sub(i8x16.max_u(cur, prev), i8x16.min_u(cur, prev));
    let mask = i8x16.gt_u(diff, thr);

    store<v128>(tempBuffer.dataStart + i, mask);
  }
}

// @ts-ignore: decorator
@inline
function dilate1DScalar(srcBase: usize, srcStride: i32, dstBase: usize, dstStride: i32, n: i32, r: i32): void {
  const k = 2 * r + 1;
  const m = n + 2 * r;
  const lb = vhLine.dataStart;
  const gb = vhG.dataStart;
  const hb = vhH.dataStart;

  // Pad by r on both sides with the edge values so no window crosses a border.
  const edge0 = load<u8>(srcBase);
  const edgeN = load<u8>(srcBase + <usize>(n - 1) * <usize>srcStride);
  for (let j = 0; j < r; j++) store<u8>(lb + j, edge0);
  for (let j = 0; j < n; j++) store<u8>(lb + r + j, load<u8>(srcBase + <usize>j * <usize>srcStride));
  for (let j = 0; j < r; j++) store<u8>(lb + r + n + j, edgeN);

  // Block prefix (g) and suffix (h) maxima over the padded line.
  for (let bs = 0; bs < m; bs += k) {
    const be = bs + k < m ? bs + k : m;

    let acc = load<u8>(lb + bs);
    store<u8>(gb + bs, acc);
    for (let i = bs + 1; i < be; i++) {
      const v = load<u8>(lb + i);
      if (v > acc) acc = v;
      store<u8>(gb + i, acc);
    }

    acc = load<u8>(lb + be - 1);
    store<u8>(hb + be - 1, acc);
    for (let i = be - 2; i >= bs; i--) {
      const v = load<u8>(lb + i);
      if (v > acc) acc = v;
      store<u8>(hb + i, acc);
    }
  }

  // out[i] = max(h[i], g[i + 2r]); window [i, i+2r] in padded coords.
  for (let i = 0; i < n; i++) {
    const hv = load<u8>(hb + i);
    const gv = load<u8>(gb + i + 2 * r);
    store<u8>(dstBase + <usize>i * <usize>dstStride, hv > gv ? hv : gv);
  }
}

// @ts-ignore: decorator
@inline
function dilate1DSimdCols(x0: i32, n: i32, r: i32): void {
  const k = 2 * r + 1;
  const m = n + 2 * r;
  const lb = vhLine.dataStart;
  const gb = vhG.dataStart;
  const hb = vhH.dataStart;

  const srcCol = dilateBuffer.dataStart + x0;
  const dstCol = tempBuffer.dataStart + x0;
  const stride = <usize>width;

  const edge0 = v128.load(srcCol);
  const edgeN = v128.load(srcCol + <usize>(n - 1) * stride);
  for (let j = 0; j < r; j++) v128.store(lb + (<usize>j << 4), edge0);
  for (let j = 0; j < n; j++) v128.store(lb + (<usize>(r + j) << 4), v128.load(srcCol + <usize>j * stride));
  for (let j = 0; j < r; j++) v128.store(lb + (<usize>(r + n + j) << 4), edgeN);

  for (let bs = 0; bs < m; bs += k) {
    const be = bs + k < m ? bs + k : m;

    let acc = v128.load(lb + (<usize>bs << 4));
    v128.store(gb + (<usize>bs << 4), acc);
    for (let i = bs + 1; i < be; i++) {
      acc = i8x16.max_u(acc, v128.load(lb + (<usize>i << 4)));
      v128.store(gb + (<usize>i << 4), acc);
    }

    acc = v128.load(lb + (<usize>(be - 1) << 4));
    v128.store(hb + (<usize>(be - 1) << 4), acc);
    for (let i = be - 2; i >= bs; i--) {
      acc = i8x16.max_u(acc, v128.load(lb + (<usize>i << 4)));
      v128.store(hb + (<usize>i << 4), acc);
    }
  }

  for (let i = 0; i < n; i++) {
    const hv = v128.load(hb + (<usize>i << 4));
    const gv = v128.load(gb + (<usize>(i + 2 * r) << 4));
    v128.store(dstCol + <usize>i * stride, i8x16.max_u(hv, gv));
  }
}

// @ts-ignore: decorator
@inline
function dilate(size: i32): void {
  let r = size - 1;
  if (r < 1) return;
  if (r > MAX_DILATE_RADIUS) r = MAX_DILATE_RADIUS;

  for (let y: i32 = 0; y < height; y++) {
    let row = <usize>y * <usize>width;
    dilate1DScalar(tempBuffer.dataStart + row, 1, dilateBuffer.dataStart + row, 1, width, r);
  }

  let x: i32 = 0;
  for (; x <= width - 16; x += 16) {
    dilate1DSimdCols(x, height, r);
  }
  for (; x < width; x++) {
    dilate1DScalar(dilateBuffer.dataStart + x, width, tempBuffer.dataStart + x, width, height, r);
  }
}

// @ts-ignore: decorator
@inline
function findBoundingBoxes(minArea: i32): i32 {
  numBoxes = 0;

  memory.fill(visitedBuffer.dataStart, 0, maxSize * sizeof<u8>());

  let totalPixels = width * height;
  let step = 16;

  for (let i: i32 = 0; i < totalPixels; i += step) {
    let vMask = v128.load(tempBuffer.dataStart + i);
    let vVisited = v128.load(visitedBuffer.dataStart + i);

    let vCondition = v128.and(vMask, v128.not(vVisited));

    if (v128.any_true(vCondition)) {
      for (let j: i32 = 0; j < 16; j++) {
        let index = i + j;
        if (index >= totalPixels) break;

        if (load<u8>(tempBuffer.dataStart + index) === 255 && load<u8>(visitedBuffer.dataStart + index) === 0) {
          let area = 0;
          let head: i32 = 0;
          let tail: i32 = 0;

          let seedX = index % width;
          let seedY = index / width;

          // Queue stores packed (y << 16 | x) to avoid div/mod per popped pixel.
          store<i32>(queueBuffer.dataStart + tail * 4, (seedY << 16) | seedX);
          tail++;
          store<u8>(visitedBuffer.dataStart + index, 1);

          let minX = seedX;
          let minY = seedY;
          let maxX = seedX;
          let maxY = seedY;

          while (head < tail) {
            let packed = load<i32>(queueBuffer.dataStart + head * 4);
            head++;
            let xx = packed & 0xffff;
            let yy = packed >>> 16;

            if (xx < minX) minX = xx;
            if (yy < minY) minY = yy;
            if (xx > maxX) maxX = xx;
            if (yy > maxY) maxY = yy;

            area++;

            for (let dy: i32 = -1; dy <= 1; dy++) {
              for (let dx: i32 = -1; dx <= 1; dx++) {
                if (dy === 0 && dx === 0) continue;

                let ny = yy + dy;
                let nx = xx + dx;

                if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;

                let nIndex = ny * width + nx;

                if (load<u8>(tempBuffer.dataStart + nIndex) === 255 && load<u8>(visitedBuffer.dataStart + nIndex) === 0) {
                  store<i32>(queueBuffer.dataStart + tail * 4, (ny << 16) | nx);
                  tail++;
                  store<u8>(visitedBuffer.dataStart + nIndex, 1);
                }
              }
            }
          }

          if (area >= minArea && numBoxes < MAX_BOXES) {
            store<i32>(boxesBuffer.dataStart + numBoxes * 16, minX);
            store<i32>(boxesBuffer.dataStart + numBoxes * 16 + 4, minY);
            store<i32>(boxesBuffer.dataStart + numBoxes * 16 + 8, maxX - minX + 1);
            store<i32>(boxesBuffer.dataStart + numBoxes * 16 + 12, maxY - minY + 1);
            numBoxes++;
          }
        }
      }
    }
  }

  return numBoxes;
}

export function initialize(w: i32, h: i32): void {
  width = w;
  height = h;
  maxSize = width * height;

  let padded = (maxSize + 15) & ~15;

  currentFrame = new Uint8Array(padded);
  previousFrame = new Uint8Array(padded);
  tempBuffer = new Uint8Array(padded);
  dilateBuffer = new Uint8Array(padded);
  visitedBuffer = new Uint8Array(padded);
  queueBuffer = new Int32Array(maxSize);
  boxesBuffer = new Int32Array(MAX_BOXES * 4);

  let lineLen = (max(width, height) + 2 * MAX_DILATE_RADIUS) * 16;
  vhLine = new Uint8Array(lineLen);
  vhG = new Uint8Array(lineLen);
  vhH = new Uint8Array(lineLen);

  numBoxes = 0;
  isPreviousFrameInitialized = false;
}

export function getFramePtr(): usize {
  return currentFrame.dataStart;
}

export function getBoxesPtr(): usize {
  return boxesBuffer.dataStart;
}

export function getMaxBoxes(): i32 {
  return MAX_BOXES;
}

export function reset(): void {
  isPreviousFrameInitialized = false;
  numBoxes = 0;
}

export function detectMotion(threshold: i32, radius: i32, dilationSize: i32, minArea: i32): i32 {
  blurFrame(radius);

  if (!isPreviousFrameInitialized) {
    memory.copy(previousFrame.dataStart, currentFrame.dataStart, maxSize);
    isPreviousFrameInitialized = true;
    numBoxes = 0;
    return 0;
  }

  createMotionMask(threshold);
  dilate(dilationSize);
  findBoundingBoxes(minArea);

  memory.copy(previousFrame.dataStart, currentFrame.dataStart, maxSize);

  return numBoxes;
}

export function getNumBoxes(): i32 {
  return numBoxes;
}
