"use client";

import { useEffect, useRef, useState } from "react";
import { useOpenCV } from "@/lib/useOpenCV";

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null); // final annotated
  const canvasThreshRef = useRef<HTMLCanvasElement | null>(null);
  const canvasOpenedRef = useRef<HTMLCanvasElement | null>(null);
  const canvasDistRef = useRef<HTMLCanvasElement | null>(null);
  const canvasSegRef = useRef<HTMLCanvasElement | null>(null);
  const canvasChanARef = useRef<HTMLCanvasElement | null>(null);
  const canvasChanBRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<HTMLImageElement | null>(null);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  // no explicit processing button; auto-processing on change
  const [colonyCount, setColonyCount] = useState<number | null>(null);
  const [countA, setCountA] = useState<number | null>(null);
  const [countB, setCountB] = useState<number | null>(null);
  const { isReady, error } = useOpenCV();

  // parameters
  const [blurSize, setBlurSize] = useState<number>(1); // must be odd
  const [morphSize, setMorphSize] = useState<number>(5); // must be odd
  const [minArea, setMinArea] = useState<number>(1);
  const [thresholdMode, setThresholdMode] = useState<"otsu" | "adaptive-mean" | "adaptive-gaussian">("adaptive-mean");
  const [adaptiveBlock, setAdaptiveBlock] = useState<number>(3); // odd
  const [adaptiveC, setAdaptiveC] = useState<number>(2);
  const [separateTouching, setSeparateTouching] = useState<boolean>(false);
  const [minDistance, setMinDistance] = useState<number>(10); // for watershed marker size
  const [markerColor, setMarkerColor] = useState<string>("#00ff00");
  const [markerRadius, setMarkerRadius] = useState<number>(5);
  const [invertMask, setInvertMask] = useState<boolean>(true);
  const [effectiveRadiusPct, setEffectiveRadiusPct] = useState<number>(87); // 僅判斷內圈半徑比例（%）
  // Keep viewport adaptive; do not expose display scaling to avoid vertical scroll
  const [useColorSplit, setUseColorSplit] = useState<boolean>(true);
  // HSV A channel
  const [hueCenterA, setHueCenterA] = useState<number>(19);
  const [hueTolA, setHueTolA] = useState<number>(6);
  const [satMinA, setSatMinA] = useState<number>(39);
  const [valMinA, setValMinA] = useState<number>(88);
  const [colorA, setColorA] = useState<string>("#00ff00"); // marker color only; auto-calibration won't change this
  // HSV B channel
  const [hueCenterB, setHueCenterB] = useState<number>(140);
  const [hueTolB, setHueTolB] = useState<number>(15);
  const [satMinB, setSatMinB] = useState<number>(40);
  const [valMinB, setValMinB] = useState<number>(40);
  const [colorB, setColorB] = useState<string>("#ff00ff");
  // Morph for seeds
  const [erodeSize, setErodeSize] = useState<number>(5);
  const [dilateSize, setDilateSize] = useState<number>(7);

  // Debounce re-process on parameter change
  useEffect(() => {
    if (!selectedUrl) return;
    const id = setTimeout(() => {
      void processImage();
    }, 150);
    return () => clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blurSize, morphSize, minArea, thresholdMode, adaptiveBlock, adaptiveC, effectiveRadiusPct, selectedUrl, isReady, useColorSplit, hueCenterA, hueTolA, satMinA, valMinA, hueCenterB, hueTolB, satMinB, valMinB, erodeSize, dilateSize]);

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
    const tryBlurSizes = [5, 9, 13];
    const tryMorphSizes = [3, 5, 7];
    const tryModes: Array<{ mode: "otsu" | "adaptive-mean" | "adaptive-gaussian"; blocks?: number[]; Cs?: number[] }> = [
      { mode: "otsu" },
      { mode: "adaptive-mean", blocks: [11, 17, 23], Cs: [-6, -4, -2, 0, 2] },
      { mode: "adaptive-gaussian", blocks: [11, 17, 23], Cs: [-6, -4, -2, 0, 2] },
    ];
    const invert = [true, false];
    let best = { count: -1, blur: blurSize, morph: morphSize, mode: thresholdMode, block: adaptiveBlock, C: adaptiveC, inv: invertMask };
    try {
      // If color split is enabled, tune erosion/dilation for seeds on A/B masks using current HSV settings
      if (useColorSplit) {
        // Dish detection once at current blur
        const kBlur = Math.max(1, blurSize | 1);
        const blurred = new cv.Mat();
        cv.GaussianBlur(gray, blurred, new cv.Size(kBlur, kBlur), 0, 0, cv.BORDER_DEFAULT);
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

        const roiSize = Math.min(src.cols, src.rows, Math.round(dishR * 2 * 1.05));
        const roiX = Math.max(0, Math.round(dishCx - roiSize / 2));
        const roiY = Math.max(0, Math.round(dishCy - roiSize / 2));
        const roiW = Math.min(roiSize, src.cols - roiX);
        const roiH = Math.min(roiSize, src.rows - roiY);
        const roiRect = new cv.Rect(roiX, roiY, roiW, roiH);
        const innerMask = cv.Mat.zeros(roiH, roiW, cv.CV_8UC1);
        const effR = Math.round((dishR * effectiveRadiusPct) / 100);
        const innerCx = Math.round(Math.min(Math.max(0, dishCx - roiX), roiW));
        const innerCy = Math.round(Math.min(Math.max(0, dishCy - roiY), roiH));
        cv.circle(innerMask, { x: innerCx, y: innerCy }, effR, new cv.Scalar(255), -1);

        // Build HSV and masks using current HSV settings
        const rgb = new cv.Mat();
        cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
        const hsv = new cv.Mat();
        cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
        const makeBound = (h: number, s: number, v: number) => new cv.Mat(hsv.rows, hsv.cols, cv.CV_8UC3, new cv.Scalar(h, s, v, 0));
        const buildHueMask = (center: number, tol: number, sMin: number, vMin: number) => {
          const maskBase = new cv.Mat();
          if (center - tol < 0 || center + tol > 179) {
            const lowPart = new cv.Mat();
            const highPart = new cv.Mat();
            const lowerLow = makeBound(0, sMin, vMin);
            const upperLow = makeBound(Math.max(0, (center + tol) % 180), 255, 255);
            const lowerHigh = makeBound(Math.max(0, (center - tol + 180) % 180), sMin, vMin);
            const upperHigh = makeBound(179, 255, 255);
            cv.inRange(hsv, lowerLow, upperLow, lowPart);
            cv.inRange(hsv, lowerHigh, upperHigh, highPart);
            cv.bitwise_or(lowPart, highPart, maskBase);
            lowPart.delete();
            highPart.delete();
            lowerLow.delete();
            upperLow.delete();
            lowerHigh.delete();
            upperHigh.delete();
          } else {
            const lower = makeBound(Math.max(0, center - tol), sMin, vMin);
            const upper = makeBound(Math.min(179, center + tol), 255, 255);
            cv.inRange(hsv, lower, upper, maskBase);
            lower.delete();
            upper.delete();
          }
          return maskBase;
        };
        const maskAFull = buildHueMask(hueCenterA, hueTolA, satMinA, valMinA);
        const maskBFull = buildHueMask(hueCenterB, hueTolB, satMinB, valMinB);
        const maskARoi = maskAFull.roi(roiRect);
        const maskBRoi = maskBFull.roi(roiRect);
        const maskAInner = new cv.Mat();
        const maskBInner = new cv.Mat();
        cv.bitwise_and(maskARoi, maskARoi, maskAInner, innerMask);
        cv.bitwise_and(maskBRoi, maskBRoi, maskBInner, innerMask);

        const tryErode = [1, 3, 5, 7];
        const tryDilate = [3, 5, 7, 9];
        let bestSeeds = { count: -1, erode: erodeSize, dilate: dilateSize };
        for (const eSize of tryErode) {
          for (const dSize of tryDilate) {
            const erodeK = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(Math.max(1, (eSize | 1)), Math.max(1, (eSize | 1))));
            const dilateK = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(Math.max(1, (dSize | 1)), Math.max(1, (dSize | 1))));
            const seedsA = new cv.Mat();
            const seedsB = new cv.Mat();
            cv.erode(maskAInner, seedsA, erodeK);
            cv.dilate(seedsA, seedsA, dilateK);
            cv.erode(maskBInner, seedsB, erodeK);
            cv.dilate(seedsB, seedsB, dilateK);
            const labelsA = new cv.Mat();
            const statsA = new cv.Mat();
            const centsA = new cv.Mat();
            const labelsB = new cv.Mat();
            const statsB = new cv.Mat();
            const centsB = new cv.Mat();
            const numA = cv.connectedComponentsWithStats(seedsA, labelsA, statsA, centsA, 8, cv.CV_32S);
            const numB = cv.connectedComponentsWithStats(seedsB, labelsB, statsB, centsB, 8, cv.CV_32S);
            let count = 0;
            for (let i = 1; i < numA; i++) { if (statsA.intPtr(i, 4)[0] >= minArea) count++; }
            for (let i = 1; i < numB; i++) { if (statsB.intPtr(i, 4)[0] >= minArea) count++; }
            if (count > bestSeeds.count) bestSeeds = { count, erode: eSize, dilate: dSize };
            erodeK.delete();
            dilateK.delete();
            seedsA.delete();
            seedsB.delete();
            labelsA.delete();
            statsA.delete();
            centsA.delete();
            labelsB.delete();
            statsB.delete();
            centsB.delete();
          }
        }
        // cleanup
        blurred.delete();
        maskAFull.delete();
        maskBFull.delete();
        maskARoi.delete();
        maskBRoi.delete();
        maskAInner.delete();
        maskBInner.delete();
        hsv.delete();
        rgb.delete();
        innerMask.delete();

        // apply best erosion/dilation and continue to threshold tuning
        setErodeSize(bestSeeds.erode);
        setDilateSize(bestSeeds.dilate);
      }

      for (const b of tryBlurSizes) {
        const blurred = new cv.Mat();
        cv.GaussianBlur(gray, blurred, new cv.Size(b, b), 0, 0, cv.BORDER_DEFAULT);
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
        const masked = new cv.Mat();
        cv.bitwise_and(blurred, blurred, masked, mask);

        const roiSize = Math.min(src.cols, src.rows, Math.round(dishR * 2 * 1.05));
        const roiX = Math.max(0, Math.round(dishCx - roiSize / 2));
        const roiY = Math.max(0, Math.round(dishCy - roiSize / 2));
        const roiW = Math.min(roiSize, src.cols - roiX);
        const roiH = Math.min(roiSize, src.rows - roiY);
        const roiRect = new cv.Rect(roiX, roiY, roiW, roiH);
        const maskedRoi = masked.roi(roiRect);

        for (const { mode, blocks, Cs } of tryModes) {
          const blockList = mode === "otsu" ? [0] : (blocks ?? [17]);
          const cList = mode === "otsu" ? [0] : (Cs ?? [-4]);
          for (const blk of blockList) {
            for (const c of cList) {
              for (const inv of invert) {
                const thresh = new cv.Mat();
                if (mode === "otsu") {
                  cv.threshold(maskedRoi, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
                } else {
                  const block = Math.max(3, blk | 1);
                  const method = mode === "adaptive-mean" ? cv.ADAPTIVE_THRESH_MEAN_C : cv.ADAPTIVE_THRESH_GAUSSIAN_C;
                  cv.adaptiveThreshold(maskedRoi, thresh, 255, method, cv.THRESH_BINARY, block, c);
                }
                let bin = thresh as unknown as typeof thresh;
                const invOwned = new cv.Mat();
                let usingOwned = false;
                if (inv) {
                  cv.threshold(thresh, invOwned, 0, 255, cv.THRESH_BINARY_INV);
                  bin = invOwned;
                  usingOwned = true;
                }
                for (const m of tryMorphSizes) {
                  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(m, m));
                  const opened = new cv.Mat();
                  cv.morphologyEx(bin, opened, cv.MORPH_OPEN, kernel);
                  const innerMask = cv.Mat.zeros(opened.rows, opened.cols, cv.CV_8UC1);
                  const effR = Math.round((dishR * effectiveRadiusPct) / 100);
                  const innerCx = Math.round(Math.min(Math.max(0, dishCx - roiX), opened.cols));
                  const innerCy = Math.round(Math.min(Math.max(0, dishCy - roiY), opened.rows));
                  cv.circle(innerMask, { x: innerCx, y: innerCy }, effR, new cv.Scalar(255), -1);
                  const maskedInner = new cv.Mat();
                  cv.bitwise_and(opened, opened, maskedInner, innerMask);
                  const labels = new cv.Mat();
                  const stats = new cv.Mat();
                  const cents = new cv.Mat();
                  const n = cv.connectedComponentsWithStats(maskedInner, labels, stats, cents, 8, cv.CV_32S);
                  let count = 0;
                  for (let i = 1; i < n; i++) {
                    const area = stats.intPtr(i, 4)[0];
                    if (area < minArea) continue;
                    count++;
                  }
                  if (count > best.count) {
                    best = { count, blur: b, morph: m, mode, block: blk || 17, C: c || -4, inv };
                  }
                  kernel.delete();
                  opened.delete();
                  innerMask.delete();
                  maskedInner.delete();
                  labels.delete();
                  stats.delete();
                  cents.delete();
                }
                thresh.delete();
                if (usingOwned) invOwned.delete();
              }
            }
          }
        }
        masked.delete();
        blurred.delete();
        mask.delete();
      }
    } finally {
      // Auto-calibrate Channel A HSV from segmented colonies (single species use-case)
      try {
        const cv = window.cv;
        // 1) Recompute dish ROI using best blur
        const kBlurBest = Math.max(1, best.blur | 1);
        const blurredBest = new cv.Mat();
        cv.GaussianBlur(gray, blurredBest, new cv.Size(kBlurBest, kBlurBest), 0, 0, cv.BORDER_DEFAULT);
        const edgesBest = new cv.Mat();
        cv.Canny(blurredBest, edgesBest, 50, 150);
        const plateContoursBest = new cv.MatVector();
        const plateHierarchyBest = new cv.Mat();
        cv.findContours(edgesBest, plateContoursBest, plateHierarchyBest, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        let dishCx = Math.floor(src.cols / 2);
        let dishCy = Math.floor(src.rows / 2);
        let dishR = Math.floor(Math.min(src.cols, src.rows) / 2);
        let maxRectArea = 0;
        for (let i = 0; i < plateContoursBest.size(); i++) {
          const cnt = plateContoursBest.get(i);
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
        plateContoursBest.delete();
        plateHierarchyBest.delete();
        edgesBest.delete();

        // 2) Build ROI and binary mask with tuned threshold params
        const maskDish = cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC1);
        cv.circle(maskDish, { x: dishCx, y: dishCy }, dishR, new cv.Scalar(255), -1);
        const maskedGrayBest = new cv.Mat();
        cv.bitwise_and(blurredBest, blurredBest, maskedGrayBest, maskDish);

        const roiSize = Math.min(src.cols, src.rows, Math.round(dishR * 2 * 1.05));
        const roiX = Math.max(0, Math.round(dishCx - roiSize / 2));
        const roiY = Math.max(0, Math.round(dishCy - roiSize / 2));
        const roiW = Math.min(roiSize, src.cols - roiX);
        const roiH = Math.min(roiSize, src.rows - roiY);
        const roiRect = new cv.Rect(roiX, roiY, roiW, roiH);

        const threshBest = new cv.Mat();
        if (best.mode === "otsu") {
          cv.threshold(maskedGrayBest, threshBest, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        } else {
          const block = Math.max(3, best.block | 1);
          const method = best.mode === "adaptive-mean" ? cv.ADAPTIVE_THRESH_MEAN_C : cv.ADAPTIVE_THRESH_GAUSSIAN_C;
          cv.adaptiveThreshold(maskedGrayBest, threshBest, 255, method, cv.THRESH_BINARY, block, best.C);
        }
        let binBest = threshBest as unknown as typeof threshBest;
        const invOwnedBest = new cv.Mat();
        let usingInvBest = false;
        if (best.inv) {
          cv.threshold(threshBest, invOwnedBest, 0, 255, cv.THRESH_BINARY_INV);
          binBest = invOwnedBest;
          usingInvBest = true;
        }
        const kernelBest = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(Math.max(1, best.morph | 1), Math.max(1, best.morph | 1)));
        const openedBest = new cv.Mat();
        cv.morphologyEx(binBest, openedBest, cv.MORPH_OPEN, kernelBest);

        const toLabelRoi = openedBest.roi(roiRect);
        const innerMask = cv.Mat.zeros(toLabelRoi.rows, toLabelRoi.cols, cv.CV_8UC1);
        const effR = Math.round((dishR * effectiveRadiusPct) / 100);
        const innerCx = Math.round(Math.min(Math.max(0, dishCx - roiX), toLabelRoi.cols));
        const innerCy = Math.round(Math.min(Math.max(0, dishCy - roiY), toLabelRoi.rows));
        cv.circle(innerMask, { x: innerCx, y: innerCy }, effR, new cv.Scalar(255), -1);
        const sampleMask = new cv.Mat();
        cv.bitwise_and(toLabelRoi, toLabelRoi, sampleMask, innerMask);

        // 3) Build HSV from original RGB
        const rgbBest = new cv.Mat();
        cv.cvtColor(src, rgbBest, cv.COLOR_RGBA2RGB);
        const hsvBest = new cv.Mat();
        cv.cvtColor(rgbBest, hsvBest, cv.COLOR_RGB2HSV);

        const hues: number[] = [];
        const sats: number[] = [];
        const vals: number[] = [];
        let sumR = 0, sumG = 0, sumB = 0, nPix = 0;
        for (let y = 0; y < sampleMask.rows; y++) {
          for (let x = 0; x < sampleMask.cols; x++) {
            if (sampleMask.ucharPtr(y, x)[0] === 0) continue;
            const gx = roiX + x;
            const gy = roiY + y;
            const h = hsvBest.ucharPtr(gy, gx)[0];
            const s = hsvBest.ucharPtr(gy, gx)[1];
            const v = hsvBest.ucharPtr(gy, gx)[2];
            hues.push(h);
            sats.push(s);
            vals.push(v);
            const px = rgbBest.ucharPtr(gy, gx);
            sumR += px[0];
            sumG += px[1];
            sumB += px[2];
            nPix++;
          }
        }

        if (nPix > 20) {
          // Circular mean for hue (0..179)
          let sumX = 0;
          let sumY = 0;
          for (const h of hues) {
            const theta = (h / 180) * 2 * Math.PI;
            sumX += Math.cos(theta);
            sumY += Math.sin(theta);
          }
          let meanTheta = Math.atan2(sumY, sumX);
          if (meanTheta < 0) meanTheta += 2 * Math.PI;
          const hueCenter = Math.round((meanTheta / (2 * Math.PI)) * 180) % 180;

          // Robust tolerance: 80th percentile of circular distance
          const circDist: number[] = hues.map((h) => {
            let d = Math.abs(h - hueCenter);
            d = Math.min(d, 180 - d);
            return d;
          }).sort((a, b) => a - b);
          const p80 = circDist[Math.min(circDist.length - 1, Math.floor(circDist.length * 0.8))] || 10;
          const hueTol = Math.max(6, Math.min(40, Math.round(p80)));

          // S/V minima from 20th percentile
          const sortedS = sats.slice().sort((a, b) => a - b);
          const sortedV = vals.slice().sort((a, b) => a - b);
          const sMin = sortedS[Math.min(sortedS.length - 1, Math.floor(sortedS.length * 0.2))] || 40;
          const vMin = sortedV[Math.min(sortedV.length - 1, Math.floor(sortedV.length * 0.2))] || 40;

          // Representative color
          const avgR = Math.min(255, Math.max(0, Math.round(sumR / nPix)));
          const avgG = Math.min(255, Math.max(0, Math.round(sumG / nPix)));
          const avgB = Math.min(255, Math.max(0, Math.round(sumB / nPix)));
          const toHex = (n: number) => n.toString(16).padStart(2, '0');
          setHueCenterA(hueCenter);
          setHueTolA(hueTol);
          setSatMinA(sMin);
          setValMinA(vMin);
          // Do not change colorA (marker color), only HSV thresholds
        }

        // cleanup locals
        hsvBest.delete();
        rgbBest.delete();
        sampleMask.delete();
        innerMask.delete();
        toLabelRoi.delete();
        kernelBest.delete();
        openedBest.delete();
        if (usingInvBest) invOwnedBest.delete();
        threshBest.delete();
        maskedGrayBest.delete();
        maskDish.delete();
        blurredBest.delete();
      } catch {
        // ignore calibration errors; fall back to manual HSV
      }

      src.delete();
      gray.delete();
      setBlurSize(best.blur);
      setMorphSize(best.morph);
      setThresholdMode(best.mode);
      if (best.mode !== "otsu") {
        setAdaptiveBlock(best.block);
        setAdaptiveC(best.C);
      }
      setInvertMask(best.inv);
      void processImage();
    }
  };

  const processImage = async () => {
    if (!isReady) return;
    const imgEl = previewRef.current;
    const canvasEl = canvasRef.current;
    const canvasThreshEl = canvasThreshRef.current;
    const canvasOpenedEl = canvasOpenedRef.current;
    const canvasDistEl = canvasDistRef.current;
    const canvasSegEl = canvasSegRef.current;
    if (!imgEl || !canvasEl || !canvasThreshEl || !canvasOpenedEl) return;

    try {
      const cv = window.cv;
      const src = cv.imread(imgEl);
      const toScalarFromHex = (hex: string) => {
        const normalized = hex.replace("#", "");
        const r = parseInt(normalized.substring(0, 2), 16);
        const g = parseInt(normalized.substring(2, 4), 16);
        const b = parseInt(normalized.substring(4, 6), 16);
        return new cv.Scalar(r, g, b, 255);
      };
      const markColorScalar = toScalarFromHex(markerColor);
      const gray = new cv.Mat();
      const blurred = new cv.Mat();
      const thresh = new cv.Mat();

      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
      const kBlur = Math.max(1, blurSize | 1); // force odd
      cv.GaussianBlur(gray, blurred, new cv.Size(kBlur, kBlur), 0, 0, cv.BORDER_DEFAULT);

      // Detect largest circular region (petri dish) and build mask
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

      // 建立置中 ROI：以培養皿為中心的正方形，邊長為直徑的 1.05 倍（含少量邊界）
      const roiSize = Math.min(src.cols, src.rows, Math.round(dishR * 2 * 1.05));
      const roiX = Math.max(0, Math.round(dishCx - roiSize / 2));
      const roiY = Math.max(0, Math.round(dishCy - roiSize / 2));
      const roiW = Math.min(roiSize, src.cols - roiX);
      const roiH = Math.min(roiSize, src.rows - roiY);
      const roiRect = new cv.Rect(roiX, roiY, roiW, roiH);

      if (thresholdMode === "otsu") {
        cv.threshold(maskedGray, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      } else {
        const block = Math.max(3, adaptiveBlock | 1);
        const C = adaptiveC;
        const method = thresholdMode === "adaptive-mean" ? cv.ADAPTIVE_THRESH_MEAN_C : cv.ADAPTIVE_THRESH_GAUSSIAN_C;
        cv.adaptiveThreshold(maskedGray, thresh, 255, method, cv.THRESH_BINARY, block, C);
      }
      // Binary used for downstream steps and display
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

      let toLabel = opened;
      let owned = false;
      if (separateTouching) {
        // Watershed: split黏連的菌落
        const sureBg = new cv.Mat();
        cv.morphologyEx(opened, sureBg, cv.MORPH_OPEN, kernel); // background-ish
        const dist = new cv.Mat();
        cv.distanceTransform(opened, dist, cv.DIST_L2, 5);
        const distNorm = new cv.Mat();
        cv.normalize(dist, distNorm, 0, 1.0, cv.NORM_MINMAX);

        // generate peaks as markers
        // scale normalized distance (0..1) to 8-bit manually
        const dist8u = new cv.Mat(distNorm.rows, distNorm.cols, cv.CV_8UC1);
        for (let y = 0; y < distNorm.rows; y++) {
          for (let x = 0; x < distNorm.cols; x++) {
            const val = distNorm.floatPtr(y, x)[0];
            dist8u.ucharPtr(y, x)[0] = Math.max(0, Math.min(255, Math.round(val * 255)));
          }
        }

        // Erode to create separated peaks based on desired minDistance
        const erodeKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(Math.max(1, (minDistance | 1)), Math.max(1, (minDistance | 1))));
        const peaks = new cv.Mat();
        cv.erode(dist8u, peaks, erodeKernel);

        const markers = new cv.Mat();
        cv.connectedComponentsWithStats(peaks, markers, new cv.Mat(), new cv.Mat(), 8, cv.CV_32S);

        // watershed expects 3-channel image
        const rgb = new cv.Mat();
        cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
        cv.watershed(rgb, markers);
        rgb.delete();

        // convert markers (CV_32S) to binary mask (CV_8U): keep labels > 1
        const separated = new cv.Mat(markers.rows, markers.cols, cv.CV_8UC1);
        for (let y = 0; y < markers.rows; y++) {
          for (let x = 0; x < markers.cols; x++) {
            const label = markers.intPtr(y, x)[0];
            separated.ucharPtr(y, x)[0] = label > 1 ? 255 : 0;
          }
        }

        // show distance immediately if canvas available
        if (canvasDistEl) cv.imshow(canvasDistEl, dist8u);
        toLabel = separated;
        owned = true;

        // cleanup temps
        sureBg.delete();
        dist.delete();
        distNorm.delete();
        erodeKernel.delete();
        peaks.delete();
        markers.delete();
      }

      // 針對置中 ROI 計數與顯示：支援顏色分離或單通道
      const labels = new cv.Mat();
      const stats = new cv.Mat();
      const centroids = new cv.Mat();
      const toLabelRoi = toLabel.roi(roiRect);
      const innerMask = cv.Mat.zeros(toLabelRoi.rows, toLabelRoi.cols, cv.CV_8UC1);
      const effR = Math.round((dishR * effectiveRadiusPct) / 100);
      const innerCx = Math.round(Math.min(Math.max(0, dishCx - roiX), toLabelRoi.cols));
      const innerCy = Math.round(Math.min(Math.max(0, dishCy - roiY), toLabelRoi.rows));
      cv.circle(innerMask, { x: innerCx, y: innerCy }, effR, new cv.Scalar(255), -1);

      // 顏色分離路徑：在內圈內建立 A/B 色彩遮罩並統計
      if (useColorSplit) {
        const rgb = new cv.Mat();
        cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
        const hsv = new cv.Mat();
        cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);

        const buildHueMask = (center: number, tol: number, sMin: number, vMin: number) => {
          const maskBase = new cv.Mat();
          const makeBound = (h: number, s: number, v: number) => new cv.Mat(hsv.rows, hsv.cols, cv.CV_8UC3, new cv.Scalar(h, s, v, 0));
          if (center - tol < 0 || center + tol > 179) {
            const lowPart = new cv.Mat();
            const highPart = new cv.Mat();
            const lowerLow = makeBound(0, sMin, vMin);
            const upperLow = makeBound(Math.max(0, (center + tol) % 180), 255, 255);
            const lowerHigh = makeBound(Math.max(0, (center - tol + 180) % 180), sMin, vMin);
            const upperHigh = makeBound(179, 255, 255);
            cv.inRange(hsv, lowerLow, upperLow, lowPart);
            cv.inRange(hsv, lowerHigh, upperHigh, highPart);
            cv.bitwise_or(lowPart, highPart, maskBase);
            lowPart.delete();
            highPart.delete();
            lowerLow.delete();
            upperLow.delete();
            lowerHigh.delete();
            upperHigh.delete();
          } else {
            const lower = makeBound(Math.max(0, center - tol), sMin, vMin);
            const upper = makeBound(Math.min(179, center + tol), 255, 255);
            cv.inRange(hsv, lower, upper, maskBase);
            lower.delete();
            upper.delete();
          }
          return maskBase;
        };

        const maskA = buildHueMask(hueCenterA, hueTolA, satMinA, valMinA);
        const maskB = buildHueMask(hueCenterB, hueTolB, satMinB, valMinB);
        const maskARoi = maskA.roi(roiRect);
        const maskBRoi = maskB.roi(roiRect);
        const maskAInner = new cv.Mat();
        const maskBInner = new cv.Mat();
        cv.bitwise_and(maskARoi, maskARoi, maskAInner, innerMask);
        cv.bitwise_and(maskBRoi, maskBRoi, maskBInner, innerMask);

        const erodeK = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(Math.max(1, (erodeSize | 1)), Math.max(1, (erodeSize | 1))));
        const dilateK = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(Math.max(1, (dilateSize | 1)), Math.max(1, (dilateSize | 1))));
        const seedsA = new cv.Mat();
        const seedsB = new cv.Mat();
        cv.erode(maskAInner, seedsA, erodeK);
        cv.dilate(seedsA, seedsA, dilateK);
        cv.erode(maskBInner, seedsB, erodeK);
        cv.dilate(seedsB, seedsB, dilateK);

        const labelsA = new cv.Mat();
        const statsA = new cv.Mat();
        const centsA = new cv.Mat();
        const labelsB = new cv.Mat();
        const statsB = new cv.Mat();
        const centsB = new cv.Mat();
        const numA = cv.connectedComponentsWithStats(seedsA, labelsA, statsA, centsA, 8, cv.CV_32S);
        const numB = cv.connectedComponentsWithStats(seedsB, labelsB, statsB, centsB, 8, cv.CV_32S);

        const parseHex = (hex: string) => {
          const normalized = hex.replace('#', '');
          const r = parseInt(normalized.substring(0, 2), 16);
          const g = parseInt(normalized.substring(2, 4), 16);
          const b = parseInt(normalized.substring(4, 6), 16);
          return new cv.Scalar(r, g, b, 255);
        };
        const colorASc = parseHex(colorA);
        const colorBSc = parseHex(colorB);

        let aCount = 0;
        let bCount = 0;
        for (let i = 1; i < numA; i++) {
          const area = statsA.intPtr(i, 4)[0];
          if (area < minArea) continue;
          aCount++;
          const cx = Math.round(centsA.doublePtr(i, 0)[0]) + roiX;
          const cy = Math.round(centsA.doublePtr(i, 1)[0]) + roiY;
          cv.circle(src, { x: cx, y: cy }, Math.max(1, markerRadius), colorASc, 2);
        }
        for (let i = 1; i < numB; i++) {
          const area = statsB.intPtr(i, 4)[0];
          if (area < minArea) continue;
          bCount++;
          const cx = Math.round(centsB.doublePtr(i, 0)[0]) + roiX;
          const cy = Math.round(centsB.doublePtr(i, 1)[0]) + roiY;
          cv.circle(src, { x: cx, y: cy }, Math.max(1, markerRadius), colorBSc, 2);
        }
        setCountA(aCount);
        setCountB(bCount);
        setColonyCount(aCount + bCount);

        // show channel masks if canvases available
        const showRoi = (mat: typeof toLabel, canvas: HTMLCanvasElement | null) => {
          if (!canvas) return;
          const view = mat.roi(roiRect);
          try {
            const colored = new cv.Mat();
            cv.applyColorMap(view, colored, cv.COLORMAP_JET);
            cv.imshow(canvas, colored);
            colored.delete();
          } catch {
            cv.imshow(canvas, view);
          }
          view.delete();
        };
        showRoi(maskA, (canvasChanARef.current));
        showRoi(maskB, (canvasChanBRef.current));

        // cleanup A/B
        rgb.delete();
        hsv.delete();
        maskA.delete();
        maskB.delete();
        maskARoi.delete();
        maskBRoi.delete();
        maskAInner.delete();
        maskBInner.delete();
        erodeK.delete();
        dilateK.delete();
        seedsA.delete();
        seedsB.delete();
        labelsA.delete();
        statsA.delete();
        centsA.delete();
        labelsB.delete();
        statsB.delete();
        centsB.delete();
      } else {
        // 單通道：延用既有流程
        const toLabelInner = new cv.Mat();
        cv.bitwise_and(toLabelRoi, toLabelRoi, toLabelInner, innerMask);
        const numLabels: number = cv.connectedComponentsWithStats(toLabelInner, labels, stats, centroids, 8, cv.CV_32S);
        let count = 0;
        for (let i = 1; i < numLabels; i++) {
          const area = stats.intPtr(i, 4)[0];
          if (area < minArea) continue;
          count++;
        }
        setCountA(null);
        setCountB(null);
        setColonyCount(count);
        for (let i = 1; i < numLabels; i++) {
          const area = stats.intPtr(i, 4)[0];
          if (area < minArea) continue;
          const cx = Math.round(centroids.doublePtr(i, 0)[0]) + roiX;
          const cy = Math.round(centroids.doublePtr(i, 1)[0]) + roiY;
          cv.circle(src, { x: cx, y: cy }, Math.max(1, markerRadius), markColorScalar, 2);
        }
        toLabelInner.delete();
      }
      // draw detected dish boundary
      cv.circle(src, { x: dishCx, y: dishCy }, dishR, new cv.Scalar(255, 128, 0), 3);
      // 對視圖輸出使用 ROI 置中顯示
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const showWithRoi = (mat: any, target: HTMLCanvasElement) => {
        const view = mat.roi(roiRect);
        cv.imshow(target, view);
        view.delete();
      };
      // 顏色輸出：最終結果顯示原圖 ROI 帶標註
      const srcRoi = src.roi(roiRect);
      cv.imshow(canvasEl, srcRoi);
      srcRoi.delete();
      // stage outputs: colorize 1-channel mats for visibility
      const colorizeAndShow = (mat: ReturnType<typeof cv.Mat.prototype.clone>, canvas: HTMLCanvasElement) => {
        try {
          const colored = new cv.Mat();
          if (cv.applyColorMap) {
            cv.applyColorMap(mat, colored, cv.COLORMAP_JET);
          } else {
            cv.cvtColor(mat, colored, cv.COLOR_GRAY2RGBA);
          }
          showWithRoi(colored, canvas);
          colored.delete();
        } catch {
          showWithRoi(mat, canvas);
        }
      };
      colorizeAndShow(bin, canvasThreshEl);
      colorizeAndShow(opened, canvasOpenedEl);
      if (canvasSegEl) colorizeAndShow(toLabel, canvasSegEl);

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
      kernel.delete();
      if (owned) toLabel.delete();
      mask.delete();
      maskedGray.delete();
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
            <span className="text-sm">
              總數：<b>{colonyCount}</b>
              {countA !== null && countB !== null && (
                <>
                  <span className="ml-2">A：<b>{countA}</b></span>
                  <span className="ml-2">B：<b>{countB}</b></span>
                </>
              )}
            </span>
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
              <p className="text-sm font-semibold">模式</p>
              <label className="text-sm inline-flex items-center gap-2">
                <input type="checkbox" checked={useColorSplit} onChange={(e) => setUseColorSplit(e.target.checked)} />
                顏色分離（A/B 兩通道）
              </label>
            </div>
            {/* 二值化：影響「二值化」視圖 */}
            <div className="space-y-2">
              <p className="text-sm font-semibold">二值化（對應視圖：二值化）</p>
              <label className="text-sm block">模糊核大小：{blurSize}
                <input type="range" min={1} max={21} step={2} value={blurSize} onChange={(e) => setBlurSize(parseInt(e.target.value))} className="w-full" />
              </label>
              <label className="text-sm block">模式
                <select
                  className="border rounded px-2 py-1 ml-2"
                  value={thresholdMode}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                    setThresholdMode(e.target.value as "otsu" | "adaptive-mean" | "adaptive-gaussian")
                  }
                >
                  <option value="otsu">大津法（Otsu）</option>
                  <option value="adaptive-mean">自適應（平均）</option>
                  <option value="adaptive-gaussian">自適應（高斯）</option>
                </select>
              </label>
              {(thresholdMode !== "otsu") && (
                <>
                  <label className="text-sm block">區塊大小：{adaptiveBlock}
                    <input type="range" min={3} max={101} step={2} value={adaptiveBlock} onChange={(e) => setAdaptiveBlock(parseInt(e.target.value))} className="w-full" />
                  </label>
                  <label className="text-sm block">偏移 C：{adaptiveC}
                    <input type="range" min={-20} max={20} step={1} value={adaptiveC} onChange={(e) => setAdaptiveC(parseInt(e.target.value))} className="w-full" />
                  </label>
                </>
              )}
              <label className="text-sm inline-flex items-center gap-2">
                <input type="checkbox" checked={invertMask} onChange={(e) => setInvertMask(e.target.checked)} />
                反轉遮罩（讓菌落為白、背景為黑）
              </label>
            </div>

            {/* 顏色分離（A 通道） */}
            <div className="space-y-2">
              <p className="text-sm font-semibold">顏色分離 A（對應視圖：通道 A）</p>
              <label className="text-sm block">Hue 中心：{hueCenterA}
                <input type="range" min={0} max={179} step={1} value={hueCenterA} onChange={(e) => setHueCenterA(parseInt(e.target.value))} className="w-full" />
              </label>
              <label className="text-sm block">Hue 容差：{hueTolA}
                <input type="range" min={0} max={40} step={1} value={hueTolA} onChange={(e) => setHueTolA(parseInt(e.target.value))} className="w-full" />
              </label>
              <label className="text-sm block">S 最小：{satMinA}
                <input type="range" min={0} max={255} step={1} value={satMinA} onChange={(e) => setSatMinA(parseInt(e.target.value))} className="w-full" />
              </label>
              <label className="text-sm block">V 最小：{valMinA}
                <input type="range" min={0} max={255} step={1} value={valMinA} onChange={(e) => setValMinA(parseInt(e.target.value))} className="w-full" />
              </label>
              <label className="text-sm inline-flex items-center gap-2">標記顏色 A
                <input type="color" value={colorA} onChange={(e) => setColorA(e.target.value)} />
              </label>
            </div>

            {/* 顏色分離（B 通道） */}
            <div className="space-y-2">
              <p className="text-sm font-semibold">顏色分離 B（對應視圖：通道 B）</p>
              <label className="text-sm block">Hue 中心：{hueCenterB}
                <input type="range" min={0} max={179} step={1} value={hueCenterB} onChange={(e) => setHueCenterB(parseInt(e.target.value))} className="w-full" />
              </label>
              <label className="text-sm block">Hue 容差：{hueTolB}
                <input type="range" min={0} max={40} step={1} value={hueTolB} onChange={(e) => setHueTolB(parseInt(e.target.value))} className="w-full" />
              </label>
              <label className="text-sm block">S 最小：{satMinB}
                <input type="range" min={0} max={255} step={1} value={satMinB} onChange={(e) => setSatMinB(parseInt(e.target.value))} className="w-full" />
              </label>
              <label className="text-sm block">V 最小：{valMinB}
                <input type="range" min={0} max={255} step={1} value={valMinB} onChange={(e) => setValMinB(parseInt(e.target.value))} className="w-full" />
              </label>
              <label className="text-sm inline-flex items-center gap-2">標記顏色 B
                <input type="color" value={colorB} onChange={(e) => setColorB(e.target.value)} />
              </label>
            </div>

            {/* 種子偵測（侵蝕/膨脹） */}
            <div className="space-y-2">
              <p className="text-sm font-semibold">種子偵測（侵蝕/膨脹）</p>
              <label className="text-sm block">侵蝕核大小：{erodeSize}
                <input type="range" min={1} max={21} step={2} value={erodeSize} onChange={(e) => setErodeSize(parseInt(e.target.value))} className="w-full" />
              </label>
              <label className="text-sm block">膨脹核大小：{dilateSize}
                <input type="range" min={1} max={21} step={2} value={dilateSize} onChange={(e) => setDilateSize(parseInt(e.target.value))} className="w-full" />
              </label>
            </div>
            {/* 形態學：影響「形態學」視圖 */}
            <div className="space-y-2">
              <p className="text-sm font-semibold">形態學（對應視圖：形態學）</p>
              <label className="text-sm block">形態學核大小：{morphSize}
                <input type="range" min={1} max={21} step={2} value={morphSize} onChange={(e) => setMorphSize(parseInt(e.target.value))} className="w-full" />
              </label>
            </div>

            {/* 分離與距離：影響「距離變換、分割遮罩」視圖 */}
            <div className="space-y-2">
              <p className="text-sm font-semibold">分離與距離（對應視圖：距離變換、分割遮罩）</p>
              <label className="text-sm inline-flex items-center gap-2">
                <input type="checkbox" checked={separateTouching} onChange={(e) => setSeparateTouching(e.target.checked)} />
                分離黏連菌落（Watershed）
              </label>
              {separateTouching && (
                <label className="text-sm block">最小距離：{minDistance}
                  <input type="range" min={3} max={41} step={2} value={minDistance} onChange={(e) => setMinDistance(parseInt(e.target.value))} className="w-full" />
                </label>
              )}
            </div>

            {/* 計數與標記：影響「最終結果」視圖 */}
            <div className="space-y-2">
              <p className="text-sm font-semibold">計數與標記（對應視圖：最終結果）</p>
              <label className="text-sm block">有效半徑比例（%）：{effectiveRadiusPct}
                <input type="range" min={50} max={100} step={1} value={effectiveRadiusPct} onChange={(e) => setEffectiveRadiusPct(parseInt(e.target.value))} className="w-full" />
              </label>
              <label className="text-sm block">最小面積：{minArea}
                <input type="range" min={1} max={500} step={1} value={minArea} onChange={(e) => setMinArea(parseInt(e.target.value))} className="w-full" />
              </label>
              <label className="text-sm block">標記半徑：{markerRadius}
                <input type="range" min={2} max={20} step={1} value={markerRadius} onChange={(e) => setMarkerRadius(parseInt(e.target.value))} className="w-full" />
              </label>
              <label className="text-sm inline-flex items-center gap-2">標記顏色
                <input type="color" value={markerColor} onChange={(e) => setMarkerColor(e.target.value)} />
              </label>
            </div>
          </div>
        </aside>

        <section className="flex-1 min-w-0 min-h-0 p-2 overflow-hidden">
          <div className="w-full h-full grid grid-cols-4 grid-rows-2 gap-2">
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
                      const cT = canvasThreshRef.current;
                      const cO = canvasOpenedRef.current;
                      const cD = canvasDistRef.current;
                      const cS = canvasSegRef.current;
                      const cA = canvasChanARef.current;
                      const cB = canvasChanBRef.current;
                      if (img) {
                        const w = img.naturalWidth;
                        const h = img.naturalHeight;
                        if (canvas) { canvas.width = w; canvas.height = h; }
                        if (cT) { cT.width = w; cT.height = h; }
                        if (cO) { cO.width = w; cO.height = h; }
                        if (cD) { cD.width = w; cD.height = h; }
                        if (cS) { cS.width = w; cS.height = h; }
                        if (cA) { cA.width = w; cA.height = h; }
                        if (cB) { cB.width = w; cB.height = h; }
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

            <div className="border rounded overflow-hidden flex flex-col">
              <div className="px-2 py-1 border-b text-xs font-medium">二值化</div>
              <div className="flex-1 min-h-0 media-box bg-[color:var(--background)]">
                <canvas ref={canvasThreshRef} />
              </div>
            </div>

            <div className="border rounded overflow-hidden flex flex-col">
              <div className="px-2 py-1 border-b text-xs font-medium">形態學</div>
              <div className="flex-1 min-h-0 media-box bg-[color:var(--background)]">
                <canvas ref={canvasOpenedRef} />
              </div>
            </div>

            <div className="border rounded overflow-hidden flex flex-col">
              <div className="px-2 py-1 border-b text-xs font-medium">距離變換</div>
              <div className="flex-1 min-h-0 media-box bg-[color:var(--background)]">
                <canvas ref={canvasDistRef} />
              </div>
            </div>

            <div className="border rounded overflow-hidden flex flex-col">
              <div className="px-2 py-1 border-b text-xs font-medium">分割遮罩</div>
              <div className="flex-1 min-h-0 media-box bg-[color:var(--background)]">
                <canvas ref={canvasSegRef} />
              </div>
            </div>

            <div className="border rounded overflow-hidden flex flex-col">
              <div className="px-2 py-1 border-b text-xs font-medium">通道 A</div>
              <div className="flex-1 min-h-0 media-box bg-[color:var(--background)]">
                <canvas ref={canvasChanARef} />
              </div>
            </div>

            <div className="border rounded overflow-hidden flex flex-col">
              <div className="px-2 py-1 border-b text-xs font-medium">通道 B</div>
              <div className="flex-1 min-h-0 media-box bg-[color:var(--background)]">
                <canvas ref={canvasChanBRef} />
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
