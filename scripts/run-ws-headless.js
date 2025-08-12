/* eslint-disable no-console */
const fs = require("fs/promises");
const path = require("path");

async function main() {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Blank page; prepare Module first, then load OpenCV.js
  await page.setContent("<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>");
  await page.addInitScript(() => {
    window.Module = window.Module || {};
    const prev = window.Module.onRuntimeInitialized;
    window.__cvReady = false;
    window.Module.onRuntimeInitialized = () => {
      if (typeof prev === 'function') prev();
      window.__cvReady = true;
    };
  });
  await page.addScriptTag({ url: "https://docs.opencv.org/4.x/opencv.js" });
  await page.waitForFunction(() => (window.cv && typeof window.cv.Mat === "function") || window.__cvReady, { timeout: 45000 });

  // Read local test image and convert to data URL
  const imgPath = path.join(process.cwd(), "public", "test.jpg");
  const buf = await fs.readFile(imgPath);
  const dataUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;

  // Parameters from user
  const params = {
    minArea: 93,
    effectiveRadiusPct: 84,
    blurSize: 7,
    morphSize: 5,
    thresholdMode: "adaptive-gaussian",
    adaptiveBlock: 33,
    adaptiveC: 0,
    invertMask: true,
    sweep: {
      distTypes: ["L1", "L2", "C"],
      distMasks: [3, 5],
      alphas: [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6],
      absTs: [60, 80, 100, 120, 140],
      pkSizes: [1, 3, 5],
    },
  };

  const result = await page.evaluate(async ({ dataUrl, params }) => {
    const logs = [];
    const step = async (name, fn) => {
      try { logs.push(`start:${name}`); const r = await fn(); logs.push(`ok:${name}`); return { ok: true, value: r }; }
      catch (e) { logs.push(`fail:${name}:${e && e.message ? e.message : e}`); return { ok: false, error: e && e.message ? String(e.message) : String(e) }; }
    };
    const out = { logs };
    try {
      const cv = window.cv;
      function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
      function ensureOdd(n) { return (n % 2 === 0 ? n + 1 : n); }

      // Load and draw onto canvas for imread
      let img, canvas, ctx, src;
      {
        const r1 = await step('load-image', async () => {
          img = new Image();
          img.src = dataUrl;
          await new Promise((res, rej) => { img.onload = () => res(); img.onerror = rej; });
        }); if (!r1.ok) return { ok: false, stage: 'load-image', error: r1.error, logs };
        const r2 = await step('draw-canvas', async () => {
          canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
        }); if (!r2.ok) return { ok: false, stage: 'draw-canvas', error: r2.error, logs };
        const r3 = await step('imread', async () => {
          src = cv.imread(canvas);
        }); if (!r3.ok) return { ok: false, stage: 'imread', error: r3.error, logs };
      }
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    const blurred = new cv.Mat();
    const kBlur = Math.max(1, ensureOdd(params.blurSize));
    cv.GaussianBlur(gray, blurred, new cv.Size(kBlur, kBlur), 0, 0, cv.BORDER_DEFAULT);

    // Approx dish via largest rectangle from Canny contours
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

    // ROI
    const roiSize = Math.min(src.cols, src.rows, Math.round(dishR * 2 * 1.05));
    const roiX = Math.max(0, Math.round(dishCx - roiSize / 2));
    const roiY = Math.max(0, Math.round(dishCy - roiSize / 2));
    const roiW = Math.min(roiSize, src.cols - roiX);
    const roiH = Math.min(roiSize, src.rows - roiY);
    const roiRect = new cv.Rect(roiX, roiY, roiW, roiH);

    // Threshold: adaptive gaussian with requested settings
    const thresh = new cv.Mat();
    const blk = Math.max(3, ensureOdd(params.adaptiveBlock));
    cv.adaptiveThreshold(maskedGray, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blk, params.adaptiveC);
    let bin = thresh;
    let binOwned = false;
    if (params.invertMask) {
      const inv = new cv.Mat();
      cv.threshold(thresh, inv, 0, 255, cv.THRESH_BINARY_INV);
      bin = inv; binOwned = true;
    }
    const kMorph = Math.max(1, ensureOdd(params.morphSize));
    const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kMorph, kMorph));
    const opened = new cv.Mat();
    cv.morphologyEx(bin, opened, cv.MORPH_OPEN, kernel);

    // Helper count inside inner circle
    const countInside = (maskMat) => {
      const innerMask = cv.Mat.zeros(maskMat.rows, maskMat.cols, cv.CV_8UC1);
      const effR = Math.round((dishR * params.effectiveRadiusPct) / 100);
      const innerCx = Math.round(clamp(dishCx - roiX, 0, maskMat.cols));
      const innerCy = Math.round(clamp(dishCy - roiY, 0, maskMat.rows));
      cv.circle(innerMask, { x: innerCx, y: innerCy }, effR, new cv.Scalar(255), -1);
      const maskedInner = new cv.Mat();
      cv.bitwise_and(maskMat, maskMat, maskedInner, innerMask);
      const labels = new cv.Mat();
      const stats = new cv.Mat();
      const cents = new cv.Mat();
      const n = cv.connectedComponentsWithStats(maskedInner, labels, stats, cents, 8, cv.CV_32S);
      let cnt = 0;
      for (let i = 1; i < n; i++) {
        const area = stats.intPtr(i, 4)[0];
        if (area < params.minArea) continue; cnt++;
      }
      labels.delete(); stats.delete(); cents.delete(); maskedInner.delete(); innerMask.delete();
      return cnt;
    };

    // Baseline
    const toLabelRoi = opened.roi(roiRect);
    const baseline = countInside(toLabelRoi);

    // Watershed run helper
    const runWs = (distType, distMask, mode, alphaValue, dtAbs, pkSize) => {
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
      const dilK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      const dilated = new cv.Mat();
      cv.dilate(dist8u, dilated, dilK);
      const diff = new cv.Mat();
      cv.absdiff(dist8u, dilated, diff);
      const peaks = new cv.Mat();
      cv.threshold(diff, peaks, 0, 255, cv.THRESH_BINARY_INV);
      const t255 = mode === "absolute" ? dtAbs : Math.max(0, Math.min(255, Math.round((0.02 + (alphaValue || 0) * 0.38) * 255)));
      const fg = new cv.Mat();
      cv.threshold(dist8u, fg, t255, 255, cv.THRESH_BINARY);
      cv.bitwise_and(peaks, fg, peaks);
      const pk = Math.max(1, ensureOdd(pkSize));
      let peaksClean = new cv.Mat();
      if (pk >= 3) {
        const pkK = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(pk, pk));
        cv.morphologyEx(peaks, peaksClean, cv.MORPH_OPEN, pkK);
        pkK.delete();
      } else {
        peaksClean = peaks.clone();
      }
      const markers = new cv.Mat();
      cv.connectedComponentsWithStats(peaksClean, markers, new cv.Mat(), new cv.Mat(), 8, cv.CV_32S);
      const rgbRoiFull = new cv.Mat();
      const srcRoiFull = src.roi(roiRect);
      cv.cvtColor(srcRoiFull, rgbRoiFull, cv.COLOR_RGBA2RGB);
      cv.watershed(rgbRoiFull, markers);
      rgbRoiFull.delete(); srcRoiFull.delete();
      const separated = new cv.Mat(markers.rows, markers.cols, cv.CV_8UC1);
      for (let y = 0; y < markers.rows; y++) {
        for (let x = 0; x < markers.cols; x++) {
          const label = markers.intPtr(y, x)[0];
          separated.ucharPtr(y, x)[0] = label > 1 ? 255 : 0;
        }
      }
      const sepRoi = separated.roi(roiRect);
      const count = countInside(sepRoi);

      dist.delete(); distNorm.delete(); dist8u.delete(); dilK.delete(); dilated.delete(); diff.delete(); peaks.delete(); peaksClean.delete(); fg.delete(); markers.delete(); separated.delete(); sepRoi.delete();
      return count;
    };

    const results = [];
    const { distTypes, distMasks, alphas, absTs, pkSizes } = params.sweep;
    for (const dt of distTypes) {
      for (const dm of distMasks) {
        for (const pk of pkSizes) {
          for (const a of alphas) {
            const count = runWs(dt, dm, "alpha", a, undefined, pk);
            results.push({ id: `a-${dt}-${dm}-${pk}-${a}`, params: { mode: "alpha", splitStrength: a, distType: dt, distMask: dm, peakCleanupSize: pk }, count });
          }
          for (const t of absTs) {
            const count = runWs(dt, dm, "absolute", undefined, t, pk);
            results.push({ id: `t-${dt}-${dm}-${pk}-${t}`, params: { mode: "absolute", dtThreshAbs: t, distType: dt, distMask: dm, peakCleanupSize: pk }, count });
          }
        }
      }
    }

    toLabelRoi.delete(); kernel.delete(); opened.delete(); if (binOwned) bin.delete(); thresh.delete(); maskedGray.delete(); mask.delete(); blurred.delete(); gray.delete(); src.delete();

      results.sort((a, b) => b.count - a.count);
      return { ok: true, baseline, results, logs };
    } catch (e) {
      return { ok: false, error: e && e.message ? String(e.message) : String(e), logs };
    }
  }, { dataUrl, params });

  await browser.close();

  // Print summary
  if (!result || !result.ok) {
    console.error('[headless-ws] Failed:', result && result.error ? result.error : 'Unknown error');
    if (result && result.logs) console.error('[headless-ws] logs:\n' + result.logs.join('\n'));
    process.exit(1);
  }
  const baseline = result.baseline;
  const improved = result.results.filter(r => r.count > baseline).slice(0, 15);
  console.log(`[headless-ws] Baseline (no watershed): ${baseline}`);
  if (improved.length === 0) {
    console.log("[headless-ws] No watershed settings improved over baseline.");
  } else {
    console.log("[headless-ws] Top improving parameter sets:");
    for (const r of improved) {
      const p = r.params;
      const modeStr = p.mode === 'alpha' ? `alpha=${p.splitStrength}` : `T=${p.dtThreshAbs}`;
      console.log(`- count=${r.count} | ${modeStr}, dist=${p.distType}, mask=${p.distMask}, pk=${p.peakCleanupSize}`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });


