/**
 * Optional zero-bundle-cost React adapter factory for `@jiange/slides-ui`.
 * Call `createSlidesViewComponent(React)` to obtain a React component without
 * pulling React into vanilla/Vue/Svelte bundles.
 */

import type { Presentation } from "@jiange/slides-sdk";
import { mountSlidesView, type MountedSlidesView, type SlidesViewOptions } from "./slides-view.js";

export interface SlidesReactLike {
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useRef<T>(initial: T): { current: T };
  createElement(type: string, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
}

export interface SlidesViewProps extends SlidesViewOptions {
  presentation: Presentation;
  width?: number;
  height?: number;
  className?: string;
}

export function createSlidesViewComponent(React: SlidesReactLike): (props: SlidesViewProps) => unknown {
  return function SlidesView(props: SlidesViewProps) {
    const hostRef = React.useRef<HTMLElement | null>(null);
    React.useEffect(() => {
      let alive = true;
      let mounted: MountedSlidesView | null = null;
      const el = hostRef.current;
      if (!el) return;
      void mountSlidesView(el, props.presentation, props).then((v) => {
        if (!alive) v.dispose();
        else mounted = v;
      });
      return () => {
        alive = false;
        mounted?.dispose();
      };
    }, [props.presentation]);
    return React.createElement("div", {
      ref: hostRef,
      tabIndex: 0,
      className: props.className,
      style: {
        width: props.width ? `${props.width}px` : "100%",
        height: props.height ? `${props.height}px` : "100%",
      },
    });
  };
}
