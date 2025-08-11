// Minimal type declarations for OpenCV.js used in this project

declare class Mat {
  readonly rows: number;
  readonly cols: number;
  delete(): void;
  intPtr(row: number, col: number): Int32Array;
  doublePtr(row: number, col: number): Float64Array;
  floatPtr(row: number, col: number): Float32Array;
  ucharPtr(row: number, col: number): Uint8Array;
  clone(): Mat;
  // OpenCV.js supports ROI via Mat.roi(Rect)
  roi(rect: Rect): Mat;
}

declare class MatVector {
  size(): number;
  get(index: number): Mat;
  delete(): void;
}

declare class Scalar {
  constructor(v0: number, v1?: number, v2?: number, v3?: number);
}

declare class Size {
  constructor(width: number, height: number);
}

interface MatConstructor {
  new (...args: unknown[]): Mat;
  zeros(rows: number, cols: number, type: number): Mat;
}

interface MatVectorConstructor {
  new (...args: unknown[]): MatVector;
}

interface ScalarConstructor {
  new (v0: number, v1?: number, v2?: number, v3?: number): Scalar;
}

interface SizeConstructor {
  new (width: number, height: number): Size;
}

declare class Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  constructor(x: number, y: number, width: number, height: number);
}

interface CV {
  // constructors
  Mat: MatConstructor;
  MatVector: MatVectorConstructor;
  Scalar: ScalarConstructor;
  Size: SizeConstructor;
  Rect: typeof Rect;

  // core API used
  imread(image: HTMLImageElement | HTMLCanvasElement | string): Mat;
  imshow(canvas: HTMLCanvasElement | string, mat: Mat): void;
  cvtColor(src: Mat, dst: Mat, code: number, dstCn?: number): void;
  applyColorMap(src: Mat, dst: Mat, colormap: number): void;
  inRange(src: Mat, lowerb: Scalar, upperb: Scalar, dst: Mat): void;
  GaussianBlur(
    src: Mat,
    dst: Mat,
    ksize: Size,
    sigmaX: number,
    sigmaY?: number,
    borderType?: number
  ): void;
  threshold(src: Mat, dst: Mat, thresh: number, maxVal: number, type: number): number;
  adaptiveThreshold(
    src: Mat,
    dst: Mat,
    maxValue: number,
    adaptiveMethod: number,
    thresholdType: number,
    blockSize: number,
    C: number
  ): void;
  findContours(
    image: Mat,
    contours: MatVector,
    hierarchy: Mat,
    mode: number,
    method: number
  ): void;
  drawContours(
    image: Mat,
    contours: MatVector,
    contourIdx: number,
    color: Scalar,
    thickness?: number,
    lineType?: number,
    hierarchy?: Mat,
    maxLevel?: number
  ): void;

  Canny(image: Mat, edges: Mat, threshold1: number, threshold2: number, apertureSize?: number, L2gradient?: boolean): void;
  boundingRect(array: Mat): { x: number; y: number; width: number; height: number };
  circle(img: Mat, center: { x: number; y: number }, radius: number, color: Scalar, thickness?: number, lineType?: number, shift?: number): void;
  bitwise_and(src1: Mat, src2: Mat, dst: Mat, mask?: Mat): void;
  subtract(src1: Mat, src2: Mat, dst: Mat): void;
  getStructuringElement(shape: number, ksize: Size): Mat;
  morphologyEx(src: Mat, dst: Mat, op: number, kernel: Mat): void;
  erode(src: Mat, dst: Mat, kernel: Mat): void;
  dilate(src: Mat, dst: Mat, kernel: Mat): void;
  bitwise_or(src1: Mat, src2: Mat, dst: Mat): void;
  connectedComponentsWithStats(image: Mat, labels: Mat, stats: Mat, centroids: Mat, connectivity?: number, ltype?: number): number;
  distanceTransform(src: Mat, dst: Mat, distanceType: number, maskSize: number): void;
  normalize(src: Mat, dst: Mat, alpha: number, beta: number, normType: number): void;
  watershed(image: Mat, markers: Mat): void;

  // constants used
  COLOR_RGBA2GRAY: number;
  COLOR_RGBA2RGB: number;
  COLOR_RGB2HSV: number;
  COLOR_GRAY2RGB: number;
  COLOR_GRAY2RGBA: number;
  THRESH_BINARY: number;
  THRESH_BINARY_INV: number;
  THRESH_OTSU: number;
  ADAPTIVE_THRESH_MEAN_C: number;
  ADAPTIVE_THRESH_GAUSSIAN_C: number;
  RETR_EXTERNAL: number;
  CHAIN_APPROX_SIMPLE: number;
  LINE_8: number;
  BORDER_DEFAULT: number;
  CV_8UC3: number;
  CV_8UC1: number;
  CV_32S: number;
  CV_32F: number;
  MORPH_OPEN: number;
  MORPH_ELLIPSE: number;
  NORM_MINMAX: number;
  DIST_L2: number;
  COLORMAP_JET: number;
}

interface OpenCvWasmModule {
  onRuntimeInitialized?: () => void;
}

declare global {
  // global from the opencv.js script
  var cv: CV;
  interface Window {
    cv: CV;
    Module: OpenCvWasmModule;
  }
}

export {};


