// In-page pointer used by video capture. Browser/Playwright recordings do not
// include the operating-system cursor, so recording actions install this
// lightweight overlay in the current document.

export function recordingPointerScript() {
  if (document.getElementById("mare-recording-pointer")) return;

  const style = document.createElement("style");
  style.id = "mare-recording-pointer-style";
  style.textContent = `
    #mare-recording-pointer {
      position: fixed;
      left: 0;
      top: 0;
      width: 34px;
      height: 34px;
      z-index: 2147483647;
      pointer-events: none;
      opacity: 0;
      border: 3px solid rgba(255, 183, 0, 0.98);
      border-radius: 999px;
      background: rgba(255, 235, 59, 0.34);
      box-shadow: 0 1px 8px rgba(0, 0, 0, 0.28), inset 0 0 0 2px rgba(255, 255, 255, 0.65);
      transform: translate(-50%, -50%) scale(1);
      transition: left 80ms linear, top 80ms linear, opacity 120ms ease, transform 120ms ease;
    }
    #mare-recording-pointer.mare-pointer-down {
      transform: translate(-50%, -50%) scale(0.72);
      background: rgba(255, 193, 7, 0.58);
    }
    #mare-recording-pointer.mare-pointer-pulse::after {
      content: "";
      position: absolute;
      inset: -4px;
      border: 3px solid rgba(255, 193, 7, 0.86);
      border-radius: inherit;
      animation: mare-pointer-pulse 420ms ease-out forwards;
    }
    @keyframes mare-pointer-pulse {
      from { opacity: 0.9; transform: scale(0.8); }
      to { opacity: 0; transform: scale(1.9); }
    }
  `;

  const pointer = document.createElement("div");
  pointer.id = "mare-recording-pointer";
  pointer.setAttribute("aria-hidden", "true");
  document.documentElement.append(style, pointer);

  const placePointer = event => {
    pointer.style.left = `${event.clientX}px`;
    pointer.style.top = `${event.clientY}px`;
    pointer.style.opacity = "1";
  };

  window.addEventListener("pointermove", placePointer, true);
  window.addEventListener("pointerdown", event => {
    placePointer(event);
    pointer.classList.add("mare-pointer-down");
  }, true);
  window.addEventListener("pointerup", event => {
    placePointer(event);
    pointer.classList.remove("mare-pointer-down");
    pointer.classList.remove("mare-pointer-pulse");
    void pointer.offsetWidth;
    pointer.classList.add("mare-pointer-pulse");
  }, true);
}

export async function installRecordingPointer(page) {
  await page.evaluate(recordingPointerScript);
}

// Keep the pointer element installed so the next recorded action can reuse it,
// but make it impossible for a completed recording to contaminate screenshots.
// Removing the active classes also prevents a half-finished pulse animation from
// reappearing when the element is shown again.
export function hideRecordingPointerScript() {
  const pointer = document.getElementById("mare-recording-pointer");
  if (!pointer) return { present: false, hidden: true };

  pointer.style.opacity = "0";
  pointer.classList.remove("mare-pointer-down", "mare-pointer-pulse");
  return {
    present: true,
    hidden: getComputedStyle(pointer).opacity === "0",
  };
}

export async function hideRecordingPointer(page) {
  if (!page || page.isClosed()) return { present: false, hidden: true };
  try {
    return await page.evaluate(hideRecordingPointerScript);
  } catch {
    // Navigation can replace the document between screencast stop and cleanup.
    // A replaced document cannot contain the old pointer, so it is clean.
    return { present: false, hidden: true };
  }
}
