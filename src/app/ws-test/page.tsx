// OpenCV types are declared globally via `src/types/opencv.d.ts`
"use client";

import { useEffect, useRef, useState } from "react";
import { useOpenCV } from "@/lib/useOpenCV";

type DistType = "L1" | "L2" | "C";

type SweepResult = {
  id: string;
  params: {
    mode: "alpha" | "absolute";
    splitStrength?: number;
    dtThreshAbs?: number;
    distType: DistType;
    distMask: 3 | 5;
    peakCleanupSize: number;
  };
  count: number;
  previewUrl: string;
};

export default function WsTestPage() {
  const { isReady, error } = useOpenCV();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<SweepResult[]>([]);
  const [baseCount, setBaseCount] = useState<number | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // auto-load test image
  const [srcUrl] = useState<string>("/test.jpg");

  useEffect(() => {
    if (isReady && imageLoaded && !running) void runSweep();
  }, [isReady, imageLoaded]);

  const runSweep = async () => {
    if (!isReady || !imgRef.current) return;
    setRunning(true);
    setResults([]);
    setProgress(null);
    try {
      console.log("[ws-test] Starting sweep...");
      const cv = window.cv;
      const img = imgRef.current;
      const src = cv.imread(img);

      // Prepare grayscale and blur
      const gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
      const blurred = new cv.Mat();
      // Match user's sensitivity 6 (blur ≈ 7)
      cv.GaussianBlur(gray, blurred, new cv.Size(7, 7), 0, 0, cv.BORDER_DEFAULT);

      // Detect dish (largest external rect from Canny)
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

      // Mask outside dish
      const dishMask = cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC1);
      cv.circle(dishMask, { x: dishCx, y: dishCy }, dishR, new cv.Scalar(255), -1);

      // Focus on ROI around dish
      const roiSize = Math.min(src.cols, src.rows, Math.round(dishR * 2 * 1.05));
      const roiX = Math.max(0, Math.round(dishCx - roiSize / 2));
      const roiY = Math.max(0, Math.round(dishCy - roiSize / 2));
      const roiW = Math.min(roiSize, src.cols - roiX);
      const roiH = Math.min(roiSize, src.rows - roiY);
      const roiRect = new cv.Rect(roiX, roiY, roiW, roiH);

      const maskedGray = new cv.Mat();
      cv.bitwise_and(blurred, blurred, maskedGray, dishMask);
      const grayRoi = maskedGray.roi(roiRect);

      // Base binarization per user's request: Adaptive Gaussian, block=33, C=0, invert
      const thresh = new cv.Mat();
      cv.adaptiveThreshold(
        grayRoi,
        thresh,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY,
        Math.max(3, 33 | 1),
        0
      );
      const bin = new cv.Mat();
      cv.threshold(thresh, bin, 0, 255, cv.THRESH_BINARY_INV);
      // Match user's sensitivity 6 (morph ≈ 5)
      const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
      const opened = new cv.Mat();
      cv.morphologyEx(bin, opened, cv.MORPH_OPEN, kernel);

      // Helper: count colonies inside inner circle and create preview
      const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
      // Use user's parameters
      const minArea = 93;
      const effectiveRadiusPct = 84;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const countAndPreview = (maskMat: any) => {
        const innerMask = cv.Mat.zeros(maskMat.rows, maskMat.cols, cv.CV_8UC1);
        const effR = Math.round((dishR * effectiveRadiusPct) / 100);
        const innerCx = Math.round(clamp(dishCx - roiX, 0, maskMat.cols));
        const innerCy = Math.round(clamp(dishCy - roiY, 0, maskMat.rows));
        cv.circle(innerMask, { x: innerCx, y: innerCy }, effR, new cv.Scalar(255), -1);
        const maskedInner = new cv.Mat();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        cv.bitwise_and(maskMat, maskMat, maskedInner, innerMask);

        const labels = new cv.Mat();
        const stats = new cv.Mat();
        const cents = new cv.Mat();
        const n = cv.connectedComponentsWithStats(maskedInner, labels, stats, cents, 8, cv.CV_32S);
        const idxs: number[] = [];
        for (let i = 1; i < n; i++) {
          const area = stats.intPtr(i, 4)[0];
          if (area < minArea) continue;
          idxs.push(i);
        }

        // Build preview: draw centroids on RGB ROI
        const rgbRoi = new cv.Mat();
        const srcRoi = src.roi(roiRect);
        cv.cvtColor(srcRoi, rgbRoi, cv.COLOR_RGBA2RGB);
        const markColor = new cv.Scalar(0, 255, 0, 255);
        for (const i of idxs) {
          const cx = Math.round(cents.doublePtr(i, 0)[0]);
          const cy = Math.round(cents.doublePtr(i, 1)[0]);
          cv.circle(rgbRoi, { x: cx, y: cy }, 4, markColor, 2);
        }
        cv.circle(rgbRoi, { x: clamp(dishCx - roiX, 0, rgbRoi.cols), y: clamp(dishCy - roiY, 0, rgbRoi.rows) }, Math.round((dishR * effectiveRadiusPct) / 100), new cv.Scalar(255, 128, 0), 2);

        const canvas = document.createElement("canvas");
        canvas.width = rgbRoi.cols;
        canvas.height = rgbRoi.rows;
        cv.imshow(canvas, rgbRoi);
        const url = canvas.toDataURL("image/png");

        // Cleanup
        canvas.width = 0; // help GC
        rgbRoi.delete();
        srcRoi.delete();
        labels.delete();
        stats.delete();
        cents.delete();
        maskedInner.delete();
        innerMask.delete();

        return { count: idxs.length, previewUrl: url };
      };

      // Baseline without watershed (for comparison)
      const base = countAndPreview(opened);
      setBaseCount(base.count);
      console.log("[ws-test] Baseline (no watershed):", base.count);

      // Sweep parameters (expanded to include gentler DT thresholds and peak cleanups)
      const distTypes: DistType[] = ["L2"];
      const distMasks: (3 | 5)[] = [3, 5];
      // Lower alpha range so DT threshold is much smaller (helps retain seeds)
      const alphas = [0.0, 0.02, 0.05, 0.08, 0.1, 0.12, 0.15, 0.18, 0.2];
      // Also try low absolute thresholds
      const absTs = [5, 10, 15, 20, 25, 30, 40, 50, 60];
      // Include no-cleanup (1) and light cleanup (3, 5)
      const pkSizes = [1, 3, 5];
      const totalCombos = distTypes.length * distMasks.length * pkSizes.length * (alphas.length + absTs.length);
      let processed = 0;
      setProgress({ done: 0, total: totalCombos });
      console.log(`[ws-test] Total combos: ${totalCombos}`);

      const localResults: SweepResult[] = [];

      // Helper to run watershed with given params
      const runWs = (
        distType: DistType,
        distMask: 3 | 5,
        mode: "alpha" | "absolute",
        splitStrength: number | undefined,
        dtThreshAbs: number | undefined,
        peakCleanupSize: number
      ) => {
        const dist = new cv.Mat();
        cv.distanceTransform(opened, dist, distType === "L1" ? cv.DIST_L1 : distType === "C" ? cv.DIST_C : cv.DIST_L2, distMask);
        const distNorm = new cv.Mat();
        cv.normalize(dist, distNorm, 0, 1.0, cv.NORM_MINMAX);
        const dist8u = new cv.Mat(distNorm.rows, distNorm.cols, cv.CV_8UC1);
        for (let y = 0; y < distNorm.rows; y++) {
          for (let x = 0; x < distNorm.cols; x++) {
            const v = distNorm.floatPtr(y, x)[0];
            dist8u.ucharPtr(y, x)[0] = Math.max(0, Math.min(255, Math.round(v * 255)));
          }
        }
        // Peaks via regional maxima
        const dilK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
        const dilated = new cv.Mat();
        cv.dilate(dist8u, dilated, dilK);
        const diff = new cv.Mat();
        cv.absdiff(dist8u, dilated, diff);
        const peaks = new cv.Mat();
        cv.threshold(diff, peaks, 0, 255, cv.THRESH_BINARY_INV);
        // Foreground threshold on distance transform
        const alpha = typeof splitStrength === "number" ? splitStrength : 0.2;
        const t255 = mode === "absolute" ? (dtThreshAbs ?? 100) : Math.max(0, Math.min(255, Math.round((0.02 + alpha * 0.38) * 255)));
        const fg = new cv.Mat();
        cv.threshold(dist8u, fg, t255, 255, cv.THRESH_BINARY);
        cv.bitwise_and(peaks, fg, peaks);
        // Cleanup peaks
        const pkSize = Math.max(1, peakCleanupSize | 1);
        let peaksClean = new cv.Mat();
        if (pkSize >= 3) {
          const pkK = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(pkSize, pkSize));
          cv.morphologyEx(peaks, peaksClean, cv.MORPH_OPEN, pkK);
          pkK.delete();
        } else {
          peaksClean = peaks.clone();
        }
        // Markers & watershed (run within ROI for speed and correctness)
        const markers = new cv.Mat();
        cv.connectedComponentsWithStats(peaksClean, markers, new cv.Mat(), new cv.Mat(), 8, cv.CV_32S);
        const rgbRoiFull = new cv.Mat();
        const srcRoiFull = src.roi(roiRect);
        cv.cvtColor(srcRoiFull, rgbRoiFull, cv.COLOR_RGBA2RGB);
        cv.watershed(rgbRoiFull, markers);
        rgbRoiFull.delete();
        srcRoiFull.delete();
        const separated = new cv.Mat(markers.rows, markers.cols, cv.CV_8UC1);
        for (let y = 0; y < markers.rows; y++) {
          for (let x = 0; x < markers.cols; x++) {
            const label = markers.intPtr(y, x)[0];
            // Ignore boundaries (-1) and background (0/1). Keep real regions (>1)
            separated.ucharPtr(y, x)[0] = label > 1 ? 255 : 0;
          }
        }
        // Constrain watershed result to original foreground to avoid flooding background
        const separatedFg = new cv.Mat();
        cv.bitwise_and(separated, opened, separatedFg);

        const { count, previewUrl } = countAndPreview(separatedFg);

        // Cleanup
        dist.delete();
        distNorm.delete();
        dist8u.delete();
        dilK.delete();
        dilated.delete();
        diff.delete();
        peaks.delete();
        peaksClean.delete();
        fg.delete();
        markers.delete();
        separated.delete();
        separatedFg.delete();

        return { count, previewUrl };
      };

      for (const distType of distTypes) {
        for (const distMask of distMasks) {
          for (const peakCleanupSize of pkSizes) {
            // Relative (alpha)
            for (const splitStrength of alphas) {
              const { count, previewUrl } = runWs(distType, distMask, "alpha", splitStrength, undefined, peakCleanupSize);
              localResults.push({
                id: `a-${distType}-${distMask}-${peakCleanupSize}-${splitStrength}`,
                params: { mode: "alpha", splitStrength, distType, distMask, peakCleanupSize },
                count,
                previewUrl,
              });
              processed++;
              if (processed % 25 === 0 || processed === totalCombos) {
                setProgress({ done: processed, total: totalCombos });
                console.log(`[ws-test] Progress: ${processed}/${totalCombos}`);
              }
            }
            // Absolute
            for (const t of absTs) {
              const { count, previewUrl } = runWs(distType, distMask, "absolute", undefined, t, peakCleanupSize);
              localResults.push({
                id: `t-${distType}-${distMask}-${peakCleanupSize}-${t}`,
                params: { mode: "absolute", dtThreshAbs: t, distType, distMask, peakCleanupSize },
                count,
                previewUrl,
              });
              processed++;
              if (processed % 25 === 0 || processed === totalCombos) {
                setProgress({ done: processed, total: totalCombos });
                console.log(`[ws-test] Progress: ${processed}/${totalCombos}`);
              }
            }
          }
        }
      }

      // Sort by count desc and keep
      localResults.sort((a, b) => b.count - a.count);
      setResults(localResults);
      // Expose results to headless harness (Playwright) without network
      ;(window as unknown as { __wsResults?: unknown }).__wsResults = {
        baseline: base.count,
        results: localResults,
      };
      const tops = localResults.slice(0, 8);
      console.log("[ws-test] Done. Top results:");
      for (const r of tops) {
        const p = r.params;
        const modeStr = p.mode === "alpha" ? `alpha=${p.splitStrength}` : `T=${p.dtThreshAbs}`;
        console.log(`- count=${r.count} | ${modeStr}, dist=${p.distType}, mask=${p.distMask}, pk=${p.peakCleanupSize}`);
      }

      // Cleanup bases
      kernel.delete();
      opened.delete();
      bin.delete();
      thresh.delete();
      grayRoi.delete();
      maskedGray.delete();
      dishMask.delete();
      blurred.delete();
      gray.delete();
      src.delete();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="p-4 space-y-4">
      {running && progress && (
        <div className="fixed top-2 left-2 z-50 bg-black/70 text-white text-xs px-2 py-1 rounded">
          進度 {progress.done}/{progress.total}
        </div>
      )}
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">Watershed 參數測試</h2>
        {error && <span className="text-sm text-red-600">{error}</span>}
        {!isReady && <span className="text-sm text-gray-500">正在載入 OpenCV…</span>}
      </div>
      {/* hidden image source */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imgRef}
        src={srcUrl}
        alt="test"
        className="hidden"
        onLoad={() => setImageLoaded(true)}
      />

      <div className="flex items-center gap-4">
        <button
          className="px-3 py-1.5 rounded border disabled:opacity-50"
          onClick={() => void runSweep()}
          disabled={!isReady || running}
        >
          {running ? "測試中…" : "重新測試"}
        </button>
        {baseCount !== null && <span className="text-sm">不使用分水嶺的基準計數：<b>{baseCount}</b></span>}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {results.map((r) => (
          <div key={r.id} className="border rounded overflow-hidden">
            <div className="text-xs px-2 py-1 border-b flex items-center justify-between">
              <span>計數：<b>{r.count}</b></span>
              <span>
                {r.params.mode === "alpha"
                  ? `α=${r.params.splitStrength?.toFixed(2)}`
                  : `T=${r.params.dtThreshAbs}`}
              </span>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={r.previewUrl} alt="preview" className="w-full h-auto object-contain" />
            <div className="text-[11px] px-2 py-1 text-gray-600">
              <div>dist={r.params.distType}, mask={r.params.distMask}, pk={r.params.peakCleanupSize}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


