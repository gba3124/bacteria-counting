"use client";

import { useEffect, useRef, useState } from "react";

// globals are declared in src/types/opencv.d.ts

let scriptLoadingPromise: Promise<void> | null = null;

function loadOpenCvScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();

  if (window.cv && typeof window.cv.Mat === "function") {
    return Promise.resolve();
  }

  if (scriptLoadingPromise) return scriptLoadingPromise;

  scriptLoadingPromise = new Promise<void>((resolve, reject) => {
    // Ensure Module is defined before the script loads so onRuntimeInitialized is picked up
    if (!window.Module) {
      window.Module = {};
    }

    const script = document.createElement("script");
    script.async = true;
    script.src = "https://docs.opencv.org/4.x/opencv.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load opencv.js"));
    document.head.appendChild(script);
  });

  return scriptLoadingPromise;
}

export function useOpenCV() {
  const [isReady, setIsReady] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const initializedRef = useRef<boolean>(false);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    let cancelled = false;

    const ensureReady = async () => {
      try {
        // If already loaded and initialized
        if (typeof window !== "undefined" && window.cv && typeof window.cv.Mat === "function") {
          if (!cancelled) setIsReady(true);
          return;
        }

        // Set onRuntimeInitialized before loading the script
        if (typeof window !== "undefined") {
          window.Module = window.Module || {};
          const prevOnRuntimeInitialized = window.Module.onRuntimeInitialized;
          window.Module.onRuntimeInitialized = () => {
            prevOnRuntimeInitialized?.();
            if (!cancelled) setIsReady(true);
          };
        }

        await loadOpenCvScript();

        // Fallback 1: if onRuntimeInitialized did not fire yet but cv is present
        if (typeof window !== "undefined" && window.cv && typeof window.cv.Mat === "function") {
          if (!cancelled) setIsReady(true);
          return;
        }

        // Fallback 2: some builds expose onRuntimeInitialized on cv itself
        if (typeof window !== "undefined" && (window as unknown as { cv?: unknown }).cv) {
          const cvObject = (window as unknown as { cv: { onRuntimeInitialized?: () => void } }).cv;
          const prev = cvObject.onRuntimeInitialized;
          cvObject.onRuntimeInitialized = () => {
            prev?.();
            if (!cancelled) setIsReady(true);
          };
        }

        // Fallback 3: poll up to 15s for cv readiness
        const start = Date.now();
        await new Promise<void>((resolvePoll, rejectPoll) => {
          const timer = setInterval(() => {
            if (cancelled) {
              clearInterval(timer);
              resolvePoll();
              return;
            }
            if (typeof window !== "undefined" && window.cv && typeof window.cv.Mat === "function") {
              clearInterval(timer);
              if (!cancelled) setIsReady(true);
              resolvePoll();
            } else if (Date.now() - start > 15000) {
              clearInterval(timer);
              rejectPoll(new Error("Timed out waiting for OpenCV to initialize"));
            }
          }, 150);
        });
      } catch (e: unknown) {
        if (!cancelled) {
          if (e instanceof Error) {
            setError(e.message);
          } else {
            setError("Failed to initialize OpenCV");
          }
        }
      }
    };

    ensureReady();
    return () => {
      cancelled = true;
    };
  }, []);

  return { isReady, error } as const;
}


