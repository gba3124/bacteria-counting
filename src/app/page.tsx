// OpenCV types are declared globally via `src/types/opencv.d.ts`
"use client";

import { useEffect, useRef, useState } from "react";
import { useOpenCV } from "@/lib/useOpenCV";

type ThresholdMode = "otsu" | "adaptive-mean" | "adaptive-gaussian" | "fixed";

type DistType = "L1" | "L2" | "C";

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<HTMLImageElement | null>(null);

  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [colonyCount, setColonyCount] = useState<number | null>(null);
  const { isReady, error } = useOpenCV();

  // Minimal controls
  // Interpret as a 0..10 scale; mapped to pixel area internally
  const [minArea, setMinArea] = useState<number>(0);
  const [effectiveRadiusPct, setEffectiveRadiusPct] = useState<number>(84);

  // Binarization controls
  const [thresholdMode, setThresholdMode] = useState<ThresholdMode>("adaptive-gaussian");
  const [adaptiveBlockMin, setAdaptiveBlockMin] = useState<number>(21); // odd only
  const [adaptiveBlockMax, setAdaptiveBlockMax] = useState<number>(41); // odd only
  const [adaptiveC, setAdaptiveC] = useState<number>(0);
  const [fixedThresh, setFixedThresh] = useState<number>(128);
  const [invertMask, setInvertMask] = useState<boolean>(true);

  // Watershed
  const [useWatershed, setUseWatershed] = useState<boolean>(false);
  const [splitStrength, setSplitStrength] = useState<number>(0.3); // 0..1
  const [distType, setDistType] = useState<DistType>("L2");
  const [distMask, setDistMask] = useState<3 | 5>(3);
  const [dtThreshMode, setDtThreshMode] = useState<"alpha" | "absolute">("alpha");
  const [dtThreshAbs, setDtThreshAbs] = useState<number>(100); // 0..255
  const [peakCleanupSize, setPeakCleanupSize] = useState<number>(1); // odd 1..7
  // Watershed marker strategy
  const [wsMarkerMode, setWsMarkerMode] = useState<"dt" | "erode" | "hybrid">("erode");
  const [erodeKernelSize, setErodeKernelSize] = useState<number>(5); // odd
  const [erodeIterations, setErodeIterations] = useState<number>(2); // 1..10

  // Color consistency filter
  const [useColorConsistency, setUseColorConsistency] = useState<boolean>(false);
  const [colorTolerance, setColorTolerance] = useState<number>(0.35); // 0..1, hue window scale

  // Internal params (auto tuned or sensitivity)
  const [blurSize, setBlurSize] = useState<number>(7); // odd
  const [morphSize, setMorphSize] = useState<number>(5); // odd

  // Sensitivity master slider (0..10)
  const [sensitivity, setSensitivity] = useState<number>(5);

  // Helpers
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const ensureOdd = (n: number) => (n % 2 === 0 ? n + 1 : n);
  const circularHueDist = (h1: number, h2: number) => {
    const d = Math.abs(h1 - h2);
    return Math.min(d, 180 - d);
  };
  type CvConstants = { DIST_L1: number; DIST_L2: number; DIST_C: number };
  const cvDistConst = (cvObj: unknown, t: DistType) => {
    const c = cvObj as CvConstants;
    return t === "L1" ? c.DIST_L1 : t === "C" ? c.DIST_C : c.DIST_L2;
  };
  //

  const applySensitivity = (s: number) => {
    // Blur: 13 -> 3 as sensitivity increases
    const newBlur = ensureOdd(clamp(13 - s, 3, 13));
    // Morph: 7 -> 3 as sensitivity increases (less aggressive opening)
    const newMorph = ensureOdd(clamp(7 - Math.round(s * 0.4), 3, 9));
    // Min area scale (0..10): decreases with sensitivity (accept smaller colonies)
    const newMinArea = clamp(parseFloat((5 - s * 0.4).toFixed(1)), 0, 10);

    setBlurSize(newBlur);
    setMorphSize(newMorph);
    setMinArea(newMinArea);

    if (thresholdMode === "adaptive-mean" || thresholdMode === "adaptive-gaussian") {
      // Block size range: min shrinks with sensitivity; max = min + 12 (odd)
      const blkMin = ensureOdd(clamp(41 - Math.round(s * 3), 11, 81));
      let blkMax = ensureOdd(clamp(blkMin + 12, blkMin, 101));
      if (blkMax < blkMin) blkMax = blkMin;
      // C offset: +4 -> -10 as sensitivity increases (lower threshold)
      const newC = clamp(Math.round(4 - s * 1.4), -20, 20);
      setAdaptiveBlockMin(blkMin);
      setAdaptiveBlockMax(blkMax);
      setAdaptiveC(newC);
    } else if (thresholdMode === "fixed") {
      // Fixed threshold: 170 -> 110 as sensitivity increases (tend to include more detail)
      const newT = clamp(170 - s * 6, 1, 255);
      setFixedThresh(newT);
    }

    if (useWatershed && dtThreshMode === "alpha") {
      // Split strength in 0..1 as sensitivity increases
      const newSplit = clamp(s / 10, 0, 1);
      setSplitStrength(newSplit);
    }
  };

  // Debounce processing on changes
  useEffect(() => {
    if (!selectedUrl) return;
    const id = setTimeout(() => {
      void processImage();
    }, 120);
    return () => clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUrl, isReady, minArea, effectiveRadiusPct, blurSize, morphSize, invertMask, thresholdMode, adaptiveBlockMin, adaptiveBlockMax, adaptiveC, fixedThresh, useWatershed, splitStrength, useColorConsistency, colorTolerance, distType, distMask, dtThreshMode, dtThreshAbs, peakCleanupSize, wsMarkerMode, erodeKernelSize, erodeIterations]);

  // Revoke object URL
  useEffect(() => {
    return () => {
      if (selectedUrl) URL.revokeObjectURL(selectedUrl);
    };
  }, [selectedUrl]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (selectedUrl) URL.revokeObjectURL(selectedUrl);
    const url = URL.createObjectURL(file);
    setSelectedUrl(url);
    setColonyCount(null);
  };

  const autoTune = async () => {
    if (!isReady || !previewRef.current) return;
    const cv = window.cv;
    const img = previewRef.current;
    const src = cv.imread(img);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

    // Build HSV once for color filter
    const rgbFull = new cv.Mat();
    cv.cvtColor(src, rgbFull, cv.COLOR_RGBA2RGB);
    const hsvFull = new cv.Mat();
    cv.cvtColor(rgbFull, hsvFull, cv.COLOR_RGB2HSV);

    // Restrict auto-tune to only binarization sensitivity.
    // Keep current blur/morph settings and do not explore watershed or color filters.
    const tryBlurSizes = [Math.max(1, blurSize | 1)];
    const tryMorphSizes = [Math.max(1, morphSize | 1)];
    const invertChoices = [true, false];
    const considerWatershed = false;
    const considerColorConsistency = false;

    // Try multiple binarization strategies
    type Candidate = { count: number; blur: number; morph: number; inv: boolean; mode: ThresholdMode; blk?: number; C?: number; fixed?: number };
    let best: Candidate = { count: -1, blur: blurSize, morph: morphSize, inv: invertMask, mode: thresholdMode, blk: adaptiveBlockMin, C: adaptiveC, fixed: fixedThresh };

    try {
      for (const b of tryBlurSizes) {
        const blurred = new cv.Mat();
        cv.GaussianBlur(gray, blurred, new cv.Size(b, b), 0, 0, cv.BORDER_DEFAULT);

        // Detect dish
        const edges = new cv.Mat();
        cv.Canny(blurred, edges, 50, 150);
        const plateContours = new cv.MatVector();
        const plateHierarchy = new cv.Mat();
        cv.findContours(edges, plateContours, plateHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        let dishCx = Math.floor(src.cols / 2);
        let dishCy = Math.floor(src.rows / 2);
        let dishR = Math.floor(Math.min(src.cols, src.rows) / 2);
        let maxRectArea = 0;
        for (let i = 0; i < plateContours.size(); i++) {
          const cnt = plateContours.get(i);
          const rect = cv.boundingRect(cnt);
          const areaRect = rect.width * rect.height;
          if (areaRect > maxRectArea) {
            maxRectArea = areaRect;
            dishCx = rect.x + Math.round(rect.width / 2);
            dishCy = rect.y + Math.round(rect.height / 2);
            dishR = Math.round(Math.max(rect.width, rect.height) / 2);
          }
          cnt.delete();
        }
        plateContours.delete();
        plateHierarchy.delete();
        edges.delete();

        const mask = cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC1);
        cv.circle(mask, { x: dishCx, y: dishCy }, dishR, new cv.Scalar(255), -1);

        // Prepare base grayscale masked
        const maskedGray = new cv.Mat();
        cv.bitwise_and(blurred, blurred, maskedGray, mask);

        // ROI centered on dish
        const roiSize = Math.min(src.cols, src.rows, Math.round(dishR * 2 * 1.05));
        const roiX = Math.max(0, Math.round(dishCx - roiSize / 2));
        const roiY = Math.max(0, Math.round(dishCy - roiSize / 2));
        const roiW = Math.min(roiSize, src.cols - roiX);
        const roiH = Math.min(roiSize, src.rows - roiY);
        const roiRect = new cv.Rect(roiX, roiY, roiW, roiH);
        const maskedRoi = maskedGray.roi(roiRect);

        // Effective area threshold (px) from UI scale
        const minAreaPx = Math.max(1, Math.round(5 + minArea * minArea * 15));

        // Search over methods
        const modes: Array<{ mode: ThresholdMode; blocks?: number[]; Cs?: number[]; fixedTs?: number[] }> = [
          { mode: "otsu" },
          { mode: "adaptive-mean", blocks: [11, 17, 23], Cs: [-10, -8, -6, -4, -2, 0, 2] },
          { mode: "adaptive-gaussian", blocks: [11, 17, 23], Cs: [-10, -8, -6, -4, -2, 0, 2] },
          { mode: "fixed", fixedTs: [40, 60, 80, 100, 120, 140, 160, 180] },
        ];

        for (const mSpec of modes) {
          const buildBinary = () => {
            const local = new cv.Mat();
            if (mSpec.mode === "otsu") {
              cv.threshold(maskedRoi, local, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
            } else if (mSpec.mode === "fixed") {
              const t = (mSpec.fixedTs ?? [120])[0];
              cv.threshold(maskedRoi, local, t, 255, cv.THRESH_BINARY);
            }
            return local;
          };

          if (mSpec.mode === "otsu" || mSpec.mode === "fixed") {
            const fixedUsed = (mSpec.fixedTs ?? [120])[0];
            const thresh = buildBinary();
            for (const inv of invertChoices) {
              const bin = new cv.Mat();
                if (inv) {
                cv.threshold(thresh, bin, 0, 255, cv.THRESH_BINARY_INV);
              } else {
                cv.bitwise_and(thresh, thresh, bin);
                }
                for (const m of tryMorphSizes) {
                  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(m, m));
                  const opened = new cv.Mat();
                  cv.morphologyEx(bin, opened, cv.MORPH_OPEN, kernel);

                  // Count on opened
                  let bestLocal = (() => {
                    const innerMask = cv.Mat.zeros(opened.rows, opened.cols, cv.CV_8UC1);
                    const effR = Math.round((dishR * effectiveRadiusPct) / 100);
                    const innerCx = Math.round(Math.min(Math.max(0, dishCx - roiX), innerMask.cols));
                    const innerCy = Math.round(Math.min(Math.max(0, dishCy - roiY), innerMask.rows));
                    cv.circle(innerMask, { x: innerCx, y: innerCy }, effR, new cv.Scalar(255), -1);
                    const maskedInner = new cv.Mat();
                    cv.bitwise_and(opened, opened, maskedInner, innerMask);
                    const labels = new cv.Mat();
                    const stats = new cv.Mat();
                    const cents = new cv.Mat();
                    const n = cv.connectedComponentsWithStats(maskedInner, labels, stats, cents, 8, cv.CV_32S);
                    let countedLocal = 0;
                     for (let i = 1; i < n; i++) {
                       const area = stats.intPtr(i, 4)[0];
                       if (area < minAreaPx) continue;
                      countedLocal++;
                    }
                    labels.delete();
                    stats.delete();
                    cents.delete();
                    maskedInner.delete();
                    innerMask.delete();
                    return countedLocal;
                  })();

                  // Optional watershed (disabled in auto-tune restriction)
                  if (considerWatershed && useWatershed) {
                  const dist = new cv.Mat();
                  cv.distanceTransform(opened, dist, cvDistConst(cv, distType), distMask);
                  const distNorm = new cv.Mat();
                  cv.normalize(dist, distNorm, 0, 1.0, cv.NORM_MINMAX);
                  const dist8u = new cv.Mat(distNorm.rows, distNorm.cols, cv.CV_8UC1);
                  for (let y = 0; y < distNorm.rows; y++) {
                    for (let x = 0; x < distNorm.cols; x++) {
                      const v = distNorm.floatPtr(y, x)[0];
                      dist8u.ucharPtr(y, x)[0] = Math.max(0, Math.min(255, Math.round(v * 255)));
                    }
                  }
                  // Regional maxima: peaks where dist8u == dilate(dist8u)
                  const dilK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
                  const dilated = new cv.Mat();
                  cv.dilate(dist8u, dilated, dilK);
                  const diff = new cv.Mat();
                  cv.absdiff(dist8u, dilated, diff);
                  const peaks = new cv.Mat();
                  cv.threshold(diff, peaks, 0, 255, cv.THRESH_BINARY_INV);
                  // Threshold on distance (gentler for auto-tune)
                  const alpha = 0.01 + splitStrength * 0.25;
                  const t255 = dtThreshMode === "absolute" ? dtThreshAbs : Math.max(0, Math.min(255, Math.round(alpha * 255)));
                  const fg = new cv.Mat();
                  cv.threshold(dist8u, fg, t255, 255, cv.THRESH_BINARY);
                  cv.bitwise_and(peaks, fg, peaks);
                  // No cleanup in auto-tune to maximize recall
                  const peaksClean = peaks.clone();
                  const markers = new cv.Mat();
                  cv.connectedComponentsWithStats(peaksClean, markers, new cv.Mat(), new cv.Mat(), 8, cv.CV_32S);
                  const rgb = new cv.Mat();
                  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
                  cv.watershed(rgb, markers);
                  rgb.delete();
                  const separated = new cv.Mat(markers.rows, markers.cols, cv.CV_8UC1);
                  for (let y = 0; y < markers.rows; y++) {
                    for (let x = 0; x < markers.cols; x++) {
                      const label = markers.intPtr(y, x)[0];
                      separated.ucharPtr(y, x)[0] = label > 1 ? 255 : 0;
                    }
                  }
                  // Count on separated (watershed)
                  const wsCount = (() => {
                    const innerMaskWs = cv.Mat.zeros(separated.rows, separated.cols, cv.CV_8UC1);
                    const effRws = Math.round((dishR * effectiveRadiusPct) / 100);
                    const innerCxWs = Math.round(Math.min(Math.max(0, dishCx - roiX), innerMaskWs.cols));
                    const innerCyWs = Math.round(Math.min(Math.max(0, dishCy - roiY), innerMaskWs.rows));
                    cv.circle(innerMaskWs, { x: innerCxWs, y: innerCyWs }, effRws, new cv.Scalar(255), -1);
                    const maskedInnerWs = new cv.Mat();
                    cv.bitwise_and(separated, separated, maskedInnerWs, innerMaskWs);
                    const labelsWs = new cv.Mat();
                    const statsWs = new cv.Mat();
                    const centsWs = new cv.Mat();
                    const nWs = cv.connectedComponentsWithStats(maskedInnerWs, labelsWs, statsWs, centsWs, 8, cv.CV_32S);
                    let countedLocalWs = 0;
                     for (let i = 1; i < nWs; i++) {
                       const area = statsWs.intPtr(i, 4)[0];
                       if (area < minAreaPx) continue;
                      countedLocalWs++;
                    }
                    labelsWs.delete();
                    statsWs.delete();
                    centsWs.delete();
                    maskedInnerWs.delete();
                    innerMaskWs.delete();
                    return countedLocalWs;
                  })();
                  if (wsCount > bestLocal) bestLocal = wsCount;
                  dist.delete();
                  distNorm.delete();
                  dist8u.delete();
                  dilK.delete();
                  dilated.delete();
                  diff.delete();
                  peaks.delete();
                  peaksClean.delete();
                  markers.delete();
                }

                // Evaluate inside inner circle
                  const innerMask = cv.Mat.zeros(opened.rows, opened.cols, cv.CV_8UC1);
                  const effR = Math.round((dishR * effectiveRadiusPct) / 100);
                const innerCx = Math.round(Math.min(Math.max(0, dishCx - roiX), innerMask.cols));
                const innerCy = Math.round(Math.min(Math.max(0, dishCy - roiY), innerMask.rows));
                  cv.circle(innerMask, { x: innerCx, y: innerCy }, effR, new cv.Scalar(255), -1);
                  const maskedInner = new cv.Mat();
                  cv.bitwise_and(opened, opened, maskedInner, innerMask);
                  const labels = new cv.Mat();
                  const stats = new cv.Mat();
                  const cents = new cv.Mat();
                  const n = cv.connectedComponentsWithStats(maskedInner, labels, stats, cents, 8, cv.CV_32S);
                // Raw count by area
                const idxs: number[] = [];
                  for (let i = 1; i < n; i++) {
                    const area = stats.intPtr(i, 4)[0];
                    if (area < minAreaPx) continue;
                  idxs.push(i);
                }
                let counted = idxs.length;
                // Optional color consistency disabled during auto-tune restriction
                if (considerColorConsistency && useColorConsistency && counted > 1) {
                  const hues: number[] = [];
                  for (const i of idxs) {
                    const cx0 = Math.round(cents.doublePtr(i, 0)[0]);
                    const cy0 = Math.round(cents.doublePtr(i, 1)[0]);
                    const gx = clamp(roiX + cx0, 0, hsvFull.cols - 1);
                    const gy = clamp(roiY + cy0, 0, hsvFull.rows - 1);
                    const h = hsvFull.ucharPtr(gy, gx)[0];
                    hues.push(h);
                  }
                  // circular mean
                  let sumX = 0, sumY = 0;
                  for (const h of hues) {
                    const th = (h / 180) * 2 * Math.PI;
                    sumX += Math.cos(th);
                    sumY += Math.sin(th);
                  }
                  let meanTheta = Math.atan2(sumY, sumX);
                  if (meanTheta < 0) meanTheta += 2 * Math.PI;
                  const hueCenter = Math.round((meanTheta / (2 * Math.PI)) * 180) % 180;
                  const tolHue = Math.round(10 + 60 * colorTolerance); // 10..70 deg
                  counted = hues.filter((h) => circularHueDist(h, hueCenter) <= tolHue).length;
                }
                if (counted > best.count) best = { count: counted, blur: b, morph: m, inv, mode: mSpec.mode, fixed: mSpec.mode === "fixed" ? fixedUsed : undefined };
                  kernel.delete();
                  opened.delete();
                  innerMask.delete();
                  maskedInner.delete();
                  labels.delete();
                  stats.delete();
                  cents.delete();
                }
                bin.delete();
                }
                thresh.delete();
            } else {
              // adaptive mean / gaussian
              const blocks = mSpec.blocks ?? [17];
              const Cs = mSpec.Cs ?? [-4];
              for (const blk of blocks) {
                const block = Math.max(3, blk | 1);
                for (const C of Cs) {
                  const thresh = new cv.Mat();
                  const method = mSpec.mode === "adaptive-mean" ? cv.ADAPTIVE_THRESH_MEAN_C : cv.ADAPTIVE_THRESH_GAUSSIAN_C;
                  cv.adaptiveThreshold(maskedRoi, thresh, 255, method, cv.THRESH_BINARY, block, C);
                  for (const inv of invertChoices) {
                    const bin = new cv.Mat();
                    if (inv) {
                      cv.threshold(thresh, bin, 0, 255, cv.THRESH_BINARY_INV);
                    } else {
                      cv.bitwise_and(thresh, thresh, bin);
                    }
                    for (const m of tryMorphSizes) {
                      const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(m, m));
                      const opened = new cv.Mat();
                      cv.morphologyEx(bin, opened, cv.MORPH_OPEN, kernel);

                      // Count on opened
                      let bestLocal = (() => {
                        const innerMask = cv.Mat.zeros(opened.rows, opened.cols, cv.CV_8UC1);
                        const effR = Math.round((dishR * effectiveRadiusPct) / 100);
                        const innerCx = Math.round(Math.min(Math.max(0, dishCx - roiX), innerMask.cols));
                        const innerCy = Math.round(Math.min(Math.max(0, dishCy - roiY), innerMask.rows));
                        cv.circle(innerMask, { x: innerCx, y: innerCy }, effR, new cv.Scalar(255), -1);
                        const maskedInner = new cv.Mat();
                        cv.bitwise_and(opened, opened, maskedInner, innerMask);
                        const labels = new cv.Mat();
                        const stats = new cv.Mat();
                        const cents = new cv.Mat();
                        const n = cv.connectedComponentsWithStats(maskedInner, labels, stats, cents, 8, cv.CV_32S);
                        let countedLocal = 0;
                        for (let i = 1; i < n; i++) {
                          const area = stats.intPtr(i, 4)[0];
                          if (area < minArea) continue;
                          countedLocal++;
                        }
                        labels.delete();
                        stats.delete();
                        cents.delete();
                        maskedInner.delete();
                        innerMask.delete();
                        return countedLocal;
                      })();

                      // Optional watershed (disabled in auto-tune restriction)
                      if (considerWatershed && useWatershed) {
                        const dist = new cv.Mat();
                        cv.distanceTransform(opened, dist, cvDistConst(cv, distType), distMask);
                        const distNorm = new cv.Mat();
                        cv.normalize(dist, distNorm, 0, 1.0, cv.NORM_MINMAX);
                        const dist8u = new cv.Mat(distNorm.rows, distNorm.cols, cv.CV_8UC1);
                        for (let y = 0; y < distNorm.rows; y++) {
                          for (let x = 0; x < distNorm.cols; x++) {
                            const v = distNorm.floatPtr(y, x)[0];
                            dist8u.ucharPtr(y, x)[0] = Math.max(0, Math.min(255, Math.round(v * 255)));
                          }
                        }
                        // Regional maxima
                        const dilK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
                        const dilated = new cv.Mat();
                        cv.dilate(dist8u, dilated, dilK);
                        const diff = new cv.Mat();
                        cv.absdiff(dist8u, dilated, diff);
                        const peaks = new cv.Mat();
                        cv.threshold(diff, peaks, 0, 255, cv.THRESH_BINARY_INV);
                        const alpha = 0.01 + splitStrength * 0.25;
                        const t255 = dtThreshMode === "absolute" ? dtThreshAbs : Math.max(0, Math.min(255, Math.round(alpha * 255)));
                        const fg = new cv.Mat();
                        cv.threshold(dist8u, fg, t255, 255, cv.THRESH_BINARY);
                        cv.bitwise_and(peaks, fg, peaks);
                        const peaksClean = peaks.clone();
                        const markers = new cv.Mat();
                        cv.connectedComponentsWithStats(peaksClean, markers, new cv.Mat(), new cv.Mat(), 8, cv.CV_32S);
                        const rgb = new cv.Mat();
                        cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
                        cv.watershed(rgb, markers);
                        rgb.delete();
                        const separated = new cv.Mat(markers.rows, markers.cols, cv.CV_8UC1);
                        for (let y = 0; y < markers.rows; y++) {
                          for (let x = 0; x < markers.cols; x++) {
                            const label = markers.intPtr(y, x)[0];
                            separated.ucharPtr(y, x)[0] = label > 1 ? 255 : 0;
                          }
                        }
                        const wsCount = (() => {
                          const innerMaskWs = cv.Mat.zeros(separated.rows, separated.cols, cv.CV_8UC1);
                          const effRws = Math.round((dishR * effectiveRadiusPct) / 100);
                          const innerCxWs = Math.round(Math.min(Math.max(0, dishCx - roiX), innerMaskWs.cols));
                          const innerCyWs = Math.round(Math.min(Math.max(0, dishCy - roiY), innerMaskWs.rows));
                          cv.circle(innerMaskWs, { x: innerCxWs, y: innerCyWs }, effRws, new cv.Scalar(255), -1);
                          const maskedInnerWs = new cv.Mat();
                          cv.bitwise_and(separated, separated, maskedInnerWs, innerMaskWs);
                          const labelsWs = new cv.Mat();
                          const statsWs = new cv.Mat();
                          const centsWs = new cv.Mat();
                          const nWs = cv.connectedComponentsWithStats(maskedInnerWs, labelsWs, statsWs, centsWs, 8, cv.CV_32S);
                          let countedLocalWs = 0;
                         for (let i = 1; i < nWs; i++) {
                            const area = statsWs.intPtr(i, 4)[0];
                            if (area < minAreaPx) continue;
                            countedLocalWs++;
                          }
                          labelsWs.delete();
                          statsWs.delete();
                          centsWs.delete();
                          maskedInnerWs.delete();
                          innerMaskWs.delete();
                          return countedLocalWs;
                        })();
                        if (wsCount > bestLocal) bestLocal = wsCount;
                        dist.delete();
                        distNorm.delete();
                        dist8u.delete();
                        dilK.delete();
                        dilated.delete();
                        diff.delete();
                        peaks.delete();
                        peaksClean.delete();
                        markers.delete();
                      }

                      const innerMask = cv.Mat.zeros(opened.rows, opened.cols, cv.CV_8UC1);
        const effR = Math.round((dishR * effectiveRadiusPct) / 100);
                    const innerCx = Math.round(Math.min(Math.max(0, dishCx - roiX), innerMask.cols));
                    const innerCy = Math.round(Math.min(Math.max(0, dishCy - roiY), innerMask.rows));
        cv.circle(innerMask, { x: innerCx, y: innerCy }, effR, new cv.Scalar(255), -1);
                    const maskedInner = new cv.Mat();
                    cv.bitwise_and(opened, opened, maskedInner, innerMask);
                    const labels = new cv.Mat();
                    const stats = new cv.Mat();
                    const cents = new cv.Mat();
                    const n = cv.connectedComponentsWithStats(maskedInner, labels, stats, cents, 8, cv.CV_32S);

                    const idxs: number[] = [];
                    for (let i = 1; i < n; i++) {
                      const area = stats.intPtr(i, 4)[0];
                      if (area < minAreaPx) continue;
                      idxs.push(i);
                    }
                    let counted = idxs.length;
                        if (considerColorConsistency && useColorConsistency && counted > 1) {
        const hues: number[] = [];
                      for (const i of idxs) {
                        const cx0 = Math.round(cents.doublePtr(i, 0)[0]);
                        const cy0 = Math.round(cents.doublePtr(i, 1)[0]);
                        const gx = clamp(roiX + cx0, 0, hsvFull.cols - 1);
                        const gy = clamp(roiY + cy0, 0, hsvFull.rows - 1);
                        const h = hsvFull.ucharPtr(gy, gx)[0];
            hues.push(h);
                      }
                      let sumX = 0, sumY = 0;
          for (const h of hues) {
                        const th = (h / 180) * 2 * Math.PI;
                        sumX += Math.cos(th);
                        sumY += Math.sin(th);
          }
          let meanTheta = Math.atan2(sumY, sumX);
          if (meanTheta < 0) meanTheta += 2 * Math.PI;
          const hueCenter = Math.round((meanTheta / (2 * Math.PI)) * 180) % 180;
                      const tolHue = Math.round(10 + 60 * colorTolerance);
                      counted = hues.filter((h) => circularHueDist(h, hueCenter) <= tolHue).length;
                    }
                        if (counted > best.count) best = { count: counted, blur: b, morph: m, inv, mode: mSpec.mode, blk: block, C };
                    kernel.delete();
                    opened.delete();
        innerMask.delete();
                    maskedInner.delete();
                    labels.delete();
                    stats.delete();
                    cents.delete();
                  }
                  bin.delete();
                }
                thresh.delete();
              }
            }
          }
          }

          // Apply best binarization settings back to UI state
          setInvertMask(best.inv);
          setThresholdMode(best.mode);
          if (best.mode === "adaptive-mean" || best.mode === "adaptive-gaussian") {
            if (typeof best.blk === "number") {
              setAdaptiveBlockMin(Math.max(3, best.blk | 1));
              setAdaptiveBlockMax(Math.max(3, (best.blk + 12) | 1));
            }
            if (typeof best.C === "number") setAdaptiveC(best.C);
          } else if (best.mode === "fixed") {
            if (typeof best.fixed === "number") setFixedThresh(best.fixed);
          }

          maskedRoi.delete();
          maskedGray.delete();
          blurred.delete();
          mask.delete();
        }
    } finally {
      src.delete();
      gray.delete();
      // cleanup color mats
      rgbFull.delete?.();
      hsvFull.delete?.();
      void processImage();
    }
  };

  const processImage = async () => {
    if (!isReady) return;
    const imgEl = previewRef.current;
    const canvasEl = canvasRef.current;
    if (!imgEl || !canvasEl) return;

    try {
      const cv = window.cv;
      const src = cv.imread(imgEl);
      const gray = new cv.Mat();
      const blurred = new cv.Mat();
      const thresh = new cv.Mat();

      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
      const kBlur = Math.max(1, blurSize | 1);
      cv.GaussianBlur(gray, blurred, new cv.Size(kBlur, kBlur), 0, 0, cv.BORDER_DEFAULT);

      // Detect largest dish
      const edges = new cv.Mat();
      cv.Canny(blurred, edges, 50, 150);
      const plateContours = new cv.MatVector();
      const plateHierarchy = new cv.Mat();
      cv.findContours(edges, plateContours, plateHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      let dishCx = Math.floor(src.cols / 2);
      let dishCy = Math.floor(src.rows / 2);
      let dishR = Math.floor(Math.min(src.cols, src.rows) / 2);
      let maxRectArea = 0;
      for (let i = 0; i < plateContours.size(); i++) {
        const cnt = plateContours.get(i);
        const rect = cv.boundingRect(cnt);
        const areaRect = rect.width * rect.height;
        if (areaRect > maxRectArea) {
          maxRectArea = areaRect;
          dishCx = rect.x + Math.round(rect.width / 2);
          dishCy = rect.y + Math.round(rect.height / 2);
          dishR = Math.round(Math.max(rect.width, rect.height) / 2);
        }
        cnt.delete();
      }
      plateContours.delete();
      plateHierarchy.delete();
      edges.delete();

      const mask = cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC1);
      cv.circle(mask, { x: dishCx, y: dishCy }, dishR, new cv.Scalar(255), -1);
      const maskedGray = new cv.Mat();
      cv.bitwise_and(blurred, blurred, maskedGray, mask);

      // ROI centered on dish
      const roiSize = Math.min(src.cols, src.rows, Math.round(dishR * 2 * 1.05));
      const roiX = Math.max(0, Math.round(dishCx - roiSize / 2));
      const roiY = Math.max(0, Math.round(dishCy - roiSize / 2));
      const roiW = Math.min(roiSize, src.cols - roiX);
      const roiH = Math.min(roiSize, src.rows - roiY);
      const roiRect = new cv.Rect(roiX, roiY, roiW, roiH);

      // Threshold by selected mode
      if (thresholdMode === "otsu") {
        cv.threshold(maskedGray, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      } else if (thresholdMode === "fixed") {
        cv.threshold(maskedGray, thresh, fixedThresh, 255, cv.THRESH_BINARY);
      } else {
        const method = thresholdMode === "adaptive-mean" ? cv.ADAPTIVE_THRESH_MEAN_C : cv.ADAPTIVE_THRESH_GAUSSIAN_C;
        const blkMin = Math.max(3, adaptiveBlockMin | 1);
        const blkMax = Math.max(blkMin, adaptiveBlockMax | 1);
        const tMin = new cv.Mat();
        const tMax = new cv.Mat();
        cv.adaptiveThreshold(maskedGray, tMin, 255, method, cv.THRESH_BINARY, blkMin, adaptiveC);
        cv.adaptiveThreshold(maskedGray, tMax, 255, method, cv.THRESH_BINARY, blkMax, adaptiveC);
        cv.bitwise_and(tMin, tMax, thresh);
        tMin.delete();
        tMax.delete();
      }

      let bin = thresh as unknown as typeof thresh;
      let binOwned = false;
      if (invertMask) {
        const inv = new cv.Mat();
        cv.threshold(thresh, inv, 0, 255, cv.THRESH_BINARY_INV);
        bin = inv;
        binOwned = true;
      }

      const kMorph = Math.max(1, morphSize | 1);
      const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kMorph, kMorph));
      const opened = new cv.Mat();
      cv.morphologyEx(bin, opened, cv.MORPH_OPEN, kernel);

      // Optional watershed for splitting touching colonies
      let toLabel = opened;
      let owned = false;
      if (useWatershed) {
        let markers: ReturnType<typeof cv.imread> | null = null;
        if (wsMarkerMode === "erode") {
          // Erosion-based seed extraction
          const kSize = ensureOdd(clamp(erodeKernelSize, 1, 31));
          const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kSize, kSize));
          const iters = clamp(erodeIterations, 1, 10);
          let seed = opened.clone();
          for (let t = 0; t < iters; t++) {
            const next = new cv.Mat();
            cv.erode(seed, next, k);
            seed.delete();
            seed = next;
          }
          k.delete();
          // optional cleanup with small opening to break thin bridges
          const clean = new cv.Mat();
          const smallK = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
          cv.morphologyEx(seed, clean, cv.MORPH_OPEN, smallK);
          smallK.delete();
          markers = new cv.Mat();
          cv.connectedComponentsWithStats(clean, markers, new cv.Mat(), new cv.Mat(), 8, cv.CV_32S);
          seed.delete();
          clean.delete();
        } else if (wsMarkerMode === "dt") {
          // Distance-transform based seeds (existing path)
          const dist = new cv.Mat();
          cv.distanceTransform(opened, dist, cvDistConst(cv, distType), distMask);
          const distNorm = new cv.Mat();
          cv.normalize(dist, distNorm, 0, 1.0, cv.NORM_MINMAX);
          const dist8u = new cv.Mat(distNorm.rows, distNorm.cols, cv.CV_8UC1);
          for (let y = 0; y < distNorm.rows; y++) {
            for (let x = 0; x < distNorm.cols; x++) {
              const v = distNorm.floatPtr(y, x)[0];
              dist8u.ucharPtr(y, x)[0] = Math.max(0, Math.min(255, Math.round(v * 255)));
            }
          }
          const dilK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
          const dilated = new cv.Mat();
          cv.dilate(dist8u, dilated, dilK);
          const diff = new cv.Mat();
          cv.absdiff(dist8u, dilated, diff);
          const peaks = new cv.Mat();
          cv.threshold(diff, peaks, 0, 255, cv.THRESH_BINARY_INV);
          const pkSize = ensureOdd(clamp(peakCleanupSize, 1, 7));
          let peaksClean = new cv.Mat();
          if (dtThreshMode === "absolute") {
            const t255 = clamp(dtThreshAbs, 0, 255);
            const fg = new cv.Mat();
            cv.threshold(dist8u, fg, t255, 255, cv.THRESH_BINARY);
            cv.bitwise_and(peaks, fg, peaks);
            if (pkSize >= 3) {
              const pkK = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(pkSize, pkSize));
              cv.morphologyEx(peaks, peaksClean, cv.MORPH_OPEN, pkK);
              pkK.delete();
            } else {
              peaksClean = peaks.clone();
            }
            fg.delete();
          } else {
            // Relative mode: per-component dynamic threshold on distance maxima
            const labelsOpen = new cv.Mat();
            const statsOpen = new cv.Mat();
            const centsOpen = new cv.Mat();
            const numOpenLabels = cv.connectedComponentsWithStats(opened, labelsOpen, statsOpen, centsOpen, 8, cv.CV_32S);
            const compMax: number[] = new Array(Math.max(1, numOpenLabels)).fill(0);
            for (let y = 0; y < opened.rows; y++) {
              for (let x = 0; x < opened.cols; x++) {
                if (opened.ucharPtr(y, x)[0] === 0) continue;
                const l = labelsOpen.intPtr(y, x)[0];
                const d = dist.floatPtr(y, x)[0];
                if (d > compMax[l]) compMax[l] = d;
              }
            }
            const alphaRel = 0.2 + splitStrength * 0.5; // 0.2..0.7 of per-blob max
            const refined = peaks.clone();
            for (let y = 0; y < refined.rows; y++) {
              for (let x = 0; x < refined.cols; x++) {
                if (refined.ucharPtr(y, x)[0] === 0) continue;
                const l = labelsOpen.intPtr(y, x)[0];
                if (l <= 0) { refined.ucharPtr(y, x)[0] = 0; continue; }
                const d = dist.floatPtr(y, x)[0];
                const t = compMax[l] * alphaRel;
                if (d < t) refined.ucharPtr(y, x)[0] = 0;
              }
            }
            if (pkSize >= 3) {
              const pkK = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(pkSize, pkSize));
              cv.morphologyEx(refined, peaksClean, cv.MORPH_OPEN, pkK);
              pkK.delete();
            } else {
              peaksClean = refined.clone();
            }
            refined.delete();
            labelsOpen.delete();
            statsOpen.delete();
            centsOpen.delete();
          }
          markers = new cv.Mat();
          cv.connectedComponentsWithStats(peaksClean, markers, new cv.Mat(), new cv.Mat(), 8, cv.CV_32S);
          dist.delete();
          distNorm.delete();
          dist8u.delete();
          dilK.delete();
          dilated.delete();
          diff.delete();
          peaks.delete();
          peaksClean.delete();
        } else {
          // Hybrid: union of erosion-seeds and DT-seeds
          // Erode path
          const kSize = ensureOdd(clamp(erodeKernelSize, 1, 31));
          const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kSize, kSize));
          const iters = clamp(erodeIterations, 1, 10);
          let seed = opened.clone();
          for (let t = 0; t < iters; t++) {
            const next = new cv.Mat();
            cv.erode(seed, next, k);
            seed.delete();
            seed = next;
          }
          const cleanE = new cv.Mat();
          const smallK = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
          cv.morphologyEx(seed, cleanE, cv.MORPH_OPEN, smallK);
          smallK.delete();
          k.delete();
          seed.delete();

          // DT path (reuse the DT recipe above, absolute mode for stability)
          const dist = new cv.Mat();
          cv.distanceTransform(opened, dist, cvDistConst(cv, distType), distMask);
          const distNorm = new cv.Mat();
          cv.normalize(dist, distNorm, 0, 1.0, cv.NORM_MINMAX);
          const dist8u = new cv.Mat(distNorm.rows, distNorm.cols, cv.CV_8UC1);
          for (let y = 0; y < distNorm.rows; y++) {
            for (let x = 0; x < distNorm.cols; x++) {
              const v = distNorm.floatPtr(y, x)[0];
              dist8u.ucharPtr(y, x)[0] = Math.max(0, Math.min(255, Math.round(v * 255)));
            }
          }
          const dilK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
          const dilated = new cv.Mat();
          cv.dilate(dist8u, dilated, dilK);
          const diff = new cv.Mat();
          cv.absdiff(dist8u, dilated, diff);
          const peaks = new cv.Mat();
          cv.threshold(diff, peaks, 0, 255, cv.THRESH_BINARY_INV);
          const t255 = clamp(dtThreshAbs, 0, 255);
          const fg = new cv.Mat();
          cv.threshold(dist8u, fg, t255, 255, cv.THRESH_BINARY);
          cv.bitwise_and(peaks, fg, peaks);
          const pkSize = ensureOdd(clamp(peakCleanupSize, 1, 7));
          const cleanD = new cv.Mat();
          if (pkSize >= 3) {
            const pkK = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(pkSize, pkSize));
            cv.morphologyEx(peaks, cleanD, cv.MORPH_OPEN, pkK);
            pkK.delete();
          } else {
            peaks.copyTo(cleanD);
          }

          // Union seeds
          const union = new cv.Mat();
          cv.bitwise_or(cleanE, cleanD, union);
          cleanE.delete();
          cleanD.delete();
          fg.delete();
          peaks.delete();
          diff.delete();
          dilated.delete();
          dist8u.delete();
          distNorm.delete();
          dist.delete();

          markers = new cv.Mat();
          cv.connectedComponentsWithStats(union, markers, new cv.Mat(), new cv.Mat(), 8, cv.CV_32S);
          union.delete();
        }

        const rgb = new cv.Mat();
        cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
        cv.watershed(rgb, markers!);
        rgb.delete();
        const _markers = markers!;
        const separated = new cv.Mat(_markers.rows, _markers.cols, cv.CV_8UC1);
        for (let y = 0; y < _markers.rows; y++) {
          for (let x = 0; x < _markers.cols; x++) {
            const label = _markers.intPtr(y, x)[0];
            separated.ucharPtr(y, x)[0] = label > 1 ? 255 : 0;
          }
        }
        const separatedFg = new cv.Mat();
        cv.bitwise_and(separated, opened, separatedFg);
        toLabel = separatedFg;
        owned = true;
        _markers.delete();
        separated.delete();
      }

      // Count inside inner circle
      // Map UI minArea scale (0..10) to pixel area threshold
      const minAreaPx = Math.max(1, Math.round(5 + minArea * minArea * 15));
      const labels = new cv.Mat();
      const stats = new cv.Mat();
      const centroids = new cv.Mat();
      const toLabelRoi = toLabel.roi(roiRect);
      const innerMask = cv.Mat.zeros(toLabelRoi.rows, toLabelRoi.cols, cv.CV_8UC1);
      const effR = Math.round((dishR * effectiveRadiusPct) / 100);
      const innerCx = Math.round(Math.min(Math.max(0, dishCx - roiX), toLabelRoi.cols));
      const innerCy = Math.round(Math.min(Math.max(0, dishCy - roiY), toLabelRoi.rows));
      cv.circle(innerMask, { x: innerCx, y: innerCy }, effR, new cv.Scalar(255), -1);
        const toLabelInner = new cv.Mat();
        cv.bitwise_and(toLabelRoi, toLabelRoi, toLabelInner, innerMask);

        const numLabels: number = cv.connectedComponentsWithStats(toLabelInner, labels, stats, centroids, 8, cv.CV_32S);
      const idxs: number[] = [];
        for (let i = 1; i < numLabels; i++) {
          const area = stats.intPtr(i, 4)[0];
          if (area < minAreaPx) continue;
        idxs.push(i);
      }

      let acceptedIdxs = idxs;
      if (useColorConsistency && idxs.length > 1) {
        const rgbFull = new cv.Mat();
        cv.cvtColor(src, rgbFull, cv.COLOR_RGBA2RGB);
        const hsvFull = new cv.Mat();
        cv.cvtColor(rgbFull, hsvFull, cv.COLOR_RGB2HSV);
        const hues: number[] = [];
        for (const i of idxs) {
          const cx0 = Math.round(centroids.doublePtr(i, 0)[0]);
          const cy0 = Math.round(centroids.doublePtr(i, 1)[0]);
          const gx = clamp(roiX + cx0, 0, hsvFull.cols - 1);
          const gy = clamp(roiY + cy0, 0, hsvFull.rows - 1);
          const h = hsvFull.ucharPtr(gy, gx)[0];
          hues.push(h);
        }
        let sumX = 0, sumY = 0;
        for (const h of hues) {
          const th = (h / 180) * 2 * Math.PI;
          sumX += Math.cos(th);
          sumY += Math.sin(th);
        }
        let meanTheta = Math.atan2(sumY, sumX);
        if (meanTheta < 0) meanTheta += 2 * Math.PI;
        const hueCenter = Math.round((meanTheta / (2 * Math.PI)) * 180) % 180;
        const tolHue = Math.round(10 + 60 * colorTolerance);
        acceptedIdxs = idxs.filter((_, k) => circularHueDist(hues[k], hueCenter) <= tolHue);
        hsvFull.delete();
        rgbFull.delete();
      }

      setColonyCount(acceptedIdxs.length);

      // Draw contours efficiently: run findContours once on the inner mask and keep only accepted labels
      const markColor = new cv.Scalar(0, 255, 0, 255);
      const srcRoi = src.roi(roiRect);
      cv.circle(srcRoi, { x: innerCx, y: innerCy }, effR, new cv.Scalar(255, 128, 0), 2);

      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      // Contours on the binary inner mask that we actually count on
      cv.findContours(toLabelInner, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      // Build a quick lookup for accepted labels
      const accepted = new Set<number>(acceptedIdxs);

      // Draw only contours whose interior maps to an accepted label index
      for (let k = 0; k < contours.size(); k++) {
        const cnt = contours.get(k);
        const rect = cv.boundingRect(cnt);
        if (rect.width <= 0 || rect.height <= 0) continue;
        const sx = Math.min(toLabelRoi.cols - 1, Math.max(0, rect.x + Math.floor(rect.width / 2)));
        const sy = Math.min(toLabelRoi.rows - 1, Math.max(0, rect.y + Math.floor(rect.height / 2)));
        const labelAtCenter = labels.intPtr(sy + 0, sx + 0)[0];
        if (!accepted.has(labelAtCenter)) continue;
        cv.drawContours(srcRoi, contours, k, markColor, 2);
      }
      cv.imshow(canvasEl, srcRoi);
      hierarchy.delete();
      contours.delete();
      srcRoi.delete();

      src.delete();
      gray.delete();
      blurred.delete();
      thresh.delete();
      if (binOwned) (bin as unknown as { delete: () => void }).delete();
      opened.delete();
      labels.delete();
      stats.delete();
      centroids.delete();
      toLabelRoi.delete();
      innerMask.delete();
      toLabelInner.delete();
      kernel.delete();
      mask.delete();
      maskedGray.delete();
      if (owned) toLabel.delete();
    } finally {
    }
  };

  const downloadResult = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const a = document.createElement("a");
    a.download = "result.png";
    a.href = canvas.toDataURL("image/png");
    a.click();
  };

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden">
      <header className="h-14 border-b flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">菌落計數器</h1>
          {colonyCount !== null && (
            <span className="text-sm">總數：<b>{colonyCount}</b></span>
          )}
          {!isReady && <span className="text-sm text-gray-500">正在載入 OpenCV…</span>}
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
        <div className="flex items-center gap-3">
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileChange} />
          <button
            onClick={() => void autoTune()}
            disabled={!selectedUrl}
            className="px-3 py-1.5 rounded border disabled:opacity-50"
          >
            自動參數
          </button>
          <button
            onClick={downloadResult}
            disabled={!selectedUrl}
            className="px-3 py-1.5 rounded border disabled:opacity-50"
          >
            下載結果
          </button>
        </div>
      </header>

      <main className="flex-1 min-h-0 flex overflow-hidden">
        <aside className="w-[360px] max-w-[40vw] shrink-0 border-r p-4 overflow-auto">
          <div className="space-y-6">
            <div className="space-y-2">
              <p className="text-sm font-semibold">基本</p>
              <label className="text-sm block">最小面積（尺度）：{minArea.toFixed(1)}
                <input type="range" min={0} max={10} step={0.1} value={minArea} onChange={(e) => setMinArea(parseFloat(e.target.value))} className="w-full" />
              </label>
              <label className="text-sm block">有效半徑比例（%）：{effectiveRadiusPct}
                <input type="range" min={50} max={100} step={1} value={effectiveRadiusPct} onChange={(e) => setEffectiveRadiusPct(parseInt(e.target.value))} className="w-full" />
              </label>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-semibold">二值化</p>
              <label className="text-sm block">模式
                <select
                  className="border rounded px-2 py-1 ml-2"
                  value={thresholdMode}
                  onChange={(e) => setThresholdMode(e.target.value as ThresholdMode)}
                >
                  <option value="otsu">Otsu（自動）</option>
                  <option value="adaptive-mean">自適應（平均）</option>
                  <option value="adaptive-gaussian">自適應（高斯）</option>
                  <option value="fixed">固定閾值</option>
                </select>
              </label>
              {(thresholdMode === "adaptive-mean" || thresholdMode === "adaptive-gaussian") && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-sm block">區塊大小最小：{adaptiveBlockMin}
                      <input type="range" min={3} max={99} step={2} value={adaptiveBlockMin} onChange={(e) => setAdaptiveBlockMin(parseInt(e.target.value))} className="w-full" />
                    </label>
                    <label className="text-sm block">區塊大小最大：{adaptiveBlockMax}
                      <input type="range" min={adaptiveBlockMin} max={101} step={2} value={adaptiveBlockMax} onChange={(e) => setAdaptiveBlockMax(parseInt(e.target.value))} className="w-full" />
                    </label>
                  </div>
                  <label className="text-sm block">偏移 C：{adaptiveC}
                    <input type="range" min={-20} max={20} step={1} value={adaptiveC} onChange={(e) => setAdaptiveC(parseInt(e.target.value))} className="w-full" />
                  </label>
                </>
              )}
              {thresholdMode === "fixed" && (
                <label className="text-sm block">閾值：{fixedThresh}
                  <input type="range" min={1} max={255} step={1} value={fixedThresh} onChange={(e) => setFixedThresh(parseInt(e.target.value))} className="w-full" />
                </label>
              )}
              <label className="text-sm inline-flex items-center gap-2">
                <input type="checkbox" checked={invertMask} onChange={(e) => setInvertMask(e.target.checked)} />
                反轉遮罩（讓菌落為白）
              </label>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-semibold">靈敏度</p>
              <label className="text-sm block">靈敏度：{sensitivity}
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={sensitivity}
                  onChange={(e) => {
                    const v = parseInt(e.target.value);
                    setSensitivity(v);
                    applySensitivity(v);
                  }}
                  className="w-full"
                />
              </label>
              <p className="text-xs text-gray-500">此滑桿會同時調整模糊、形態學、最小面積；在自適應/固定模式下亦會調整區塊大小、C 或固定閾值；若開啟分水嶺，且閾值模式為相對，亦會調整分離強度。</p>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-semibold">分水嶺分割</p>
              <label className="text-sm inline-flex items-center gap-2">
                <input type="checkbox" checked={useWatershed} onChange={(e) => setUseWatershed(e.target.checked)} />
                分離黏連菌落（Watershed）
              </label>
              {useWatershed && (
                <>
                  <div className="space-y-1">
                    <p className="text-sm">種子策略</p>
                    <label className="text-sm inline-flex items-center gap-2 mr-3">
                      <input type="radio" name="wsmark" checked={wsMarkerMode === "erode"} onChange={() => setWsMarkerMode("erode")} /> 腐蝕種子（快）
                    </label>
                    <label className="text-sm inline-flex items-center gap-2">
                      <input type="radio" name="wsmark" checked={wsMarkerMode === "dt"} onChange={() => setWsMarkerMode("dt")} /> 距離變換種子（精細）
                    </label>
                  </div>
                  {wsMarkerMode === "erode" && (
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-sm block">腐蝕核大小（奇數）：{erodeKernelSize}
                        <input type="range" min={1} max={31} step={2} value={erodeKernelSize} onChange={(e) => setErodeKernelSize(parseInt(e.target.value))} className="w-full" />
                      </label>
                      <label className="text-sm block">腐蝕次數：{erodeIterations}
                        <input type="range" min={1} max={10} step={1} value={erodeIterations} onChange={(e) => setErodeIterations(parseInt(e.target.value))} className="w-full" />
                      </label>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-sm block">距離類型
                      <select className="border rounded px-2 py-1 w-full" value={distType} onChange={(e) => setDistType(e.target.value as DistType)}>
                        <option value="L1">L1（曼哈頓）</option>
                        <option value="L2">L2（歐幾里德）</option>
                        <option value="C">切比雪夫</option>
                      </select>
              </label>
                    <label className="text-sm block">遮罩大小
                      <select className="border rounded px-2 py-1 w-full" value={distMask} onChange={(e) => setDistMask(parseInt(e.target.value) as 3 | 5)}>
                        <option value={3}>3×3</option>
                        <option value={5}>5×5</option>
                      </select>
              </label>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm">DT 閾值模式</p>
                    <label className="text-sm inline-flex items-center gap-2 mr-3">
                      <input type="radio" name="dtmode" checked={dtThreshMode === "alpha"} onChange={() => setDtThreshMode("alpha")} /> 相對（強度）
              </label>
                    <label className="text-sm inline-flex items-center gap-2">
                      <input type="radio" name="dtmode" checked={dtThreshMode === "absolute"} onChange={() => setDtThreshMode("absolute")} /> 絕對（0–255）
              </label>
            </div>
                  {dtThreshMode === "alpha" ? (
                    <>
                      <label className="text-sm block">分離強度：{splitStrength.toFixed(1)}
                        <input type="range" min={0} max={1} step={0.1} value={splitStrength} onChange={(e) => setSplitStrength(parseFloat(e.target.value))} className="w-full" />
              </label>
                      <label className="text-xs inline-flex items-center gap-2">手填
                        <input type="number" min={0} max={1} step={0.05} value={splitStrength} onChange={(e) => setSplitStrength(clamp(parseFloat(e.target.value || "0") || 0, 0, 1))} className="w-24 border rounded px-1 py-0.5" />
              </label>
                    </>
                  ) : (
                    <label className="text-sm block">DT 閾值（0–255）：{dtThreshAbs}
                      <input type="range" min={0} max={255} step={1} value={dtThreshAbs} onChange={(e) => setDtThreshAbs(parseInt(e.target.value))} className="w-full" />
              </label>
                  )}
                  <label className="text-sm block">峰值清理核（1–7，奇數）：{peakCleanupSize}
                    <input type="range" min={1} max={7} step={2} value={peakCleanupSize} onChange={(e) => setPeakCleanupSize(parseInt(e.target.value))} className="w-full" />
                  </label>
                </>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-sm font-semibold">顏色一致性過濾</p>
              <label className="text-sm inline-flex items-center gap-2">
                <input type="checkbox" checked={useColorConsistency} onChange={(e) => setUseColorConsistency(e.target.checked)} />
                啟用（同色群保留，異色剔除）
              </label>
              {useColorConsistency && (
                <label className="text-sm block">容許度：{colorTolerance.toFixed(2)}
                  <input type="range" min={0} max={1} step={0.05} value={colorTolerance} onChange={(e) => setColorTolerance(parseFloat(e.target.value))} className="w-full" />
                </label>
              )}
              <p className="text-xs text-gray-500">依「色相」一致性過濾，藉由群體色相中心與容許角度（約 10°→70°）。</p>
            </div>
          </div>
        </aside>

        <section className="flex-1 min-w-0 min-h-0 p-2 overflow-hidden">
          <div className="w-full h-full grid grid-cols-2 grid-rows-1 gap-2">
            <div className="border rounded overflow-hidden flex flex-col">
              <div className="px-2 py-1 border-b text-xs font-medium">輸入</div>
              <div className="flex-1 min-h-0 media-box bg-[color:var(--background)]">
                {selectedUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    ref={previewRef}
                    src={selectedUrl}
                    alt="輸入影像"
                    className="w-auto h-auto max-w-full max-h-full object-contain"
                    onLoad={() => {
                      const img = previewRef.current;
                      const canvas = canvasRef.current;
                      if (img) {
                        const w = img.naturalWidth;
                        const h = img.naturalHeight;
                        if (canvas) { canvas.width = w; canvas.height = h; }
                      }
                    }}
                  />
                ) : (
                  <div className="text-sm text-gray-500">尚未選擇影像</div>
                )}
              </div>
            </div>

            <div className="border rounded overflow-hidden flex flex-col">
              <div className="px-2 py-1 border-b text-xs font-medium">最終結果</div>
              <div className="flex-1 min-h-0 media-box bg-[color:var(--background)]">
                <canvas ref={canvasRef} />
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
