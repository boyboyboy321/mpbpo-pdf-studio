import { PointerSensor } from "@dnd-kit/core";
import type { PointerSensorProps } from "@dnd-kit/core";

// A release outside the WebView can be lost. Cancel the sensor itself as well
// as its UI state, so a later hover cannot resume an abandoned drag.
export class PagePointerSensor extends PointerSensor {
  autoScrollEnabled = false;

  constructor(props: PointerSensorProps) {
    const listeners = new AbortController();
    super({
      ...props,
      onCancel: () => {
        listeners.abort();
        props.onCancel();
      },
      onEnd: () => {
        listeners.abort();
        props.onEnd();
      },
    });

    const pointer = props.event as PointerEvent;
    const ownerDocument = (pointer.target as Node | null)?.ownerDocument ?? document;
    const ownerWindow = ownerDocument.defaultView ?? window;
    const cancel = () => {
      if (listeners.signal.aborted) return;
      ownerDocument.dispatchEvent(new PointerEvent("pointercancel", {
        bubbles: true,
        pointerId: pointer.pointerId,
        pointerType: pointer.pointerType,
      }));
    };

    ownerDocument.addEventListener("pointermove", (event) => {
      if (event.pointerId !== pointer.pointerId) return;
      if ((event.buttons & 1) === 0) {
        event.stopImmediatePropagation();
        cancel();
      }
    }, { capture: true, signal: listeners.signal });
    ownerDocument.addEventListener("lostpointercapture", (event) => {
      if (event.pointerId === pointer.pointerId) cancel();
    }, { capture: true, signal: listeners.signal });
    ownerDocument.addEventListener("visibilitychange", () => {
      if (ownerDocument.hidden) cancel();
    }, { signal: listeners.signal });
    ownerWindow.addEventListener("blur", cancel, { signal: listeners.signal });
    ownerWindow.addEventListener("pagehide", cancel, { signal: listeners.signal });
  }
}
