let width: i32 = 0;
let height: i32 = 0;
let maxSize: i32 = 0;

let currentFrame: Uint8Array = new Uint8Array(0);
let previousFrame: Uint8Array = new Uint8Array(0);
let tempBuffer: Uint8Array = new Uint8Array(0);
let dilateBuffer: Uint8Array = new Uint8Array(0);
let visitedBuffer: Uint8Array = new Uint8Array(0);
let queueBuffer: Int32Array = new Int32Array(0);
let boxesBuffer: Int32Array = new Int32Array(0);
let numBoxes: i32 = 0;

let isPreviousFrameInitialized: boolean = false;

class StackBlurNode {
  value: u8 = 0;
  next: StackBlurNode | null = null;
}

const mulTable: i32[] = [
  512, 512, 456, 512, 328, 456, 335, 512, 405, 328, 271, 456, 388, 335, 292, 512, 454, 405, 364, 328, 298, 271, 496, 456, 420, 388, 360, 335, 312, 292, 273, 512, 482,
  454, 428, 405, 383, 364, 345, 328, 312, 298, 284, 271, 259, 496, 475, 456, 437, 420, 404, 388, 374, 360, 347, 335, 323, 312, 302, 292, 282, 273, 265, 512, 497, 482,
  468, 454, 441, 428, 417, 405, 394, 383, 373, 364, 354, 345, 337, 328, 320, 312, 305, 298, 291, 284, 278, 271, 265, 259, 507, 496, 485, 475, 465, 456, 446, 437, 428,
  420, 412, 404, 396, 388, 381, 374, 367, 360, 354, 347, 341, 335, 329, 323, 318, 312, 307, 302, 297, 292, 287, 282, 278, 273, 269, 265, 261, 512, 505, 497, 489, 482,
  475, 468, 461, 454, 447, 441, 435, 428, 422, 417, 411, 405, 399, 394, 389, 383, 378, 373, 368, 364, 359, 354, 350, 345, 341, 337, 332, 328, 324, 320, 316, 312, 309,
  305, 301, 298, 294, 291, 287, 284, 281, 278, 274, 271, 268, 265, 262, 259, 257, 507, 501, 496, 491, 485, 480, 475, 470, 465, 460, 456, 451, 446, 442, 437, 433, 428,
  424, 420, 416, 412, 408, 404, 400, 396, 392, 388, 385, 381, 377, 374, 370, 367, 363, 360, 357, 354, 350, 347, 344, 341, 338, 335, 332, 329, 326, 323, 320, 318, 315,
  312, 310, 307, 304, 302, 299, 297, 294, 292, 289, 287, 285, 282, 280, 278, 275, 273, 271, 269, 267, 265, 263, 261, 259,
];

const shgTable: i32[] = [
  9, 11, 12, 13, 13, 14, 14, 15, 15, 15, 15, 16, 16, 16, 16, 17, 17, 17, 17, 17, 17, 17, 18, 18, 18, 18, 18, 18, 18, 18, 18, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19,
  19, 19, 19, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
  21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22,
  22, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23,
  23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
  24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
  24, 24, 24,
];

let stackPool: StackBlurNode[] = [];

// @ts-ignore: decorator
@inline
function initializeStackPool(radius: i32): void {
  if (stackPool.length === 0) {
    let div: i32 = radius + radius + 1;
    for (let i = 0; i < div; i++) {
      stackPool.push(new StackBlurNode());
    }
  }
}

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

  const diameter: i32 = radius * 2 + 1;
  const divisor: i32 = diameter;

  for (let y: i32 = 0; y < height; y++) {
    let sum: i32 = 0;
    for (let i: i32 = -radius; i <= radius; i++) {
      let x = clamp(i, 0, width - 1);
      sum += currentFrame[y * width + x];
    }

    tempBuffer[y * width] = <u8>(sum / divisor);

    for (let x: i32 = 1; x < width; x++) {
      let removeIdx = x - radius - 1;
      let addIdx = x + radius;

      removeIdx = clamp(removeIdx, 0, width - 1);
      addIdx = clamp(addIdx, 0, width - 1);

      sum = sum - currentFrame[y * width + removeIdx] + currentFrame[y * width + addIdx];
      tempBuffer[y * width + x] = <u8>(sum / divisor);
    }
  }

  for (let x: i32 = 0; x < width; x++) {
    let sum: i32 = 0;
    for (let i: i32 = -radius; i <= radius; i++) {
      let y = clamp(i, 0, height - 1);
      sum += tempBuffer[y * width + x];
    }

    currentFrame[x] = <u8>(sum / divisor);

    for (let y: i32 = 1; y < height; y++) {
      let removeIdx = y - radius - 1;
      let addIdx = y + radius;

      removeIdx = clamp(removeIdx, 0, height - 1);
      addIdx = clamp(addIdx, 0, height - 1);

      sum = sum - tempBuffer[removeIdx * width + x] + tempBuffer[addIdx * width + x];
      currentFrame[y * width + x] = <u8>(sum / divisor);
    }
  }
}

// @ts-ignore: decorator
@inline
function stackBlur(radius: i32): void {
  if (radius < 1) return;

  initializeStackPool(radius);

  let div: i32 = radius + radius + 1;
  let widthMinus1: i32 = width - 1;
  let heightMinus1: i32 = height - 1;
  let radiusPlus1: i32 = radius + 1;
  let sumFactor: i32 = (radiusPlus1 * (radiusPlus1 + 1)) / 2;

  let stackStart: StackBlurNode = stackPool[0];
  let stack: StackBlurNode = stackStart;
  let stackEnd: StackBlurNode | null = null;

  for (let i: i32 = 1; i < div; i++) {
    stack.next = stackPool[i];
    stack = stack.next!;
    if (i == radiusPlus1) stackEnd = stack;
  }

  stack.next = stackStart;
  let stackIn: StackBlurNode;
  let stackOut: StackBlurNode;

  let mulSum: i32 = mulTable[radius];
  let shgSum: i32 = shgTable[radius];

  let yi: i32 = 0;
  let sum: i32;
  let outSum: i32, inSum: i32;

  for (let y: i32 = 0; y < height; y++) {
    inSum = sum = 0;
    outSum = radiusPlus1 * currentFrame[yi];
    sum += sumFactor * currentFrame[yi];
    stack = stackStart;

    for (let i: i32 = 0; i < radiusPlus1; i++) {
      stack.value = currentFrame[yi];
      stack = stack.next!;
    }

    for (let i: i32 = 1; i < radiusPlus1; i++) {
      let p = yi + (i <= widthMinus1 ? i : widthMinus1);
      stack.value = currentFrame[p];

      let rbs: i32 = radiusPlus1 - i;
      sum += stack.value * rbs;
      inSum += stack.value;
      stack = stack.next!;
    }

    stackIn = stackStart;
    stackOut = stackEnd!;

    for (let x: i32 = 0; x < width; x++) {
      tempBuffer[yi + x] = (sum * mulSum) >> shgSum;

      sum -= outSum;
      outSum -= stackIn.value;

      let p = yi + (x + radius <= widthMinus1 ? x + radius : widthMinus1);
      stackIn.value = currentFrame[p];

      inSum += stackIn.value;
      sum += inSum;
      stackIn = stackIn.next!;
      outSum += stackOut.value;
      inSum -= stackOut.value;
      stackOut = stackOut.next!;
    }
    yi += width;
  }

  for (let x: i32 = 0; x < width; x++) {
    inSum = sum = 0;
    outSum = radiusPlus1 * tempBuffer[x];
    sum += sumFactor * tempBuffer[x];
    stack = stackStart;

    for (let i: i32 = 0; i < radiusPlus1; i++) {
      stack.value = tempBuffer[x];
      stack = stack.next!;
    }

    for (let i: i32 = 1; i <= radius; i++) {
      let p = x + (i < heightMinus1 ? i : heightMinus1) * width;
      stack.value = tempBuffer[p];

      let rbs: i32 = radiusPlus1 - i;
      sum += stack.value * rbs;
      inSum += stack.value;
      stack = stack.next!;
    }

    stackIn = stackStart;
    stackOut = stackEnd!;

    for (let y: i32 = 0; y < height; y++) {
      let p = y * width + x;
      currentFrame[p] = (sum * mulSum) >> shgSum;

      sum -= outSum;
      outSum -= stackIn.value;

      let pp = x + (y + radius < heightMinus1 ? (y + radius) * width : heightMinus1 * width);
      stackIn.value = tempBuffer[pp];
      inSum += stackIn.value;
      sum += inSum;
      stackIn = stackIn.next!;
      outSum += stackOut.value;
      inSum -= stackOut.value;
      stackOut = stackOut.next!;
    }
  }
}

// @ts-ignore: decorator
@inline
function createMotionMask(threshold: i32): void {
  let length = width * height;

  for (let i = 0; i < length; i += 16) {
    let prevPixels = load<v128>(changetype<usize>(previousFrame.buffer) + i);
    let currentPixels = load<v128>(changetype<usize>(currentFrame.buffer) + i);

    let diff = i8x16.abs(i8x16.sub(currentPixels, prevPixels));
    let mask = i8x16.gt_u(diff, v128.splat<u8>(<u8>threshold));

    let result = v128.and(mask, v128.splat<u8>(255));
    store<v128>(changetype<usize>(tempBuffer.buffer) + i, result);
  }
}

// @ts-ignore: decorator
@inline
function dilate(size: i32): void {
  for (let y: i32 = 0; y < height; y++) {
    let rowStart = y * width;
    let x: i32 = 0;

    memory.copy(dilateBuffer.dataStart + rowStart, tempBuffer.dataStart + rowStart, width * sizeof<u8>());

    for (let offset: i32 = -size + 1; offset < size; offset++) {
      let shiftedX: i32 = 0;

      for (; shiftedX <= width - 16; shiftedX += 16) {
        let clampedX = clamp(shiftedX + offset, 0, width - 16);
        let ptr = changetype<usize>(tempBuffer.buffer) + rowStart + clampedX;
        let currentVec = v128.load(ptr);

        let dilatePtr = changetype<usize>(dilateBuffer.buffer) + rowStart + shiftedX;
        let dilateVec = v128.load(dilatePtr);

        let maxVec = i8x16.max_u(dilateVec, currentVec);
        v128.store(dilatePtr, maxVec);
      }

      for (; shiftedX < width; shiftedX++) {
        let clamped = clamp(shiftedX + offset, 0, width - 1);
        let currentVal = load<u8>(changetype<usize>(tempBuffer.buffer) + rowStart + clamped);
        let dilatePtr = changetype<usize>(dilateBuffer.buffer) + rowStart + shiftedX;
        let existingVal = load<u8>(dilatePtr);
        store<u8>(dilatePtr, max<u8>(existingVal, currentVal));
      }
    }

    memory.copy(tempBuffer.dataStart + rowStart, dilateBuffer.dataStart + rowStart, width * sizeof<u8>());
  }

  for (let x: i32 = 0; x < width; x++) {
    let y: i32 = 0;

    for (let yInit = 0; yInit < height; yInit++) {
      store<u8>(changetype<usize>(dilateBuffer.buffer) + yInit * width + x, load<u8>(changetype<usize>(tempBuffer.buffer) + yInit * width + x));
    }

    for (let offset: i32 = -size + 1; offset < size; offset++) {
      let shiftedY: i32 = 0;

      for (; shiftedY <= height - 16; shiftedY += 16) {
        let clampedY = clamp(shiftedY + offset, 0, height - 16);
        let ptr = changetype<usize>(tempBuffer.buffer) + clampedY * width + x;
        let currentVec = v128.load(ptr);

        let dilatePtr = changetype<usize>(dilateBuffer.buffer) + shiftedY * width + x;
        let dilateVec = v128.load(dilatePtr);

        let maxVec = i8x16.max_u(dilateVec, currentVec);
        v128.store(dilatePtr, maxVec);
      }

      for (; shiftedY < height; shiftedY++) {
        let clamped = clamp(shiftedY + offset, 0, height - 1);
        let currentVal = load<u8>(changetype<usize>(tempBuffer.buffer) + clamped * width + x);
        let dilatePtr = changetype<usize>(dilateBuffer.buffer) + shiftedY * width + x;
        let existingVal = load<u8>(dilatePtr);
        store<u8>(dilatePtr, max<u8>(existingVal, currentVal));
      }
    }

    for (let yCopy = 0; yCopy < height; yCopy++) {
      let tempPtr = changetype<usize>(tempBuffer.buffer) + yCopy * width + x;
      let dilateVal = load<u8>(changetype<usize>(dilateBuffer.buffer) + yCopy * width + x);
      store<u8>(tempPtr, dilateVal);
    }
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
    let vMask = v128.load(changetype<usize>(tempBuffer.buffer) + i);
    let vVisited = v128.load(changetype<usize>(visitedBuffer.buffer) + i);

    let vCondition = v128.and(vMask, v128.not(vVisited));

    if (v128.any_true(vCondition)) {
      for (let j: i32 = 0; j < 16; j++) {
        let index = i + j;
        if (index >= totalPixels) break;

        if (load<u8>(changetype<usize>(tempBuffer.buffer) + index) === 255 && load<u8>(changetype<usize>(visitedBuffer.buffer) + index) === 0) {
          let area = 0;
          let head: i32 = 0;
          let tail: i32 = 0;

          store<i32>(changetype<usize>(queueBuffer.buffer) + tail * 4, index);
          tail++;
          store<u8>(changetype<usize>(visitedBuffer.buffer) + index, 1);

          let minX = index % width;
          let minY = index / width;
          let maxX = minX;
          let maxY = minY;

          while (head < tail) {
            let pos = load<i32>(changetype<usize>(queueBuffer.buffer) + head * 4);
            head++;
            let yy = pos / width;
            let xx = pos % width;

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

                if (load<u8>(changetype<usize>(tempBuffer.buffer) + nIndex) === 255 && load<u8>(changetype<usize>(visitedBuffer.buffer) + nIndex) === 0) {
                  store<i32>(changetype<usize>(queueBuffer.buffer) + tail * 4, nIndex);
                  tail++;
                  store<u8>(changetype<usize>(visitedBuffer.buffer) + nIndex, 1);
                }
              }
            }
          }

          if (area >= minArea) {
            store<i32>(changetype<usize>(boxesBuffer.buffer) + numBoxes * 16, minX);
            store<i32>(changetype<usize>(boxesBuffer.buffer) + numBoxes * 16 + 4, minY);
            store<i32>(changetype<usize>(boxesBuffer.buffer) + numBoxes * 16 + 8, maxX - minX + 1);
            store<i32>(changetype<usize>(boxesBuffer.buffer) + numBoxes * 16 + 12, maxY - minY + 1);
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

  currentFrame = new Uint8Array(maxSize);
  previousFrame = new Uint8Array(maxSize);
  tempBuffer = new Uint8Array(maxSize);
  dilateBuffer = new Uint8Array(maxSize);
  visitedBuffer = new Uint8Array(maxSize);
  queueBuffer = new Int32Array(maxSize);
  boxesBuffer = new Int32Array(maxSize * 4);

  isPreviousFrameInitialized = false;
}

export function detectMotion(inputFrame: Uint8Array, threshold: i32, radius: i32, dilationSize: i32, minArea: i32): Int32Array {
  memory.copy(currentFrame.dataStart, inputFrame.dataStart, maxSize);

  blurFrame(radius);

  if (!isPreviousFrameInitialized) {
    memory.copy(previousFrame.dataStart, currentFrame.dataStart, maxSize);
    isPreviousFrameInitialized = true;
    return new Int32Array(0);
  }

  createMotionMask(threshold);

  dilate(dilationSize);

  findBoundingBoxes(minArea);

  memory.copy(previousFrame.dataStart, currentFrame.dataStart, maxSize);

  let result = new Int32Array(numBoxes * 4);
  memory.copy(result.dataStart, boxesBuffer.dataStart, numBoxes * 4 * sizeof<i32>());

  return result;
}

export function getNumBoxes(): i32 {
  return numBoxes;
}

export const Uint8Array_ID = idof<Uint8Array>();
